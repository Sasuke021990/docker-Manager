'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { assertInsideRoot, ComposeError, slugify, uniqueId } = require('../src/compose/pathguard');
const { isComposeBasename } = require('../src/compose/discovery');

async function withTmp(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-compose-'));
  try { return await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('slugify and uniqueId produce stable safe ids', () => {
  assert.equal(slugify('Stack A'), 'stack-a');
  assert.ok(/^[a-z0-9][a-z0-9_-]{0,62}$/.test(slugify('!!!')));
  const used = new Set();
  const a = uniqueId('same', used);
  const b = uniqueId('same', used);
  assert.notEqual(a, b);
});

test('isComposeBasename accepts compose file names', () => {
  assert.ok(isComposeBasename('docker-compose.yml'));
  assert.ok(isComposeBasename('compose.yaml'));
  assert.ok(isComposeBasename('docker-compose.prod.yml'));
  assert.ok(!isComposeBasename('notes.yml'));
  assert.ok(!isComposeBasename('Dockerfile'));
});

test('path guard allows files inside root and rejects traversal (UT-005)', async () => {
  await withTmp(async (dir) => {
    const sub = path.join(dir, 'app');
    await fs.mkdir(sub);
    const file = path.join(sub, 'docker-compose.yml');
    await fs.writeFile(file, 'services: {}');
    const real = await assertInsideRoot(dir, 'app/docker-compose.yml');
    assert.equal(real, await fs.realpath(file));
    await assert.rejects(() => assertInsideRoot(dir, '../etc/passwd'), (e) => e instanceof ComposeError && e.code === 'COMPOSE_OUTSIDE_ROOT');
    await assert.rejects(() => assertInsideRoot(dir, 'app/nope.yml'), (e) => e instanceof ComposeError);
  });
});

test('path guard rejects bad filenames and directories', async () => {
  await withTmp(async (dir) => {
    await fs.writeFile(path.join(dir, 'notes.yml'), 'x');
    await fs.mkdir(path.join(dir, 'docker-compose.yml')); // dir with compose name
    await assert.rejects(() => assertInsideRoot(dir, 'notes.yml'), (e) => e.code === 'COMPOSE_BAD_FILENAME');
    await assert.rejects(() => assertInsideRoot(dir, 'docker-compose.yml'), (e) => e.code === 'COMPOSE_BAD_FILENAME');
  });
});

test('path guard rejects missing root', async () => {
  await assert.rejects(() => assertInsideRoot('/tmp/dm-no-such-compose-root-xyz', 'docker-compose.yml'), (e) => e.code === 'COMPOSE_ROOT_MISSING');
});
