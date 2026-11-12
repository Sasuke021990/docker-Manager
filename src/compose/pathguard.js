'use strict';

// Compose path containment (design §3.8.1, SEC-007, UT-005). The only untrusted
// path input in the app: everything resolves to a real path inside the verified
// compose root, or is refused. Never throws raw fs errors to the caller — all
// rejections are ComposeErrors with taxonomy codes.

const fs = require('node:fs/promises');
const path = require('node:path');
const { DockerError } = require('../docker/errors');

class ComposeError extends DockerError {
  constructor(code, message, detail) {
    super(code, message, detail);
    this.name = 'ComposeError';
  }
}

function isInside(root, p) {
  return p === root || p.startsWith(root + path.sep);
}

const COMPOSE_NAME_RE = /^(docker-)?compose(\.[a-z0-9_-]+)?\.ya?ml$/i;
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

async function realRoot(rootDir) {
  try {
    return await fs.realpath(rootDir);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new ComposeError('COMPOSE_ROOT_MISSING', `Compose folder ${rootDir} does not exist.`);
    }
    throw new ComposeError('COMPOSE_OUTSIDE_ROOT', `Could not resolve compose folder ${rootDir}.`);
  }
}

async function assertInsideRoot(rootDir, candidate, { mustExist = true } = {}) {
  const root = await realRoot(rootDir);
  if (typeof candidate !== 'string' || !candidate) {
    throw new ComposeError('COMPOSE_BAD_FILENAME', 'Compose path is required.');
  }
  // Lexical normalisation inside root first, then realpath to resolve symlinks.
  const abs = path.resolve(root, candidate);
  if (!isInside(root, abs)) {
    throw new ComposeError('COMPOSE_OUTSIDE_ROOT', `Compose files must live inside ${rootDir}. Refused: ${candidate}`);
  }

  let real;
  try {
    real = await fs.realpath(abs);
  } catch (err) {
    if (!mustExist && err && err.code === 'ENOENT') {
      throw new ComposeError('COMPOSE_BAD_FILENAME', `Compose file does not exist: ${candidate}`);
    }
    throw new ComposeError('COMPOSE_BAD_FILENAME', `Could not resolve compose path: ${candidate}`);
  }
  if (!isInside(root, real)) {
    throw new ComposeError('COMPOSE_OUTSIDE_ROOT', `Compose path resolves outside ${rootDir} (symlink). Refused: ${candidate}`);
  }
  if (!COMPOSE_NAME_RE.test(path.basename(real))) {
    throw new ComposeError('COMPOSE_BAD_FILENAME', 'Not a Compose file name.');
  }
  const st = await fs.stat(real);
  if (!st.isFile()) {
    throw new ComposeError('COMPOSE_BAD_FILENAME', 'Not a regular file.');
  }
  return real;
}

function slugify(name) {
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 62);
  if (PROJECT_ID_RE.test(base)) return base;
  const fallback = `p-${base}`.replace(/^-+/, 'p-').slice(0, 63);
  return PROJECT_ID_RE.test(fallback) ? fallback : 'project';
}

function uniqueId(name, used) {
  const id = slugify(name);
  if (!used.has(id)) { used.add(id); return id; }
  for (let i = 2; i < 1000; i += 1) {
    const cand = `${id.slice(0, 58)}-${i}`;
    if (!used.has(cand)) { used.add(cand); return cand; }
  }
  const rand = `${id.slice(0, 54)}-${Date.now().toString(36)}`.slice(0, 63);
  used.add(rand);
  return rand;
}

module.exports = {
  ComposeError,
  assertInsideRoot,
  realRoot,
  isInside,
  COMPOSE_NAME_RE,
  PROJECT_ID_RE,
  slugify,
  uniqueId
};
