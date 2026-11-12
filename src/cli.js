'use strict';

// CLI (FR-090…FR-095, design §3.10): a thin mirror of the web UI running
// in-process against the same core layer. It re-reads the config file on
// every invocation, does not require the web server, and maps every outcome
// onto the four exit codes of FR-093: 0 success, 1 failure, 2 usage error,
// 3 container/host not found.
//
// Output rules (§3.10.3): aligned columns for humans, colour only on a TTY
// without NO_COLOR, one JSON document per invocation with --json — except
// `logs --follow --json` and `events --json`, which emit NDJSON so they can
// be piped to jq. Errors go to stderr as `docker-manager: <message>` and, in
// --json mode, as {"error":{…}} on stdout too.

const readline = require('node:readline');
const APP_VERSION = require('../package.json').version;
const envParse = require('./config/env');
const { createStore } = require('./config/store');
const { Bus } = require('./core/bus');
const { createActivity } = require('./core/activity');
const f = require('./core/format');
const { createPool } = require('./docker/pool');
const { createQueries, applyFilter } = require('./docker/queries');
const { createActions } = require('./docker/actions');
const { createLogService } = require('./docker/logs');
const { createComposeService } = require('./compose');
const { DockerError, mapDockerError } = require('./docker/errors');
const { resolveSelf } = require('./docker/self');
const { derive } = require('./docker/stats');
const { normalise } = require('./docker/events');

// ---------------------------------------------------------------- usage ---

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.code = 'USAGE';
  }
}

const VALUE_FLAGS = ['host', 'state', 'q', 'tail', 'timeout', 'signal', 'since'];
const BOOL_FLAGS = ['json', 'follow', 'timestamps', 'no-timestamps', 'force', 'stop', 'yes', 'detach'];
const STATE_VALUES = ['all', 'running', 'stopped', 'paused'];
const COMPOSE_SUBS = ['ls', 'up', 'down'];

// Command surface of design §3.10.1 + two read-only extras (hosts, config).
const COMMANDS = {
  list: { args: [0, 0], flags: ['host', 'json', 'state', 'q'] },
  inspect: { args: [1, 1], flags: ['host', 'json'] },
  logs: { args: [1, 1], flags: ['host', 'json', 'tail', 'follow', 'timestamps', 'no-timestamps'] },
  start: { args: [1, 1], flags: ['host', 'json'] },
  stop: { args: [1, 1], flags: ['host', 'json', 'timeout'] },
  restart: { args: [1, 1], flags: ['host', 'json', 'timeout'] },
  kill: { args: [1, 1], flags: ['host', 'json', 'signal'] },
  rm: { args: [1, 1], flags: ['host', 'json', 'force', 'stop'] },
  pause: { args: [1, 1], flags: ['host', 'json'] },
  unpause: { args: [1, 1], flags: ['host', 'json'] },
  stats: { args: [1, 1], flags: ['host', 'json'] },
  events: { args: [0, 0], flags: ['host', 'json', 'since'] },
  images: { args: [0, 0], flags: ['host', 'json'] },
  volumes: { args: [0, 0], flags: ['host', 'json'] },
  networks: { args: [0, 0], flags: ['host', 'json'] },
  hosts: { args: [0, 0], flags: ['json'] },
  config: { args: [0, 0], flags: ['json'] },
  compose: {
    sub: {
      ls: { args: [0, 0], flags: ['host', 'json'] },
      up: { args: [1, 1], flags: ['host', 'json', 'detach'] },
      down: { args: [1, 1], flags: ['host', 'json', 'yes'] }
    }
  }
};

function specLabel(command, sub) {
  return sub ? `${command} ${sub}` : command;
}

// A relative span ("30m"), unix seconds, or an RFC3339 timestamp — the same
// vocabulary the docker CLI accepts for --since.
function parseSince(raw) {
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return s;
  const rel = /^(\d+)([smhd])$/.exec(s);
  if (rel) {
    const mult = { s: 1, m: 60, h: 3600, d: 86400 }[rel[2]];
    return String(Math.floor(Date.now() / 1000) - Number(rel[1]) * mult);
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(Date.parse(s))) return s;
  throw new UsageError(`--since must be a relative span (30m), unix seconds, or an RFC3339 timestamp; got "${raw}".`);
}

function requireInt(raw, name, min, max) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new UsageError(`--${name} must be an integer between ${min} and ${max}.`);
  }
  return n;
}

function validateFlagValues(flags) {
  if (flags.state !== undefined && !STATE_VALUES.includes(flags.state)) {
    throw new UsageError(`--state must be one of: ${STATE_VALUES.join(', ')}.`);
  }
  if (flags.tail !== undefined) requireInt(flags.tail, 'tail', 0, 10000); // FR-094 default 100
  if (flags.timeout !== undefined) requireInt(flags.timeout, 'timeout', 0, 300);
  if (flags.signal !== undefined && !/^[A-Za-z0-9]+$/.test(flags.signal)) {
    throw new UsageError('--signal must be a signal name or number (e.g. SIGTERM or 15).');
  }
  if (flags.since !== undefined) parseSince(flags.since);
}

// Pure argv parser (UT-007): flags may appear before or after the command,
// `--flag=value` is accepted, `--` ends flag parsing.
function parseArgv(argv) {
  const tokens = (argv || []).map(String);
  const flags = {};
  const positional = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === '--') {
      positional.push(...tokens.slice(i + 1));
      break;
    }
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      const name = eq >= 0 ? tok.slice(2, eq) : tok.slice(2);
      const inline = eq >= 0 ? tok.slice(eq + 1) : null;
      if (name === 'help') { flags.help = true; continue; }
      if (name === 'version') { flags.version = true; continue; }
      if (BOOL_FLAGS.includes(name)) {
        if (inline !== null) throw new UsageError(`Flag --${name} does not take a value.`);
        flags[name] = true;
        continue;
      }
      if (!VALUE_FLAGS.includes(name)) throw new UsageError(`Unknown flag --${name}.`);
      let value = inline;
      if (value === null) {
        value = tokens[i + 1];
        if (value === undefined || value === '--' || value.startsWith('--')) {
          throw new UsageError(`Flag --${name} needs a value.`);
        }
        i += 1;
      }
      flags[name] = value;
      continue;
    }
    if (tok.startsWith('-') && tok.length > 1 && !/^-\d/.test(tok)) {
      throw new UsageError(`Unknown flag ${tok}.`);
    }
    positional.push(tok);
  }

  if (flags.help) return { command: 'help', sub: null, args: [], flags };
  if (flags.version) return { command: 'version', sub: null, args: [], flags };
  if (positional.length === 0) throw new UsageError('Missing command. Run "docker-manager --help".');

  const command = positional[0];
  if (command === 'help') return { command: 'help', sub: null, args: [], flags };
  if (command === 'version') return { command: 'version', sub: null, args: [], flags };

  const entry = COMMANDS[command];
  if (!entry) throw new UsageError(`Unknown command "${command}". Run "docker-manager --help".`);

  let sub = null;
  let spec = entry;
  let args;
  if (entry.sub) {
    sub = positional[1];
    if (!sub) throw new UsageError(`"${command}" needs a subcommand: ${COMPOSE_SUBS.join(', ')}.`);
    if (!entry.sub[sub]) throw new UsageError(`Unknown "${command}" subcommand "${sub}".`);
    spec = entry.sub[sub];
    args = positional.slice(2);
  } else {
    args = positional.slice(1);
  }

  const label = specLabel(command, sub);
  for (const name of Object.keys(flags)) {
    if (name === 'help' || name === 'version') continue;
    if (!spec.flags.includes(name)) throw new UsageError(`Flag --${name} is not valid for "${label}".`);
  }
  const [min, max] = spec.args;
  if (args.length < min || args.length > max) {
    const expect = min === max
      ? `${min} argument${min === 1 ? '' : 's'}`
      : `${min === 0 ? 'no' : min} to ${max} arguments`;
    throw new UsageError(`"${label}" expects ${expect}, got ${args.length}.`);
  }
  if (command === 'rm' && flags.force && flags.stop) {
    throw new UsageError('--force and --stop are mutually exclusive.');
  }

  validateFlagValues(flags);
  return { command, sub, args, flags };
}

// FR-093 / design §3.10.2: 0 success, 2 usage, 3 not found, 1 everything else.
// DockerError and ConfigError carry their exit code in the shared TABLE.
function exitCodeFor(err) {
  if (!err) return 0;
  if (err.name === 'UsageError') return 2;
  if (typeof err.cliExit === 'number') return err.cliExit;
  const code = err.code;
  if (code === 'CONTAINER_NOT_FOUND' || code === 'HOST_NOT_FOUND') return 3;
  return 1;
}

// ---------------------------------------------------------------- output ---

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g;

function makeIO() {
  const paintable = Boolean(process.stdout.isTTY) && !('NO_COLOR' in process.env);
  return {
    out: (s) => process.stdout.write(s),
    line: (s = '') => process.stdout.write(`${s}\n`),
    errLine: (s = '') => process.stderr.write(`${s}\n`),
    json: (doc) => process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`),
    ndjson: (doc) => process.stdout.write(`${JSON.stringify(doc)}\n`),
    paint: (code, text) => (paintable ? `\u001b[${code}m${text}\u001b[0m` : String(text))
  };
}

function visibleWidth(s) {
  return String(s ?? '').replace(ANSI_RE, '').length;
}

function renderTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(visibleWidth(h), ...rows.map((r) => visibleWidth(r[i]))));
  const fmt = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ').trimEnd();
  return [fmt(headers), ...rows.map(fmt)].join('\n');
}

function statePaint(io, state) {
  const s = String(state || '');
  if (s === 'running' || s === 'restarting') return io.paint(32, s);
  if (s === 'paused') return io.paint(33, s);
  if (s === 'exited' || s === 'dead') return io.paint(31, s);
  return s;
}

function portText(ports) {
  const list = Array.isArray(ports) ? ports : [];
  const shown = list.filter((p) => p.hostPort).length ? list.filter((p) => p.hostPort) : list;
  const head = shown.slice(0, 2)
    .map((p) => (p.hostPort ? `${p.hostPort}→${p.containerPort}` : `${p.containerPort}/${p.proto}`))
    .join(', ');
  const more = shown.length > 2 ? ` +${shown.length - 2}` : '';
  return (head + more) || '—';
}

function kvBlock(pairs) {
  const width = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join('\n');
}

function eventStamp(at) {
  const d = new Date(Number(at) * 1000);
  if (Number.isNaN(d.getTime())) return '—'.padEnd(19);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function quietLog() {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop, setLevel: noop };
}

// ----------------------------------------------------------------- setup ---

function resolveHost(cfg, requested) {
  if (requested) {
    const hit = cfg.hosts.find((h) => h.id === requested) || cfg.hosts.find((h) => h.name === requested);
    if (!hit) throw new DockerError('HOST_NOT_FOUND', `No configured host "${requested}".`);
    return hit;
  }
  const active = cfg.hosts.find((h) => h.id === cfg.settings.activeHostId);
  if (active) return active;
  if (cfg.hosts.length) return cfg.hosts[0];
  throw new DockerError('HOST_NOT_FOUND', 'No Docker hosts are configured.');
}

async function createContext(parsed, io) {
  const env = envParse.parse();
  const log = quietLog(); // src/log.js writes JSON lines to stdout — never in a CLI process
  const store = createStore({
    configPath: env.configPath,
    env,
    log,
    onChange: () => pool.syncHosts()
  });
  await store.load();

  const bus = new Bus();
  const activity = createActivity(bus);
  const pool = createPool({ env, log, bus, store });
  const queries = createQueries({ pool, store, log });
  const actions = createActions({ env, pool, store, queries, activity, log });
  const logs = createLogService({ pool, store, log });
  const compose = createComposeService({ env, store, pool, log, activity, bus });
  pool.syncHosts();

  const host = resolveHost(store.get(), parsed.flags.host);
  return {
    env, io, log, store, pool, queries, actions, logs, compose, bus, activity,
    flags: parsed.flags,
    args: parsed.args,
    parsed,
    hostId: host.id,
    access: host.access || null,
    selfReady: false,
    async close() {
      try { logs.closeAll(); } catch { /* ignore */ }
      try { await compose.runner.stop(); } catch { /* ignore */ }
      try { await pool.close(); } catch { /* ignore */ }
      try { await store.close(); } catch { /* ignore */ }
    }
  };
}

// Self-container identity: resolved on demand before mutating verbs, so the
// CLI refuses `stop docker-manager` exactly like the web UI (§3.10.4). The
// probe is bounded (2 s) and failures leave assertNotSelf failing closed.
async function prepareSelf(ctx) {
  if (ctx.selfReady) return;
  ctx.selfReady = true;
  try {
    const local = ctx.store.get().hosts.find((h) => h.access === 'socket');
    if (local) await ctx.pool.probeHost(local);
    await resolveSelf(ctx.pool, ctx.env);
  } catch { /* self-guard fails closed */ }
}

// The prompt goes to stderr so `compose down --json` keeps stdout parseable.
function promptLine(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ------------------------------------------------------------ commands ----

async function cmdList(ctx) {
  const { flags, io } = ctx;
  const payload = await ctx.queries.listContainers(ctx.hostId);
  const { rows, counts } = applyFilter(payload.rows, { state: flags.state, q: flags.q });
  if (flags.json) {
    io.json({ host: payload.host, counts, containers: rows, updatedAt: payload.updatedAt });
    return 0;
  }
  if (!rows.length) {
    io.line(flags.state || flags.q ? 'No containers match the filter.' : 'No containers.');
    return 0;
  }
  const table = rows.map((r) => [
    r.name,
    r.idShort,
    statePaint(io, r.state),
    f.upExit(r),
    r.image,
    portText(r.ports)
  ]);
  io.line(renderTable(['NAME', 'ID', 'STATE', 'STATUS', 'IMAGE', 'PORTS'], table));
  return 0;
}

async function cmdInspect(ctx) {
  const { io, flags } = ctx;
  const detail = await ctx.queries.getContainer(ctx.hostId, ctx.args[0]);
  if (flags.json) {
    io.json(detail);
    return 0;
  }
  const pairs = [
    ['Name', detail.name],
    ['ID', detail.id],
    ['Image', detail.image],
    ['State', statePaint(io, detail.state)],
    ['Status', detail.status],
    ...(detail.health ? [['Health', detail.health]] : []),
    ['Created', f.dateTime(detail.created)],
    ['Started', f.dateTime(detail.startedAt)],
    ['Uptime', f.upExit(detail)],
    ['Command', f.cmd(detail.command)],
    ['Ports', portText(detail.ports)],
    ['Networks', detail.networks.map((n) => n.name).join(', ') || '—'],
    ['Mounts', detail.mounts.map((m) => `${m.source}→${m.destination}${m.readOnly ? ' (ro)' : ''}`).join(', ') || '—'],
    ['Restart', detail.restartPolicy.name],
    ['Description', detail.description || '—']
  ];
  io.line(kvBlock(pairs.map(([k, v]) => [k, String(v ?? '—')])));
  return 0;
}

async function cmdLogs(ctx) {
  const { flags, io } = ctx;
  const target = ctx.args[0];
  const tail = flags.tail === undefined ? undefined : Number(flags.tail);
  const showTs = flags.timestamps
    ? true
    : (flags['no-timestamps'] ? false : Boolean(ctx.store.get().settings.showTimestamps));
  const write = (l) => {
    if (flags.json) {
      io.ndjson({ s: l.s, ts: l.ts, m: l.m });
      return;
    }
    const text = (showTs && l.ts ? `${l.ts} ` : '') + l.m;
    if (l.s === 'err') io.errLine(text);
    else io.line(text);
  };

  if (!flags.follow) {
    const snap = await ctx.logs.fetchSnapshot(ctx.hostId, target, tail, true);
    if (flags.json) io.json({ host: ctx.hostId, container: snap.name, tty: snap.tty, lines: snap.lines });
    else snap.lines.forEach(write);
    return 0;
  }

  // --follow: a fake SSE endpoint in place of the HTTP response. SIGINT
  // destroys the Docker stream and exits 0 (FR-095, §3.10.3).
  let failure = null;
  let settle = null;
  const finished = new Promise((resolve) => { settle = resolve; });
  const sse = {
    closed: false,
    sendT(frame) {
      if (frame.t === 'snapshot') { frame.lines.forEach(write); return; }
      if (frame.t === 'line') { write({ s: frame.s, ts: frame.ts, m: frame.m }); return; }
      if (frame.t === 'error' || (frame.t === 'state' && frame.state === 'error')) failure = frame;
      // 'live', 'warn' and 'closed' are informational in a terminal.
    },
    close() {
      this.closed = true;
      settle();
    }
  };
  const view = await ctx.logs.openStream(ctx.hostId, target, { tail, after: null, timestamps: true, sse });
  if (!view) {
    const fr = failure || {};
    throw new DockerError(fr.code || 'DOCKER_ERROR', fr.message || 'The log stream could not be opened.', { action: 'logs' });
  }
  await new Promise((resolve) => {
    const onSigint = () => {
      try {
        if (view.dockerStream) view.dockerStream.destroy();
      } catch { /* ignore */ }
      resolve();
    };
    process.once('SIGINT', onSigint);
    finished.then(() => {
      process.removeListener('SIGINT', onSigint);
      resolve();
    });
  });
  if (failure) {
    throw new DockerError(failure.code || 'DOCKER_ERROR', failure.message || 'Log stream error.', { action: 'logs' });
  }
  return 0;
}

async function cmdAction(ctx, verb) {
  const { flags, io } = ctx;
  const target = ctx.args[0];
  await prepareSelf(ctx);

  if (verb === 'rm') {
    const mode = flags.force ? 'force' : (flags.stop ? 'stop' : undefined);
    await ctx.actions.remove(ctx.hostId, target, mode ? { mode } : {});
    if (flags.json) io.json({ ok: true, verb: 'rm', target });
    else io.line(`rm ok — ${target} removed`);
    return 0;
  }

  const opts = {};
  if (flags.timeout !== undefined) opts.timeoutSeconds = Number(flags.timeout);
  if (flags.signal !== undefined) opts.signal = flags.signal;
  const result = await ctx.actions.run(ctx.hostId, target, verb, opts);
  if (flags.json) io.json({ ok: result.ok, verb, target, state: result.state || null });
  else io.line(`${verb} ok — ${target}${result.state ? ` is ${result.state}` : ''}`);
  return 0;
}

async function cmdStats(ctx) {
  const { flags, io } = ctx;
  const client = await ctx.pool.withClient(ctx.hostId, (c) => c);
  const inspect = await client.getContainer(ctx.args[0]).inspect();
  const sample = await client.getContainer(inspect.Id).stats({ stream: false });
  const d = derive(sample || {});
  const name = (inspect.Name || '').replace(/^\//, '') || inspect.Id.slice(0, 12);
  const memPct = d.memLimit ? Math.round((d.memUsed / d.memLimit) * 1000) / 10 : null;
  const doc = { name, idShort: inspect.Id.slice(0, 12), ...d, memPct };
  if (flags.json) {
    io.json(doc);
    return 0;
  }
  const pct = d.cpuPct === null ? '—' : `${d.cpuPct.toFixed(1)}%`;
  io.line(kvBlock([
    ['Container', `${doc.name} (${doc.idShort})`],
    ['CPU', pct],
    ['Memory', `${f.bytes(d.memUsed)} / ${f.bytes(d.memLimit)} (${memPct === null ? '—' : `${memPct}%`})`],
    ['Network', `rx ${f.bytes(d.net.rx)} · tx ${f.bytes(d.net.tx)}`],
    ['Block', `read ${f.bytes(d.block.read)} · write ${f.bytes(d.block.write)}`],
    ['PIDs', String(d.pids)]
  ]));
  return 0;
}

async function cmdEvents(ctx) {
  const { flags, io } = ctx;
  const since = flags.since === undefined ? null : parseSince(flags.since);
  const client = await ctx.pool.withClient(ctx.hostId, (c) => c);
  const stream = await client.getEvents(since
    ? { filters: { type: ['container'] }, since }
    : { filters: { type: ['container'] } });
  let streamError = null;
  await new Promise((resolve) => {
    let carry = '';
    let cleanup = () => {};
    const finish = () => {
      cleanup();
      resolve();
    };
    const onSigint = () => {
      try { stream.destroy(); } catch { /* ignore */ }
      finish();
    };
    cleanup = () => process.removeListener('SIGINT', onSigint);
    process.once('SIGINT', onSigint);

    stream.on('data', (chunk) => {
      carry += String(chunk);
      const parts = carry.split('\n');
      carry = parts.pop() ?? '';
      for (const p of parts) {
        if (!p.trim()) continue;
        let raw = null;
        try {
          raw = JSON.parse(p);
        } catch {
          continue; // malformed frame: count nothing, keep streaming
        }
        const ev = normalise(raw, ctx.hostId);
        if (flags.json) io.ndjson(ev);
        else io.line(`${eventStamp(ev.at)}  ${String(ev.action || '').padEnd(18)} ${ev.name}`);
      }
    });
    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', (err) => {
      streamError = err;
      finish();
    });
  });
  if (streamError) {
    const mapped = mapDockerError(streamError, { action: 'events', access: ctx.access });
    throw mapped || new DockerError('DOCKER_ERROR', streamError.message || 'Event stream error.');
  }
  return 0; // SIGINT stops the stream cleanly (§3.10.3)
}

async function cmdImages(ctx) {
  const { io, flags } = ctx;
  const payload = await ctx.queries.listImages(ctx.hostId);
  if (flags.json) {
    io.json(payload);
    return 0;
  }
  if (!payload.images.length && !payload.dangling.length) {
    io.line('No images.');
    return 0;
  }
  const table = payload.images.map((i) => [i.idShort, i.repoTag, f.bytes(i.size), f.date(i.created), String(i.usedBy)]);
  io.line(renderTable(['IMAGE ID', 'NAME', 'SIZE', 'CREATED', 'USED BY'], table));
  if (payload.dangling.length) io.line(`${payload.dangling.length} dangling image(s).`);
  return 0;
}

async function cmdVolumes(ctx) {
  const { io, flags } = ctx;
  const payload = await ctx.queries.listVolumes(ctx.hostId);
  if (flags.json) {
    io.json(payload);
    return 0;
  }
  if (!payload.volumes.length) {
    io.line('No volumes.');
    return 0;
  }
  const table = payload.volumes.map((v) => [v.name, v.driver, f.date(v.created), v.usedBy === null ? '—' : String(v.usedBy)]);
  io.line(renderTable(['NAME', 'DRIVER', 'CREATED', 'USED BY'], table));
  return 0;
}

async function cmdNetworks(ctx) {
  const { io, flags } = ctx;
  const payload = await ctx.queries.listNetworks(ctx.hostId);
  if (flags.json) {
    io.json(payload);
    return 0;
  }
  if (!payload.networks.length) {
    io.line('No networks.');
    return 0;
  }
  const table = payload.networks.map((n) => [n.idShort, n.name, n.driver, n.subnet || '—', String(n.containers.length)]);
  io.line(renderTable(['NETWORK ID', 'NAME', 'DRIVER', 'SUBNET', 'CONTAINERS'], table));
  return 0;
}

function endpointOf(h) {
  if (h.access === 'tcp') return h.url || '—';
  if (h.access === 'ssh') return `${h.sshUser || 'root'}@${h.sshHost || '?'}:${h.sshPort || 22}`;
  return h.socketPath || '—';
}

async function cmdHosts(ctx) {
  const { io, flags } = ctx;
  const cfg = ctx.store.get();
  const activeId = cfg.settings.activeHostId;
  const hosts = cfg.hosts.map((h) => ({
    id: h.id,
    name: h.name,
    access: h.access,
    endpoint: endpointOf(h),
    labelFilter: h.labelFilter || [],
    active: h.id === activeId
  }));
  if (flags.json) {
    io.json({ activeHostId: activeId, hosts });
    return 0;
  }
  if (!hosts.length) {
    io.line('No hosts configured.');
    return 0;
  }
  const table = hosts.map((h) => [h.active ? io.paint(32, '*') : ' ', h.id, h.name, h.access, h.endpoint]);
  io.line(renderTable([' ', 'ID', 'NAME', 'ACCESS', 'ENDPOINT'], table));
  return 0;
}

async function cmdConfig(ctx) {
  const { io, flags } = ctx;
  const cfg = ctx.store.get();
  const doc = {
    path: ctx.store.path,
    state: ctx.store.getState(),
    writable: ctx.store.isWritable(),
    version: cfg.version,
    hosts: cfg.hosts.length,
    notes: Object.keys(cfg.notes || {}).length,
    composeFolder: (cfg.compose && cfg.compose.folder) || null,
    activeHostId: cfg.settings.activeHostId,
    settings: cfg.settings
  };
  if (flags.json) {
    io.json(doc);
    return 0;
  }
  io.line(kvBlock([
    ['Path', doc.path],
    ['State', String(doc.state)],
    ['Writable', doc.writable ? 'yes' : 'no'],
    ['Hosts', String(doc.hosts)],
    ['Notes', String(doc.notes)],
    ['Compose folder', String(doc.composeFolder || '—')],
    ['Active host', String(doc.activeHostId || '—')],
    ['Theme', String(doc.settings.theme)],
    ['Log tail', `${doc.settings.logTailLines} lines`],
    ['Stop timeout', `${doc.settings.stopTimeoutSeconds} s`]
  ]));
  return 0;
}

// ------------------------------------------------------------- compose ----

function statesText(states) {
  if (!states) return '—';
  const parts = Object.entries(states)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`);
  return parts.join(', ') || '—';
}

async function composeLs(ctx) {
  const { io, flags } = ctx;
  const payload = await ctx.compose.listPublic(ctx.hostId);
  if (flags.json) {
    io.json(payload);
    return 0;
  }
  if (!payload.stacks.length) {
    io.line(`No compose projects found in ${payload.folder}.`);
    return 0;
  }
  const table = payload.stacks.map((s) => [s.name, String(s.serviceCount), statesText(s.states), s.file || s.reason || '—']);
  io.line(renderTable(['NAME', 'SERVICES', 'STATES', 'FILE'], table));
  const probeState = payload.compose || {};
  io.line(`\nCompose: ${probeState.version || probeState.state || 'unknown'}${probeState.message ? ` — ${probeState.message}` : ''}`);
  return 0;
}

function waitForJob(job) {
  if (job.done) {
    return Promise.resolve(job.result || { t: 'exit', code: job.exitCode ?? 1, durationMs: job.durationMs });
  }
  return new Promise((resolve) => job.emitter.once('done', resolve));
}

async function composeRun(ctx, action) {
  const { io, flags } = ctx;
  const projectId = ctx.args[0];

  const project = await ctx.compose.resolveProject(ctx.hostId, projectId);
  if (!project) throw new UsageError(`Unknown compose project "${projectId}". Run "docker-manager compose ls".`);

  if (action === 'down' && !flags.yes) {
    // The CLI is scriptable but never silently destructive (§3.10.1):
    // non-TTY refuses with exit 2, a TTY gets an explicit yes/no prompt.
    if (!process.stdin.isTTY) throw new UsageError('Refusing to run down without --yes.');
    io.line(`Project ${project.name}:`);
    for (const svc of project.services || []) io.line(`  ${svc.name || svc.containerId.slice(0, 12)}`);
    const answer = await promptLine('Continue? [yes/N]: ');
    if (answer.trim().toLowerCase() !== 'yes') {
      io.errLine('Aborted.');
      return 1;
    }
    await prepareSelf(ctx); // self-project guard needs the resolved identity
  }

  let started;
  try {
    // Consent was given above (prompt or --yes), so mixed ownership may proceed.
    started = await ctx.compose.run(ctx.hostId, projectId, action, { confirmMixed: action === 'down' });
  } catch (err) {
    if (err && err.code === 'CONTAINER_NOT_FOUND') {
      throw new UsageError(`Unknown compose project "${projectId}". Run "docker-manager compose ls".`);
    }
    throw err;
  }

  const job = ctx.compose.runner.getJob(started.jobId);
  if (!job) throw new DockerError('DOCKER_ERROR', 'The Compose job could not be read back.');

  const collected = [];
  const handle = (entry) => {
    if (flags.json) collected.push({ stream: entry.stream, line: entry.line });
    else if (entry.stream === 'stderr') io.errLine(entry.line);
    else io.line(entry.line);
  };
  job.emitter.on('out', handle);
  for (const entry of job.lines) handle(entry); // output produced before we attached

  const done = await waitForJob(job);
  if (done.t === 'error') throw new DockerError(done.code || 'COMPOSE_FAILED', done.message || 'Compose failed.', { action: `compose ${action}` });
  const exit = done.t === 'exit' ? done.code : 1;

  if (flags.json) {
    io.json({ project: project.name, action, jobId: job.id, lines: collected, exit, durationMs: done.durationMs ?? null });
  }
  if (exit !== 0) {
    io.errLine(`docker-manager: compose ${action} failed (exit ${exit}).`);
    return 1;
  }
  return 0;
}

// ------------------------------------------------------------ dispatch ----

async function dispatch(ctx) {
  const { command, sub } = ctx.parsed;
  switch (command) {
    case 'list': return cmdList(ctx);
    case 'inspect': return cmdInspect(ctx);
    case 'logs': return cmdLogs(ctx);
    case 'stats': return cmdStats(ctx);
    case 'events': return cmdEvents(ctx);
    case 'images': return cmdImages(ctx);
    case 'volumes': return cmdVolumes(ctx);
    case 'networks': return cmdNetworks(ctx);
    case 'hosts': return cmdHosts(ctx);
    case 'config': return cmdConfig(ctx);
    case 'compose': return sub === 'ls' ? composeLs(ctx) : composeRun(ctx, sub);
    default: return cmdAction(ctx, command);
  }
}

const HELP = `docker-manager ${APP_VERSION} — inspect and control Docker containers

Usage:
  docker-manager <command> [arguments] [flags]

Commands:
  list                        List containers                 --state, --q
  inspect <name|id>           Show one container in detail
  logs <name|id>              Show or follow logs             --tail, --follow, --timestamps/--no-timestamps
  start <name|id>             Start a container
  stop <name|id>              Stop a container                --timeout <s>
  restart <name|id>           Restart a container             --timeout <s>
  kill <name|id>              Kill a container                --signal <sig>
  rm <name|id>                Remove a container              --force | --stop
  pause <name|id>             Pause a container
  unpause <name|id>           Unpause a container
  stats <name|id>             One-shot resource sample
  events                      Stream container events         --since
  images                      List images
  volumes                     List volumes
  networks                    List networks
  compose ls                  List Compose projects
  compose up <project>        Run Compose up (always detached) --detach (default)
  compose down <project>      Run Compose down                --yes
  hosts                       List configured hosts
  config                      Show configuration file state
  --help                      Show this help
  --version                   Show the version

Global flags:
  --host <id|name>   Select a configured host (default: the active host)
  --json             Machine-readable output; NDJSON for logs --follow and events

Exit codes:
  0 success · 1 failure · 2 usage error · 3 container/host not found
`;

// --------------------------------------------------------------- entry ----

// `ioOverride` lets tests capture output without touching process.stdout —
// which the node:test runner uses for its own result traffic.
async function run(argv, ioOverride) {
  const parsed = parseArgv(argv);
  const io = ioOverride || makeIO();
  if (parsed.command === 'help') {
    io.out(HELP);
    return 0;
  }
  if (parsed.command === 'version') {
    io.line(`docker-manager ${APP_VERSION}`);
    return 0;
  }
  const ctx = await createContext(parsed, io);
  try {
    return await dispatch(ctx);
  } catch (err) {
    if (err && (err.name === 'UsageError' || err instanceof DockerError)) throw err;
    const label = `${parsed.command}${parsed.sub ? ` ${parsed.sub}` : ''}`;
    const mapped = mapDockerError(err, { action: label, access: ctx.access });
    throw mapped || new DockerError('DOCKER_ERROR', (err && err.message) || 'Unknown error.');
  } finally {
    await ctx.close();
  }
}

function reportError(err, argv) {
  const io = makeIO();
  const message = err && err.message ? err.message : String(err);
  const code = (err && err.name === 'UsageError') ? 'USAGE' : ((err && err.code) || 'DOCKER_ERROR');
  if ((argv || []).includes('--json')) io.json({ error: { code, message } });
  io.errLine(`docker-manager: ${message}`);
  if (err && err.name === 'UsageError') io.errLine('Run "docker-manager --help" for usage.');
}

// A write callback fires only after everything queued before it has flushed,
// so an empty write is a drain.
function drainStdio(stream) {
  return new Promise((resolve) => {
    if (!stream) {
      resolve();
      return;
    }
    try {
      stream.write('', () => resolve());
    } catch {
      resolve();
    }
  });
}

async function main(argv = process.argv.slice(2)) {
  let code = 0;
  try {
    code = await run(argv);
  } catch (err) {
    code = exitCodeFor(err);
    reportError(err, argv);
  }
  // Pipes flush asynchronously: drain both streams before the hard exit so a
  // piped `--json` document is never truncated.
  await Promise.all([drainStdio(process.stdout), drainStdio(process.stderr)]);
  process.exit(code);
}

if (require.main === module) main();

module.exports = { parseArgv, exitCodeFor, UsageError, run, main, HELP };
