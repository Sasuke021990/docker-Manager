'use strict';

// Compose job runner (design §3.8.3, §3.8.4, FR-073–FR-078).
// Spawns `docker compose` with argv array, shell:false, streamed output.
// One job at a time globally; output ring kept for late-connecting clients.

const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const { openSse } = require('../web/sse');
const { ComposeError } = require('./pathguard');

const JOB_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 5000;
const MAX_OUTPUT_LINES = 2000;

function stripAnsi(s) {
  // Defensive: --ansi never is requested, but strip residual ESC sequences.
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

function splitLines(carry, chunk) {
  const text = carry + String(chunk);
  const parts = text.split(/\r?\n/);
  const nextCarry = parts.pop() ?? '';
  return { lines: parts, carry: nextCarry };
}

function createComposeRunner({ env, store: _store, pool, log, probe, activity, bus, resolveProject }) {
  let current = null; // { id, projectId, projectName, action, startedAt, emitter, lines, done, exitCode, error, child }
  let last = null;   // most recent finished job, kept so late readers (CLI) can poll the result

  function busyError() {
    return new ComposeError('COMPOSE_BUSY', `Another compose job is running (${current ? current.projectName : 'unknown'}).`, {
      action: 'compose',
      project: current ? current.projectName : null,
      jobId: current ? current.id : null
    });
  }

  function buildEnv(project) {
    const e = { PATH: process.env.PATH || '', HOME: '/tmp' };
    // Forward Docker host context needed to reach the daemon. For SSH hosts the
    // compose CLI must reach the remote daemon and needs the agent socket.
    const dockerHost = process.env.DOCKER_HOST || env.dockerHost || '';
    if (dockerHost) e.DOCKER_HOST = dockerHost;
    if (project && project.access === 'ssh') {
      const sock = env.sshAuthSock || process.env.SSH_AUTH_SOCK;
      if (sock) e.SSH_AUTH_SOCK = sock;
    }
    return e;
  }

  async function isSelfProject(project) {
    const selfId = pool.getSelfId && pool.getSelfId();
    if (!selfId) return false;
    if (!project || !Array.isArray(project.services)) return false;
    const prefix = String(selfId).slice(0, 12);
    return project.services.some((s) => s.containerId && (s.containerId === selfId || String(s.containerId).startsWith(prefix)));
  }

  async function checkMixedOwnership(hostId, project, targetFile) {
    if (!project || !Array.isArray(project.services) || !targetFile) return false;
    let targetReal = targetFile;
    try { targetReal = await fs.realpath(targetFile); } catch { /* ignore */ }
    for (const s of project.services) {
      const cf = s.configFile;
      if (!cf) continue;
      try {
        const real = await fs.realpath(cf);
        if (real !== targetReal) return true;
      } catch {
        // missing reported file: treat as mismatch only if different string
        if (cf !== targetFile) return true;
      }
    }
    return false;
  }

  async function start({ hostId, projectId, action, confirmMixed = false, access = null }) {
    if (action !== 'up' && action !== 'down') {
      throw new ComposeError('BAD_REQUEST', 'Compose action must be "up" or "down".', { action: 'compose' });
    }
    if (current && !current.done) throw busyError();

    const probeState = await probe.get();
    if (probeState.state === 'missing' || probeState.state === 'cli-missing') {
      throw new ComposeError('COMPOSE_UNAVAILABLE', probeState.message || 'The docker compose plugin is not available.', { action: 'compose' });
    }

    const project = await resolveProject(hostId, projectId);
    if (!project) {
      throw new ComposeError('CONTAINER_NOT_FOUND', `Unknown compose project "${projectId}".`, { action: 'compose' });
    }
    if (!project.absFile) {
      if (project.reason) throw new ComposeError('COMPOSE_OUTSIDE_ROOT', project.reason, { action: 'compose' });
      throw new ComposeError('COMPOSE_OUTSIDE_ROOT', 'Compose file not in /compose — manage with docker compose on the host.', { action: 'compose' });
    }

    if (action === 'down' && await isSelfProject(project)) {
      throw new ComposeError('SELF_PROJECT', 'This project contains Docker Manager itself. Running compose down here would stop the app. Run it on the host instead.', { action: 'compose-down', project: project.name });
    }

    if (action === 'down' && !confirmMixed) {
      const mixed = await checkMixedOwnership(hostId, project, project.absFile);
      if (mixed) {
        throw new ComposeError('COMPOSE_MIXED_PROJECT', 'This project contains containers not created by this Compose file.', { action: 'compose-down', project: project.name });
      }
    }

    const dir = project.dir;
    const file = project.absFile;
    const args = action === 'up'
      ? ['compose', '--ansi', 'never', '--progress', 'plain', '--project-directory', dir, '-f', file, 'up', '-d', '--remove-orphans']
      : ['compose', '--ansi', 'never', '--progress', 'plain', '--project-directory', dir, '-f', file, 'down', '--remove-orphans'];

    const id = randomUUID();
    const emitter = new EventEmitter();
    emitter.setMaxListeners(50);
    const job = {
      id, projectId, projectName: project.name, action, startedAt: Date.now(),
      emitter, lines: [], done: false, exitCode: null, error: null, child: null,
      stdoutCarry: '', stderrCarry: ''
    };
    current = job;

    const pushLine = (stream, line) => {
      const clean = stripAnsi(line);
      const entry = { t: 'out', stream, line: clean };
      job.lines.push(entry);
      if (job.lines.length > MAX_OUTPUT_LINES) job.lines.splice(0, job.lines.length - MAX_OUTPUT_LINES);
      emitter.emit('out', entry);
    };

    let child;
    try {
      child = spawn('docker', args, {
        cwd: dir,
        env: buildEnv({ ...project, access }),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true
      });
    } catch (err) {
      current = null;
      if (err && err.code === 'ENOENT') {
        probe.markMissing('The docker binary is not installed in this container.');
        throw new ComposeError('COMPOSE_UNAVAILABLE', 'The docker binary is not installed in this container.', { action: 'compose' });
      }
      throw new ComposeError('COMPOSE_UNAVAILABLE', err.message || 'Could not start docker compose.', { action: 'compose' });
    }
    job.child = child;

    if (activity) activity.append({ action: `compose ${action}`, container: project.name, containerId: projectId, result: 'ok', state: 'running' });
    log.info('compose.start', { jobId: id, project: project.name, action });

    const timeout = setTimeout(() => {
      if (job.done) return;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, KILL_GRACE_MS).unref?.();
      job.error = { code: 'COMPOSE_TIMEOUT', message: 'Compose job timed out after 10 minutes.' };
    }, JOB_TIMEOUT_MS);
    timeout.unref && timeout.unref();

    const onChunk = (stream) => (chunk) => {
      const key = stream === 'stdout' ? 'stdoutCarry' : 'stderrCarry';
      const { lines, carry } = splitLines(job[key], chunk);
      job[key] = carry;
      for (const line of lines) pushLine(stream, line);
    };
    child.stdout.on('data', onChunk('stdout'));
    child.stderr.on('data', onChunk('stderr'));

    child.on('error', (err) => {
      if (job.done) return;
      clearTimeout(timeout);
      job.done = true;
      job.exitCode = null;
      const msg = err.message || 'Compose failed to start.';
      job.error = { code: err.code === 'ENOENT' ? 'COMPOSE_UNAVAILABLE' : 'COMPOSE_FAILED', message: msg };
      if (err.code === 'ENOENT') probe.markMissing('The docker binary is not installed in this container.');
      const frame = { t: 'error', code: job.error.code, message: job.error.message };
      job.result = frame; // retained for late readers (CLI waits on this)
      emitter.emit('done', frame);
      if (activity) activity.append({ action: `compose ${action}`, container: project.name, containerId: projectId, result: 'failed', message: msg });
      last = job;
      current = null;
    });

    child.on('close', (code, signal) => {
      if (job.done) return;
      clearTimeout(timeout);
      // flush carries
      if (job.stdoutCarry) pushLine('stdout', job.stdoutCarry);
      if (job.stderrCarry) pushLine('stderr', job.stderrCarry);
      job.done = true;
      job.exitCode = typeof code === 'number' ? code : (signal ? 128 : 1);
      job.durationMs = Date.now() - job.startedAt;
      if (job.error && job.error.code === 'COMPOSE_TIMEOUT') {
        job.result = { t: 'error', code: 'COMPOSE_TIMEOUT', message: job.error.message };
        emitter.emit('done', job.result);
        if (activity) activity.append({ action: `compose ${action}`, container: project.name, containerId: projectId, result: 'failed', message: job.error.message });
      } else if (job.exitCode !== 0) {
        // A "not a docker command" signature flips probe state (design §3.8.5).
        const allErr = job.lines.filter((l) => l.stream === 'stderr').map((l) => l.line).join('\n');
        if (/is not a docker command/i.test(allErr)) probe.markMissing('The docker compose plugin is not installed in this container.');
        job.result = { t: 'exit', code: job.exitCode, durationMs: job.durationMs };
        emitter.emit('done', job.result);
        if (activity) activity.append({ action: `compose ${action}`, container: project.name, containerId: projectId, result: 'failed', message: `exit ${job.exitCode}` });
      } else {
        job.result = { t: 'exit', code: 0, durationMs: job.durationMs };
        emitter.emit('done', job.result);
        if (activity) activity.append({ action: `compose ${action}`, container: project.name, containerId: projectId, result: 'ok', state: 'done' });
      }
      log.info('compose.exit', { jobId: id, project: project.name, action, code: job.exitCode, durationMs: job.durationMs });
      last = job;
      current = null;
      // trigger a resync so stack containers refresh
      if (bus) bus.publish('docker.event', { at: Date.now(), action: 'compose', raw: { Action: `compose-${action}` } });
    });

    return { jobId: id, streamUrl: `/api/compose/${id}/stream` };
  }

  function getJob(jobId) {
    if (current && current.id === jobId) return current;
    if (last && last.id === jobId) return last;
    return null;
  }

  function streamJob(req, res, jobId) {
    const job = getJob(jobId);
    if (!job) return null;
    const stream = openSse(req, res, { heartbeat: true });
    if (!stream) return null;
    // Replay buffered output so late connectors see the start.
    for (const line of job.lines) stream.sendT(line);
    if (job.done) {
      if (job.error && job.error.code === 'COMPOSE_TIMEOUT') stream.sendT({ t: 'error', code: job.error.code, message: job.error.message });
      else if (job.error) stream.sendT({ t: 'error', code: job.error.code, message: job.error.message });
      else stream.sendT({ t: 'exit', code: job.exitCode, durationMs: job.durationMs || 0 });
      stream.close();
      return stream;
    }
    const onOut = (entry) => stream.sendT(entry);
    const onDone = (frame) => {
      stream.sendT(frame);
      stream.close();
    };
    job.emitter.on('out', onOut);
    job.emitter.once('done', onDone);
    req.on('close', () => {
      job.emitter.off('out', onOut);
      job.emitter.off('done', onDone);
      // Client disconnect does not kill the job (design §3.8.4).
    });
    return stream;
  }

  function status() {
    return current && !current.done ? { busy: true, jobId: current.id, project: current.projectName, action: current.action } : { busy: false };
  }

  async function stop() {
    if (current && current.child && !current.done) {
      try { current.child.kill('SIGTERM'); } catch { /* ignore */ }
    }
  }

  return { start, getJob, streamJob, status, stop };
}

module.exports = { createComposeRunner };
