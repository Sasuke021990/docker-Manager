'use strict';

// Compose JSON/SSE routes (design §4.2.2, FR-070–FR-078).
// POST accepts projectId (not a path); raw paths in body are rejected.

const express = require('express');
const { DockerError } = require('../../docker/errors');
const { ComposeError } = require('../../compose/pathguard');

function activeHostId(store) {
  return store.get().settings.activeHostId;
}

function composeRouter(ctx) {
  const { store, compose } = ctx;
  const router = express.Router();

  router.get('/api/stacks', async (req, res, next) => {
    try {
      res.json(await compose.listPublic(activeHostId(store)));
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/compose/run', async (req, res, next) => {
    try {
      const body = req.body || {};
      if (typeof body.path === 'string' || typeof body.file === 'string' || typeof body.dir === 'string') {
        throw new ComposeError('BAD_REQUEST', 'Raw paths are not accepted. Use a projectId from /api/stacks.');
      }
      const projectId = body.projectId;
      const action = body.action;
      if (typeof projectId !== 'string' || !projectId) {
        throw new ComposeError('BAD_REQUEST', 'projectId is required.');
      }
      if (action !== 'up' && action !== 'down') {
        throw new ComposeError('BAD_REQUEST', 'action must be "up" or "down".');
      }
      const result = await compose.run(activeHostId(store), projectId, action, {
        confirmMixed: body.confirmMixed === true
      });
      res.status(202).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/compose/:jobId/stream', (req, res, next) => {
    const stream = compose.runner.streamJob(req, res, req.params.jobId);
    if (!stream) {
      next(new DockerError('NOT_FOUND', 'Unknown or expired compose job.'));
    }
  });

  return router;
}

module.exports = { composeRouter };
