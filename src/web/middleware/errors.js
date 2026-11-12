'use strict';

// One error envelope for every failure (design §4.2): message is the
// daemon's or system's text, verbatim (NFR-045); `action` is what the
// operator tried. Stacks are logged, never returned.

const { DockerError, mapDockerError } = require('../../docker/errors');

function wantsJson(req) {
  if (req.path.startsWith('/api') || req.path === '/metrics') return true;
  const accept = req.headers.accept || '';
  return accept.includes('json') && !accept.includes('html');
}

function notFound(req, res) {
  const err = new DockerError('NOT_FOUND', `No route: ${req.method} ${req.path}`);
  if (wantsJson(req)) res.status(404).json(err.toJSON());
  else res.status(404).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not found</title></head><body><h1>Not found</h1><p>No route: ${req.method} ${req.path}</p><p><a href="/containers">Back to containers</a></p></body></html>`);
}

function errorHandler(log) {
  // eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity
  return function errorMiddleware(err, req, res, next) {
    let mapped;
    if (err instanceof DockerError) mapped = err;
    else if (err && typeof err.code === 'string' && typeof err.httpStatus === 'number') {
      // ConfigError and friends carry their own taxonomy code (design §4.1.2).
      mapped = new DockerError(err.code, err.message);
    } else if (err.type === 'entity.too.large') mapped = new DockerError('BODY_TOO_LARGE', 'Request body exceeds the 16 KB limit.');
    else if (err.type === 'entity.parse.failed') mapped = new DockerError('BAD_REQUEST', 'Request body is not valid JSON.');
    else mapped = mapDockerError(err);

    log.error('request.error', {
      route: req.originalUrl.split('?')[0],
      method: req.method,
      code: mapped.code,
      message: mapped.message,
      stack: err && err.stack
    });

    if (res.headersSent) {
      res.end();
      return;
    }
    if (wantsJson(req)) {
      res.status(mapped.httpStatus).json(mapped.toJSON());
      return;
    }
    const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${mapped.code}</title></head><body><h1>${mapped.code}</h1><p>${escapeHtml(mapped.message)}</p><p>Failed action: ${escapeHtml(mapped.action || req.method)}</p><p><a href="/containers">Back to containers</a></p></body></html>`;
    res.status(mapped.httpStatus).type('html').send(doc);
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { notFound, errorHandler, wantsJson };
