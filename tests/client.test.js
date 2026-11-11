'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { modemOptions, readTlsMaterial, negotiate, cmpVersion, minVersion, normalise } = require('../src/docker/client');

const noEnv = { sshAuthSock: '/nonexistent/ssh-agent.sock', dockerCertPath: null, dockerApiVersion: null };

test('socket access builds a socketPath modem option set', () => {
  const opts = modemOptions({ access: 'socket', socketPath: '/var/run/docker.sock' }, noEnv);
  assert.deepEqual(opts, { socketPath: '/var/run/docker.sock', timeout: 0, connectionTimeout: 5000 });
});

test('plain tcp and tls tcp build host/port/protocol options', () => {
  const plain = modemOptions({ access: 'tcp', url: 'tcp://10.0.0.2:2375' }, noEnv);
  assert.equal(plain.host, '10.0.0.2');
  assert.equal(plain.port, 2375);
  assert.equal(plain.protocol, 'http');
  assert.equal(plain.timeout, 0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-tls-'));
  for (const f of ['ca.pem', 'cert.pem', 'key.pem']) fs.writeFileSync(path.join(dir, f), `contents-of-${f}`);
  const tls = modemOptions({ access: 'tcp', url: 'https://10.0.0.2', tls: { ca: path.join(dir, 'ca.pem'), cert: path.join(dir, 'cert.pem'), key: path.join(dir, 'key.pem') } }, noEnv);
  assert.equal(tls.protocol, 'https');
  assert.equal(tls.port, 2376);
  assert.ok(Buffer.isBuffer(tls.ca));
});

test('TLS material errors name the file, never the contents (SEC-006)', () => {
  try {
    readTlsMaterial({ ca: '/certs/missing-ca.pem', cert: '/certs/cert.pem', key: '/certs/key.pem' });
    assert.fail('should throw');
  } catch (err) {
    assert.equal(err.code, 'DOCKER_TLS_MATERIAL_MISSING');
    assert.ok(err.message.includes('/certs/missing-ca.pem'));
    assert.ok(!err.message.includes('contents'));
  }
});

test('ssh access needs a live ssh-agent socket (FR-085)', () => {
  assert.throws(
    () => modemOptions({ access: 'ssh', sshHost: 'nas', sshUser: 'ops', sshPort: 22 }, noEnv),
    (e) => e.code === 'DOCKER_SSH_AGENT_MISSING'
  );

  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-agent-')), 'agent.sock');
  fs.writeFileSync(sock, '');
  const opts = modemOptions({ access: 'ssh', sshHost: 'nas', sshUser: 'ops', sshPort: 2222 }, { ...noEnv, sshAuthSock: sock });
  assert.equal(opts.protocol, 'ssh');
  assert.equal(opts.username, 'ops');
  assert.equal(opts.port, 2222);
  assert.deepEqual(opts.sshOptions, { agent: sock });
});

test('version comparison and normalisation', () => {
  assert.equal(cmpVersion('1.40', '1.39'), 1);
  assert.equal(cmpVersion('1.40', '1.40'), 0);
  assert.equal(cmpVersion('1.9', '1.10'), -1);
  assert.equal(minVersion('1.56', '1.49'), '1.49');
  assert.equal(normalise('v1.44'), '1.44');
  assert.throws(() => normalise('latest'), (e) => e.code === 'API_VERSION_UNSUPPORTED');
});

function fakeClient(apiVersion) {
  return { modem: {}, version: async () => ({ ApiVersion: apiVersion, Version: '27.0' }) };
}

test('negotiation: floor, pin and max (FR-088, FR-089)', async () => {
  const env = { ...noEnv };

  await assert.rejects(negotiate(fakeClient('1.39'), env), (e) => {
    assert.equal(e.code, 'DAEMON_TOO_OLD');
    assert.ok(e.message.includes('1.40'));
    return true;
  });

  const capped = await negotiate(fakeClient('1.60'), env);
  assert.equal(capped.apiVersion, '1.56'); // APP_MAX_API wins over a newer daemon
  assert.equal(capped.maxApiVersion, '1.60');

  const chosen = await negotiate(fakeClient('1.44'), env);
  assert.equal(chosen.apiVersion, '1.44');

  const pinned = await negotiate(fakeClient('1.44'), { ...env, dockerApiVersion: '1.41' });
  assert.equal(pinned.apiVersion, '1.41');

  await assert.rejects(
    negotiate(fakeClient('1.44'), { ...env, dockerApiVersion: '1.50' }),
    (e) => e.code === 'API_VERSION_UNSUPPORTED' && e.message.includes('1.50') && e.message.includes('1.44')
  );
});

test('negotiation pins modem.version so every dial uses it', async () => {
  const client = fakeClient('1.52');
  await negotiate(client, noEnv);
  assert.equal(client.modem.version, 'v1.52');
});
