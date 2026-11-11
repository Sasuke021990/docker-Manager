'use strict';

// UT-001: config store atomic writes and invalid-document recovery.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createStore } = require('../src/config/store');
const { ConfigError } = require('../src/config/schema');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const noEnv = {
  composeFolder: null, logTailLines: null, stopTimeoutSeconds: null,
  dockerHost: null, dockerApiVersion: null, dockerCertPath: null,
  sshAuthSock: '/run/ssh-agent.sock', selfContainerId: null
};

async function tmpStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-config-'));
  const configPath = path.join(dir, 'config.json');
  const store = createStore({ configPath, env: noEnv, log: silent });
  return { dir, configPath, store };
}

test('missing file: defaults are written once and state is created', async () => {
  const { configPath, store } = await tmpStore();
  const cfg = await store.load();
  assert.equal(store.getState(), 'created');
  const onDisk = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.deepEqual(onDisk, JSON.parse(JSON.stringify(cfg)));
  const st = await fs.stat(configPath);
  assert.equal(st.mode & 0o777, 0o600);
  await store.close();
});

test('save is atomic: pretty-printed, newline-terminated, no temp files left', async () => {
  const { dir, configPath, store } = await tmpStore();
  await store.load();
  const next = JSON.parse(JSON.stringify(store.get()));
  next.notes.web = { note: 'behind Traefik', updatedAt: new Date().toISOString(), containerId: 'abc' };
  await store.save(next);
  const text = await fs.readFile(configPath, 'utf8');
  assert.ok(text.endsWith('}\n'));
  assert.ok(text.includes('  "version": "1"'));
  const leftovers = (await fs.readdir(dir)).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
  assert.equal(store.get().notes.web.note, 'behind Traefik');
  await store.close();
});

test('save rejects an oversized document with CONFIG_TOO_LARGE', async () => {
  const { store } = await tmpStore();
  await store.load();
  const next = JSON.parse(JSON.stringify(store.get()));
  next.notes = {};
  for (let i = 0; i < 800; i += 1) {
    next.notes[`name-${i}`] = { note: 'x'.repeat(2000), updatedAt: new Date().toISOString() };
  }
  await assert.rejects(store.save(next), (e) => e instanceof ConfigError && e.code === 'CONFIG_TOO_LARGE');
  await store.close();
});

test('invalid JSON keeps last-known-good and sets degraded (D-020)', async () => {
  const { configPath, store } = await tmpStore();
  await store.load();
  const before = store.get();
  await fs.writeFile(configPath, '{ not json', 'utf8');
  await store.reload();
  assert.equal(store.getState(), 'degraded');
  assert.deepEqual(store.get(), before);
  await store.close();
});

test('wrong version rejects the file but the app keeps serving last-known-good', async () => {
  const { configPath, store } = await tmpStore();
  await store.load();
  await fs.writeFile(configPath, JSON.stringify({ version: '99' }), 'utf8');
  await store.reload();
  assert.equal(store.getState(), 'degraded');
  assert.equal(store.get().version, '1');
  await store.close();
});

test('a hand-edited valid file is hot-reloaded', async () => {
  const { configPath, store } = await tmpStore();
  await store.load();
  const next = JSON.parse(JSON.stringify(store.get()));
  next.settings.theme = 'dark';
  await fs.writeFile(configPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  await store.reload();
  assert.equal(store.getState(), 'ok');
  assert.equal(store.get().settings.theme, 'dark');
  await store.close();
});

test('note lookup covers exact, recreated, foreign and none (FR-009)', async () => {
  const { store } = await tmpStore();
  await store.load();
  const liveIds = new Set(['id1']);
  assert.equal(store.lookupNote({ id: 'id1', name: 'web' }, liveIds).status, 'none');

  await store.saveNote('web', 'payments API', 'id1');
  assert.deepEqual(
    (({ status, note }) => ({ status, note }))(store.lookupNote({ id: 'id1', name: 'web' }, liveIds)),
    { status: 'exact', note: 'payments API' }
  );

  // recreated: same name, old id no longer alive
  const afterRecreate = store.lookupNote({ id: 'id2', name: 'web' }, new Set(['id2']));
  assert.equal(afterRecreate.status, 'recreated');
  assert.equal(afterRecreate.note, 'payments API');

  // foreign: the recorded id is alive on a different container with the same name
  const foreign = store.lookupNote({ id: 'id2', name: 'web' }, new Set(['id1', 'id2']));
  assert.equal(foreign.status, 'foreign');
  assert.equal(foreign.note, null);

  // next explicit save refreshes the id
  await store.saveNote('web', 'payments API', 'id2');
  assert.equal(store.lookupNote({ id: 'id2', name: 'web' }, new Set(['id1', 'id2'])).status, 'exact');
  await store.close();
});

test('notes hygiene: stale names listed and pruned only explicitly', async () => {
  const { store } = await tmpStore();
  await store.load();
  await store.saveNote('gone1', 'a', 'x1');
  await store.saveNote('gone2', 'b', 'x2');
  await store.saveNote('live', 'c', 'x3');
  assert.deepEqual(store.staleNoteNames(new Set(['live'])).sort(), ['gone1', 'gone2']);
  const { removed } = await store.pruneNotes(['gone1', 'nope']);
  assert.equal(removed, 1);
  assert.deepEqual(Object.keys(store.get().notes).sort(), ['gone2', 'live']);
  await store.close();
});

test('empty note removes the entry', async () => {
  const { store } = await tmpStore();
  await store.load();
  await store.saveNote('web', 'x', 'id');
  await store.saveNote('web', '', 'id');
  assert.deepEqual(Object.keys(store.get().notes), []);
  await store.close();
});

test('saveSettings validates and persists', async () => {
  const { store } = await tmpStore();
  await store.load();
  const s = await store.saveSettings({ theme: 'dark', logTailLines: 250 });
  assert.equal(s.theme, 'dark');
  assert.equal(s.logTailLines, 250);
  assert.equal(store.get().settings.theme, 'dark');
  await assert.rejects(store.saveSettings({ note: 'x'.repeat(2001) }), () => true);
  await store.close();
});
