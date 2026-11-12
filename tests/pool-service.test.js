'use strict';

// Pool service tests: fake client seam (patched before pool.js loads), fake
// store/env/bus/log. Covers ensure/negotiate, the withClient funnel incl. the
// renegotiation retry, health probing, host switching and lifecycle.

const test = require('node:test');
const assert = require('node:assert/strict');

// Patch the client seam BEFORE pool.js is required (it destructures at load).
const clientModule = require('../src/docker/client');
const realBuild = clientModule.buildClient;
let fakeBuilt = 0;
let fakePing = async () => ({});
let fakeVersion = async () => ({ ApiVersion: '1.51', Version: '27.1.0' });

clientModule.buildClient = function patchedBuildClient(_host, _env) {
  fakeBuilt += 1;
  return {
    modem: {},
    ping: (...a) => fakePing(...a),
    version: (...a) => fakeVersion(...a)
  };
};

const { createPool } = require('../src/docker/pool');

test.after(() => { clientModule.buildClient = realBuild; });

function fakeStore(hosts, activeHostId = 'local') {
  const cfg = {
    hosts,
    settings: { activeHostId },
    compose: { folder: '/compose', projects: [] }
  };
  return { get: () => cfg };
}

function fakeLog() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function fakeBus() {
  const frames = [];
  return { frames, publish: (kind, data) => frames.push({ kind, data }) };
}

const SOCKET_HOST = { id: 'local', name: 'This host', access: 'socket', socketPath: '/tmp/dm-test.sock' };

function mkPool({ hosts = [SOCKET_HOST], active = 'local', env = {} } = {}) {
  fakeBuilt = 0;
  const bus = fakeBus();
  const pool = createPool({ env, log: fakeLog(), bus, store: fakeStore(hosts, active) });
  return { pool, bus };
}

test('ensure negotiates the API version and pins it on the modem', async () => {
  const { pool } = mkPool();
  const host = SOCKET_HOST;
  const rt = pool.runtimeFor(host);
  await pool.ensure(rt, host);
  assert.equal(rt.state, 'reachable');
  assert.equal(rt.apiVersion, '1.51');
  assert.equal(rt.maxApiVersion, '1.51');
  assert.equal(rt.engineVersion, '27.1.0');
  assert.equal(rt.client.modem.version, 'v1.51'); // pinned below APP_MAX 1.56
  await pool.close();
});

test('ensure pins a newer daemon down to APP_MAX_API and flags too-old daemons', async () => {
  {
    fakeVersion = async () => ({ ApiVersion: '1.99', Version: '99.0' });
    const { pool } = mkPool();
    const rt = pool.runtimeFor(SOCKET_HOST);
    await pool.ensure(rt, SOCKET_HOST);
    assert.equal(rt.apiVersion, clientModule.APP_MAX_API);
    await pool.close();
  }
  {
    fakeVersion = async () => ({ ApiVersion: '1.39', Version: '19.0' });
    const { pool } = mkPool();
    const rt = pool.runtimeFor(SOCKET_HOST);
    await assert.rejects(() => pool.ensure(rt, SOCKET_HOST), (e) => e.code === 'DAEMON_TOO_OLD');
    assert.equal(rt.state, 'too-old');
    await pool.close();
  }
  fakeVersion = async () => ({ ApiVersion: '1.51', Version: '27.1.0' });
});

test('withClient funnels calls through the runtime and maps daemon errors', async () => {
  const { pool } = mkPool();
  let calls = 0;
  const out = await pool.withClient('local', (client) => { calls += 1; assert.ok(client.modem); return 'ok'; });
  assert.equal(out, 'ok');
  assert.equal(calls, 1);
  await assert.rejects(
    () => pool.withClient('local', async () => {
      const e = new Error('No such container: web');
      e.statusCode = 404;
      e.json = { message: 'No such container: web' };
      throw e;
    }),
    (e) => e.code === 'CONTAINER_NOT_FOUND'
  );
  await assert.rejects(() => pool.withClient('nope', () => {}), (e) => e.code === 'HOST_NOT_FOUND');
  await pool.close();
});

test('withClient renegotiates once when the daemon rejects the pinned version', async () => {
  const { pool } = mkPool();
  let attempts = 0;
  const result = await pool.withClient('local', async (client) => {
    attempts += 1;
    if (attempts === 1) {
      assert.ok(client.modem.version, 'first attempt should carry the pinned version');
      const e = new Error('client version 1.51 is too new');
      e.statusCode = 400;
      e.json = { message: 'client version 1.51 is too new' };
      throw e;
    }
    assert.equal(client.modem.version, undefined, 'version pin dropped before the retry');
    return 'retried';
  });
  assert.equal(result, 'retried');
  assert.equal(attempts, 2);
  await pool.close();
});

test('probeHost publishes health transitions over the bus', async () => {
  const { pool, bus } = mkPool();
  const rt = await pool.probeHost(SOCKET_HOST);
  assert.equal(rt.state, 'reachable');
  // reachable → unreachable
  fakePing = async () => { const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e; };
  const rt2 = await pool.probeHost(SOCKET_HOST);
  assert.equal(rt2.state, 'unreachable');
  const kinds = bus.frames.map((f) => f.kind);
  assert.ok(kinds.includes('host.health'));
  fakePing = async () => ({});
  await pool.close();
});

test('setActive switches hosts and emits deactivate/activate/resync', async () => {
  const hosts = [SOCKET_HOST, { id: 'ssh1', name: 'Remote', access: 'ssh', sshHost: 'h', sshUser: 'u' }];
  const { pool } = mkPool({ hosts, active: 'local' });
  pool.syncHosts(); // boot path: activates 'local' before we watch
  const seen = [];
  pool.on('activate', (id) => seen.push(['activate', id]));
  pool.on('deactivate', (id) => seen.push(['deactivate', id]));
  pool.on('resync', (why) => seen.push(['resync', why]));
  assert.equal(pool.setActive('ssh1'), 'ssh1');
  assert.deepEqual(seen, [
    ['deactivate', 'local'],
    ['activate', 'ssh1'],
    ['resync', 'host-changed']
  ]);
  assert.equal(pool.activeHostId(), 'ssh1');
  assert.equal(pool.activeHost().id, 'ssh1');
  await assert.rejects(async () => pool.setActive('ghost'), (e) => e.code === 'HOST_NOT_FOUND');
  await pool.close();
});

test('syncHosts drops runtimes for removed hosts and follows the active host', async () => {
  const hosts = [SOCKET_HOST, { id: 'tcp1', name: 'Tcp', access: 'tcp', url: 'tcp://127.0.0.1:2375' }];
  const store = fakeStore(hosts, 'local');
  const bus = fakeBus();
  const pool = createPool({ env: {}, log: fakeLog(), bus, store });
  pool.setActive('tcp1');
  // remove tcp1 from config, active falls back per settings
  store.get = () => ({ hosts: [SOCKET_HOST], settings: { activeHostId: 'local' }, compose: {} });
  pool.syncHosts();
  assert.equal(pool.activeHostId(), 'local');
  assert.ok(!pool.runtimes.has('tcp1'));
  await pool.close();
});

test('localSocketHost finds the socket runtime; close clears everything', async () => {
  const { pool } = mkPool();
  pool.syncHosts(); // boot path builds the runtime
  assert.equal(pool.localSocketHost().id, 'local');
  await pool.close();
  assert.equal(pool.runtimes.size, 0);
  assert.equal(pool.activeHost(), undefined); // no runtimes left behind
});

test('fingerprint change rebuilds the client (host entry edited)', async () => {
  const store = fakeStore([SOCKET_HOST], 'local');
  const pool = createPool({ env: {}, log: fakeLog(), bus: fakeBus(), store });
  pool.runtimeFor(SOCKET_HOST);
  assert.equal(fakeBuilt, 0); // lazy: not built until ensure()
  const rt1 = pool.runtimeFor(SOCKET_HOST);
  await pool.ensure(rt1, SOCKET_HOST);
  assert.equal(fakeBuilt, 1);
  // same fingerprint: reuse
  await pool.ensure(pool.runtimeFor(SOCKET_HOST), SOCKET_HOST);
  assert.equal(fakeBuilt, 1);
  // change the host entry: fingerprint differs → deactivate + rebuild
  const seen = [];
  pool.on('deactivate', (id) => seen.push(id));
  const rt2 = pool.runtimeFor({ ...SOCKET_HOST, socketPath: '/tmp/dm-test-2.sock' });
  assert.notEqual(rt2.fingerprint, rt1.fingerprint);
  await pool.ensure(rt2, { ...SOCKET_HOST, socketPath: '/tmp/dm-test-2.sock' });
  assert.equal(fakeBuilt, 2);
  await pool.close();
});
