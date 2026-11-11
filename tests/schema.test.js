'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validate, applyEnvOverrides, defaultConfig, ConfigError, parseDockerHost } = require('../src/config/schema');

test('defaults validate and round-trip', () => {
  const { config, warnings } = validate(defaultConfig());
  assert.equal(warnings.length, 0);
  assert.equal(config.version, '1');
  assert.equal(config.hosts[0].id, 'local');
  assert.equal(config.settings.activeHostId, 'local');
});

test('wrong version rejects the file', () => {
  assert.throws(() => validate({ version: '2' }), (e) => e instanceof ConfigError && e.code === 'CONFIG_INVALID');
  assert.throws(() => validate(null), (e) => e.code === 'CONFIG_INVALID');
});

test('invalid hosts are dropped, valid ones kept', () => {
  const { config, warnings } = validate({
    version: '1',
    hosts: [
      { id: 'ok', name: 'good', access: 'socket', socketPath: '/var/run/docker.sock' },
      { id: 'Bad ID!', access: 'socket', socketPath: '/x' },
      { id: 'tcp1', access: 'tcp', url: 'not a url' },
      { id: 'tcp2', name: 'box', access: 'tcp', url: 'tcp://10.0.0.5:2376' },
      { id: 'ssh1', access: 'ssh', sshHost: 'nas', sshUser: 'ops', sshPort: 99999 },
      { id: 'ssh2', access: 'ssh', sshHost: 'nas', sshUser: 'ops' }
    ]
  });
  assert.deepEqual(config.hosts.map((h) => h.id).sort(), ['ok', 'ssh2', 'tcp2']);
  assert.equal(config.hosts.find((h) => h.id === 'ssh2').sshPort, 22);
  assert.ok(warnings.length >= 3);
});

test('duplicate host ids are dropped and lists are capped at 10', () => {
  const hosts = [];
  for (let i = 0; i < 12; i += 1) {
    hosts.push({ id: `h${i}`, access: 'socket', socketPath: '/var/run/docker.sock' });
  }
  hosts.push({ id: 'h0', access: 'socket', socketPath: '/var/run/docker.sock' });
  const { config, warnings } = validate({ version: '1', hosts });
  assert.equal(config.hosts.length, 10);
  assert.ok(warnings.some((w) => w.includes('duplicated')));
  assert.ok(warnings.some((w) => w.includes('first 10')));
});

test('notes: invalid entries dropped, values clamped shape', () => {
  const { config, warnings } = validate({
    version: '1',
    notes: {
      good: { note: 'hello', updatedAt: '2026-11-11T09:12:00.000Z', containerId: 'abc123' },
      long: { note: 'x'.repeat(2001) },
      bad: 'not an object',
      empty: {}
    }
  });
  assert.deepEqual(Object.keys(config.notes), ['good']);
  assert.equal(config.notes.good.updatedAt, '2026-11-11T09:12:00.000Z');
  assert.ok(warnings.length >= 3);
});

test('settings are clamped and enums validated', () => {
  const { config, warnings } = validate({
    version: '1',
    settings: {
      logTailLines: 999999,
      stopTimeoutSeconds: -5,
      statsIntervalMs: 10,
      maxBufferLines: 1,
      theme: 'neon',
      activeHostId: 'ghost',
      showTimestamps: false
    }
  });
  assert.equal(config.settings.logTailLines, 10000);
  assert.equal(config.settings.stopTimeoutSeconds, 0);
  assert.equal(config.settings.statsIntervalMs, 500);
  assert.equal(config.settings.maxBufferLines, 100);
  assert.equal(config.settings.theme, 'system');
  assert.equal(config.settings.activeHostId, 'local');
  assert.equal(config.settings.showTimestamps, false);
  assert.ok(warnings.length >= 5);
});

test('compose.folder must be absolute and eventFilter is intersected', () => {
  const { config, warnings } = validate({
    version: '1',
    compose: { folder: 'relative/path', projects: [{ name: 'a', path: 'a', file: 'docker-compose.yml' }, { name: 'bad' }] },
    eventFilter: { types: ['start', 'die', 'bogus'] }
  });
  assert.equal(config.compose.folder, '/compose');
  assert.equal(config.compose.projects.length, 1);
  assert.deepEqual(config.eventFilter.types, ['start', 'die']);
  assert.ok(warnings.length >= 3);
});

test('parseDockerHost understands unix, tcp and ssh forms', () => {
  assert.deepEqual(parseDockerHost('unix:///custom/docker.sock'), { access: 'socket', socketPath: '/custom/docker.sock' });
  assert.equal(parseDockerHost('tcp://10.0.0.9:2376').url, 'http://10.0.0.9:2376');
  const ssh = parseDockerHost('ssh://ops@nas:2222');
  assert.deepEqual(ssh, { access: 'ssh', sshHost: 'nas', sshUser: 'ops', sshPort: 2222 });
  assert.throws(() => parseDockerHost('ftp://x'), (e) => e.code === 'CONFIG_INVALID');
});

test('environment overrides win over the file (D-021)', () => {
  const base = defaultConfig();
  base.hosts.push({ id: 'prod', name: 'prod', access: 'tcp', url: 'tcp://10.0.0.2:2375' });
  base.settings.activeHostId = 'prod';
  const merged = applyEnvOverrides(base, {
    composeFolder: '/mnt/compose',
    logTailLines: 250,
    stopTimeoutSeconds: 30,
    dockerHost: 'unix:///custom.sock'
  });
  assert.equal(merged.compose.folder, '/mnt/compose');
  assert.equal(merged.settings.logTailLines, 250);
  assert.equal(merged.settings.stopTimeoutSeconds, 30);
  const local = merged.hosts.find((h) => h.id === 'local');
  assert.equal(local.socketPath, '/custom.sock');
  assert.equal(local.managedByEnv, true);
  // DOCKER_HOST manages the local entry only; the active host is untouched
  assert.equal(merged.settings.activeHostId, 'prod');
});
