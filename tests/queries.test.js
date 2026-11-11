'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseStatus,
  matchLabelFilter,
  applyFilter,
  buildRow,
  stateBucket,
  filterLabels
} = require('../src/docker/queries');

// UT-003: the pure read-model seams (FR-002, FR-003, FR-011, FR-083).

test('parseStatus falls back to the list Status string', () => {
  assert.deepEqual(parseStatus('Up 3 hours (healthy)'), {
    uptimeSec: 3 * 3600,
    exitCode: null
  });
  assert.deepEqual(parseStatus('Up 2 weeks 3 days 4 hours 5 minutes 6 seconds'), {
    uptimeSec: 2 * 604800 + 3 * 86400 + 4 * 3600 + 5 * 60 + 6,
    exitCode: null
  });
  assert.deepEqual(parseStatus('Exited (1) 2 hours ago'), {
    uptimeSec: null,
    exitCode: 1
  });
  assert.deepEqual(parseStatus('Created'), { uptimeSec: null, exitCode: null });
  assert.deepEqual(parseStatus(undefined), { uptimeSec: null, exitCode: null });
});

test('state buckets follow FR-003 (restarting counts as running)', () => {
  assert.equal(stateBucket('running'), 'running');
  assert.equal(stateBucket('restarting'), 'running');
  assert.equal(stateBucket('exited'), 'stopped');
  assert.equal(stateBucket('created'), 'stopped');
  assert.equal(stateBucket('dead'), 'stopped');
  assert.equal(stateBucket('paused'), 'paused');
});

test('matchLabelFilter ANDs key=value, key!=value, bare key (FR-083)', () => {
  const labels = { env: 'prod', tier: 'web' };
  assert.equal(matchLabelFilter(labels, []), true);
  assert.equal(matchLabelFilter(labels, null), true);
  assert.equal(matchLabelFilter(labels, ['env=prod']), true);
  assert.equal(matchLabelFilter(labels, ['env=prod', 'tier']), true);
  assert.equal(matchLabelFilter(labels, ['env=prod', 'env!=dev']), true);
  assert.equal(matchLabelFilter(labels, ['env=dev']), false);
  assert.equal(matchLabelFilter(labels, ['env!=prod']), false);
  assert.equal(matchLabelFilter(labels, ['missing']), false);
  assert.equal(matchLabelFilter(null, ['missing']), false);
  // mixed semantics: `key!=value` passes when key is absent
  assert.equal(matchLabelFilter({}, ['env!=prod']), true);
});

test('applyFilter counts buckets, filters state+q, sorts (FR-003/FR-011)', () => {
  const rows = [
    { name: 'beta', image: 'nginx', state: 'exited' },
    { name: 'alpha', image: 'postgres:17', state: 'running' },
    { name: 'gamma', image: 'nginx', state: 'paused' },
    { name: 'delta', image: 'redis', state: 'restarting' }
  ];
  const all = applyFilter(rows, { state: 'all', q: '' });
  assert.deepEqual(all.counts, { all: 4, running: 2, stopped: 1, paused: 1 });
  assert.deepEqual(all.rows.map((r) => r.name), ['alpha', 'beta', 'delta', 'gamma']);

  const running = applyFilter(rows, { state: 'running', q: '' });
  assert.deepEqual(running.rows.map((r) => r.name), ['alpha', 'delta']);

  const q = applyFilter(rows, { state: 'all', q: 'NGIN' });
  assert.deepEqual(q.rows.map((r) => r.name), ['beta', 'gamma']);
  // q matches image too
  const qi = applyFilter(rows, { state: 'all', q: 'postgres' });
  assert.deepEqual(qi.rows.map((r) => r.name), ['alpha']);

  const desc = applyFilter(rows, { state: 'all', q: '', sort: 'name', dir: 'desc' });
  assert.deepEqual(desc.rows.map((r) => r.name), ['gamma', 'delta', 'beta', 'alpha']);

  // counts always reflect the unfiltered set
  assert.equal(q.counts.all, 4);
});

test('buildRow is partial without inspect and rich with one (§4.2.3)', () => {
  const listEntry = {
    Id: 'a'.repeat(64),
    Names: ['/web'],
    Image: 'nginx:alpine',
    ImageID: 'sha256:' + 'b'.repeat(64),
    State: 'running',
    Status: 'Up 3 hours (healthy)',
    Created: 1700000000,
    Ports: [{ IP: '0.0.0.0', PublicPort: 8080, PrivatePort: 80, Type: 'tcp' }],
    Labels: { 'com.docker.compose.project': 'stack-a', 'com.docker.compose.service': 'web' }
  };

  const partial = buildRow(listEntry, null, { now: 1700000000000 });
  assert.equal(partial.partial, true);
  assert.equal(partial.idShort, 'a'.repeat(12));
  assert.equal(partial.name, 'web');
  assert.equal(partial.restarts, null);
  assert.equal(partial.uptimeSec, 3 * 3600); // parsed from Status
  assert.deepEqual(partial.compose, { project: 'stack-a', service: 'web' });

  const inspect = {
    State: {
      Status: 'running',
      StartedAt: '2023-11-14T22:13:20.000000000Z',
      ExitCode: 0,
      Health: { Status: 'healthy' }
    },
    RestartCount: 2,
    Config: { Labels: { env: 'prod' } }
  };
  const full = buildRow(listEntry, inspect, {
    selfId: 'a'.repeat(64),
    noteStatus: 'exact',
    now: 1700000000000 + 60 * 60 * 1000
  });
  assert.equal(full.partial, false);
  assert.equal(full.health, 'healthy');
  assert.equal(full.restarts, 2);
  assert.equal(full.uptimeSec, 3600);
  assert.equal(full.self, true);
  assert.equal(full.hasNote, true);
  assert.equal(buildRow(listEntry, inspect, { noteStatus: 'foreign' }).hasNote, false);
  assert.equal(buildRow(listEntry, inspect, { noteStatus: 'recreated' }).hasNote, true);
});

test('filterLabels applies the display allowlist (SEC-005-adjacent)', () => {
  const out = filterLabels({
    'org.opencontainers.image.description': 'ok',
    'com.docker.compose.project': 'ok',
    'traefik.enable': 'true',
    'secret.token': 'nope',
    'env': 'nope'
  });
  assert.deepEqual(Object.keys(out).sort(), [
    'com.docker.compose.project',
    'org.opencontainers.image.description',
    'traefik.enable'
  ]);
});
