'use strict';

// Read model (design §3.4.7). `listContainers` fetches the list payload,
// applies the host's labelFilter, then enriches each row with one inspect
// (concurrency 8, 3 s per inspect, 3.5 s whole budget, 5 s cache keyed by
// (hostId, containerId) and invalidated by events). A row whose inspect
// timed out is built from the list payload alone and marked `partial`.
//
// Pure seams exported for tests (UT-003): parseStatus, matchLabelFilter,
// applyFilter, buildRow, stateBucket.

const { describe } = require('../core/describe');

const ENRICH_CONCURRENCY = 8;
const INSPECT_TIMEOUT_MS = 3000;
const ENRICH_BUDGET_MS = 3500;
const ROW_CACHE_TTL_MS = 5000;
const IMAGE_CACHE_TTL_MS = 5 * 60 * 1000;

// Only these label prefixes are ever displayed (§4.2.3): labels routinely
// hold deployment secrets in the wild.
const LABEL_ALLOWLIST = /^(org\.opencontainers\.image\.|com\.docker\.compose\.|traefik\.)/;

const STATE_BUCKETS = {
  running: ['running', 'restarting'],
  stopped: ['exited', 'created', 'dead'],
  paused: ['paused']
};

// FR-003 chip → states. Restarting sits in the Running bucket so a container
// in a restart loop is visible where operators look for "is it up".
function stateBucket(state) {
  for (const [bucket, states] of Object.entries(STATE_BUCKETS)) {
    if (states.includes(state)) return bucket;
  }
  return 'all';
}

// Fallback parser for the list payload's `Status` string when inspect is
// unavailable: "Up 3 hours (healthy)" / "Exited (1) 2 hours ago" / "Created".
function parseStatus(status) {
  const out = { uptimeSec: null, exitCode: null };
  if (typeof status !== 'string') return out;
  const exit = status.match(/^Exited \((-?\d+)\)/);
  if (exit) out.exitCode = Number(exit[1]);
  const up = status.match(/\bUp (?:(\d+) weeks? )?(?:(\d+) days? )?(?:(\d+) hours? )?(?:(\d+) minutes? )?(?:(\d+) seconds?)?/);
  if (up && up[0]) {
    const [, w, d, h, m, s] = up;
    out.uptimeSec = (Number(w) || 0) * 604800 + (Number(d) || 0) * 86400
      + (Number(h) || 0) * 3600 + (Number(m) || 0) * 60 + (Number(s) || 0);
  }
  return out;
}

// host.labelFilter (FR-083): `key=value`, `key!=value` or bare `key`.
// Entries are ANDed; an empty filter list matches everything.
function matchLabelFilter(labels, filters) {
  if (!filters || !filters.length) return true;
  const l = labels || {};
  return filters.every((f) => {
    const neIdx = f.indexOf('!=');
    if (neIdx >= 0) return l[f.slice(0, neIdx)] !== f.slice(neIdx + 2);
    const eqIdx = f.indexOf('=');
    if (eqIdx >= 0) return l[f.slice(0, eqIdx)] === f.slice(eqIdx + 1);
    return Object.prototype.hasOwnProperty.call(l, f);
  });
}

function filterLabels(labels) {
  const out = {};
  for (const [k, v] of Object.entries(labels || {})) {
    if (LABEL_ALLOWLIST.test(k)) out[k] = v;
  }
  return out;
}

function toIso(epochOrIso) {
  if (!epochOrIso) return null;
  const d = new Date(typeof epochOrIso === 'number' ? epochOrIso * 1000 : epochOrIso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function validIso(s) {
  if (typeof s !== 'string' || !s || s.startsWith('0001')) return null;
  return toIso(s);
}

function shortId(id) {
  return typeof id === 'string' ? id.slice(0, 12) : null;
}

function containerName(listEntry) {
  return (listEntry.Names && listEntry.Names[0] ? listEntry.Names[0] : listEntry.Id).replace(/^\//, '');
}

function portsOf(listEntry) {
  return (listEntry.Ports || [])
    .filter((p) => p.Type)
    .map((p) => ({
      hostIp: p.PublicPort ? (p.IP || null) : null,
      hostPort: p.PublicPort || null,
      containerPort: p.PrivatePort,
      proto: p.Type
    }))
    .sort((a, b) => (a.hostPort || 1e9) - (b.hostPort || 1e9) || a.containerPort - b.containerPort);
}

function composeOf(labels) {
  const l = labels || {};
  if (!l['com.docker.compose.project']) return null;
  return {
    project: l['com.docker.compose.project'],
    service: l['com.docker.compose.service'] || null
  };
}

// Row DTO (§4.2.3). `inspect` is null for a partial row.
function buildRow(listEntry, inspect, { selfId = null, noteStatus = 'none', now = Date.now() } = {}) {
  const labels = inspect ? (inspect.Config && inspect.Config.Labels) || {} : {};
  const parsed = parseStatus(listEntry.Status);
  const startedAt = inspect ? validIso(inspect.State && inspect.State.StartedAt) : null;
  const uptimeSec = startedAt
    ? Math.max(0, Math.round((now - new Date(startedAt).getTime()) / 1000))
    : parsed.uptimeSec;
  return {
    id: listEntry.Id,
    idShort: shortId(listEntry.Id),
    name: containerName(listEntry),
    image: listEntry.Image,
    imageId: listEntry.ImageID,
    state: (inspect && inspect.State && inspect.State.Status) || listEntry.State,
    status: listEntry.Status,
    health: (inspect && inspect.State && inspect.State.Health && inspect.State.Health.Status) || null,
    exitCode: inspect && inspect.State && inspect.State.ExitCode !== undefined ? inspect.State.ExitCode : parsed.exitCode,
    restarts: inspect ? inspect.RestartCount : null,
    created: toIso(listEntry.Created),
    startedAt,
    uptimeSec,
    ports: portsOf(listEntry),
    compose: composeOf(listEntry.Labels || labels),
    self: Boolean(selfId) && (listEntry.Id === selfId || (selfId.startsWith && selfId.startsWith(listEntry.Id))),
    hasNote: noteStatus === 'exact' || noteStatus === 'recreated',
    partial: !inspect
  };
}

// FR-003/FR-011: state chip + free-text name/image filter + sort. Pure.
function applyFilter(rows, { state, q, sort = 'name', dir = 'asc' } = {}) {
  const counts = { all: rows.length, running: 0, stopped: 0, paused: 0 };
  for (const row of rows) {
    const bucket = stateBucket(row.state);
    if (bucket !== 'all') counts[bucket] += 1;
  }

  let out = rows;
  if (state && state !== 'all') {
    out = out.filter((r) => stateBucket(r.state) === state);
  }
  if (q) {
    const needle = String(q).toLowerCase();
    out = out.filter((r) => r.name.toLowerCase().includes(needle) || r.image.toLowerCase().includes(needle));
  }

  const cmp = {
    name: (a, b) => a.name.localeCompare(b.name),
    image: (a, b) => a.image.localeCompare(b.image) || a.name.localeCompare(b.name),
    state: (a, b) => a.state.localeCompare(b.state) || a.name.localeCompare(b.name),
    created: (a, b) => String(a.created || '').localeCompare(String(b.created || '')) || a.name.localeCompare(b.name)
  }[sort] || ((a, b) => a.name.localeCompare(b.name));

  out = out.slice().sort(cmp);
  if (dir === 'desc') out.reverse();
  return { rows: out, counts };
}

// Fills `results[i]` as each task completes; unfinished slots stay empty so
// the caller can tell which rows are partial after a budget cut.
function mapParallel(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = [];
  for (let w = 0; w < Math.min(limit, items.length); w += 1) {
    workers.push((async () => {
      while (next < items.length) {
        const i = next;
        next += 1;
        results[i] = await fn(items[i], i);
      }
    })());
  }
  return { results, done: Promise.all(workers).then(() => results) };
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
      timer.unref && timer.unref();
    })
  ]);
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref && timer.unref();
  });
}

function createQueries({ pool, store, log }) {
  const rowCache = new Map();   // `${hostId}\n${containerId}` -> {at, inspect}
  const imageCache = new Map(); // `${hostId}\n${imageId}` -> {at, inspect}

  function invalidate(containerId) {
    if (!containerId) return;
    for (const key of [...rowCache.keys()]) {
      const id = key.split('\n')[1];
      if (id === containerId || id.startsWith(containerId) || containerId.startsWith(id)) {
        rowCache.delete(key);
      }
    }
  }

  async function cachedInspect(client, hostId, listEntry) {
    const key = `${hostId}\n${listEntry.Id}`;
    const hit = rowCache.get(key);
    if (hit && Date.now() - hit.at < ROW_CACHE_TTL_MS) return hit.inspect;
    const inspect = await withTimeout(
      client.getContainer(listEntry.Id).inspect().catch((err) => {
        log.debug('docker.request', { what: 'inspect', containerId: shortId(listEntry.Id), error: err.message });
        return null;
      }),
      INSPECT_TIMEOUT_MS
    );
    if (inspect) rowCache.set(key, { at: Date.now(), inspect });
    return inspect || null;
  }

  async function imageInspect(client, hostId, imageId) {
    if (!imageId) return null;
    const key = `${hostId}\n${imageId}`;
    const hit = imageCache.get(key);
    if (hit && Date.now() - hit.at < IMAGE_CACHE_TTL_MS) return hit.inspect;
    const inspect = await withTimeout(
      client.getImage(imageId).inspect().catch(() => null),
      INSPECT_TIMEOUT_MS
    );
    if (inspect) imageCache.set(key, { at: Date.now(), inspect });
    return inspect || null;
  }

  function hostFrame(id) {
    const rt = pool.runtimes.get(id);
    const entry = store.get().hosts.find((h) => h.id === id);
    return {
      id,
      name: entry ? entry.name : id,
      state: rt ? rt.state : 'connecting',
      apiVersion: rt ? rt.apiVersion : null,
      engineVersion: rt ? rt.engineVersion : null
    };
  }

  async function listContainers(hostId) {
    const started = Date.now();
    const host = store.get().hosts.find((h) => h.id === hostId);
    const list = await pool.withClient(hostId, (client) => client.listContainers({ all: true }));

    const kept = list.filter((e) => matchLabelFilter(e.Labels, host && host.labelFilter));
    const selfId = pool.getSelfId();
    const liveIds = new Set(kept.map((e) => e.Id));
    const noteStatus = new Map();
    for (const e of kept) {
      noteStatus.set(e.Id, store.lookupNote({ id: e.Id, name: containerName(e) }, liveIds).status);
    }

    const { results, done } = mapParallel(kept, ENRICH_CONCURRENCY, async (e) => {
      const inspect = await pool.withClient(hostId, (client) => cachedInspect(client, hostId, e));
      return { inspect };
    });
    // Whole-enrichment budget: rows still empty after 3.5 s are partial.
    await Promise.race([done, delay(ENRICH_BUDGET_MS)]);

    const rows = kept.map((e, i) => {
      const inspect = (results[i] && results[i].inspect) || null;
      return buildRow(e, inspect, { selfId, noteStatus: noteStatus.get(e.Id), now: Date.now() });
    });

    log.debug('docker.request', {
      what: 'listContainers', hostId, containers: rows.length,
      partial: rows.filter((r) => r.partial).length, durationMs: Date.now() - started
    });
    return { host: hostFrame(hostId), counts: applyFilter(rows).counts, rows, updatedAt: Date.now() };
  }

  // Ports from inspect: PortBindings for published, ExposedPorts for the rest.
  function portsFromInspect(inspect) {
    const ports = [];
    for (const [containerPortProto, bindings] of Object.entries((inspect.NetworkSettings && inspect.NetworkSettings.Ports) || {})) {
      const [containerPort, proto] = containerPortProto.split('/');
      if (bindings && bindings.length) {
        for (const b of bindings) {
          ports.push({ IP: b.HostIp || '0.0.0.0', PrivatePort: Number(containerPort), PublicPort: Number(b.HostPort), Type: proto });
        }
      } else {
        ports.push({ PrivatePort: Number(containerPort), Type: proto });
      }
    }
    if (!ports.length) {
      for (const ep of Object.keys((inspect.Config && inspect.Config.ExposedPorts) || {})) {
        const [containerPort, proto] = ep.split('/');
        ports.push({ PrivatePort: Number(containerPort), Type: proto });
      }
    }
    return ports;
  }

  async function getContainer(hostId, id) {
    const inspect = await pool.withClient(hostId, (client) => client.getContainer(id).inspect());
    const labels = (inspect.Config && inspect.Config.Labels) || {};
    const listEntry = {
      Id: inspect.Id,
      Names: [inspect.Name],
      Image: (inspect.Config && inspect.Config.Image) || inspect.Image,
      ImageID: inspect.Image,
      State: inspect.State && inspect.State.Status,
      Status: inspect.State && inspect.State.Status,
      Created: inspect.Created,
      Labels: labels,
      Ports: portsFromInspect(inspect)
    };

    const selfId = pool.getSelfId();
    const note = store.lookupNote({ id: inspect.Id, name: containerName(listEntry) }, new Set([inspect.Id]));
    const row = buildRow(listEntry, inspect, { selfId, noteStatus: note.status, now: Date.now() });

    const imageInfo = await pool.withClient(hostId, (client) => imageInspect(client, hostId, inspect.Image));
    const imageLabels = (imageInfo && imageInfo.Config && imageInfo.Config.Labels) || null;

    const description = describe({
      note: note.note,
      imageLabels,
      compose: row.compose,
      imageRef: listEntry.Image
    });

    return {
      ...row,
      created: validIso(inspect.Created),
      command: (inspect.Config && inspect.Config.Cmd) || null,
      entrypoint: (inspect.Config && inspect.Config.Entrypoint) || null,
      workingDir: (inspect.Config && inspect.Config.WorkingDir) || null,
      user: (inspect.Config && inspect.Config.User) || null,
      exposedPorts: Object.keys((inspect.Config && inspect.Config.ExposedPorts) || {}).sort(),
      envNames: ((inspect.Config && inspect.Config.Env) || [])
        .map((e) => e.split('=')[0])
        .filter(Boolean)
        .sort(),
      mounts: (inspect.Mounts || []).map((m) => ({
        type: m.Type || 'volume',
        source: m.Source || m.Name || '—',
        destination: m.Destination,
        readOnly: m.RW === false
      })),
      networks: Object.entries((inspect.NetworkSettings && inspect.NetworkSettings.Networks) || {}).map(([name, cfg]) => ({
        name,
        ip: (cfg && cfg.IPAddress) || null,
        aliases: (cfg && cfg.Aliases) || []
      })),
      restartPolicy: inspect.HostConfig && inspect.HostConfig.RestartPolicy
        ? { name: inspect.HostConfig.RestartPolicy.Name || 'no', maximumRetryCount: inspect.HostConfig.RestartPolicy.MaximumRetryCount || 0 }
        : { name: 'no', maximumRetryCount: 0 },
      digest: (imageInfo && imageInfo.RepoDigests && imageInfo.RepoDigests[0]) || inspect.Image || null,
      imageTag: (inspect.Config && inspect.Config.Image) || null,
      labels: filterLabels(labels),
      note: note.status === 'foreign'
        ? { status: 'foreign', note: null, updatedAt: null }
        : { status: note.status, note: note.note || null, updatedAt: note.updatedAt || null },
      description
    };
  }

  function dfOf(raw) {
    const volumesSize = (raw.Volumes || []).reduce((n, v) => n + ((v.UsageData && v.UsageData.Size) || 0), 0);
    return {
      layersSize: raw.LayersSize ?? null,
      images: raw.Images ? raw.Images.length : null,
      containers: raw.Containers ?? null,
      volumes: raw.Volumes ? raw.Volumes.length : null,
      volumesSize: volumesSize || null,
      buildCache: (raw.BuildCache || []).reduce((n, c) => n + (c.Size || 0), 0) || null
    };
  }

  async function systemDf(hostId) {
    const raw = await pool.withClient(hostId, (client) => client.df());
    return dfOf(raw);
  }

  async function listImages(hostId) {
    const [rawImages, containers, df] = await Promise.all([
      pool.withClient(hostId, (client) => client.listImages({ all: true })),
      pool.withClient(hostId, (client) => client.listContainers({ all: true })).catch(() => []),
      systemDf(hostId).catch(() => null)
    ]);
    const usedBy = new Map();
    for (const c of containers) {
      usedBy.set(c.ImageID, (usedBy.get(c.ImageID) || 0) + 1);
    }
    const images = rawImages.map((img) => {
      const tags = (img.RepoTags || []).filter((t) => t && t !== '<none>:<none>');
      return {
        id: img.Id,
        idShort: shortId(img.Id),
        repoTags: tags,
        repoTag: tags[0] || '<none>:<none>',
        size: img.Size ?? null,
        created: toIso(img.Created),
        usedBy: usedBy.get(img.Id) || 0,
        dangling: tags.length === 0
      };
    });
    return {
      images: images.filter((i) => !i.dangling),
      dangling: images.filter((i) => i.dangling),
      df
    };
  }

  async function getImage(hostId, id) {
    const img = await pool.withClient(hostId, (client) => client.getImage(id).inspect());
    const tags = (img.RepoTags || []).filter((t) => t && t !== '<none>:<none>');
    return {
      id: img.Id,
      idShort: shortId(img.Id),
      repoTags: tags,
      repoTag: tags[0] || '<none>:<none>',
      repoDigests: img.RepoDigests || [],
      size: img.Size ?? null,
      created: validIso(img.Created),
      architecture: img.Architecture || null,
      os: img.Os || null,
      envNames: (img.Config && img.Config.Env ? img.Config.Env : []).map((e) => e.split('=')[0]).filter(Boolean).sort(),
      labels: filterLabels((img.Config && img.Config.Labels) || {})
    };
  }

  async function listVolumes(hostId) {
    const [raw, df] = await Promise.all([
      pool.withClient(hostId, (client) => client.listVolumes()),
      systemDf(hostId).catch(() => null)
    ]);
    return {
      volumes: (raw.Volumes || []).map((v) => ({
        name: v.Name,
        driver: v.Driver || 'local',
        mountpoint: v.Mountpoint,
        scope: v.Scope || 'local',
        created: validIso(v.CreatedAt),
        usedBy: v.UsageData && v.UsageData.RefCount !== undefined ? v.UsageData.RefCount : null
      })),
      df
    };
  }

  async function getVolume(hostId, name) {
    const v = await pool.withClient(hostId, (client) => client.getVolume(name).inspect());
    return {
      name: v.Name,
      driver: v.Driver || 'local',
      mountpoint: v.Mountpoint,
      scope: v.Scope || 'local',
      created: validIso(v.CreatedAt),
      labels: filterLabels(v.Labels || {}),
      options: v.Options || {},
      usage: v.UsageData ? { size: v.UsageData.Size ?? null, refCount: v.UsageData.RefCount ?? null } : null
    };
  }

  async function listNetworks(hostId) {
    const raw = await pool.withClient(hostId, (client) => client.listNetworks());
    return {
      networks: (raw || []).map((n) => ({
        id: n.Id,
        idShort: shortId(n.Id),
        name: n.Name,
        driver: n.Driver,
        scope: n.Scope,
        subnet: (n.IPAM && n.IPAM.Config && n.IPAM.Config[0] && n.IPAM.Config[0].Subnet) || null,
        containers: Object.entries(n.Containers || {}).map(([cid, c]) => ({
          id: cid,
          idShort: shortId(cid),
          name: c.Name,
          ip: c.IPv4Address || null
        }))
      }))
    };
  }

  async function getNetwork(hostId, id) {
    const n = await pool.withClient(hostId, (client) => client.getNetwork(id).inspect());
    return {
      id: n.Id,
      idShort: shortId(n.Id),
      name: n.Name,
      driver: n.Driver,
      scope: n.Scope,
      internal: Boolean(n.Internal),
      ipam: (n.IPAM && n.IPAM.Config) || [],
      containers: Object.entries(n.Containers || {}).map(([cid, c]) => ({
        id: cid,
        idShort: shortId(cid),
        name: c.Name,
        ip: c.IPv4Address || null
      })),
      labels: filterLabels(n.Labels || {})
    };
  }

  return {
    listContainers,
    getContainer,
    listImages,
    getImage,
    listVolumes,
    getVolume,
    listNetworks,
    getNetwork,
    systemDf,
    hostFrame,
    invalidate
  };
}

module.exports = {
  createQueries,
  applyFilter,
  matchLabelFilter,
  parseStatus,
  buildRow,
  stateBucket,
  filterLabels,
  LABEL_ALLOWLIST,
  ENRICH_CONCURRENCY,
  ENRICH_BUDGET_MS
};
