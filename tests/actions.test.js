'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createActions, VERBS } = require('../src/docker/actions');
const { createActivity } = require('../src/core/activity');

// P2 action layer (FR-020…FR-029, SEC-008): verb allowlist, stop timeout
// from settings, rm modes, self-guard, activity recording.

const ID = 'a'.repeat(64);

function harness({ inspectState = 'running', failVerb = null, failInspect = false } = {}) {
  const calls = [];
  const container = {
    inspect: async () => {
      calls.push(['inspect']);
      if (failInspect) {
        const e = new Error('No such container: ' + ID);
        e.statusCode = 404;
        throw e;
      }
      return { Id: ID, Name: '/web', State: { Status: inspectState, ExitCode: 0 } };
    },
    start: async () => { if (failVerb === 'start') { const e = new Error('daemon exploded'); e.statusCode = 500; throw e; } calls.push(['start']); },
    stop: async (o) => calls.push(['stop', o]),
    restart: async (o) => calls.push(['restart', o]),
    kill: async () => calls.push(['kill']),
    pause: async () => calls.push(['pause']),
    unpause: async () => calls.push(['unpause']),
    remove: async (o) => calls.push(['remove', o])
  };
  const pool = {
    selfId: null,
    getSelfId() { return this.selfId; },
    setSelfId(v) { this.selfId = v; },
    withClient: (hostId, fn) => fn({ getContainer: () => container })
  };
  const store = { get: () => ({ settings: { stopTimeoutSeconds: 7 } }) };
  const queries = { invalidate: (id) => calls.push(['invalidate', id]) };
  const activity = createActivity(null);
  const log = { info() {}, debug() {}, warn() {}, error() {} };
  const actions = createActions({ env: {}, pool, store, queries, activity, log });
  return { actions, pool, activity, calls };
}

test('verb allowlist matches the API contract (design §4.2.2)', () => {
  assert.deepEqual([...VERBS].sort(), ['kill', 'pause', 'restart', 'start', 'stop', 'unpause']);
});

test('unknown verb is BAD_REQUEST and touches nothing', async () => {
  const { actions, calls, activity } = harness();
  await assert.rejects(
    actions.run('local', ID, 'rm'),
    (e) => e.code === 'BAD_REQUEST' && /Unknown action/.test(e.message)
  );
  assert.equal(calls.length, 0);
  assert.equal(activity.size(), 0);
});

test('stop sends SIGTERM then SIGKILL after the configured timeout (FR-021)', async () => {
  const { actions, calls, activity } = harness({ inspectState: 'running' });
  const out = await actions.run('local', ID, 'stop');
  assert.deepEqual(out, { ok: true, state: 'running' }); // state read after the call
  assert.deepEqual(calls.filter((c) => c[0] !== 'inspect' && c[0] !== 'invalidate'), [['stop', { t: 7 }]]);
  const events = activity.list();
  assert.equal(events[0].action, 'stop');
  assert.equal(events[0].container, 'web');
  assert.equal(events[0].result, 'ok');
});

test('remove a running container: stop-first and force modes (FR-025)', async () => {
  const stopFirst = harness({ inspectState: 'running' });
  await stopFirst.actions.remove('local', ID, { mode: 'stop' });
  const calls1 = stopFirst.calls.filter((c) => c[0] === 'stop' || c[0] === 'remove');
  assert.deepEqual(calls1, [['stop', { t: 7 }], ['remove', { v: false, force: false }]]);

  const force = harness({ inspectState: 'running' });
  await force.actions.remove('local', ID, { mode: 'force' });
  const calls2 = force.calls.filter((c) => c[0] === 'stop' || c[0] === 'remove');
  assert.deepEqual(calls2, [['remove', { v: false, force: true }]]);

  // stopped container with no mode: plain remove, never --volumes (§7.6.2)
  const plain = harness({ inspectState: 'exited' });
  await plain.actions.remove('local', ID, {});
  assert.deepEqual(plain.calls.filter((c) => c[0] === 'remove'), [['remove', { v: false, force: false }]]);
});

test('self container: destructive verbs refused, unpause allowed (SEC-008)', async () => {
  const { actions, pool, calls } = harness({ inspectState: 'paused' });
  pool.setSelfId(ID);
  for (const verb of ['start', 'stop', 'kill', 'pause', 'restart']) {
    await assert.rejects(
      actions.run('local', ID, verb),
      (e) => e.code === 'SELF_PROTECTED' && e.action === verb,
      verb
    );
  }
  await assert.rejects(actions.remove('local', ID, {}), (e) => e.code === 'SELF_PROTECTED');
  const out = await actions.run('local', ID, 'unpause'); // recovery stays open
  assert.equal(out.ok, true);
  assert.ok(calls.some((c) => c[0] === 'unpause'));
});

test('failures map to the taxonomy and land in activity verbatim (FR-029, FR-031)', async () => {
  const { actions, activity } = harness({ failVerb: 'start' });
  await assert.rejects(
    actions.run('local', ID, 'start'),
    (e) => e.code === 'DOCKER_ERROR' && e.message === 'daemon exploded'
  );
  const events = activity.list();
  assert.equal(events[0].result, 'failed');
  assert.equal(events[0].message, 'daemon exploded');
  assert.equal(events[0].action, 'start');
});

test('a missing container is CONTAINER_NOT_FOUND', async () => {
  const { actions } = harness({ failInspect: true });
  await assert.rejects(
    actions.run('local', ID, 'start'),
    (e) => e.code === 'CONTAINER_NOT_FOUND'
  );
});
