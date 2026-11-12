'use strict';

// Container action layer (FR-020…FR-031). This is the only module allowed to
// issue mutating Docker calls, and every entry point is an explicit operator
// request (POST/DELETE behind CSRF) — nothing runs on a schedule, on a
// heuristic, or without a request (FR-027, AC-014).
//
// Self-container verbs are refused except unpause, so a paused self can be
// recovered (SEC-008, SN-09). Remove never passes `--volumes` and never
// touches images (design §7.6.2: the "kept" line is true).

const { DockerError, mapDockerError } = require('./errors');
const { assertNotSelf } = require('./self');

// The verb set of POST /api/containers/:id/actions/:verb (design §4.2.2).
const VERBS = new Set(['start', 'stop', 'restart', 'kill', 'pause', 'unpause']);

function containerName(inspect) {
  return (inspect.Name || '').replace(/^\//, '') || (inspect.Id || '').slice(0, 12);
}

function createActions({ env, pool, store, queries, activity, log }) {
  function stopTimeout() {
    return store.get().settings.stopTimeoutSeconds; // FR-021, default 10 s
  }

  function inspectOne(hostId, containerId) {
    return pool.withClient(hostId, (client) => client.getContainer(containerId).inspect());
  }

  function record(entry) {
    if (activity) activity.append(entry); // FR-031: last 100 in memory
  }

  // Map a thrown error; `null` means 304 "already in the desired state",
  // which the daemon reports but which is not a failure for an operator.
  function mapOrNull(err, ctx) {
    return err instanceof DockerError ? err : mapDockerError(err, ctx);
  }

  // Optional per-request overrides from the CLI's --timeout/--signal
  // (design §3.10.1). The web routes never pass them, so the configured
  // stopTimeoutSeconds stays the only source of the web timeout.
  function timeoutOf(opts) {
    return Number.isInteger(opts.timeoutSeconds)
      ? Math.min(300, Math.max(0, opts.timeoutSeconds))
      : stopTimeout();
  }

  async function run(hostId, containerId, verb, opts = {}) {
    if (!VERBS.has(verb)) {
      throw new DockerError('BAD_REQUEST', `Unknown action "${verb}". Allowed: ${[...VERBS].join(', ')}.`, { action: verb, containerId });
    }
    const started = Date.now();
    let name = String(containerId).slice(0, 12);
    try {
      const inspect = await inspectOne(hostId, containerId);
      name = containerName(inspect);
      assertNotSelf(pool, env, inspect.Id, name, verb); // SEC-008 (unpause exempt)
      try {
        await pool.withClient(hostId, (client) => {
          const c = client.getContainer(inspect.Id);
          switch (verb) {
            case 'start': return c.start();
            case 'stop': return c.stop({ t: timeoutOf(opts) }); // SIGTERM → SIGKILL
            case 'restart': return c.restart({ t: timeoutOf(opts) });
            case 'kill': return opts.signal ? c.kill({ signal: opts.signal }) : c.kill(); // default SIGKILL
            case 'pause': return c.pause();
            case 'unpause': return c.unpause();
            default: return null;
          }
        });
      } catch (err) {
        const mapped = mapOrNull(err, { action: verb, containerId: inspect.Id });
        if (mapped) throw mapped;
        // 304: already stopped/started/etc. — outcome success, state below.
      }
      queries.invalidate(inspect.Id);
      const after = await inspectOne(hostId, inspect.Id);
      const state = (after && after.State && after.State.Status) || null;
      record({ action: verb, container: name, containerId: inspect.Id, result: 'ok', state });
      log.info('container.action', { verb, container: name, containerId: inspect.Id, state, durationMs: Date.now() - started });
      return { ok: true, state }; // design §4.2.2: {ok, state}
    } catch (err) {
      const mapped = err instanceof DockerError ? err : mapOrNull(err, { action: verb, containerId });
      record({ action: verb, container: name, containerId, result: 'failed', message: mapped.message });
      throw mapped;
    }
  }

  // FR-024/FR-025: remove. For a running container the UI must choose:
  // `mode: 'stop'` stops gracefully first (FR-021 timeout), `mode: 'force'`
  // passes force. With no mode on a running container the daemon's 409 is
  // returned verbatim as CONTAINER_STATE_CONFLICT.
  async function remove(hostId, containerId, { mode } = {}) {
    const started = Date.now();
    let name = String(containerId).slice(0, 12);
    try {
      const inspect = await inspectOne(hostId, containerId);
      name = containerName(inspect);
      assertNotSelf(pool, env, inspect.Id, name, 'rm'); // SEC-008
      const running = inspect.State && inspect.State.Status === 'running';
      await pool.withClient(hostId, async (client) => {
        const c = client.getContainer(inspect.Id);
        if (mode === 'stop' && running) await c.stop({ t: stopTimeout() });
        return c.remove({ v: false, force: mode === 'force' }); // never --volumes
      });
      queries.invalidate(inspect.Id);
      record({ action: 'remove', container: name, containerId: inspect.Id, result: 'ok', state: null });
      log.info('container.action', { verb: 'rm', container: name, containerId: inspect.Id, mode: mode || 'plain', durationMs: Date.now() - started });
      return { ok: true }; // design §4.2.2: {ok}
    } catch (err) {
      const mapped = err instanceof DockerError ? err : mapOrNull(err, { action: 'rm', containerId });
      record({ action: 'remove', container: name, containerId, result: 'failed', message: mapped.message });
      throw mapped;
    }
  }

  return { run, remove, VERBS };
}

module.exports = { createActions, VERBS };
