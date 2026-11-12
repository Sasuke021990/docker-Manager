'use strict';

// Builds the Express app. Middleware order is security-relevant (§3.9):
// request log → headers/CSP → CSRF → body limit → routes → 404 → errors.

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

const { securityHeaders } = require('./web/middleware/security');
const { csrf } = require('./web/middleware/csrf');
const { bodyLimit } = require('./web/middleware/body');
const { notFound, errorHandler } = require('./web/middleware/errors');
const { healthRouter } = require('./web/routes/health');
const { assetsRouter } = require('./web/routes/assets');
const { pagesRouter } = require('./web/routes/pages');
const { apiRouter } = require('./web/routes/api');
const { streamRouter } = require('./web/routes/stream');
const { logsRouter } = require('./web/routes/logs');

function createApp(ctx) {
  const { log } = ctx;
  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'web', 'views'));

  // Access log: method, path, status, duration, request id — never bodies
  // and never query strings (they could carry a note) (OPS-002, SEC-006).
  app.use((req, res, next) => {
    req.id = crypto.randomUUID();
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      log.debug('request', {
        reqId: req.id,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        durationMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e4) / 100
      });
    });
    next();
  });

  app.use(securityHeaders);
  app.use(csrf({ log }));
  app.use((req, res, next) => {
    res.locals.csrfToken = req.csrfToken;
    next();
  });
  app.use(bodyLimit());

  app.use(assetsRouter());
  app.use(healthRouter(ctx));
  app.use(pagesRouter(ctx));
  app.use(apiRouter(ctx));
  app.use(streamRouter(ctx));
  app.use(logsRouter(ctx));

  app.use(notFound);
  app.use(errorHandler(log));
  return app;
}

module.exports = { createApp };
