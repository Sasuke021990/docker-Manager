'use strict';

// UT-008 (activity half): the action ring holds exactly 100 entries.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createActivity } = require('../src/core/activity');
const { Bus } = require('../src/core/bus');

test('activity ring caps at 100 and returns newest first (FR-031)', () => {
  const activity = createActivity();
  for (let i = 0; i < 101; i += 1) {
    activity.append({ action: 'stop', container: `c${i}`, result: 'ok' });
  }
  assert.equal(activity.size(), 100);
  const list = activity.list();
  assert.equal(list.length, 100);
  assert.equal(list[0].container, 'c100'); // newest first
  assert.equal(list[99].container, 'c1');
});

test('activity publishes to the bus', () => {
  const bus = new Bus();
  const seen = [];
  bus.on('activity.appended', (e) => seen.push(e));
  const activity = createActivity(bus);
  activity.append({ action: 'start', container: 'web', result: 'ok' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].action, 'start');
  assert.ok(seen[0].at);
});

test('bus assigns monotonic sequence numbers', () => {
  const bus = new Bus();
  const a = bus.publish('host.health', { hostId: 'local', state: 'reachable' });
  const b = bus.publish('docker.event', { containerId: 'x' });
  assert.ok(b > a);
  assert.throws(() => bus.publish('unknown.channel', {}));
});
