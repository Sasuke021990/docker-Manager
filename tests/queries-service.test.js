'use strict';

// Service-level tests for the read model (queries.js async half): fake pool +
// client + store, no Docker daemon (UT-003 companion).

const test = require('node:test');
const assert = require('node:assert/strict');

const { createQueries } = require('../src/docker/queries');

const NOW = Date.parse('2026-11-11T12:00:00Z') / 1000;

function makeInspect(id, extra = {}) {
  const exited = id.startsWith('b'); // second fixture row is the stopped one
  return {
    Id: id,
    Name: '/web',
    Created: '2026-11-10T00:00:00Z',
    Image: 'sha256:abc',
    State: exited
      ? { Status: 'exited', StartedAt: '2026-11-10T00:00:00Z', ExitCode: 1, Health: null }
      : { Status: 'running', StartedAt: '2026-11-11T10:00:00Z', ExitCode: 0, Health: { Status: 'healthy' } },
    RestartCount: exited ? 0 : 2,
    Config: {
      Image: 'nginx:1.27',
      Cmd: ['nginx', '-g', 'daemon off;'],
      Entrypoint: ['/entry.sh'],
      WorkingDir: '/srv',
      User: 'www',
      Labels: { 'com.docker.compose.project': 'stack-a', 'secret.key': 'hunter2' },
      ExposedPorts: { '80/tcp': {} },
      Env: ['PATH=/usr/bin', 'GREETING=hi']
    },
    Mounts: [{ Type: 'bind', Source: '/data', Destination: '/data', RW: false }],
    NetworkSettings: {
      Ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] },
      Networks: { bridge: { IPAddress: '172.17.0.2', Aliases: ['web'] } }
    },
    HostConfig: { RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 3 } },
    ...extra
  };
}

function fakeStore(hosts = [{ id: 'local', name: 'This host', labelFilter: [] }]) {
  const cfg = {
    hosts,
    settings: { logTailLines: 100 },
    compose: { folder: '/compose', projects: [] }
  };
  return {
    get: () => cfg,
    lookupNote: () => ({ status: 'none', note: null })
  };
}

function fakeLog() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function fakePool(client, { selfId = null } = {}) {
  const runtimes = new Map([['local', { state: 'reachable', apiVersion: '1.51', engineVersion: '27.0' }]]);
  return {
    withClient: async (_id, fn) => fn(client),
    getSelfId: () => selfId,
    runtimes,
    on() {}
  };
}

const LIST_ROWS = [
  {
    Id: 'a'.repeat(64),
    Names: ['/web'],
    Image: 'nginx:1.27',
    ImageID: 'sha256:abc',
    State: 'running',
    Status: 'Up 2 hours (healthy)',
    Created: NOW - 7200,
    Labels: { 'com.docker.compose.project': 'stack-a', 'com.docker.compose.service': 'web' },
    Ports: [{ Type: 'tcp', PrivatePort: 80, PublicPort: 8080, IP: '0.0.0.0' }]
  },
  {
    Id: 'b'.repeat(64),
    Names: ['/db'],
    Image: 'postgres:17',
    ImageID: 'sha256:def',
    State: 'exited',
    Status: 'Exited (1) 5 minutes ago',
    Created: NOW - 86400,
    Labels: {},
    Ports: []
  }
];

test('listContainers enriches rows, counts buckets and caches inspects', async () => {
  let inspects = 0;
  const client = {
    listContainers: async () => LIST_ROWS,
    getContainer: (id) => ({
      inspect: async () => { inspects += 1; return makeInspect(id); }
    })
  };
  const q = createQueries({ pool: fakePool(client), store: fakeStore(), log: fakeLog() });
  const r1 = await q.listContainers('local');
  assert.equal(r1.host.name, 'This host');
  assert.equal(r1.rows.length, 2);
  const web = r1.rows.find((r) => r.name === 'web');
  assert.equal(web.partial, false);
  assert.equal(web.health, 'healthy');
  assert.equal(web.compose.project, 'stack-a');
  assert.equal(web.ports[0].hostPort, 8080);
  assert.deepEqual(r1.counts, { all: 2, running: 1, stopped: 1, paused: 0 });
  // second list: inspect served from the 5 s row cache
  await q.listContainers('local');
  assert.equal(inspects, 2); // one per container, not four
  q.invalidate('a'.repeat(64));
  await q.listContainers('local');
  assert.equal(inspects, 3);
});

test('listContainers honours host labelFilter and self flag', async () => {
  const client = {
    listContainers: async () => LIST_ROWS,
    getContainer: (id) => ({ inspect: async () => makeInspect(id) })
  };
  const q = createQueries({
    pool: fakePool(client, { selfId: 'a'.repeat(64) }),
    store: fakeStore([{ id: 'local', name: 'This host', labelFilter: ['com.docker.compose.project=stack-a'] }]),
    log: fakeLog()
  });
  const r = await q.listContainers('local');
  assert.deepEqual(r.rows.map((row) => row.name), ['web']);
  assert.equal(r.rows[0].self, true);
});

test('a failed inspect yields a partial row built from the list payload', async () => {
  const client = {
    listContainers: async () => [LIST_ROWS[1]],
    getContainer: () => ({ inspect: async () => { throw new Error('socket gone'); } })
  };
  const q = createQueries({ pool: fakePool(client), store: fakeStore(), log: fakeLog() });
  const r = await q.listContainers('local');
  const row = r.rows[0];
  assert.equal(row.partial, true);
  assert.equal(row.state, 'exited');
  assert.equal(row.exitCode, 1); // from the Status fallback parser
  assert.equal(row.uptimeSec, null);
  assert.equal(row.restarts, null);
});

test('getContainer returns the full detail DTO', async () => {
  const client = {
    getContainer: (id) => ({ inspect: async () => makeInspect(id) }),
    getImage: () => ({
      inspect: async () => ({
        Id: 'sha256:abc', RepoDigests: ['nginx@sha256:zzz'], Config: { Labels: { 'org.opencontainers.image.title': 'nginx' } }
      })
    })
  };
  const q = createQueries({ pool: fakePool(client), store: fakeStore(), log: fakeLog() });
  const d = await q.getContainer('local', 'a'.repeat(64));
  assert.equal(d.command[0], 'nginx');
  assert.equal(d.user, 'www');
  assert.deepEqual(d.envNames.sort(), ['GREETING', 'PATH']);
  assert.deepEqual(d.exposedPorts, ['80/tcp']);
  assert.equal(d.mounts[0].readOnly, true);
  assert.equal(d.networks[0].ip, '172.17.0.2');
  assert.equal(d.restartPolicy.name, 'on-failure');
  assert.equal(d.digest, 'nginx@sha256:zzz');
  // secret label dropped; image labels never leak into d.labels (they feed
  // the description instead) — only the compose label survives the allowlist
  assert.deepEqual(Object.keys(d.labels), ['com.docker.compose.project']);
  assert.equal(d.note.status, 'none');
  assert.ok(d.description);
});

test('systemDf reduces the df payload', async () => {
  const client = {
    df: async () => ({
      LayersSize: 1234,
      Images: [{}, {}],
      Containers: 3,
      Volumes: [{ UsageData: { Size: 100 } }, { UsageData: { Size: 50 } }],
      BuildCache: [{ Size: 10 }, { Size: 20 }]
    })
  };
  const q = createQueries({ pool: fakePool(client), store: fakeStore(), log: fakeLog() });
  assert.deepEqual(await q.systemDf('local'), {
    layersSize: 1234, images: 2, containers: 3, volumes: 2, volumesSize: 150, buildCache: 30
  });
});

test('listImages splits used vs dangling and maps fields', async () => {
  const client = {
    listImages: async () => ([
      { Id: 'sha256:abc', RepoTags: ['nginx:1.27'], Size: 1000, Created: NOW - 100 },
      { Id: 'sha256:gone', RepoTags: [], Size: 10, Created: NOW - 200 }
    ]),
    listContainers: async () => [{ ImageID: 'sha256:abc' }, { ImageID: 'sha256:abc' }],
    df: async () => ({})
  };
  const q = createQueries({ pool: fakePool(client), store: fakeStore(), log: fakeLog() });
  const r = await q.listImages('local');
  assert.equal(r.images.length, 1);
  assert.equal(r.images[0].usedBy, 2);
  assert.equal(r.dangling.length, 1);
  assert.equal(r.dangling[0].repoTag, '<none>:<none>');
  assert.ok(r.df);
});

test('getImage maps the detail view', async () => {
  const client = {
    getImage: () => ({
      inspect: async () => ({
        Id: 'sha256:abc', RepoTags: ['nginx:1.27'], RepoDigests: [], Size: 1000,
        Created: '2026-11-01T00:00:00Z', Architecture: 'amd64', Os: 'linux',
        Config: { Env: ['PATH=/bin'], Labels: {} }
      })
    })
  };
  const q = createQueries({ pool: fakePool(client), store: fakeStore(), log: fakeLog() });
  const d = await q.getImage('local', 'sha256:abc');
  assert.equal(d.repoTag, 'nginx:1.27');
  assert.equal(d.architecture, 'amd64');
  assert.deepEqual(d.envNames, ['PATH']);
});

test('listVolumes and getVolume map fields', async () => {
  const client = {
    listVolumes: async () => ({
      Volumes: [{ Name: 'data', Driver: 'local', Mountpoint: '/var/lib/.../data', Scope: 'local', CreatedAt: '2026-11-01T00:00:00Z', UsageData: { RefCount: 2 } }]
    }),
    getVolume: () => ({ inspect: async () => ({ Name: 'data', Labels: { 'a.b': 'x' }, Options: { type: 'tmpfs' }, UsageData: { Size: 5, RefCount: 1 } }) }),
    df: async () => ({})
  };
  const q = createQueries({ pool: fakePool(client), store: fakeStore(), log: fakeLog() });
  const list = await q.listVolumes('local');
  assert.equal(list.volumes[0].usedBy, 2);
  assert.ok(list.df !== undefined);
  const one = await q.getVolume('local', 'data');
  assert.equal(one.options.type, 'tmpfs');
  assert.equal(one.usage.refCount, 1);
  assert.deepEqual(Object.keys(one.labels), []); // 'a.b' not in the allowlist
});

test('listNetworks and getNetwork map fields', async () => {
  const client = {
    listNetworks: async () => ([{
      Id: 'n1'.padEnd(64, '0'), Name: 'bridge', Driver: 'bridge', Scope: 'local',
      IPAM: { Config: [{ Subnet: '172.17.0.0/16' }] },
      Containers: { ['c'.padEnd(64, '0')]: { Name: 'web', IPv4Address: '172.17.0.2' } }
    }]),
    getNetwork: () => ({
      inspect: async () => ({
        Id: 'n1'.padEnd(64, '0'), Name: 'bridge', Driver: 'bridge', Scope: 'local',
        Internal: true, IPAM: { Config: [{ Subnet: '10.0.0.0/24' }] }, Labels: { kept: 'yes' },
        Containers: {}
      })
    })
  };
  const q = createQueries({ pool: fakePool(client), store: fakeStore(), log: fakeLog() });
  const list = await q.listNetworks('local');
  assert.equal(list.networks[0].subnet, '172.17.0.0/16');
  assert.equal(list.networks[0].containers[0].name, 'web');
  const one = await q.getNetwork('local', 'n1');
  assert.equal(one.internal, true);
  assert.equal(one.ipam[0].Subnet, '10.0.0.0/24');
});

test('hostFrame falls back to connecting state when the runtime is absent', () => {
  const q = createQueries({
    pool: { runtimes: new Map(), withClient: async (_i, fn) => fn({}), getSelfId: () => null, on() {} },
    store: fakeStore(),
    log: fakeLog()
  });
  const f = q.hostFrame('local');
  assert.equal(f.state, 'connecting');
  assert.equal(f.name, 'This host');
});
