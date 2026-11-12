'use strict';

// Container log routes (design §3.6, §4.2.2).
// GET /api/containers/:id/logs       — JSON snapshot or download attachment
// GET /api/containers/:id/logs/stream — SSE live stream

const express = require('express');
const { openSse } = require('../sse');
const { DockerError } = require('../../docker/errors');

function logsRouter(ctx) {
  const { store, logs } = ctx;
  const router = express.Router();

  function hostId() { return store.get().settings.activeHostId; }
  function tailOf(req) {
    const n = Number.parseInt(req.query.tail, 10);
    if (Number.isFinite(n)) return Math.min(10000, Math.max(1, n));
    return store.get().settings.logTailLines || 100;
  }

  router.get('/api/containers/:id/logs', async (req, res, next) => {
    try {
      const download = req.query.download === '1' || req.query.download === 'true';
      const tail = download ? 100 : tailOf(req);
      const timestamps = req.query.timestamps === '0' ? false : true; // export path always true below
      const snap = await logs.fetchSnapshot(hostId(), req.params.id, tail, true);
      if (download) {
        // FR-045, AC-006: export always carries timestamps regardless of toggle.
        const text = logs.toExportText(snap.lines.slice(-100));
        const name = `${logs.safeName(snap.name || req.params.id)}-${logs.stamp()}.log`;
        res.set('Content-Type', 'text/plain; charset=utf-8');
        res.set('Content-Disposition', `attachment; filename="${name}"`);
        res.send(text);
        return;
      }
      // JSON display: timestamps field present; client can hide per toggle
      const lines = snap.lines.map((l) => ({ s: l.s, ts: timestamps ? l.ts : l.ts, m: l.m }));
      res.json({ tty: snap.tty, lines, truncated: false, desynced: snap.desynced, lastTs: snap.lastTs });
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/containers/:id/logs/stream', async (req, res, next) => {
    try {
      // STREAM_LIMIT: 429 only for Accept: application/json; SSE clients get error frame.
      if (logs.size() >= logs.MAX_STREAMS && (req.headers.accept || '').includes('application/json')) {
        throw new DockerError('STREAM_LIMIT', 'Too many open log streams. Close one to open another.', { action: 'logs' });
      }
      const sse = openSse(req, res, { heartbeat: true });
      if (!sse) return;
      const tail = tailOf(req);
      const after = typeof req.query.after === 'string' ? req.query.after : null;
      await logs.openStream(hostId(), req.params.id, { tail, after, timestamps: true, sse });
      // openStream owns close; nothing else to do
    } catch (err) {
      // if headers not sent, let error middleware handle
      if (!res.headersSent) return next(err);
    }
  });

  return router;
}

module.exports = { logsRouter };
