'use strict';

// Log service tests (snapshot+follow handshake, ring, limits, export) with a
// fake pool/client and a fake SSE sink. No daemon (design §3.6).

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createLogService, truncLine, safeName, stamp } = require('../src/docker/logs');

function frame(stream, text) {
  const payload = Buffer.from(text, 'utf8');
  const h = Buffer.alloc(8);
  h[0] = stream;
  h.writeUInt32BE(payload.length, 4);
  return Buffer.concat([h, payload]);
}

const TS = '2026-11-11T18:30:00.123456789Z';

function fakeClient({ tty = false, followStream = null } = {}) {
  return {
    getContainer: () => ({
      inspect: async () => ({ Name: '/web', Config: { Tty: tty } }),
      logs: async (opts) => {
        if (opts.follow) return followStream;
        // TTY containers return raw text; non-TTY returns header-framed bytes.
        if (tty) return Buffer.from(`${TS} hello out\n${TS} hello err\n`);
        return Buffer.concat([
          frame(1, `${TS} hello out\n`),
          frame(2, `${TS} hello err\n`)
        ]);
      }
    })
  };
}

function fakePool(client) {
  return { withClient: async (_id, fn) => fn(client), on() {} };
}

function fakeStore(settings = { maxBufferLines: 5000, logTailLines: 100 }) {
  return { get: () => ({ settings }), on() {} };
}

function fakeLog() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function fakeSse() {
  const frames = [];
  return {
    frames,
    closed: false,
    sendT: (f) => frames.push(f),
    close() { this.closed = true; }
  };
}

test('fetchSnapshot parses non-TTY frames into stream-tagged lines', async () => {
  const svc = createLogService({ pool: fakePool(fakeClient()), store: fakeStore(), log: fakeLog() });
  const snap = await svc.fetchSnapshot('local', 'c1', 100, true);
  assert.equal(snap.tty, false);
  assert.equal(snap.name, 'web');
  assert.equal(snap.desynced, false);
  assert.deepEqual(snap.lines.map((l) => [l.s, l.m]), [['out', 'hello out'], ['err', 'hello err']]);
  assert.equal(snap.lastTs, TS);
});

test('fetchSnapshot parses TTY logs as plain text', async () => {
  const svc = createLogService({ pool: fakePool(fakeClient({ tty: true })), store: fakeStore(), log: fakeLog() });
  const snap = await svc.fetchSnapshot('local', 'c1', 100, true);
  assert.equal(snap.tty, true);
  assert.deepEqual(snap.lines.map((l) => [l.s, l.m]), [['out', 'hello out'], ['out', 'hello err']]);
});

test('openStream: snapshot first, then live lines from the follow stream', async () => {
  const follow = new EventEmitter();
  follow.destroy = () => {};
  const svc = createLogService({ pool: fakePool(fakeClient({ followStream: follow })), store: fakeStore(), log: fakeLog() });
  const sse = fakeSse();
  const view = await svc.openStream('local', 'c1', { sse });
  assert.ok(view);
  const snapshot = sse.frames.find((f) => f.t === 'snapshot');
  assert.equal(snapshot.tty, false);
  assert.equal(snapshot.lines.length, 2);
  assert.equal(sse.frames[sse.frames.length - 1].t, 'state');
  assert.equal(sse.frames[sse.frames.length - 1].state, 'live');
  // live line strictly after the snapshot boundary reaches the ring
  follow.emit('data', frame(1, `${TS} live line\n`));
  const line = sse.frames.find((f) => f.t === 'line' && f.m === 'live line');
  assert.ok(line, 'live line should be flushed');
  assert.equal(view.ring.length >= 3, true);
  follow.emit('end');
  assert.equal(sse.closed, true);
  assert.equal(svc.size(), 0);
});

test('openStream with `after`: no snapshot frame, staging flushed instead', async () => {
  const follow = new EventEmitter();
  follow.destroy = () => {};
  const svc = createLogService({ pool: fakePool(fakeClient({ followStream: follow })), store: fakeStore(), log: fakeLog() });
  const sse = fakeSse();
  await svc.openStream('local', 'c1', { sse, after: `${TS}` });
  assert.ok(!sse.frames.some((f) => f.t === 'snapshot'));
  follow.emit('data', frame(1, '2026-11-11T18:31:00.123456789Z after line\n'));
  assert.ok(sse.frames.some((f) => f.t === 'line' && f.m === 'after line'));
  svc.closeAll();
});

test('openStream surfaces follow errors with mapped codes', async () => {
  const follow = new EventEmitter();
  follow.destroy = () => {};
  const svc = createLogService({ pool: fakePool(fakeClient({ followStream: follow })), store: fakeStore(), log: fakeLog() });
  const sse = fakeSse();
  await svc.openStream('local', 'c1', { sse });
  follow.emit('error', Object.assign(new Error('boom'), { statusCode: 500, message: 'boom' }));
  const err = sse.frames.find((f) => f.t === 'state' && f.state === 'error');
  assert.ok(err);
  assert.equal(sse.closed, true);
});

test('openStream maps a vanished container to container-gone', async () => {
  const follow = new EventEmitter();
  follow.destroy = () => {};
  const svc = createLogService({ pool: fakePool(fakeClient({ followStream: follow })), store: fakeStore(), log: fakeLog() });
  const sse = fakeSse();
  await svc.openStream('local', 'c1', { sse });
  follow.emit('error', Object.assign(new Error('No such container'), { statusCode: 404 }));
  const closed = sse.frames.find((f) => f.t === 'state' && f.reason === 'container-gone');
  assert.ok(closed);
  assert.equal(sse.closed, true);
});

test('openStream reports unmappable daemon failures before opening', async () => {
  const pool = { withClient: async () => { throw new Error('connect ENOENT /var/run/docker.sock'); }, on() {} };
  const svc = createLogService({ pool, store: fakeStore(), log: fakeLog() });
  const sse = fakeSse();
  const view = await svc.openStream('local', 'c1', { sse });
  assert.equal(view, null);
  const err = sse.frames.find((f) => f.t === 'state' && f.state === 'error');
  assert.ok(err);
  assert.equal(sse.closed, true);
});

test('the 10-view cap answers STREAM_LIMIT and never opens an 11th', async () => {
  const follow = new EventEmitter();
  follow.destroy = () => {};
  const svc = createLogService({ pool: fakePool(fakeClient({ followStream: follow })), store: fakeStore(), log: fakeLog() });
  const views = [];
  for (let i = 0; i < svc.MAX_STREAMS; i += 1) {
    views.push(await svc.openStream('local', 'c1', { sse: fakeSse() }));
  }
  const sse11 = fakeSse();
  const rejected = await svc.openStream('local', 'c1', { sse: sse11 });
  assert.equal(rejected, null);
  assert.equal(sse11.frames[0].code, 'STREAM_LIMIT');
  assert.equal(sse11.closed, true);
  svc.closeAll();
  assert.equal(svc.size(), 0);
});

test('closeAll honours the hostId filter', async () => {
  const follow = new EventEmitter();
  follow.destroy = () => {};
  const svc = createLogService({ pool: fakePool(fakeClient({ followStream: follow })), store: fakeStore(), log: fakeLog() });
  const a = fakeSse();
  const b = fakeSse();
  await svc.openStream('local', 'c1', { sse: a });
  await svc.openStream('other', 'c2', { sse: b });
  svc.closeAll('local');
  assert.equal(a.closed, true);
  assert.equal(b.closed, false);
  svc.closeAll();
});

test('export helpers: toExportText keeps timestamps, safeName sanitises', () => {
  const svc = createLogService({ pool: fakePool(fakeClient()), store: fakeStore(), log: fakeLog() });
  assert.equal(svc.toExportText([{ ts: 'T', m: 'a' }, { ts: null, m: 'b' }]), 'T a\nb\n');
  assert.equal(safeName('/etc/passwd'), 'etc-passwd');
  assert.equal(safeName('a\x00b*|c'), 'a-b-c');
  assert.equal(safeName(''), 'container');
  assert.ok(/^(19|20)\d\d/.test(stamp()));
  assert.equal(
    truncLine('x'.repeat(8200)),
    'x'.repeat(8192) + '… [truncated 8 chars]'
  );
});

test('ringTrim drops oldest lines beyond the configured cap', () => {
  const svc = createLogService({ pool: fakePool(fakeClient()), store: fakeStore({ maxBufferLines: 2 }), log: fakeLog() });
  const ring = [1, 2, 3, 4];
  assert.equal(svc.ringTrim(ring), 2);
  assert.deepEqual(ring, [3, 4]);
});
