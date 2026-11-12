'use strict';

// JSON API (design §4.2.2), the read half plus the config-write endpoints
// (notes, settings). Mutating Docker endpoints live in the action layer (P2).

const express = require('express');
const { DockerError } = require('../../docker/errors');
const { applyFilter } = require('../../docker/queries');

function activeHostId(store) {
  return store.get().settings.activeHostId;
}

function apiRouter(ctx) {
  const { store, pool, queries, activity, actions, events, stats } = ctx;
  const router = express.Router();

  // FR-086: one row per configured host with its live connection state.
  router.get('/api/hosts', (req, res) => {
    const cfg = store.get();
    const activeId = cfg.settings.activeHostId;
    res.json(cfg.hosts.map((h) => {
      const rt = pool.runtimes.get(h.id);
      return {
        id: h.id,
        name: h.name,
        access: h.access,
        state: rt ? rt.state : 'connecting',
        apiVersion: rt ? rt.apiVersion : null,
        engineVersion: rt ? rt.engineVersion : null,
        error: rt && rt.lastError ? rt.lastError : null,
        active: h.id === activeId,
        managedByEnv: Boolean(h.managedByEnv)
      };
    }));
  });

  // FR-087: switch the active host. Writing the setting drives pool.syncHosts
  // (via the store's onChange), which closes the previous host's streams,
  // opens the new one and broadcasts resync host-changed.
  router.post('/api/hosts/:id/activate', async (req, res, next) => {
    try {
      const id = req.params.id;
      const cfg = store.get();
      if (!cfg.hosts.some((h) => h.id === id)) {
        throw new DockerError('HOST_NOT_FOUND', `No configured host with id ${id}.`, { action: 'activate-host' });
      }
      if (cfg.settings.activeHostId !== id) {
        await store.saveSettings({ activeHostId: id });
      }
      res.json({ ok: true, activeHostId: store.get().settings.activeHostId });
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/containers', async (req, res, next) => {
    try {
      const hostId = activeHostId(store);
      const list = await queries.listContainers(hostId);
      const { rows, counts } = applyFilter(list.rows, {
        state: req.query.state,
        q: req.query.q,
        sort: req.query.sort,
        dir: req.query.dir
      });
      res.json({ host: list.host, counts, rows, updatedAt: list.updatedAt });
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/containers/:id', async (req, res, next) => {
    try {
      res.json(await queries.getContainer(activeHostId(store), req.params.id));
    } catch (err) {
      next(err);
    }
  });

  // FR-009: note keyed by container name, container ID as metadata.
  router.patch('/api/containers/:id/note', async (req, res, next) => {
    try {
      const hostId = activeHostId(store);
      const detail = await queries.getContainer(hostId, req.params.id);
      const note = req.body && req.body.note;
      if (typeof note !== 'string' || note.length > 2000) {
        throw new DockerError('BAD_REQUEST', 'A note must be a string of at most 2,000 characters.', { action: 'note' });
      }
      const saved = await store.saveNote(detail.name, note, detail.id);
      queries.invalidate(detail.id);
      res.json({ ok: true, ...saved });
    } catch (err) {
      next(err);
    }
  });

  // D-003 hygiene: only names absent from the current list may be pruned.
  router.post('/api/notes/prune', async (req, res, next) => {
    try {
      const names = Array.isArray(req.body && req.body.names) ? req.body.names : null;
      if (!names || !names.every((n) => typeof n === 'string')) {
        throw new DockerError('BAD_REQUEST', 'Body must be {"names":[…]}.', { action: 'prune' });
      }
      const list = await queries.listContainers(activeHostId(store));
      const liveNames = new Set(list.rows.map((r) => r.name));
      const stale = new Set(store.staleNoteNames(liveNames));
      const allowed = names.filter((n) => stale.has(n) && !liveNames.has(n));
      const { removed } = await store.pruneNotes(allowed);
      res.json({ ok: true, removed });
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/images', async (req, res, next) => {
    try {
      res.json(await queries.listImages(activeHostId(store)));
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/images/:id', async (req, res, next) => {
    try {
      res.json(await queries.getImage(activeHostId(store), req.params.id));
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/volumes', async (req, res, next) => {
    try {
      res.json(await queries.listVolumes(activeHostId(store)));
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/volumes/:name', async (req, res, next) => {
    try {
      res.json(await queries.getVolume(activeHostId(store), req.params.name));
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/networks', async (req, res, next) => {
    try {
      res.json(await queries.listNetworks(activeHostId(store)));
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/networks/:id', async (req, res, next) => {
    try {
      res.json(await queries.getNetwork(activeHostId(store), req.params.id));
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/system/df', async (req, res, next) => {
    try {
      res.json(await queries.systemDf(activeHostId(store)));
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/activity', (req, res) => {
    res.json({ events: activity.list() });
  });

  // FR-052: chronological event feed for the selected host.
  router.get('/api/events', (req, res) => {
    const hostId = activeHostId(store);
    const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit, 10) || 500));
    const since = req.query.since ? Number(req.query.since) : null;
    const list = events.list(hostId, 500);
    const filtered = since !== null ? list.filter((e) => e.at >= since) : list;
    res.json({ events: filtered.slice(-limit) });
  });

  // FR-050/FR-051: live stats stream for a container (SSE samples).
  router.get('/api/containers/:id/stats/stream', (req, res, next) => {
    if (!stats) return next(new DockerError('DOCKER_ERROR', 'Stats service unavailable.'));
    const stream = stats.streamStats(req, res, activeHostId(store), req.params.id);
    if (!stream) return; // origin rejected -> 403 already sent
  });

  // FR-020…FR-029: the only mutating Docker endpoints (design §4.2.2).
  // CSRF middleware guards them; each call is one explicit operator request.
  router.post('/api/containers/:id/actions/:verb', async (req, res, next) => {
    try {
      res.json(await actions.run(activeHostId(store), req.params.id, req.params.verb));
    } catch (err) {
      next(err);
    }
  });

  // FR-024, FR-025: remove; ?mode=stop | ?mode=force for a running container.
  router.delete('/api/containers/:id', async (req, res, next) => {
    try {
      const mode = req.query.mode === 'stop' || req.query.mode === 'force' ? req.query.mode : null;
      res.json(await actions.remove(activeHostId(store), req.params.id, { mode }));
    } catch (err) {
      next(err);
    }
  });

  // FR-081: partial settings; unknown keys rejected by the store's allowlist.
  router.patch('/api/settings', async (req, res, next) => {
    try {
      const patch = req.body;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new DockerError('BAD_REQUEST', 'Body must be a settings object.', { action: 'settings' });
      }
      const settings = await store.saveSettings(patch);
      if (typeof patch.theme === 'string') {
        res.append('Set-Cookie', `dm_theme=${patch.theme}; SameSite=Strict; Path=/; Max-Age=31536000`);
      }
      res.json({ ok: true, settings });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { apiRouter };
