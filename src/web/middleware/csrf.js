'use strict';

// CSRF without accounts (SEC-002, design §3.9.1): a double-submit token tied
// to the browser session. `dm_csrf` is issued on any page render; every
// mutating request must echo it in X-CSRF-Token (timing-safe compare) and
// pass the origin check. SameSite=Strict is the second layer.

const crypto = require('node:crypto');
const { DockerError } = require('../../docker/errors');

const COOKIE = 'dm_csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function csrf({ log }) {
  return function csrfMiddleware(req, res, next) {
    const cookies = parseCookies(req.headers.cookie);
    let token = cookies[COOKIE];
    if (!token || !/^[0-9a-f]{64}$/.test(token)) {
      token = crypto.randomBytes(32).toString('hex');
      res.append('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
    }
    req.csrfToken = token;
    if (SAFE_METHODS.has(req.method)) return next();

    const fail = () => {
      log.warn('csrf.reject', { route: req.originalUrl.split('?')[0], remote: req.ip });
      next(new DockerError('CSRF_INVALID', 'Missing or invalid session token. Reload the page and try again.'));
    };

    const origin = `${req.protocol}://${req.headers.host}`;
    const secFetchSite = req.headers['sec-fetch-site'];
    if (secFetchSite !== undefined) {
      if (secFetchSite !== 'same-origin') return fail();
    } else {
      const o = req.headers.origin;
      if (o !== undefined && o !== origin) return fail();
      if (o === undefined && req.headers.referer && !String(req.headers.referer).startsWith(origin)) return fail();
    }

    const presented = req.headers['x-csrf-token'];
    if (typeof presented !== 'string' || presented.length !== token.length) return fail();
    if (!crypto.timingSafeEqual(Buffer.from(presented, 'utf8'), Buffer.from(token, 'utf8'))) return fail();
    return next();
  };
}

module.exports = { csrf, parseCookies };
