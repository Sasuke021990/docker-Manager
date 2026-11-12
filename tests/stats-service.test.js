'use strict';

// Stats sampler tests (§3.7): shared sampler per container, stop-on-stopped,
// host switch teardown — fake pool/store/streams, no daemon (FR-050, FR-051).

const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: sleep } = require('node:timers/promises');

const { createStatsService, derive } = require('../src/docker/stats');

function sample() {
  return {
    cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 1000, online_cpus: 2 },
    precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 500 },
    memory_stats: { usage: 300, limit: 1000, stats: { inactive_file: 50 } },
    networks: { eth0: { rx_bytes: 12, tx_bytes: 34 } },
    blkio_stats: { io_service_bytes_recursive: [{ op: 'Read', value: 5 }, { op: 'Write', value: 6 }] },
    pids_stats: { current: 9 }
  };
}

function fakeStore(interval = 500) {
  return { get: () => ({ settings: { statsIntervalMs: interval } }) };
}

function fakeLog() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

// Client-shaped fake: withClient hands fn a client with getContainer().stats().
function okClient() {
  return { getContainer: () => ({ stats: async () => sample() }) };
}

function errClient(statusCode, message) {
  return {
    getContainer: () => ({
      stats: async () => {
        const e = new Error(message);
        e.statusCode = statusCode;
        e.json = { message };
        throw e;
      }
    })
  };
}

function fakePool(client) {
  return { withClient: async (_id, fn) => fn(client), on() {} };
}

function fakeStream() {
  return {
    closed: false,
    frames: [],
    sendT(f) { this.frames.push(f); },
    close() { this.closed = true; }
  };
}

test('subscribe shares one sampler between streams and sends the last sample immediately', async () => {
  let pollCalls = 0;
  const countingClient = { getContainer: () => ({ stats: async () => { pollCalls += 1; return sample(); } }) };
  const svc = createStatsService({ pool: fakePool(countingClient), store: fakeStore(), log: fakeLog() });
  const a = fakeStream();
  const b = fakeStream();
  const removeA = svc.subscribe('local', 'c1', a);
  await sleep(20);
  assert.equal(a.frames[0].t, 'sample');
  assert.equal(a.frames[0].memUsed, 250);
  assert.equal(a.frames[0].net.tx, 34);
  svc.subscribe('local', 'c1', b); // same sampler
  await sleep(20);
  assert.equal(svc._samplers.size, 1);
  const before = pollCalls;
  removeA();
  await sleep(5);
  // b still subscribed: sampler alive
  assert.equal(svc._samplers.size, 1);
  assert.equal(pollCalls >= before, true);
  assert.equal(b.frames.some((f) => f.t === 'sample'), true);
  svc.closeAll();
  assert.equal(svc._samplers.size, 0);
});

test('a stopped container halts the sampler and closes subscribers', async () => {
  const svc = createStatsService({
    pool: fakePool(errClient(409, 'container is not running')),
    store: fakeStore(),
    log: fakeLog()
  });
  const a = fakeStream();
  svc.subscribe('local', 'c1', a);
  await sleep(20);
  const state = a.frames.find((f) => f.t === 'state');
  assert.ok(state, 'expected a state frame');
  assert.equal(state.state, 'stopped');
  assert.equal(a.closed, true);
  assert.equal(svc._samplers.size, 0);
});

test('a transient error keeps the sampler alive and reports DOCKER_ERROR', async () => {
  const svc = createStatsService({
    pool: fakePool(errClient(500, 'boom')),
    store: fakeStore(),
    log: fakeLog()
  });
  const a = fakeStream();
  svc.subscribe('local', 'c1', a);
  await sleep(20);
  const err = a.frames.find((f) => f.t === 'error');
  assert.ok(err, 'expected an error frame');
  assert.equal(a.closed, false);
  assert.equal(svc._samplers.size, 1);
  svc.closeAll();
});

test('closeHost tears down only that host and notifies subscribers', async () => {
  const svc = createStatsService({ pool: fakePool(okClient()), store: fakeStore(), log: fakeLog() });
  const a = fakeStream();
  const b = fakeStream();
  svc.subscribe('local', 'c1', a);
  svc.subscribe('other', 'c2', b);
  await sleep(10);
  svc.closeHost('local');
  assert.equal(a.closed, true);
  assert.equal(b.closed, false);
  assert.equal(svc._samplers.size, 1);
  svc.closeAll();
  assert.equal(svc._samplers.size, 0);
  assert.equal(b.closed, true);
});

test('derive is re-exported and handles empty samples', () => {
  const svc = createStatsService({ pool: fakePool(okClient()), store: fakeStore(), log: fakeLog() });
  assert.deepEqual(svc.derive({}), derive({}));
  assert.equal(svc.derive({}).cpuPct, null);
});
