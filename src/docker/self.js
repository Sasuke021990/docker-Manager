'use strict';

// Self-container identity (design §3.4.6, SEC-008). Resolved once from the
// local socket and compared against the target container ID on every host,
// so protection still holds when the same daemon is reached through a proxy
// or a TCP endpoint. If resolution fails, the action layer fails closed for
// state-changing verbs on a container whose name matches our hostname.

const os = require('node:os');
const { DockerError } = require('./errors');

const REFRESH_MS = 60 * 1000;
let lastResolveAt = 0;

async function resolveSelf(pool, env) {
  const host = pool.localSocketHost() ?? pool.activeHost();
  if (!host || !host.client) return null;
  const list = await host.client.listContainers({ all: true });
  const hints = [env.selfContainerId, os.hostname()].filter(Boolean).filter((h) => h.length >= 12);
  const hit = list.find((c) => hints.some((h) => c.Id === h || c.Id.startsWith(h)));
  lastResolveAt = Date.now();
  const resolved = hit ? { id: hit.Id, name: (hit.Names && hit.Names[0] || '').replace(/^\//, '') } : null;
  pool.setSelfId(resolved ? resolved.id : null);
  return resolved;
}

function isSelf(pool, containerId) {
  const selfId = pool.getSelfId();
  return Boolean(selfId) && (containerId === selfId || (containerId && selfId.startsWith(containerId)));
}

// SEC-008 refusal set: start/stop/kill/remove/pause (spec §19.2, SN-09).
// `unpause` stays available so a paused own container can be recovered.
const PROTECTED_VERBS = new Set(['start', 'stop', 'kill', 'rm', 'pause', 'restart']);

function assertNotSelf(pool, env, containerId, containerName, verb) {
  if (!PROTECTED_VERBS.has(verb)) return;
  if (isSelf(pool, containerId)) {
    throw new DockerError('SELF_PROTECTED',
      'Refusing: this is Docker Manager\'s own container.', { action: verb, containerId });
  }
  if (!pool.getSelfId() && containerName && containerName === os.hostname()) {
    throw new DockerError('SELF_UNVERIFIED',
      'Refusing: Docker Manager could not verify which container it runs in, and this container matches its hostname. Set SELF_CONTAINER_ID to override.',
      { action: verb, containerId });
  }
}

function needsRefresh(pool, knownIds) {
  const selfId = pool.getSelfId();
  if (!selfId) return Date.now() - lastResolveAt > REFRESH_MS;
  return !knownIds.has(selfId) && Date.now() - lastResolveAt > REFRESH_MS;
}

module.exports = { resolveSelf, isSelf, assertNotSelf, needsRefresh, PROTECTED_VERBS };
