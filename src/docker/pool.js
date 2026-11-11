'use strict';

// One HostRuntime per configured host (design §3.4.1, §3.4.4, §3.4.5).
// Clients are built lazily on first use and rebuilt when the host entry's
// fingerprint changes. The 30 s health probe is the only unconditional timer
// and performs no writes. Emits 'deactivate'/'activate'/'resync' so stream
// owners can close and reopen their resources on host switches.

const { EventEmitter } = require('node:events');
const { buildClient, negotiate } = require('./client');
const { DockerError, mapDockerError } = require('./errors');
const metrics = require('../core/metrics');

const HEALTH_INTERVAL_MS = 30 * 1000;

function fingerprintHost(host, env) {
  return [
    host.access, host.socketPath, host.url, host.sshHost, host.sshUser, host.sshPort,
    host.tls && host.tls.ca, host.tls && host.tls.cert, host.tls && host.tls.key,
    env.sshAuthSock, env.dockerCertPath, env.dockerApiVersion
  ].join('|');
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new DockerError('DOCKER_UNREACHABLE', message)), ms);
      t.unref?.();
    })
  ]);
}

function createPool({ env, log, bus, store }) {
  const pool = new EventEmitter();
  const runtimes = new Map();
  let activeHostId = null;
  let selfId = null;
  let probeTimer = null;

  function runtimeFor(host) {
    let rt = runtimes.get(host.id);
    const fp = fingerprintHost(host, env);
    if (rt && rt.fingerprint !== fp) {
      pool.emit('deactivate', rt.id); // close old event subscription and log streams
      rt = undefined;
    }
    if (!rt) {
      rt = {
        id: host.id,
        name: host.name,
        access: host.access,
        managedByEnv: Boolean(host.managedByEnv),
        fingerprint: fp,
        client: null,
        apiVersion: null,
        maxApiVersion: null,
        engineVersion: null,
        state: 'connecting',
        lastError: null,
        lastCheckAt: 0
      };
      runtimes.set(host.id, rt);
    }
    rt.name = host.name;
    rt.managedByEnv = Boolean(host.managedByEnv);
    return rt;
  }

  async function ensure(rt, host) {
    if (rt.client && rt.state === 'reachable') return rt;
    if (!rt.client) {
      try {
        rt.client = buildClient(host, env);
      } catch (err) {
        const mapped = mapDockerError(err, { access: host.access });
        rt.state = mapped.code === 'DAEMON_TOO_OLD' ? 'too-old' : (mapped.code === 'DOCKER_SSH_AGENT_MISSING' ? 'unreachable' : 'error');
        rt.lastError = { code: mapped.code, message: mapped.message };
        throw mapped;
      }
    }
    try {
      const negotiated = await withTimeout(negotiate(rt.client, env), 5000, `Docker host ${rt.id} did not answer the version handshake.`);
      rt.apiVersion = negotiated.apiVersion;
      rt.maxApiVersion = negotiated.maxApiVersion;
      rt.engineVersion = negotiated.engineVersion;
      rt.state = 'reachable';
      rt.lastError = null;
    } catch (err) {
      const mapped = mapDockerError(err, { access: host.access });
      rt.state = mapped.code === 'DAEMON_TOO_OLD' ? 'too-old' : 'unreachable';
      rt.lastError = { code: mapped.code, message: mapped.message };
      throw mapped;
    }
    return rt;
  }

  function hostEntry(id) {
    const cfg = store.get();
    const host = cfg.hosts.find((h) => h.id === id);
    if (!host) throw new DockerError('HOST_NOT_FOUND', `No configured host with id ${id}.`);
    return host;
  }

  // The single funnel for daemon calls: counts requests, retries once after a
  // re-negotiation when the daemon rejects our pinned API version, and maps
  // every failure into the error taxonomy.
  async function withClient(id, fn, ctx = {}) {
    const host = hostEntry(id);
    const rt = runtimeFor(host);
    await ensure(rt, host);
    metrics.inc('docker', 'requests');
    try {
      return await fn(rt.client, rt);
    } catch (err) {
      const body = (err && err.json && err.json.message) || (err && err.message) || '';
      if (err && err.statusCode === 400 && /client version/i.test(body) && !ctx._renegotiated) {
        rt.client.modem.version = undefined; // fall back to unversioned paths and renegotiate
        await ensure(rt, host);
        return withClient(id, fn, { ...ctx, _renegotiated: true });
      }
      metrics.inc('docker', 'errors');
      throw mapDockerError(err, { access: host.access, ...ctx });
    }
  }

  function healthFrame(rt) {
    return {
      hostId: rt.id,
      name: rt.name,
      state: rt.state,
      apiVersion: rt.apiVersion,
      engineVersion: rt.engineVersion,
      error: rt.lastError
    };
  }

  async function probeHost(host) {
    const rt = runtimeFor(host);
    const previous = rt.state;
    try {
      if (!rt.client) await ensure(rt, host);
      await withTimeout(rt.client.ping(), 2000, `Docker host ${rt.id} ping timed out.`);
      if (rt.state !== 'reachable') await ensure(rt, host);
      rt.state = 'reachable';
      rt.lastError = null;
    } catch (err) {
      const mapped = mapDockerError(err, { access: host.access });
      rt.state = mapped.code === 'DAEMON_TOO_OLD' ? 'too-old' : 'unreachable';
      rt.lastError = { code: mapped.code, message: mapped.message };
    }
    rt.lastCheckAt = Date.now();
    if (rt.state !== previous) {
      log.info('host.health', { hostId: rt.id, state: rt.state });
      bus.publish('host.health', healthFrame(rt));
    }
    return rt;
  }

  function startProbing() {
    if (probeTimer) return;
    probeTimer = setInterval(() => {
      const hosts = store.get().hosts;
      for (const host of hosts) probeHost(host).catch(() => {});
    }, HEALTH_INTERVAL_MS);
    probeTimer.unref?.();
  }

  function syncHosts() {
    const cfg = store.get();
    const seen = new Set();
    for (const host of cfg.hosts) {
      seen.add(host.id);
      runtimeFor(host);
    }
    for (const id of [...runtimes.keys()]) {
      if (!seen.has(id)) {
        pool.emit('deactivate', id);
        runtimes.delete(id);
      }
    }
    if (activeHostId !== cfg.settings.activeHostId) {
      setActive(cfg.settings.activeHostId);
    }
  }

  function setActive(id) {
    const cfg = store.get();
    const host = cfg.hosts.find((h) => h.id === id);
    if (!host) throw new DockerError('HOST_NOT_FOUND', `No configured host with id ${id}.`);
    if (activeHostId === id) return id;
    const previous = activeHostId;
    activeHostId = id;
    if (previous) pool.emit('deactivate', previous);
    pool.emit('activate', id);
    pool.emit('resync', 'host-changed');
    log.info('host.health', { hostId: id, state: 'active' });
    return id;
  }

  function activeHost() {
    return activeHostId ? runtimes.get(activeHostId) : null;
  }

  function localSocketHost() {
    const cfg = store.get();
    const host = cfg.hosts.find((h) => h.access === 'socket');
    return host ? runtimes.get(host.id) : null;
  }

  async function close() {
    if (probeTimer) clearInterval(probeTimer);
    probeTimer = null;
    for (const id of [...runtimes.keys()]) pool.emit('deactivate', id);
    runtimes.clear();
  }

  pool.runtimes = runtimes;
  pool.hostEntry = hostEntry;
  pool.runtimeFor = runtimeFor;
  pool.ensure = ensure;
  pool.withClient = withClient;
  pool.probeHost = probeHost;
  pool.startProbing = startProbing;
  pool.syncHosts = syncHosts;
  pool.setActive = setActive;
  pool.activeHost = activeHost;
  pool.activeHostId = () => activeHostId;
  pool.localSocketHost = localSocketHost;
  pool.healthFrame = healthFrame;
  pool.close = close;
  pool.getSelfId = () => selfId;
  pool.setSelfId = (id) => { selfId = id; };
  return pool;
}

module.exports = { createPool, HEALTH_INTERVAL_MS };
