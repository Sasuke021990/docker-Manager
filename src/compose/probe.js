'use strict';

// Compose plugin detection (design §3.8.5, FR-077). Read-only probe:
// `docker compose version --short` with a 3 s timeout, cached with lazy TTL.

const { spawn } = require('node:child_process');

const PROBE_TTL_MS = 60 * 1000;
const PROBE_TIMEOUT_MS = 3000;

function runProbe(env) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn('docker', ['compose', 'version', '--short'], {
        env: { PATH: process.env.PATH || '', HOME: '/tmp', DOCKER_HOST: env.dockerHost || process.env.DOCKER_HOST || '' },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true
      });
    } catch (err) {
      return finish({ state: 'cli-missing', version: null, message: `Could not start docker CLI: ${err.message}`, at: Date.now() });
    }
    let out = '';
    let errOut = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { errOut += d.toString(); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({ state: 'unknown', version: null, message: 'Compose probe timed out.', at: Date.now() });
    }, PROBE_TIMEOUT_MS);
    timer.unref && timer.unref();
    child.on('error', (err) => {
      clearTimeout(timer);
      if (err && err.code === 'ENOENT') {
        finish({ state: 'cli-missing', version: null, message: 'The docker binary is not installed in this container.', at: Date.now() });
      } else {
        finish({ state: 'unknown', version: null, message: err.message || 'Compose probe failed.', at: Date.now() });
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const version = out.trim().split(/\s+/).pop() || null;
      if (code === 0) {
        finish({ state: 'available', version: out.trim() || version, message: null, at: Date.now() });
      } else if (/is not a docker command/i.test(errOut) || /unknown command/i.test(errOut) || /not found/i.test(errOut)) {
        finish({ state: 'missing', version: null, message: 'The docker compose plugin is not installed in this container.', at: Date.now() });
      } else {
        finish({ state: 'unknown', version: null, message: errOut.trim() || `docker compose version exited ${code}`, at: Date.now() });
      }
    });
  });
}

function createComposeProbe({ env, log }) {
  let cache = null;
  let inflight = null;

  async function get({ force = false } = {}) {
    const now = Date.now();
    if (!force && cache && (now - cache.at) < PROBE_TTL_MS) return cache;
    if (inflight) return inflight;
    inflight = runProbe(env).then((result) => {
      cache = result;
      inflight = null;
      log.debug('compose.probe', { state: result.state, version: result.version });
      return result;
    }).catch((err) => {
      inflight = null;
      cache = { state: 'unknown', version: null, message: err.message, at: Date.now() };
      return cache;
    });
    return inflight;
  }

  function markMissing(message) {
    cache = { state: 'missing', version: null, message: message || 'The docker compose plugin is not installed in this container.', at: Date.now() };
  }

  function cached() { return cache; }

  return { get, cached, markMissing };
}

module.exports = { createComposeProbe, PROBE_TTL_MS, PROBE_TIMEOUT_MS };
