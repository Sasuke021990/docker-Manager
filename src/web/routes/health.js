'use strict';

// Liveness and counters (NFR-053, OPS-003, SEC-009). /healthz is always 200
// while the process can serve: a Docker outage must not trigger a container
// restart loop. No host names, paths or config content in either body.

const express = require('express');
const metrics = require('../../core/metrics');

function healthRouter({ store, pool }) {
  const router = express.Router();

  router.get('/healthz', (req, res) => {
    const rt = pool.activeHost();
    const daemon = rt
      ? {
          state: rt.state,
          apiVersion: rt.apiVersion,
          ...(rt.state === 'too-old' && rt.lastError ? { message: rt.lastError.message } : {})
        }
      : { state: 'connecting', apiVersion: null };
    res.json({
      status: 'ok',
      uptimeSec: Math.floor(process.uptime()),
      config: { state: store.getState() },
      daemon
    });
  });

  router.get('/metrics', (req, res) => {
    res.json(metrics.snapshot());
  });

  return router;
}

module.exports = { healthRouter };
