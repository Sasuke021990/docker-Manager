'use strict';

// Server-rendered pages (design §4.2.1). Two-pass render: the page template
// renders first, its HTML is embedded in layout.ejs — no layout dependency.
// Filters are real query-string links, so reading and filtering work with JS
// disabled; the JS layer adds live updates and the drawer.

const express = require('express');
const f = require('../../core/format');
const { applyFilter } = require('../../docker/queries');
const { parseCookies } = require('../middleware/csrf');
const { DockerError, mapDockerError } = require('../../docker/errors');

const APP_VERSION = require('../../../package.json').version;

function icon(name, cls) {
  return `<svg class="icon${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="/assets/icons.svg#i-${name}"></use></svg>`;
}

function pagesRouter(ctx) {
  const { store, queries, logs, events, compose } = ctx;
  const router = express.Router();

  function baseLocals(req) {
    const cfg = store.get();
    const cookies = parseCookies(req.headers.cookie);
    const theme = ['light', 'dark', 'system'].includes(cookies.dm_theme) ? cookies.dm_theme : cfg.settings.theme;
    return {
      f,
      icon,
      theme,
      settings: cfg.settings,
      appVersion: APP_VERSION,
      currentPath: req.path,
      // Pages that carry their own host frame override this default.
      hostFrame: queries.hostFrame(cfg.settings.activeHostId)
    };
  }

  function renderPage(req, res, next, view, data) {
    const locals = { ...baseLocals(req), ...data };
    res.render(view, locals, (err, html) => {
      if (err) return next(err);
      res.render('layout', { ...locals, body: html }, (err2, page) => {
        if (err2) return next(err2);
        res.type('html').send(page);
      });
    });
  }

  function renderFragment(req, res, next, view, data) {
    res.render(view, { ...baseLocals(req), ...data }, (err, html) => {
      if (err) return next(err);
      res.type('html').send(html);
    });
  }

  function queryOf(req) {
    return {
      state: typeof req.query.state === 'string' ? req.query.state : 'all',
      q: typeof req.query.q === 'string' ? req.query.q : '',
      sort: typeof req.query.sort === 'string' ? req.query.sort : 'name',
      dir: req.query.dir === 'desc' ? 'desc' : 'asc'
    };
  }

  const EMPTY_COUNTS = { all: 0, running: 0, stopped: 0, paused: 0 };

  async function containersPage(req, res, next, detail) {
    const hostId = store.get().settings.activeHostId;
    const query = queryOf(req);
    let payload;
    let error = null;
    try {
      payload = await queries.listContainers(hostId);
    } catch (err) {
      const mapped = err instanceof DockerError ? err : mapDockerError(err);
      error = { code: mapped.code, message: mapped.message };
      payload = { host: { id: hostId, name: hostId, state: 'unreachable', apiVersion: null, engineVersion: null }, rows: [], updatedAt: Date.now() };
    }
    const { rows, counts } = applyFilter(payload.rows, query);
    renderPage(req, res, next, 'pages/containers', {
      rows,
      counts: error ? EMPTY_COUNTS : counts,
      query,
      updatedAt: payload.updatedAt,
      hostFrame: payload.host,
      error,
      detail,
      tabName: req.query.tab === 'config' ? 'config' : 'overview'
    });
  }

  router.get('/', (req, res) => res.redirect('/containers'));

  router.get('/containers', (req, res, next) => {
    containersPage(req, res, next, null).catch(next);
  });

  router.get('/containers/:id', (req, res, next) => {
    (async () => {
      const detail = await queries.getContainer(store.get().settings.activeHostId, req.params.id);
      await containersPage(req, res, next, detail);
    })().catch(next);
  });

  router.get('/containers/:id/drawer', (req, res, next) => {
    queries.getContainer(store.get().settings.activeHostId, req.params.id)
      .then((detail) => renderFragment(req, res, next, 'partials/drawer', { detail }))
      .catch(next);
  });

  async function resourcePage(req, res, next, kind, detail) {
    const hostId = store.get().settings.activeHostId;
    let error = null;
    try {
      if (kind === 'image') {
        const { images, dangling, df } = await queries.listImages(hostId);
        renderPage(req, res, next, 'pages/images', { images, dangling, df, error: null, detail });
      } else if (kind === 'volume') {
        const { volumes, df } = await queries.listVolumes(hostId);
        renderPage(req, res, next, 'pages/volumes', { volumes, df, error: null, detail });
      } else {
        const { networks } = await queries.listNetworks(hostId);
        renderPage(req, res, next, 'pages/networks', { networks, error: null, detail });
      }
    } catch (err) {
      const mapped = err instanceof DockerError ? err : mapDockerError(err);
      error = { code: mapped.code, message: mapped.message };
      const empty = { images: [], dangling: [], volumes: [], networks: [], df: null };
      renderPage(req, res, next, `pages/${kind}s`, { ...empty, error, detail: null });
    }
  }

  router.get('/images', (req, res, next) => resourcePage(req, res, next, 'image', null).catch(next));
  router.get('/images/:id', (req, res, next) => {
    queries.getImage(store.get().settings.activeHostId, req.params.id)
      .then((detail) => resourcePage(req, res, next, 'image', { kind: 'image', item: detail }))
      .catch(next);
  });
  router.get('/images/:id/drawer', (req, res, next) => {
    queries.getImage(store.get().settings.activeHostId, req.params.id)
      .then((item) => renderFragment(req, res, next, 'partials/resource-drawer', { kind: 'image', item }))
      .catch(next);
  });

  router.get('/volumes', (req, res, next) => resourcePage(req, res, next, 'volume', null).catch(next));
  router.get('/volumes/:name', (req, res, next) => {
    queries.getVolume(store.get().settings.activeHostId, req.params.name)
      .then((detail) => resourcePage(req, res, next, 'volume', { kind: 'volume', item: detail }))
      .catch(next);
  });
  router.get('/volumes/:name/drawer', (req, res, next) => {
    queries.getVolume(store.get().settings.activeHostId, req.params.name)
      .then((item) => renderFragment(req, res, next, 'partials/resource-drawer', { kind: 'volume', item }))
      .catch(next);
  });

  router.get('/networks', (req, res, next) => resourcePage(req, res, next, 'network', null).catch(next));
  router.get('/networks/:id', (req, res, next) => {
    queries.getNetwork(store.get().settings.activeHostId, req.params.id)
      .then((detail) => resourcePage(req, res, next, 'network', { kind: 'network', item: detail }))
      .catch(next);
  });
  router.get('/networks/:id/drawer', (req, res, next) => {
    queries.getNetwork(store.get().settings.activeHostId, req.params.id)
      .then((item) => renderFragment(req, res, next, 'partials/resource-drawer', { kind: 'network', item }))
      .catch(next);
  });

  // FR-052/FR-053: event feed. Opening the page is the "clear badge" moment
  // on the client; the server render is the snapshot.
  router.get('/events', (req, res, next) => {
    const hostId = store.get().settings.activeHostId;
    const list = events ? events.list(hostId, 500) : [];
    renderPage(req, res, next, 'pages/events', {
      title: 'Events',
      events: list.slice().reverse(), // newest first
      hostFrame: queries.hostFrame(hostId)
    });
  });

  // FR-040/FR-041: log page. First 100 lines are server-rendered so they
  // exist before JS/SSE; the stream continues with after=<last ts>.
  router.get('/containers/:id/logs', async (req, res, next) => {
    try {
      const hostId = store.get().settings.activeHostId;
      const detail = await queries.getContainer(hostId, req.params.id).catch((err) => {
        const mapped = err instanceof DockerError ? err : mapDockerError(err);
        return { id: req.params.id, name: req.params.id.slice(0, 12), image: '', state: 'unknown', status: '', health: null, error: { code: mapped.code, message: mapped.message } };
      });
      let snap = { tty: false, lines: [], lastTs: null, desynced: false, error: null };
      if (!detail.error) {
        try {
          const tail = store.get().settings.logTailLines || 100;
          snap = await logs.fetchSnapshot(hostId, req.params.id, tail, true);
        } catch (err) {
          const mapped = err instanceof DockerError ? err : mapDockerError(err);
          snap = { tty: false, lines: [], lastTs: null, desynced: false, error: { code: mapped.code, message: mapped.message } };
        }
      }
      renderPage(req, res, next, 'pages/logs', {
        title: `Logs · ${detail.name || req.params.id}`,
        detail,
        container: { id: detail.id || req.params.id, name: detail.name || req.params.id, image: detail.image || '', state: detail.state || 'unknown', status: detail.status || '', health: detail.health || null },
        snapshot: snap,
        hostFrame: queries.hostFrame(hostId)
      });
    } catch (err) {
      next(err);
    }
  });

  // FR-070…FR-078: stacks page (compose projects, up/down, output).
  router.get('/stacks', async (req, res, next) => {
    const hostId = store.get().settings.activeHostId;
    let error = null;
    let data = { stacks: [], folder: '/compose', rootError: null, compose: { state: 'unknown', version: null, message: null }, busy: { busy: false } };
    try {
      if (!compose) throw new DockerError('DOCKER_ERROR', 'Compose service unavailable.');
      data = await compose.listPublic(hostId);
    } catch (err) {
      const mapped = err instanceof DockerError ? err : mapDockerError(err);
      error = { code: mapped.code, message: mapped.message };
    }
    renderPage(req, res, next, 'pages/stacks', {
      title: 'Stacks',
      stacks: data.stacks || [],
      folder: data.folder,
      rootError: data.rootError,
      compose: data.compose || { state: 'unknown', version: null, message: null },
      busy: data.busy || { busy: false },
      error,
      hostFrame: queries.hostFrame(hostId)
    });
  });

  return router;
}

module.exports = { pagesRouter, icon };
