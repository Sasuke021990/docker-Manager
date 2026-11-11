'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DockerError, mapDockerError, TABLE } = require('../src/docker/errors');

test('every taxonomy code maps to an HTTP status and a CLI exit code', () => {
  for (const [code, mapping] of Object.entries(TABLE)) {
    assert.ok(mapping.http >= 400 && mapping.http <= 599, code);
    assert.ok(typeof mapping.cli === 'number', code);
    const err = new DockerError(code, 'x');
    assert.equal(err.code, code);
    assert.equal(err.httpStatus, mapping.http);
    assert.equal(err.cliExit, mapping.cli);
    assert.deepEqual(Object.keys(err.toJSON().error).sort(), ['code', 'message']);
  }
});

test('unknown codes fall back to DOCKER_ERROR', () => {
  const err = new DockerError('NO_SUCH_CODE', 'boom');
  assert.equal(err.code, 'DOCKER_ERROR');
  assert.equal(err.httpStatus, 500);
});

test('daemon messages are preserved verbatim (NFR-045)', () => {
  const daemonErr = { statusCode: 500, json: { message: 'driver "overlay2" failed to mount' }, message: '500 - driver failed' };
  const mapped = mapDockerError(daemonErr);
  assert.equal(mapped.code, 'DOCKER_ERROR');
  assert.equal(mapped.message, 'driver "overlay2" failed to mount');
});

test('dockerode status codes map to the taxonomy', () => {
  assert.equal(mapDockerError({ statusCode: 404, json: { message: 'No such container: web' } }).code, 'CONTAINER_NOT_FOUND');
  assert.equal(mapDockerError({ statusCode: 409, json: { message: 'container is running' } }).code, 'CONTAINER_STATE_CONFLICT');
  assert.equal(mapDockerError({ statusCode: 304 }), null); // already in the desired state
});

test('connection errno maps to DOCKER_UNREACHABLE', () => {
  const mapped = mapDockerError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED /var/run/docker.sock' });
  assert.equal(mapped.code, 'DOCKER_UNREACHABLE');
  assert.equal(mapped.httpStatus, 503);
});

test('ssh failures on an ssh host map to DOCKER_SSH_AGENT_MISSING when agent-related', () => {
  const mapped = mapDockerError({ code: 'ECONNREFUSED', message: 'ssh agent refused the connection' }, { access: 'ssh' });
  assert.equal(mapped.code, 'DOCKER_SSH_AGENT_MISSING');
});

test('action and containerId ride along in the envelope', () => {
  const err = new DockerError('SELF_PROTECTED', 'Refusing: this is Docker Manager\'s own container.', { action: 'stop', containerId: '3f2a' });
  assert.deepEqual(err.toJSON(), {
    error: {
      code: 'SELF_PROTECTED',
      message: 'Refusing: this is Docker Manager\'s own container.',
      action: 'stop',
      containerId: '3f2a'
    }
  });
});

test('DockerError instances pass through mapDockerError unchanged', () => {
  const original = new DockerError('SELF_PROJECT', 'nope');
  assert.equal(mapDockerError(original), original);
});
