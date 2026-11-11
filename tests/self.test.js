'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { assertNotSelf, isSelf, needsRefresh } = require('../src/docker/self');

function fakePool(selfId) {
  let id = selfId;
  return { getSelfId: () => id, setSelfId: (v) => { id = v; } };
}

test('self identification blocks destructive verbs (SEC-008, UT-006)', () => {
  const pool = fakePool('3f2a9c1b7d4e1111');
  for (const verb of ['start', 'stop', 'kill', 'rm', 'pause', 'restart']) {
    assert.throws(
      () => assertNotSelf(pool, {}, '3f2a9c1b7d4e', 'web', verb),
      (e) => e.code === 'SELF_PROTECTED' && e.action === verb,
      verb
    );
  }
});

test('unpause and read-only verbs stay available for recovery (FR-013)', () => {
  const pool = fakePool('3f2a9c1b7d4e1111');
  assert.doesNotThrow(() => assertNotSelf(pool, {}, '3f2a9c1b7d4e', 'web', 'unpause'));
  assert.doesNotThrow(() => assertNotSelf(pool, {}, 'other1234567', 'web', 'stop'));
});

test('id prefix matching protects short ids too', () => {
  const pool = fakePool('3f2a9c1b7d4e1111');
  assert.equal(isSelf(pool, '3f2a9c1b7d4e'), true);
  assert.equal(isSelf(pool, 'zzzz'), false);
  assert.equal(isSelf(fakePool(null), '3f2a'), false);
});

test('fail closed when self identity is unresolved and the name matches our hostname', () => {
  const pool = fakePool(null);
  assert.throws(
    () => assertNotSelf(pool, {}, 'abc123', os.hostname(), 'stop'),
    (e) => e.code === 'SELF_UNVERIFIED'
  );
  // a different name is not refused, only the hostname match is
  assert.doesNotThrow(() => assertNotSelf(pool, {}, 'abc123', 'some-other-container', 'stop'));
});

test('needsRefresh throttles re-resolution to 60 s', () => {
  const pool = fakePool('self1234567890');
  assert.equal(needsRefresh(pool, new Set(['self1234567890'])), false);
  assert.equal(needsRefresh(pool, new Set(['other'])), true);
});
