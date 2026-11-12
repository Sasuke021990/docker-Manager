'use strict';

// /api/stream — one bus SSE per page (design §3.5.6, §4.2.4).
// Frames: hello, container.upsert, container.remove, docker.event,
// host.health, activity.appended, resync, error. id: = bus seq.

const express = require('express');
const { openSse } = require('../sse');
const MAX_STREAM_CLIENTS = 20;

function streamRouter(ctx) {
  const { bus, events, pool, store } = ctx;
  const router = express.Router();
  const clients = new Set();

  function dropOldest() {
    for (const c of clients) {
      c.sse.send('error', { code: 'STREAM_LIMIT', message: 'A newer page took this stream slot.' });
      c.sse.close();
      clients.delete(c);
      break;
    }
  }

  router.get('/api/stream', async (req, res) => {
    if (clients.size >= MAX_STREAM_CLIENTS) dropOldest();
    const sse = openSse(req, res, { heartbeat: true });
    if (!sse) return;
    // connection tracked via sse.open counter in openSse()

    const hostId = store.get().settings.activeHostId;
    const rt = pool.runtimes && pool.runtimes.get(hostId);
    const hello = {
      seq: bus.seq,
      hostId,
      apiVersion: rt ? rt.apiVersion : null
    };
    sse.send('hello', hello, bus.seq);

    // Replay on Last-Event-ID: docker.event frames only (spec replay semantics).
    const lastId = req.headers['last-event-id'];
    if (lastId !== undefined) {
      const replay = events.replay(hostId, Number(lastId));
      if (replay === null) {
        sse.send('resync', { reason: 'gap' });
      } else {
        for (const ev of replay) sse.send('docker.event', ev, ev.seq);
      }
    }

    const onDocker = (ev) => {
      if (ev.synthetic) return;
      sse.send('docker.event', ev, ev.seq);
    };
    const onUpsert = ({ hostId: hid, row }) => {
      if (hid !== store.get().settings.activeHostId) return;
      sse.send('container.upsert', row);
    };
    const onRemove = ({ hostId: hid, containerId }) => {
      if (hid !== store.get().settings.activeHostId) return;
      sse.send('container.remove', { id: containerId });
    };
    const onResync = (info) => {
      if (info && info.hostId && info.hostId !== store.get().settings.activeHostId) return;
      // full reconcile payload if available, else reason-only
      if (info && info.rows) {
        sse.send('resync', { reason: info.reason || 'reconcile', rows: info.rows, counts: info.counts, host: info.host });
      } else {
        sse.send('resync', { reason: (info && info.reason) || 'resync' });
      }
    };
    const onHost = (payload) => {
      sse.send('host.health', payload, payload.seq);
    };
    const onActivity = (payload) => {
      sse.send('activity.appended', payload, payload.seq);
    };

    events.on('docker.event', onDocker);
    events.on('container.upsert', onUpsert);
    events.on('container.remove', onRemove);
    events.on('resync', onResync);
    bus.on('host.health', onHost);
    bus.on('activity.appended', onActivity);

    const client = { sse };
    clients.add(client);

    req.on('close', () => {
      clients.delete(client);
      events.off('docker.event', onDocker);
      events.off('container.upsert', onUpsert);
      events.off('container.remove', onRemove);
      events.off('resync', onResync);
      bus.off('host.health', onHost);
      bus.off('activity.appended', onActivity);
    });
  });

  return router;
}

module.exports = { streamRouter, MAX_STREAM_CLIENTS };
