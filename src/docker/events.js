'use strict';

// Docker /events subscription per active host (design §3.5).
// Normalises events, feeds the bus + a 500-event ring, drives reactive reads
// (monitor: debounce per container → inspect → container.upsert/remove), and
// reconnects with 1/2/5/10/30 s backoff and full reconcile on live.

const { EventEmitter } = require('node:events');
const { mapDockerError } = require('./errors');

const BACKOFF = [1000, 2000, 5000, 10000, 30000];
const STABLE_MS = 10000;
const CONNECT_TIMEOUT_MS = 30000;
const RING_CAP = 500;
const DEBOUNCE_MS = 150;

const ATTR_ALLOW = new Set([
  'exitCode', 'signal', 'name', 'image',
  'com.docker.compose.project', 'com.docker.compose.service'
]);

function parseHealth(action) {
  if (typeof action !== 'string') return null;
  const i = action.indexOf('health_status:');
  if (i < 0) return null;
  const v = action.slice(i + 'health_status:'.length).trim();
  return v || null;
}

function baseAction(action) {
  if (typeof action !== 'string') return '';
  const i = action.indexOf(':');
  return i >= 0 ? action.slice(0, i) : action;
}

function normalise(raw, hostId) {
  const attr = (raw && raw.Actor && raw.Actor.Attributes) || {};
  const attributes = {};
  for (const k of Object.keys(attr)) {
    if (ATTR_ALLOW.has(k)) attributes[k] = attr[k];
  }
  const name = (attr.name || '').replace(/^\//, '') || (raw && raw.Actor && raw.Actor.ID ? raw.Actor.ID.slice(0, 12) : '');
  const image = attr.image || (raw && raw.from) || null;
  return {
    hostId,
    at: typeof raw.timeNano === 'number' ? raw.timeNano / 1e9 : (raw.time || Date.now() / 1000),
    type: raw.Type || 'container',
    action: baseAction(raw.Action),
    rawAction: raw.Action || '',
    containerId: (raw.Actor && raw.Actor.ID) || raw.id || '',
    name,
    image,
    attributes,
    health: parseHealth(raw.Action)
  };
}

class EventRing {
  constructor(cap = RING_CAP) {
    this.cap = cap;
    this.events = [];
  }
  push(ev) {
    this.events.push(ev);
    if (this.events.length > this.cap) this.events.shift();
  }
  since(seq) {
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return null;
    const idx = this.events.findIndex((e) => e.seq > seq);
    if (idx < 0) return this.events.length && this.events[this.events.length - 1].seq <= seq ? [] : null;
    // if requested seq is older than anything we have, gap
    if (idx === 0 && this.events[0].seq > seq + 1) return null;
    return this.events.slice(idx);
  }
  list(limit = 500) {
    return this.events.slice(-Math.min(limit, this.cap));
  }
  clear() { this.events.length = 0; }
}

function createEventService({ pool, bus, queries, store: _store, log }) {
  const svc = new EventEmitter();
  const rings = new Map(); // hostId -> EventRing
  const subs = new Map();  // hostId -> subscription state
  let active = null;

  function ring(hostId) {
    let r = rings.get(hostId);
    if (!r) { r = new EventRing(RING_CAP); rings.set(hostId, r); }
    return r;
  }

  function stop(hostId) {
    const sub = subs.get(hostId);
    if (!sub) return;
    sub.stopped = true;
    try { sub.stream && sub.stream.destroy(); } catch { /* ignore */ }
    if (sub.timer) clearTimeout(sub.timer);
    if (sub.stableTimer) clearTimeout(sub.stableTimer);
    subs.delete(hostId);
  }

  function publishHealth(hostId, state, error) {
    const rt = pool.runtimes && pool.runtimes.get(hostId);
    bus.publish('host.health', {
      hostId,
      state,
      apiVersion: rt ? rt.apiVersion : null,
      engineVersion: rt ? rt.engineVersion : null,
      error: error || null
    });
  }

  async function reconcile(hostId, reason) {
    try {
      const data = await queries.listContainers(hostId);
      bus.publish('docker.event', { synthetic: true, action: 'resync', reason });
      // emit a bus-level resync so stream clients refetch
      svc.emit('resync', { hostId, reason, rows: data.rows, counts: data.counts, host: data.host });
    } catch (err) {
      log.warn('events.reconcile_failed', { hostId, message: err && err.message });
    }
  }

  function scheduleUpsert(hostId, containerId, reason) {
    const sub = subs.get(hostId);
    if (!sub) return;
    const key = containerId || reason || '*';
    if (sub.pending.has(key)) return;
    const t = setTimeout(async () => {
      sub.pending.delete(key);
      try {
        if (reason === 'destroy') {
          queries.invalidate(containerId);
          bus.publish('docker.event', { hostId, action: 'container.remove', containerId });
          svc.emit('container.remove', { hostId, containerId });
          return;
        }
        queries.invalidate(containerId);
        const detail = await queries.getContainer(hostId, containerId);
        const row = {
          id: detail.id, idShort: detail.idShort, name: detail.name,
          image: detail.image, imageId: detail.imageId, state: detail.state,
          status: detail.status, health: detail.health, exitCode: detail.exitCode,
          restarts: detail.restarts, created: detail.created, startedAt: detail.startedAt,
          uptimeSec: detail.uptimeSec, ports: detail.ports, compose: detail.compose,
          self: detail.self, hasNote: detail.note && detail.note.status !== 'none',
          partial: false
        };
        svc.emit('container.upsert', { hostId, row });
      } catch (err) {
        const mapped = mapDockerError(err, { action: 'events-inspect' });
        if (mapped && mapped.code === 'CONTAINER_NOT_FOUND') {
          queries.invalidate(containerId);
          svc.emit('container.remove', { hostId, containerId });
        } else {
          log.debug('events.inspect_failed', { hostId, containerId, message: err && err.message });
        }
      }
    }, DEBOUNCE_MS);
    sub.pending.set(key, t);
  }

  function handleRaw(hostId, raw) {
    if (!raw || raw.Type !== 'container') return;
    const ev = normalise(raw, hostId);
    // Assign one seq at ingest (design §3.5.3): ring, bus, SSE id all agree.
    const seq = bus.nextSeq();
    ev.seq = seq;
    ring(hostId).push(ev);
    bus.emit('docker.event', { seq, ...ev }); // channel payload shape
    svc.emit('docker.event', ev);

    const act = ev.action;
    if (act === 'destroy') {
      scheduleUpsert(hostId, ev.containerId, 'destroy');
    } else if (['create', 'start', 'die', 'stop', 'kill', 'restart', 'pause', 'unpause', 'rename', 'oom', 'health_status', 'update'].includes(act)) {
      scheduleUpsert(hostId, ev.containerId, act);
    }
  }

  async function start(hostId) {
    if (subs.has(hostId)) return;
    active = hostId;
    const state = { hostId, attempt: 0, failures: 0, stopped: false, stream: null, timer: null, stableTimer: null, pending: new Map(), carry: '' };
    subs.set(hostId, state);
    connect(state);
  }

  async function connect(state) {
    if (state.stopped) return;
    publishHealth(state.hostId, state.attempt === 0 ? 'connecting' : 'reconnecting');
    let timedOut = false;
    const to = setTimeout(() => {
      timedOut = true;
      try { state.stream && state.stream.destroy(); } catch { /* ignore */ }
    }, CONNECT_TIMEOUT_MS);
    to.unref && to.unref();
    try {
      const client = await pool.withClient(state.hostId, (c) => c);
      const stream = await client.getEvents({ filters: { type: ['container'] } });
      if (state.stopped) { clearTimeout(to); try { stream.destroy(); } catch { /* ignore */ } return; }
      clearTimeout(to);
      state.stream = stream;
      state.carry = '';
      // first byte/frame means live
      let wentLive = false;
      const becomeLive = (afterReconnect) => {
        if (wentLive) return;
        wentLive = true;
        publishHealth(state.hostId, 'reachable');
        // reset backoff only after 10 s of stability
        state.stableTimer = setTimeout(() => {
          state.attempt = 0;
          state.failures = 0;
        }, STABLE_MS);
        state.stableTimer.unref && state.stableTimer.unref();
        if (afterReconnect) {
          svc.emit('resync', { hostId: state.hostId, reason: 'reconnect' });
          reconcile(state.hostId, 'reconnect').catch(() => {});
        }
      };

      stream.on('data', (chunk) => {
        if (state.stopped) return;
        if (!wentLive) becomeLive(state.failures > 0 || state.attempt > 0);
        const text = state.carry + chunk.toString('utf8');
        const parts = text.split('\n');
        state.carry = parts.pop() || '';
        for (const line of parts) {
          if (!line.trim()) continue;
          try {
            handleRaw(state.hostId, JSON.parse(line));
          } catch {
            // malformed: count, do not throw
          }
        }
      });

      const onEnd = (err) => {
        if (state.stopped) return;
        clearTimeout(to);
        if (state.stableTimer) clearTimeout(state.stableTimer);
        try { stream.destroy(); } catch { /* ignore */ }
        state.stream = null;
        state.failures += 1;
        state.attempt += 1;
        const delay = BACKOFF[Math.min(state.attempt - 1, BACKOFF.length - 1)];
        const label = state.failures >= 2 ? 'unreachable' : 'reconnecting';
        publishHealth(state.hostId, label, err ? { code: 'DOCKER_UNREACHABLE', message: err.message || String(err) } : null);
        log.info('events.reconnect', { hostId: state.hostId, attempt: state.attempt, delayMs: delay, reason: err ? err.message : (timedOut ? 'timeout' : 'end') });
        state.timer = setTimeout(() => connect(state), delay);
        state.timer.unref && state.timer.unref();
      };

      stream.on('end', () => onEnd(null));
      stream.on('error', (e) => onEnd(e));
    } catch (err) {
      clearTimeout(to);
      if (state.stopped) return;
      state.failures += 1;
      state.attempt += 1;
      const delay = BACKOFF[Math.min(state.attempt - 1, BACKOFF.length - 1)];
      const label = state.failures >= 2 ? 'unreachable' : 'reconnecting';
      const mapped = mapDockerError(err, { action: 'events' });
      publishHealth(state.hostId, label, { code: mapped.code, message: mapped.message });
      log.info('events.reconnect', { hostId: state.hostId, attempt: state.attempt, delayMs: delay, reason: mapped.message });
      state.timer = setTimeout(() => connect(state), delay);
      state.timer.unref && state.timer.unref();
    }
  }

  function activate(hostId) {
    if (active === hostId) return;
    if (active) stop(active);
    active = hostId;
    start(hostId).catch(() => {});
  }

  function deactivate(hostId) {
    stop(hostId);
    if (active === hostId) active = null;
  }

  pool.on('activate', activate);
  pool.on('deactivate', deactivate);

  // boot: start for active host once pool is ready (server calls activate explicitly too)
  return {
    ring, start, stop, activate, deactivate,
    activeHostId: () => active,
    replay: (hostId, lastId) => ring(hostId).since(Number(lastId)),
    list: (hostId, limit) => ring(hostId).list(limit),
    close: () => { for (const id of [...subs.keys()]) stop(id); },
    on: svc.on.bind(svc), emit: svc.emit.bind(svc)
  };
}

module.exports = { createEventService, normalise, parseHealth, baseAction, EventRing, BACKOFF, RING_CAP };
