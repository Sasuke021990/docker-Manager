'use strict';

// Compose service (design §3.8). Ties discovery, probe and runner together and
// keeps the project-id map that routes resolve against (server-side only).

const { createComposeProbe } = require('./probe');
const { createDiscovery } = require('./discovery');
const { createComposeRunner } = require('./runner');
const { ComposeError } = require('./pathguard');

function createComposeService({ env, store, pool, log, activity, bus }) {
  const probe = createComposeProbe({ env, log });
  const discovery = createDiscovery({ pool, store });
  let lastMap = new Map(); // id -> stack record
  let lastResult = null;
  let lastAt = 0;
  const CACHE_MS = 2000;

  async function list(hostId, { force = false } = {}) {
    const now = Date.now();
    if (!force && lastResult && lastResult.hostId === hostId && (now - lastAt) < CACHE_MS) {
      return lastResult;
    }
    const result = await discovery.discover(hostId);
    const map = new Map();
    for (const s of result.stacks) map.set(s.id, s);
    lastMap = map;
    lastResult = { hostId, stacks: result.stacks, root: result.root, folder: result.folder, rootError: result.rootError };
    lastAt = now;
    return lastResult;
  }

  async function resolveProject(hostId, projectId) {
    if (!lastResult || lastResult.hostId !== hostId || !lastMap.has(projectId)) {
      await list(hostId, { force: true });
    }
    return lastMap.get(projectId) || null;
  }

  const runner = createComposeRunner({
    env, store, pool, log, probe, activity, bus,
    resolveProject
  });

  function publicStack(s) {
    return {
      id: s.id,
      name: s.name,
      services: s.services.map((svc) => ({
        containerId: svc.containerId,
        name: svc.name,
        service: svc.service,
        state: svc.state,
        status: svc.status,
        image: svc.image
      })),
      serviceCount: s.serviceCount,
      states: s.states,
      runnable: s.runnable,
      file: s.file,
      reason: s.reason
    };
  }

  async function listPublic(hostId, opts) {
    const r = await list(hostId, opts);
    const p = await probe.get();
    return {
      stacks: r.stacks.map(publicStack),
      folder: r.folder,
      rootError: r.rootError,
      compose: { state: p.state, version: p.version, message: p.message },
      busy: runner.status()
    };
  }

  async function run(hostId, projectId, action, opts) {
    // Resolve host access for SSH env forwarding.
    let access = null;
    try {
      const host = pool.hostEntry(hostId);
      access = host.access;
    } catch { /* ignore */ }
    return runner.start({ hostId, projectId, action, access, ...opts });
  }

  return {
    probe,
    list,
    listPublic,
    resolveProject,
    run,
    runner,
    invalidate: () => { lastAt = 0; }
  };
}

module.exports = { createComposeService, ComposeError };
