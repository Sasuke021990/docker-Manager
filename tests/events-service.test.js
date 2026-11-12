'use strict';

// Event subscription tests (§3.5): normalisation ingest, seq assignment,
// debounced upsert, destroy handling, reconnect backoff, host switching —
// fake pool/bus/queries/stream, no daemon (FR-005, FR-036).

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');

const { createEventService, normalise, EventRing, BACKOFF, RING_CAP } = require('../src/docker/events');

function rawEvent(action, overrides = {}) {
  return {
    timeNano: 1700000000000000000,
    Type: 'container',
    Action: action,
    Actor: {
      ID: 'a'.repeat(64),
      Attributes: { name: 'web', image: 'nginx:1.27', exitCode: '0', secret: 'nope' }
    },
    ...overrides
  };
}

function fakeLog() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function fakeBus() {
  const published = [];
  const emitted = [];
  let seq = 0;
  return {
    published,
    emitted,
    publish: (kind, data) => published.push({ kind, data }),
    emit: (kind, data) => emitted.push({ kind, data }),
    nextSeq: () => ++seq
  };
}

function fakePool() {
  const p = new EventEmitter();
  p.runtimes = new Map([['local', { apiVersion: '1.51', engineVersion: '27' }]]);
  p.withClient = async (_id, fn) => fn({ getEvents: async () => p.stream });
  return p;
}

function fakeQueries() {
  const calls = { getContainer: 0, invalidate: 0 };
  return {
    calls,
    listContainers: async () => ({ rows: [], counts: {}, host: {} }),
    getContainer: async () => {
      calls.getContainer += 1;
      return {
        id: 'a'.repeat(64), idShort: 'a'.repeat(12), name: 'web', image: 'nginx:1.27',
        imageId: 'sha256:abc', state: 'running', status: 'Up', health: null, exitCode: 0,
        restarts: 0, created: 'now', startedAt: 'now', uptimeSec: 10, ports: [],
        compose: null, self: false, note: { status: 'none' }
      };
    },
    invalidate: () => { calls.invalidate += 1; }
  };
}

function svc(services = {}) {
  const pool = services.pool || fakePool();
  const bus = services.bus || fakeBus();
  const queries = services.queries || fakeQueries();
  const upserts = [];
  const removes = [];
  const service = createEventService({
    pool,
    bus,
    queries,
    store: { get: () => ({ settings: {} }) },
    log: fakeLog()
  });
  service.on('container.upsert', (e) => upserts.push(e));
  service.on('container.remove', (e) => removes.push(e));
  return { service, pool, bus, queries, upserts, removes };
}

test('normalise allowlists attributes and parses health sub-actions', () => {
  const ev = normalise(rawEvent('health_status: healthy'), 'local');
  assert.equal(ev.action, 'health_status');
  assert.equal(ev.rawAction, 'health_status: healthy');
  assert.equal(ev.health, 'healthy');
  assert.deepEqual(ev.attributes, { exitCode: '0', name: 'web', image: 'nginx:1.27' });
  assert.equal(ev.name, 'web');
  assert.equal(ev.image, 'nginx:1.27');
  assert.equal(normalise(rawEvent('die'), 'local').health, null);
  assert.equal(normalise(rawEvent('exec_start: x'), 'local').action, 'exec_start');
  assert.equal(normalise({ Type: 'container', Action: 'x', Actor: { ID: 'b'.repeat(12) } }, 'h').name, 'b'.repeat(12));
});

test('EventRing replays only after the requested seq and reports gaps', () => {
  const r = new EventRing(3);
  for (let i = 1; i <= 3; i += 1) r.push({ seq: i });
  assert.deepEqual(r.since(0).map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(r.since(2).map((e) => e.seq), [3]);
  assert.deepEqual(r.since(99), []); // client already has everything
  assert.equal(r.since('x'), null); // invalid seq is unknown, not empty
  r.push({ seq: 4 }); // evicts 1
  assert.deepEqual(r.since(1).map((e) => e.seq), [2, 3, 4]); // still contiguous
  assert.equal(r.since(0), null); // gap: seq 1 was evicted
  assert.deepEqual(r.since(3).map((e) => e.seq), [4]);
  assert.equal(r.list(2).length, 2);
  r.clear();
  assert.equal(r.list().length, 0);
});

test('ingest assigns one seq across ring + bus and debounces an upsert', async () => {
  const s = svc();
  const stream = new EventEmitter();
  stream.destroy = () => {};
  s.pool.stream = stream;
  await s.service.start('local');
  await sleep(10); // let connect() attach the stream handlers
  stream.emit('data', Buffer.from(JSON.stringify(rawEvent('start')) + '\n'));
  stream.emit('data', Buffer.from(JSON.stringify(rawEvent('die', { time: 1700000000 })) + '\n'));
  // one seq per event, shared with the ring
  const ring = s.service.list('local');
  assert.equal(ring.length, 2);
  assert.ok(ring[0].seq > 0);
  // every event is fanned out on the bus channel with its seq
  const channelled = s.bus.emitted.filter((p) => p.kind === 'docker.event');
  assert.equal(channelled.length, 2);
  assert.ok(channelled.every((p) => p.data.seq > 0));
  // health reaches reachable after the first byte
  assert.ok(s.bus.published.some((p) => p.kind === 'host.health' && p.data.state === 'reachable'));
  // debounced per container (150 ms): two events collapse into one inspect
  await sleep(220);
  assert.equal(s.queries.calls.getContainer, 1);
  assert.equal(s.upserts.length, 1);
  assert.equal(s.upserts[0].row.name, 'web');
  await s.service.close();
});

test('a destroy event removes the row without an inspect', async () => {
  const s = svc();
  const stream = new EventEmitter();
  stream.destroy = () => {};
  s.pool.stream = stream;
  await s.service.start('local');
  await sleep(10);
  stream.emit('data', Buffer.from(JSON.stringify(rawEvent('destroy')) + '\n'));
  await sleep(220);
  assert.equal(s.removes.length, 1);
  assert.equal(s.queries.calls.invalidate, 1);
  assert.equal(s.queries.calls.getContainer, 0);
  await s.service.close();
});

test('a failed inspect after a stop event maps to remove, others stay silent', async () => {
  const queries = fakeQueries();
  queries.getContainer = async () => {
    const e = new Error('No such container');
    e.statusCode = 404;
    e.json = { message: 'No such container' };
    throw e;
  };
  const s = svc({ queries });
  const stream = new EventEmitter();
  stream.destroy = () => {};
  s.pool.stream = stream;
  await s.service.start('local');
  await sleep(10);
  stream.emit('data', Buffer.from(JSON.stringify(rawEvent('stop')) + '\n'));
  await sleep(220);
  assert.equal(s.removes.length, 1);
  await s.service.close();
});

test('non-container events are ignored; malformed JSON never throws', async () => {
  const s = svc();
  const stream = new EventEmitter();
  stream.destroy = () => {};
  s.pool.stream = stream;
  await s.service.start('local');
  await sleep(10);
  stream.emit('data', Buffer.from(JSON.stringify({ Type: 'image', Action: 'pull' }) + '\n'));
  stream.emit('data', Buffer.from('{not json\n'));
  stream.emit('data', Buffer.from('\n'));
  assert.equal(s.service.list('local').length, 0);
  await s.service.close();
});

test('stream end schedules a reconnect with backoff and publishes health', async () => {
  const s = svc();
  const stream = new EventEmitter();
  stream.destroy = () => {};
  s.pool.stream = stream;
  await s.service.start('local');
  await sleep(10); // let connect() attach the stream handlers
  stream.emit('end');
  const health = s.bus.published.filter((p) => p.kind === 'host.health');
  assert.ok(health.some((f) => f.data.state === 'reconnecting'));
  // reconnect timer is pending — stop cleans it up
  await s.service.close();
  assert.equal(s.service.activeHostId(), 'local'); // close() clears subs; active label stays
});

test('activate switches the subscription; deactivate stops it', async () => {
  const s = svc();
  s.pool.stream = new EventEmitter();
  await s.service.activate('local');
  assert.equal(s.service.activeHostId(), 'local');
  await s.service.activate('other'); // stops local, starts other
  assert.equal(s.service.activeHostId(), 'other');
  s.service.deactivate('other');
  assert.equal(s.service.activeHostId(), null);
  await s.service.close();
});

test('BACKOFF ladder and RING_CAP match the design values', () => {
  assert.deepEqual(BACKOFF, [1000, 2000, 5000, 10000, 30000]);
  assert.equal(RING_CAP, 500);
});
