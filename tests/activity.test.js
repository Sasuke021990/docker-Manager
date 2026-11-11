'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createActivity, CAP } = require('../src/core/activity');

// UT-008: the action ring buffer (FR-031, D-013) — last 100, in memory.

test('ring keeps the last 100 events, newest first (UT-008)', () => {
  const activity = createActivity(null);
  for (let i = 0; i < 120; i += 1) {
    activity.append({ action: 'start', container: `c${i}`, result: 'ok', state: 'running' });
  }
  assert.equal(activity.size(), CAP);
  const list = activity.list();
  assert.equal(list[0].container, 'c119');
  assert.equal(list[list.length - 1].container, 'c20'); // c0…c19 evicted
  assert.ok(!list.some((e) => e.container === 'c0'));
});

test('entries carry action, container, result, timestamp and unique ids', () => {
  const activity = createActivity(null);
  const a = activity.append({ action: 'stop', container: 'web', result: 'ok', state: 'exited' });
  const b = activity.append({ action: 'stop', container: 'db', result: 'failed', message: 'nope' });
  assert.match(a.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.notEqual(a.id, b.id);
  assert.equal(a.action, 'stop');
  assert.equal(a.result, 'ok');
  assert.equal(b.result, 'failed');
  assert.equal(b.message, 'nope');
});

test('append publishes to the bus for the live badge', () => {
  const seen = [];
  const bus = { publish: (channel, data) => seen.push([channel, data]) };
  const activity = createActivity(bus);
  const rec = activity.append({ action: 'kill', container: 'web', result: 'ok' });
  assert.deepEqual(seen, [['activity.appended', rec]]);
});
