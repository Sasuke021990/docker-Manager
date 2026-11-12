'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { demux, splitTimestamp } = require('../src/docker/demux');

function frame(stream, text) {
  const payload = Buffer.from(text, 'utf8');
  const h = Buffer.alloc(8);
  h[0] = stream;
  h.writeUInt32BE(payload.length, 4);
  return Buffer.concat([h, payload]);
}

// UT-004: 8-byte header frames split into stdout/stderr; partial frames
// are carried; desync is reported (never crashes).

test('demux splits stdout and stderr frames', () => {
  const buf = Buffer.concat([
    frame(1, 'out line\n'),
    frame(2, 'err line\n')
  ]);
  const out = demux(buf);
  assert.equal(out.desync, false);
  assert.equal(out.rest.length, 0);
  assert.deepEqual(out.frames.map((f) => [f.stream, f.payload.toString('utf8')]), [
    ['out', 'out line\n'],
    ['err', 'err line\n']
  ]);
});

test('demux carries an incomplete frame and completes on next chunk', () => {
  const full = frame(1, 'hello world\n');
  const a = full.subarray(0, 10);
  const b = full.subarray(10);
  const r1 = demux(a);
  assert.equal(r1.frames.length, 0);
  assert.equal(r1.rest.length, a.length);
  const r2 = demux(Buffer.concat([Buffer.from(r1.rest), b]));
  assert.equal(r2.desync, false);
  assert.equal(r2.frames.length, 1);
  assert.equal(r2.frames[0].payload.toString('utf8'), 'hello world\n');
});

test('demux reports desync on invalid stream type (caller falls back to raw)', () => {
  const bad = Buffer.alloc(8);
  bad[0] = 9;
  bad.writeUInt32BE(5, 4);
  const out = demux(bad);
  assert.equal(out.desync, true);
  assert.equal(out.frames.length, 0);
});

test('splitTimestamp parses RFC3339Nano prefix', () => {
  assert.deepEqual(
    splitTimestamp('2026-11-11T18:30:00.123456789Z hello world'),
    { ts: '2026-11-11T18:30:00.123456789Z', m: 'hello world' }
  );
  assert.deepEqual(splitTimestamp('no ts here'), { ts: null, m: 'no ts here' });
});
