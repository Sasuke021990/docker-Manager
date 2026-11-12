'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalise, parseHealth, baseAction, EventRing } = require('../src/docker/events');

test('normalise whitelists attributes and splits health action', () => {
  const ev = normalise({
    Type: 'container',
    Action: 'health_status: unhealthy',
    timeNano: 1762862400123000000,
    Actor: {
      ID: 'abc123def4567890',
      Attributes: {
        name: '/web',
        image: 'nginx:1.27',
        exitCode: '137',
        'com.docker.compose.project': 'stack-a',
        SECRET: 'nope'
      }
    }
  }, 'local');
  assert.equal(ev.action, 'health_status');
  assert.equal(ev.health, 'unhealthy');
  assert.equal(ev.name, 'web');
  assert.equal(ev.attributes.exitCode, '137');
  assert.equal(ev.attributes.SECRET, undefined);
  assert.equal(ev.attributes['com.docker.compose.project'], 'stack-a');
  assert.ok(Math.abs(ev.at - 1762862400.123) < 0.001);
});

test('parseHealth/baseAction', () => {
  assert.equal(baseAction('die'), 'die');
  assert.equal(baseAction('health_status: healthy'), 'health_status');
  assert.equal(parseHealth('health_status: healthy'), 'healthy');
  assert.equal(parseHealth('die'), null);
});

test('EventRing caps at 500 and replays since seq', () => {
  const ring = new EventRing(5);
  for (let i = 1; i <= 7; i += 1) ring.push({ seq: i, action: 'x' });
  assert.deepEqual(ring.list(10).map((e) => e.seq), [3, 4, 5, 6, 7]);
  assert.deepEqual(ring.since(5).map((e) => e.seq), [6, 7]);
  assert.deepEqual(ring.since(7), []);
  assert.equal(ring.since(1), null); // gap (evicted)
});
