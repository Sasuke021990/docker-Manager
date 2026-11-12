'use strict';

// Live container stats sampler (design §3.7, FR-050, FR-051, AC-008).
// One sampler per container shared by all subscribers; one `stats?stream=false`
// poll per interval regardless of subscriber count. Stats are read-only — this
// module never mutates daemon state.

const { openSse } = require('../web/sse');
const { DockerError, mapDockerError } = require('./errors');

const STOP_GRACE_MS = 5000;
const DEFAULT_INTERVAL_MS = 2000;

function clampInterval(ms) {
  const n = Number.isFinite(ms) ? ms : DEFAULT_INTERVAL_MS;
  return Math.min(10000, Math.max(500, n));
}

function sumBlock(blkio) {
  const rows = (blkio && blkio.io_service_bytes_recursive) || [];
  let read = 0;
  let write = 0;
  for (const e of rows) {
    if (e.op === 'Read' || e.op === 'read') read += e.value || 0;
    if (e.op === 'Write' || e.op === 'write') write += e.value || 0;
  }
  return { read, write };
}

function sumNet(networks) {
  let rx = 0;
  let tx = 0;
  for (const iface of Object.values(networks || {})) {
    rx += (iface && iface.rx_bytes) || 0;
    tx += (iface && iface.tx_bytes) || 0;
  }
  return { rx, tx };
}

function derive(sample) {
  const cpuStats = sample.cpu_stats || {};
  const preCpu = sample.precpu_stats || {};
  const mem = sample.memory_stats || {};
  const cpuUsage = cpuStats.cpu_usage || {};
  const preUsage = preCpu.cpu_usage || {};

  const cpuDelta = (cpuUsage.total_usage || 0) - (preUsage.total_usage || 0);
  const sysDelta = (cpuStats.system_cpu_usage || 0) - (preCpu.system_cpu_usage || 0);
  const online = cpuStats.online_cpus || (Array.isArray(cpuUsage.percpu_usage) ? cpuUsage.percpu_usage.length : 0) || 1;
  const cpuPct = sysDelta > 0 && cpuDelta >= 0 ? (cpuDelta / sysDelta) * online * 100 : null;

  const cache = (mem.stats && (mem.stats.inactive_file ?? mem.stats.cache)) ?? 0;
  const memUsed = typeof mem.usage === 'number' ? Math.max(0, mem.usage - cache) : null;
  const memLimit = typeof mem.limit === 'number' && mem.limit > 0 ? mem.limit : null;
  const pids = (sample.pids_stats && sample.pids_stats.current) ?? null;

  return {
    cpuPct: typeof cpuPct === 'number' && Number.isFinite(cpuPct) ? Math.max(0, cpuPct) : null,
    memUsed,
    memLimit,
    net: sumNet(sample.networks),
    block: sumBlock(sample.blkio_stats),
    pids
  };
}

function createStatsService({ pool, store, log }) {
  const samplers = new Map(); // key `${hostId}\0${containerId}` -> sampler

  function key(hostId, containerId) {
    return `${hostId}\0${containerId}`;
  }

  function intervalMs() {
    return clampInterval(store.get().settings.statsIntervalMs);
  }

  function stopSampler(s) {
    if (s.timer) clearInterval(s.timer);
    if (s.grace) clearTimeout(s.grace);
    s.timer = null;
    s.grace = null;
  }

  async function poll(s) {
    if (s.subscribers.size === 0) return;
    if (s.polling) return;
    s.polling = true;
    try {
      // Only running containers are sampled (FR-051). Inspect state cheaply via
      // the daemon stats call result? No: stats?stream=false is the sampler's
      // read; if the container stopped the call fails and we report state.
      const sample = await pool.withClient(s.hostId, (client) => client.getContainer(s.containerId).stats({ stream: false }));
      const derived = derive(sample || {});
      const payload = { t: 'sample', ts: Date.now(), ...derived };
      s.lastSample = payload;
      for (const sub of s.subscribers) {
        if (!sub.closed) sub.sendT(payload);
      }
    } catch (err) {
      const mapped = err instanceof DockerError ? err : mapDockerError(err, { action: 'stats', containerId: s.containerId });
      // A stopped/non-running container must not keep being polled; surface a
      // state frame and halt the sampler (FR-051).
      const msg = mapped.message || '';
      const stopped = mapped.code === 'CONTAINER_NOT_FOUND'
        || mapped.code === 'CONTAINER_STATE_CONFLICT'
        || /not running|is not running|is paused|No such container/i.test(msg);
      const frame = stopped
        ? { t: 'state', state: 'stopped', message: 'Stopped — stats are not sampled.' }
        : { t: 'error', code: mapped.code, message: mapped.message };
      for (const sub of s.subscribers) {
        if (!sub.closed) sub.sendT(frame);
        if (stopped && !sub.closed) sub.close();
      }
      if (stopped) {
        s.subscribers.clear();
        stopSampler(s);
        samplers.delete(s.key);
      }
      // Transient errors: keep the sampler alive for the next tick so the panel
      // can show "stats paused" / retry client-side without killing the sampler
      // for other subscribers; but we do not auto-retry the SSE here (design:
      // client closes on error).
      if (!stopped) {
        log.debug('stats.poll', { hostId: s.hostId, containerId: s.containerId, code: mapped.code });
      }
    } finally {
      s.polling = false;
    }
  }

  function ensureSampler(hostId, containerId) {
    const k = key(hostId, containerId);
    let s = samplers.get(k);
    if (s) return s;
    s = {
      key: k,
      hostId,
      containerId,
      subscribers: new Set(),
      timer: null,
      grace: null,
      polling: false,
      lastSample: null
    };
    samplers.set(k, s);
    return s;
  }

  function maybeStart(s) {
    if (s.grace) {
      clearTimeout(s.grace);
      s.grace = null;
    }
    if (!s.timer) {
      // First sample immediately, then on the configured cadence.
      poll(s).catch(() => {});
      s.timer = setInterval(() => poll(s).catch(() => {}), intervalMs());
      s.timer.unref && s.timer.unref();
    }
  }

  function scheduleStop(s) {
    if (s.subscribers.size > 0) return;
    if (s.grace) return;
    s.grace = setTimeout(() => {
      s.grace = null;
      if (s.subscribers.size === 0) {
        stopSampler(s);
        samplers.delete(s.key);
      }
    }, STOP_GRACE_MS);
    s.grace.unref && s.grace.unref();
  }

  function subscribe(hostId, containerId, stream) {
    const s = ensureSampler(hostId, containerId);
    s.subscribers.add(stream);
    maybeStart(s);
    // If we already have a sample, send it immediately so the panel doesn't
    // wait a full interval.
    if (s.lastSample && !stream.closed) stream.sendT(s.lastSample);
    const remove = () => {
      s.subscribers.delete(stream);
      scheduleStop(s);
    };
    stream._onStatsClose = remove;
    return remove;
  }

  function streamStats(req, res, hostId, containerId) {
    const stream = openSse(req, res, { heartbeat: true });
    if (!stream) return null;
    const unsub = subscribe(hostId, containerId, stream);
    req.on('close', () => {
      unsub();
    });
    return stream;
  }

  function closeHost(hostId) {
    for (const [k, s] of samplers) {
      if (s.hostId !== hostId) continue;
      for (const sub of s.subscribers) {
        try { sub.sendT({ t: 'state', state: 'stopped', message: 'Host changed — stats stopped.' }); } catch { /* ignore */ }
        try { sub.close(); } catch { /* ignore */ }
      }
      s.subscribers.clear();
      stopSampler(s);
      samplers.delete(k);
    }
  }

  function closeAll() {
    for (const k of [...samplers.keys()]) {
      const s = samplers.get(k);
      if (!s) continue;
      for (const sub of s.subscribers) {
        try { sub.close(); } catch { /* ignore */ }
      }
      s.subscribers.clear();
      stopSampler(s);
      samplers.delete(k);
    }
  }

  return { derive, streamStats, subscribe, closeHost, closeAll, _samplers: samplers };
}

module.exports = { createStatsService, derive, sumNet, sumBlock, clampInterval };
