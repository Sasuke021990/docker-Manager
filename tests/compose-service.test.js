'use strict';

// Compose layer tests (§3.8): discovery merging, plugin probe, job runner
// guards + ENOENT path, service caching. Real temp dirs for files, fakes for
// pool/store/probe. No Docker daemon and no compose binary (FR-070…FR-078).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createDiscovery } = require('../src/compose/discovery');
const { createComposeProbe } = require('../src/compose/probe');
const { createComposeRunner } = require('../src/compose/runner');
const { createComposeService } = require('../src/compose/index');

async function withTmp(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-compose-svc-'));
  try { return await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

function fakeLog() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function fakePool(listRows = [], { selfId = null } = {}) {
  return {
    withClient: async (_id, fn) => fn({ listContainers: async () => listRows }),
    getSelfId: () => selfId,
    hostEntry: () => ({ access: 'socket' }),
    on() {}
  };
}

function fakeStore(cfg) {
  return { get: () => cfg };
}

function row(id, project, extras = {}) {
  return {
    Id: id,
    Names: [`/${project}-web`],
    State: 'running',
    Status: 'Up',
    Image: 'nginx:1.27',
    Labels: {
      'com.docker.compose.project': project,
      'com.docker.compose.service': 'web',
      ...(extras.configFiles ? { 'com.docker.compose.project.config_files': extras.configFiles } : {}),
      ...(extras.workingDir ? { 'com.docker.compose.project.working_dir': extras.workingDir } : {})
    }
  };
}

test('discovery finds file projects and marks them runnable inside the root', async () => {
  await withTmp(async (root) => {
    await fs.mkdir(path.join(root, 'stack-a'));
    await fs.writeFile(path.join(root, 'stack-a', 'docker-compose.yml'), 'services: {}');
    const d = createDiscovery({
      pool: fakePool(),
      store: fakeStore({ compose: { folder: root, projects: [] } })
    });
    const r = await d.discover('local');
    assert.equal(r.rootError, null);
    assert.equal(r.stacks.length, 1);
    const s = r.stacks[0];
    assert.equal(s.name, 'stack-a');
    assert.equal(s.runnable, true);
    assert.equal(s.file, path.join('stack-a', 'docker-compose.yml'));
    assert.equal(s.reason, null);
    assert.equal(s.states.running, 0);
  });
});

test('discovery merges runtime containers with the file project and counts states', async () => {
  await withTmp(async (root) => {
    await fs.mkdir(path.join(root, 'stack-a'));
    const file = path.join(root, 'stack-a', 'compose.yaml');
    await fs.writeFile(file, 'services: {}');
    const d = createDiscovery({
      pool: fakePool([
        row('a'.repeat(64), 'stack-a', { configFiles: file, workingDir: path.join(root, 'stack-a') }),
        row('b'.repeat(64), 'stack-a', { configFiles: file })
      ]),
      store: fakeStore({ compose: { folder: root, projects: [] } })
    });
    const r = await d.discover('local');
    assert.equal(r.stacks.length, 1);
    const s = r.stacks[0];
    assert.equal(s.serviceCount, 2);
    assert.deepEqual([s.states.running, s.states.exited], [2, 0]);
    assert.equal(s.runnable, true);
    assert.equal(s.configFileReported, file);
  });
});

test('runtime stacks with a compose file outside the root are not runnable', async () => {
  await withTmp(async (root) => {
    await fs.mkdir('/tmp/dm-outside-stack', { recursive: true });
    const outside = '/tmp/dm-outside-stack/docker-compose.yml';
    await fs.writeFile(outside, 'services: {}');
    const d = createDiscovery({
      pool: fakePool([row('c'.repeat(64), 'outside', { configFiles: outside })]),
      store: fakeStore({ compose: { folder: root, projects: [] } })
    });
    const r = await d.discover('local');
    assert.equal(r.stacks.length, 1);
    const s = r.stacks[0];
    assert.equal(s.runnable, false);
    assert.equal(s.reason, 'Compose file not in /compose — manage with docker compose on the host');
    assert.equal(s.serviceCount, 1);
  });
});

test('a missing compose folder reports the error instead of throwing', async () => {
  const d = createDiscovery({
    pool: fakePool(),
    store: fakeStore({ compose: { folder: '/tmp/dm-no-such-root-xyz', projects: [] } })
  });
  const r = await d.discover('local');
  assert.equal(r.root, null);
  assert.equal(r.rootError !== null, true);
  assert.equal(r.stacks.length, 0);
});

test('explicit configured projects join the scan', async () => {
  await withTmp(async (root) => {
    await fs.mkdir(path.join(root, 'explicit'));
    const file = path.join(root, 'explicit', 'docker-compose.yml');
    await fs.writeFile(file, 'services: {}');
    const d = createDiscovery({
      pool: fakePool(),
      store: fakeStore({
        compose: {
          folder: root,
          projects: [{ name: 'Explicit', path: 'explicit', file: 'docker-compose.yml' }]
        }
      })
    });
    const r = await d.discover('local');
    const s = r.stacks.find((x) => x.name === 'Explicit');
    assert.ok(s, `expected Explicit in ${r.stacks.map((x) => x.name)}`);
    assert.equal(s.runnable, true);
  });
});

test('probe: no docker binary → cli-missing, cached until marked missing', async () => {
  const probe = createComposeProbe({ env: {}, log: fakeLog() });
  const first = await probe.get();
  assert.equal(first.state, 'cli-missing'); // no docker in this container
  assert.equal(probe.cached(), first);
  probe.markMissing();
  assert.equal(probe.cached().state, 'missing');
  assert.equal(probe.cached().version, null);
  // force bypasses the TTL and re-probes
  const forced = await probe.get({ force: true });
  assert.equal(forced.state, 'cli-missing');
});

function runnerFakes(root, { selfId = null } = {}) {
  const marked = [];
  const probe = {
    get: async () => ({ state: 'available', version: 'v2.29.7', message: null }),
    markMissing: (m) => marked.push(m)
  };
  const activity = { appended: [], append(e) { this.appended.push(e); } };
  const bus = { published: [], publish(kind, data) { this.published.push({ kind, data }); } };
  const runner = createComposeRunner({
    env: {},
    store: fakeStore({ compose: { folder: root, projects: [] } }),
    pool: fakePool([], { selfId }),
    log: fakeLog(),
    probe,
    activity,
    bus,
    resolveProject: async () => null
  });
  return { runner, marked, probe, activity, bus };
}

async function waitForJob(runner, jobId) {
  for (let i = 0; i < 200; i += 1) {
    const job = runner.getJob(jobId);
    if (job && job.done) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job never finished');
}

test('runner rejects bad actions, unknown projects and files outside the root', async () => {
  await withTmp(async (root) => {
    const { runner } = runnerFakes(root);
    await assert.rejects(() => runner.start({ hostId: 'local', projectId: 'x', action: 'restart' }), (e) => e.code === 'BAD_REQUEST');
    await assert.rejects(() => runner.start({ hostId: 'local', projectId: 'ghost', action: 'up' }), (e) => e.code === 'CONTAINER_NOT_FOUND');
    // project without absFile → COMPOSE_OUTSIDE_ROOT
    const r2 = createComposeRunner({
      env: {}, store: fakeStore({}), pool: fakePool(), log: fakeLog(), probe: { get: async () => ({ state: 'available' }) },
      activity: { append() {} }, bus: { publish() {} },
      resolveProject: async () => ({ name: 'p', absFile: null, reason: 'Compose file not in /compose', dir: root })
    });
    await assert.rejects(() => r2.start({ hostId: 'local', projectId: 'p', action: 'up' }), (e) => e.code === 'COMPOSE_OUTSIDE_ROOT');
  });
});

test('runner refuses to stop a project containing Docker Manager itself', async () => {
  await withTmp(async (root) => {
    await fs.mkdir(path.join(root, 'self'));
    const file = path.join(root, 'self', 'docker-compose.yml');
    await fs.writeFile(file, 'services: {}');
    const r = createComposeRunner({
      env: {}, store: fakeStore({}), pool: fakePool([], { selfId: 'a'.repeat(64) }), log: fakeLog(),
      probe: { get: async () => ({ state: 'available' }) }, activity: { append() {} }, bus: { publish() {} },
      resolveProject: async () => ({
        name: 'self', absFile: file, dir: path.join(root, 'self'),
        services: [{ containerId: 'a'.repeat(64) }], configFile: file
      })
    });
    await assert.rejects(() => r.start({ hostId: 'local', projectId: 'self', action: 'down' }), (e) => e.code === 'SELF_PROJECT');
  });
});

test('runner refuses a mixed-ownership project on down without confirmation', async () => {
  await withTmp(async (root) => {
    await fs.mkdir(path.join(root, 'mixed'));
    const file = path.join(root, 'mixed', 'docker-compose.yml');
    await fs.writeFile(file, 'services: {}');
    const r = createComposeRunner({
      env: {}, store: fakeStore({}), pool: fakePool(), log: fakeLog(),
      probe: { get: async () => ({ state: 'available' }) }, activity: { append() {} }, bus: { publish() {} },
      resolveProject: async () => ({
        name: 'mixed', absFile: file, dir: path.join(root, 'mixed'),
        services: [{ containerId: 'b'.repeat(64), configFile: '/elsewhere/docker-compose.yml' }]
      })
    });
    await assert.rejects(
      () => r.start({ hostId: 'local', projectId: 'mixed', action: 'down' }),
      (e) => e.code === 'COMPOSE_MIXED_PROJECT'
    );
  });
});

test('runner: spawn failure (no docker binary) surfaces COMPOSE_UNAVAILABLE and marks the probe', async () => {
  await withTmp(async (root) => {
    await fs.mkdir(path.join(root, 'ok'));
    const file = path.join(root, 'ok', 'docker-compose.yml');
    await fs.writeFile(file, 'services: {}');
    const { marked, activity, bus } = runnerFakes(root);
    const r = createComposeRunner({
      env: {}, store: fakeStore({}), pool: fakePool(), log: fakeLog(),
      probe: { get: async () => ({ state: 'available' }), markMissing: (m) => marked.push(m) },
      activity, bus,
      resolveProject: async () => ({ name: 'ok', absFile: file, dir: path.join(root, 'ok'), services: [] })
    });
    const { jobId } = await r.start({ hostId: 'local', projectId: 'ok', action: 'up' });
    const job = await waitForJob(r, jobId);
    assert.equal(job.error && job.error.code, 'COMPOSE_UNAVAILABLE');
    assert.equal(marked.length > 0, true);
    assert.ok(activity.appended.some((a) => a.result === 'failed'));
    assert.equal(r.status().busy, false);
    // late readers still get the retained result
    assert.equal(r.getJob(jobId).result.t, 'error');
    // stop() on a finished job is a no-op
    await r.stop();
  });
});

test('runner: a live child keeps the job busy; stop() SIGTERMs it and reports exit', async () => {
  await withTmp(async (root) => {
    // A fake `docker` on PATH: writes a line, then waits until TERM'd.
    const shimDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-shim-'));
    await fs.writeFile(path.join(shimDir, 'docker'), '#!/bin/sh\ntrap "exit 42" TERM\necho working\nwhile :; do sleep 0.1; done\n', { mode: 0o755 });
    await fs.mkdir(path.join(root, 'ok'));
    const file = path.join(root, 'ok', 'docker-compose.yml');
    await fs.writeFile(file, 'services: {}');
    const activity = { appended: [], append(e) { this.appended.push(e); } };
    const bus = { published: [], publish(kind, data) { this.published.push({ kind, data }); } };
    const r = createComposeRunner({
      env: {}, store: fakeStore({}), pool: fakePool(), log: fakeLog(),
      probe: { get: async () => ({ state: 'available' }), markMissing() {} },
      activity, bus,
      resolveProject: async () => ({ name: 'ok', absFile: file, dir: path.join(root, 'ok'), services: [] })
    });
    const prevPath = process.env.PATH;
    process.env.PATH = `${shimDir}${path.delimiter}${prevPath || ''}`;
    try {
      const { jobId } = await r.start({ hostId: 'local', projectId: 'ok', action: 'up' });
      // while the child lives, a second start is COMPOSE_BUSY
      await assert.rejects(() => r.start({ hostId: 'local', projectId: 'ok', action: 'up' }), (e) => e.code === 'COMPOSE_BUSY');
      assert.equal(r.status().busy, true);
      await r.stop(); // SIGTERM
      const job = await waitForJob(r, jobId);
      assert.equal(job.exitCode, 42);
      assert.equal(job.result.t, 'exit');
      assert.ok(job.lines.some((l) => l.line === 'working'), 'stdout reached the ring');
      assert.ok(activity.appended.some((a) => a.result === 'failed'));
      assert.ok(bus.published.some((p) => p.kind === 'docker.event' && p.data.raw && p.data.raw.Action === 'compose-up'));
      assert.equal(r.status().busy, false);
    } finally {
      process.env.PATH = prevPath;
      await fs.rm(shimDir, { recursive: true, force: true });
    }
  });
});

test('runner.getJob returns null for unknown ids; streamJob likewise', async () => {
  await withTmp(async (root) => {
    const { runner } = runnerFakes(root);
    assert.equal(runner.getJob('nope'), null);
    assert.equal(runner.streamJob({ headers: {}, protocol: 'http', on() {} }, { writeHead() {}, write() {}, end() {}, flushHeaders() {}, writableLength: 0 }, 'nope'), null);
  });
});

test('compose service: list caches, resolveProject re-resolves, listPublic adds probe state', async () => {
  await withTmp(async (root) => {
    await fs.mkdir(path.join(root, 'stack-a'));
    await fs.writeFile(path.join(root, 'stack-a', 'docker-compose.yml'), 'services: {}');
    const svc = createComposeService({
      env: {},
      store: fakeStore({ compose: { folder: root, projects: [] } }),
      pool: fakePool(),
      log: fakeLog(),
      activity: { append() {} },
      bus: { publish() {} }
    });
    const a = await svc.list('local');
    const b = await svc.list('local');
    assert.equal(a, b); // 2 s cache
    svc.invalidate();
    const c = await svc.list('local', { force: true });
    assert.notEqual(a, c);
    const pub = await svc.listPublic('local');
    assert.equal(pub.stacks[0].runnable, true);
    assert.equal(pub.compose.state, 'cli-missing');
    assert.equal(pub.busy.busy, false);
    assert.deepEqual(pub.stacks[0].services, []);
    // resolveProject through the internal map
    const stack = await svc.resolveProject('local', pub.stacks[0].id);
    assert.equal(stack.name, 'stack-a');
    assert.equal(await svc.resolveProject('local', 'ghost'), null);
    // run() funnels through the runner and reports the probe result
    await assert.rejects(() => svc.run('local', pub.stacks[0].id, 'up'), (e) => e.code === 'COMPOSE_UNAVAILABLE');
  });
});
