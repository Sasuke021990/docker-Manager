'use strict';

// Process entry (design §11.2.4): config loads (fast, local), the HTTP server
// binds, then the pool negotiates in the background — startup time is
// independent of a slow SSH host and /healthz answers during a Docker outage.

const log = require('./log');
const envParse = require('./config/env');
const { createStore } = require('./config/store');
const { Bus } = require('./core/bus');
const { createActivity } = require('./core/activity');
const { createLimiter } = require('./core/limits');
const { createPool } = require('./docker/pool');
const { createQueries } = require('./docker/queries');
const { createActions } = require('./docker/actions');
const { resolveSelf } = require('./docker/self');
const { createApp } = require('./app');

async function main() {
  const env = envParse.parse();
  log.setLevel(env.logLevel);

  const store = createStore({
    configPath: env.configPath,
    env,
    log,
    onChange: () => pool.syncHosts()
  });
  await store.load();

  const bus = new Bus();
  const activity = createActivity(bus);
  const limiter = createLimiter();
  const pool = createPool({ env, log, bus, store });
  const queries = createQueries({ pool, store, log });
  const actions = createActions({ env, pool, store, queries, activity, log });
  pool.syncHosts();

  const shutdownHooks = [];
  const app = createApp({ env, log, store, bus, pool, queries, actions, activity, limiter, shutdownHooks });

  const server = app.listen(env.port, env.bindAddress, () => {
    log.info('boot', { port: env.port, bind: env.bindAddress, configState: store.getState() });
  });

  // Background: negotiate with the daemon, start the 30 s health probe and
  // resolve self-container identity. Failures never block the listener.
  setImmediate(async () => {
    for (const host of store.get().hosts) {
      try {
        await pool.probeHost(host);
      } catch {
        // state already recorded on the runtime and broadcast via host.health
      }
    }
    pool.startProbing();
    try {
      const self = await resolveSelf(pool, env);
      log.info('boot', { selfResolved: Boolean(self) });
    } catch (err) {
      log.warn('self.resolve_failed', { message: err.message });
    }
  });

  // Graceful shutdown (design §11.1.4): stop accepting, close SSE clients,
  // destroy streams, kill compose children, flush the config queue. Budget
  // 10 s, then exit(1). Modules register cleanup through shutdownHooks.
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutdown', { signal });
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    server.close();
    for (const hook of shutdownHooks.splice(0)) {
      try {
        await hook();
      } catch (err) {
        log.warn('shutdown', { hookError: err.message });
      }
    }
    await pool.close();
    await store.close();
    clearTimeout(force);
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return { server, store, pool, bus, activity, limiter };
}

if (require.main === module) {
  main().catch((err) => {
    log.error('boot', { failure: err.message, stack: err.stack });
    process.exit(1);
  });
}

module.exports = { main };
