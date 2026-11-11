'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { describe, pickImageLabel } = require('../src/core/describe');

// UT-002: precedence note > image label > compose > image ref (FR-008),
// with the compose source always shown separately in the provenance line.

test('note wins over every other source (UT-002)', () => {
  const out = describe({
    note: 'billing db, do not touch',
    imageLabels: { 'org.opencontainers.image.description': 'Postgres 17' },
    compose: { project: 'stack-a', service: 'db' },
    imageRef: 'postgres:17'
  });
  assert.equal(out.primary, 'billing db, do not touch');
});

test('image label beats compose beats image ref', () => {
  const withLabel = describe({
    note: null,
    imageLabels: { description: 'Queue worker' },
    compose: { project: 'stack-b', service: 'worker' },
    imageRef: 'registry/worker:2'
  });
  assert.equal(withLabel.primary, 'Queue worker');

  const composeOnly = describe({
    note: null,
    imageLabels: {},
    compose: { project: 'stack-b', service: 'api' },
    imageRef: 'registry/api:2'
  });
  assert.equal(composeOnly.primary, 'stack-b / api');

  const refOnly = describe({
    note: null,
    imageLabels: null,
    compose: null,
    imageRef: 'nginx:alpine'
  });
  assert.equal(refOnly.primary, 'nginx:alpine');
});

test('compose is shown separately in sources even when note is primary', () => {
  const out = describe({
    note: 'my note',
    imageLabels: { 'org.opencontainers.image.description': 'Desc' },
    compose: { project: 'stack-a', service: 'api' },
    imageRef: 'img'
  });
  const kinds = out.sources.map((s) => s.kind);
  assert.deepEqual(kinds, ['note', 'compose', 'image']); // display order
  assert.ok(out.sources.some((s) => s.kind === 'compose' && s.label === 'stack-a / api'));
});

test('pickImageLabel follows the key order and skips blanks', () => {
  assert.equal(pickImageLabel({
    'org.opencontainers.image.title': 'Title',
    description: 'Plain'
  }), 'Title');
  assert.equal(pickImageLabel({ description: 'Plain' }), 'Plain');
  assert.equal(pickImageLabel({ description: '   ' }), null);
  assert.equal(pickImageLabel(null), null);
});
