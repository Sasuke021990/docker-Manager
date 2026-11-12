'use strict';

// UT-007: CLI argv parsing and exit-code mapping (FR-091–FR-095, design
// §3.10.1, §3.10.2). parseArgv and exitCodeFor are pure, so the contract is
// testable without a Docker daemon.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseArgv, exitCodeFor, run, UsageError, HELP } = require('../src/cli');
const { DockerError } = require('../src/docker/errors');
const { ConfigError } = require('../src/config/schema');

function parse(...argv) {
  return parseArgv(argv);
}

function usage(fn) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof UsageError, `expected UsageError, got ${err && err.name}`);
    assert.equal(err.name, 'UsageError');
    return true;
  });
}

test('parses a command with global and command flags in any order', () => {
  const a = parse('list', '--host', 'prod', '--json', '--state', 'running', '--q', 'api');
  assert.equal(a.command, 'list');
  assert.deepEqual(a.args, []);
  assert.deepEqual(a.flags, { host: 'prod', json: true, state: 'running', q: 'api' });

  const b = parse('--host', 'prod', 'list');
  assert.equal(b.command, 'list');
  assert.equal(b.flags.host, 'prod');
});

test('parses positional arguments for single-target commands', () => {
  const a = parse('inspect', 'web');
  assert.equal(a.command, 'inspect');
  assert.deepEqual(a.args, ['web']);

  const b = parse('logs', 'web-1', '--follow', '--tail', '25');
  assert.deepEqual(b.args, ['web-1']);
  assert.equal(b.flags.follow, true);
  assert.equal(b.flags.tail, '25');
});

test('parses compose subcommands', () => {
  const ls = parse('compose', 'ls', '--json');
  assert.equal(ls.command, 'compose');
  assert.equal(ls.sub, 'ls');
  assert.deepEqual(ls.args, []);
  assert.equal(ls.flags.json, true);

  const up = parse('compose', 'up', 'stack-a', '--detach');
  assert.equal(up.sub, 'up');
  assert.deepEqual(up.args, ['stack-a']);
  assert.equal(up.flags.detach, true);

  const down = parse('compose', 'down', 'stack-a', '--yes');
  assert.equal(down.sub, 'down');
  assert.equal(down.flags.yes, true);
});

test('accepts --flag=value and the -- separator', () => {
  const a = parse('list', '--state=paused');
  assert.equal(a.flags.state, 'paused');

  const b = parse('inspect', '--', 'web');
  assert.deepEqual(b.args, ['web']);
});

test('rejects unknown commands and unknown flags', () => {
  usage(() => parse('frobnicate'));
  usage(() => parse('list', '--frobnicate'));
  usage(() => parse('list', '-x'));
  usage(() => parse());
});

test('rejects a missing or swallowed flag value', () => {
  usage(() => parse('list', '--host')); // value missing at the end
  usage(() => parse('list', '--host', '--json')); // next token is a flag
  usage(() => parse('list', '--json=please')); // boolean given a value
});

test('rejects the wrong number of arguments', () => {
  usage(() => parse('list', 'extra'));
  usage(() => parse('inspect')); // needs one target
  usage(() => parse('compose')); // needs a subcommand
  usage(() => parse('compose', 'frobnicate', 'stack-a'));
  usage(() => parse('hosts', '--host', 'x')); // --host is not valid for hosts
});

test('validates flag values', () => {
  usage(() => parse('list', '--state', 'sideways'));
  usage(() => parse('logs', 'web', '--tail', 'abc'));
  usage(() => parse('logs', 'web', '--tail', '-1'));
  usage(() => parse('stop', 'web', '--timeout', '999'));
  usage(() => parse('kill', 'web', '--signal', 'SIG KILL'));
  usage(() => parse('events', '--since', 'yesterday'));
  usage(() => parse('rm', 'web', '--force', '--stop')); // mutually exclusive

  assert.equal(parse('list', '--state', 'running').flags.state, 'running');
  assert.equal(parse('logs', 'web', '--tail', '10000').flags.tail, '10000');
  assert.equal(parse('events', '--since', '30m').flags.since, '30m');
  assert.equal(parse('events', '--since', '1700000000').flags.since, '1700000000');
});

test('global flags win: --help and --version short-circuit', () => {
  assert.equal(parse('--help').command, 'help');
  assert.equal(parse('list', '--help').command, 'help');
  assert.equal(parse('help').command, 'help');
  assert.equal(parse('--version').command, 'version');
  assert.ok(HELP.includes('Exit codes:') && HELP.includes('0 success'));
});

test('exit codes: 0 for success, 2 for usage errors', () => {
  assert.equal(exitCodeFor(null), 0);
  assert.equal(exitCodeFor(undefined), 0);
  assert.equal(exitCodeFor(new UsageError('bad flag')), 2);
});

test('exit codes: 3 when the container or host does not exist', () => {
  assert.equal(exitCodeFor(new DockerError('CONTAINER_NOT_FOUND', 'no such container')), 3);
  assert.equal(exitCodeFor(new DockerError('HOST_NOT_FOUND', 'no such host')), 3);
  assert.equal(exitCodeFor({ code: 'CONTAINER_NOT_FOUND', message: 'x' }), 3);
  assert.equal(exitCodeFor({ code: 'HOST_NOT_FOUND', message: 'x' }), 3);
});

test('exit codes: 1 for daemon, compose, config and unknown failures', () => {
  assert.equal(exitCodeFor(new DockerError('DOCKER_UNREACHABLE', 'ECONNREFUSED')), 1);
  assert.equal(exitCodeFor(new DockerError('SELF_PROTECTED', 'refused')), 1);
  assert.equal(exitCodeFor(new DockerError('COMPOSE_BUSY', 'busy')), 1);
  assert.equal(exitCodeFor(new ConfigError('CONFIG_INVALID', 'bad config')), 1);
  assert.equal(exitCodeFor(new Error('boom')), 1);
  assert.equal(exitCodeFor({ code: 'SOMETHING_ELSE' }), 1);
});

test('exit codes cover the whole taxonomy: every code maps to 1, 2 or 3', () => {
  for (const code of Object.keys(require('../src/docker/errors').TABLE)) {
    const mapped = exitCodeFor(new DockerError(code, 'x'));
    assert.ok([1, 2, 3].includes(mapped), `${code} -> ${mapped}`);
  }
});

// --- run() wiring: no Docker daemon needed (regression for missing ctx.args) ---

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-cli-test-'));
process.env.CONFIG_PATH = path.join(tmpDir, 'config.json');

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// A quiet io captures nothing and never touches process.stdout (the test
// runner reports through it; monkey-patching it hides sibling tests).
function quietIO() {
  return {
    out: () => {},
    line: () => {},
    errLine: () => {},
    json: () => {},
    ndjson: () => {},
    paint: (_code, text) => String(text)
  };
}

async function runQuiet(argv) {
  return run(argv, quietIO());
}

test('run: config and hosts work without a Docker daemon', async () => {
  assert.equal(await runQuiet(['config']), 0);
  assert.equal(await runQuiet(['hosts']), 0);
});

test('run: target commands report taxonomy errors, never internal crashes', async () => {
  const target = 'dm-cli-test-nonexistent';
  for (const argv of [['inspect', target], ['logs', target]]) {
    let err = null;
    try {
      await runQuiet(argv);
    } catch (e) {
      err = e;
    }
    assert.ok(err, `expected "${argv.join(' ')}" to fail without that container`);
    assert.equal(err.name, 'DockerError', `${argv.join(' ')}: ${err && err.message}`);
    assert.ok(!(err.cause instanceof TypeError), `${argv.join(' ')} leaked an internal error: ${err.message}`);
    assert.ok([1, 2, 3].includes(exitCodeFor(err)), `${argv.join(' ')} -> ${exitCodeFor(err)}`);
  }
});
