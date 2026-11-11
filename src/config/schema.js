'use strict';

// Hand-written validator + defaults + normaliser (design §4.1.2). No ajv:
// the dependency budget is 12 and the per-field recovery rules need custom
// logic anyway. One typo in a note must not cost the operator their whole
// host list, so invalid fields are dropped or clamped with a warning; only
// an unparseable document or a wrong `version` rejects the file.

const path = require('node:path');

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const LABEL_FILTER_RE = /^[^!=\s]+(!=.*)?$/;
const EVENT_TYPES = new Set(['create', 'start', 'die', 'restart', 'health_status', 'oom', 'destroy']);
const THEMES = new Set(['light', 'dark', 'system']);
const ACCESS = new Set(['socket', 'tcp', 'ssh']);

class ConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
    this.httpStatus = { CONFIG_INVALID: 422, CONFIG_TOO_LARGE: 413, CONFIG_WRITE_FAILED: 500, CONFIG_READ_ONLY: 503 }[code] ?? 500;
    this.cliExit = 1;
  }
}

function defaultConfig() {
  return {
    version: '1',
    hosts: [{ id: 'local', name: 'This host', access: 'socket', socketPath: '/var/run/docker.sock' }],
    notes: {},
    compose: { folder: '/compose', projects: [] },
    settings: {
      logTailLines: 100,
      stopTimeoutSeconds: 10,
      statsIntervalMs: 2000,
      theme: 'system',
      activeHostId: 'local',
      showTimestamps: true,
      maxBufferLines: 5000
    },
    eventFilter: { types: [...EVENT_TYPES] }
  };
}

function clampInt(value, def, min, max, warnings, field) {
  if (value === undefined) return def;
  const n = Number.isInteger(value) ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(n)) {
    warnings.push(`${field} is not an integer; using ${def}`);
    return def;
  }
  if (n < min || n > max) {
    warnings.push(`${field} out of range ${min}-${max}; clamped`);
    return Math.min(max, Math.max(min, n));
  }
  return n;
}

function validHost(entry, warnings) {
  if (entry === null || typeof entry !== 'object') {
    warnings.push('hosts entry is not an object; dropped');
    return null;
  }
  const id = entry.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    warnings.push('hosts entry has an invalid id; dropped');
    return null;
  }
  const host = { id, name: typeof entry.name === 'string' && entry.name ? entry.name : id, access: entry.access };
  if (!ACCESS.has(host.access)) {
    warnings.push(`hosts.${id} has an unknown access method; dropped`);
    return null;
  }
  if (host.access === 'socket') {
    if (typeof entry.socketPath !== 'string' || !path.isAbsolute(entry.socketPath)) {
      warnings.push(`hosts.${id} needs an absolute socketPath; dropped`);
      return null;
    }
    host.socketPath = entry.socketPath;
  } else if (host.access === 'tcp') {
    let u = null;
    try { u = new URL(entry.url); } catch { /* fall through */ }
    if (!u || !['tcp:', 'http:', 'https:'].includes(u.protocol) || !u.hostname) {
      warnings.push(`hosts.${id} needs a valid tcp/http/https url; dropped`);
      return null;
    }
    host.url = String(entry.url);
    if (entry.tls && typeof entry.tls === 'object') {
      const tls = {};
      for (const k of ['ca', 'cert', 'key']) {
        if (typeof entry.tls[k] === 'string') tls[k] = entry.tls[k];
      }
      if (Object.keys(tls).length) host.tls = tls;
    }
  } else {
    if (typeof entry.sshHost !== 'string' || !entry.sshHost || typeof entry.sshUser !== 'string' || !entry.sshUser) {
      warnings.push(`hosts.${id} needs sshHost and sshUser; dropped`);
      return null;
    }
    host.sshHost = entry.sshHost;
    host.sshUser = entry.sshUser;
    if (entry.sshPort !== undefined && (!Number.isInteger(entry.sshPort) || entry.sshPort < 1 || entry.sshPort > 65535)) {
      warnings.push(`hosts.${id} sshPort must be 1-65535; dropped`);
      return null;
    }
    host.sshPort = entry.sshPort ?? 22;
  }
  if (entry.labelFilter !== undefined) {
    if (Array.isArray(entry.labelFilter)) {
      const filters = entry.labelFilter.filter((f) => {
        if (typeof f === 'string' && LABEL_FILTER_RE.test(f)) return true;
        warnings.push(`hosts.${id} has an invalid labelFilter entry; dropped`);
        return false;
      });
      if (filters.length) host.labelFilter = filters;
    } else {
      warnings.push(`hosts.${id} labelFilter is not an array; dropped`);
    }
  }
  return host;
}

function validNoteEntry(name, entry, warnings) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) {
    warnings.push('note key invalid; dropped');
    return null;
  }
  if (entry === null || typeof entry !== 'object' || typeof entry.note !== 'string' || entry.note.length > 2000) {
    warnings.push(`note for ${name} invalid; dropped`);
    return null;
  }
  const updatedAt = typeof entry.updatedAt === 'string' && !Number.isNaN(Date.parse(entry.updatedAt))
    ? new Date(entry.updatedAt).toISOString()
    : new Date().toISOString();
  const out = { note: entry.note, updatedAt };
  if (typeof entry.containerId === 'string' && entry.containerId.length <= 64) out.containerId = entry.containerId;
  return out;
}

function validate(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('CONFIG_INVALID', 'Configuration root must be a JSON object.');
  }
  if (raw.version !== '1') {
    throw new ConfigError('CONFIG_INVALID', `Unsupported configuration version ${JSON.stringify(raw.version)}; expected "1".`);
  }
  const warnings = [];
  const cfg = defaultConfig();

  // hosts
  if (raw.hosts !== undefined) {
    if (!Array.isArray(raw.hosts)) {
      warnings.push('hosts is not an array; using defaults');
    } else {
      const seen = new Set();
      const hosts = [];
      for (const entry of raw.hosts) {
        const host = validHost(entry, warnings);
        if (!host) continue;
        if (seen.has(host.id)) {
          warnings.push(`hosts.${host.id} duplicated; dropped`);
          continue;
        }
        seen.add(host.id);
        hosts.push(host);
      }
      if (hosts.length > 10) {
        warnings.push('more than 10 hosts configured; keeping the first 10');
        hosts.length = 10;
      }
      if (hosts.length) cfg.hosts = hosts;
    }
  }

  // notes
  if (raw.notes !== undefined) {
    if (raw.notes === null || typeof raw.notes !== 'object' || Array.isArray(raw.notes)) {
      warnings.push('notes is not an object; ignored');
    } else {
      for (const [name, entry] of Object.entries(raw.notes)) {
        const note = validNoteEntry(name, entry, warnings);
        if (note) cfg.notes[name] = note;
      }
    }
  }

  // compose
  if (raw.compose !== undefined) {
    if (raw.compose === null || typeof raw.compose !== 'object') {
      warnings.push('compose is not an object; using defaults');
    } else {
      if (raw.compose.folder !== undefined) {
        if (typeof raw.compose.folder === 'string' && path.isAbsolute(raw.compose.folder)) {
          cfg.compose.folder = raw.compose.folder;
        } else {
          warnings.push('compose.folder must be an absolute path; using /compose');
        }
      }
      if (raw.compose.projects !== undefined) {
        if (Array.isArray(raw.compose.projects)) {
          for (const p of raw.compose.projects) {
            if (p && typeof p === 'object' && typeof p.name === 'string' && p.name
              && typeof p.path === 'string' && p.path && typeof p.file === 'string' && p.file) {
              cfg.compose.projects.push({ name: p.name, path: p.path, file: p.file });
            } else {
              warnings.push('compose.projects entry invalid; dropped');
            }
          }
        } else {
          warnings.push('compose.projects is not an array; ignored');
        }
      }
    }
  }

  // settings
  if (raw.settings !== undefined && (raw.settings === null || typeof raw.settings !== 'object')) {
    warnings.push('settings is not an object; using defaults');
  } else {
    const s = raw.settings || {};
    cfg.settings.logTailLines = clampInt(s.logTailLines, 100, 1, 10000, warnings, 'settings.logTailLines');
    cfg.settings.stopTimeoutSeconds = clampInt(s.stopTimeoutSeconds, 10, 0, 300, warnings, 'settings.stopTimeoutSeconds');
    cfg.settings.statsIntervalMs = clampInt(s.statsIntervalMs, 2000, 500, 10000, warnings, 'settings.statsIntervalMs');
    cfg.settings.maxBufferLines = clampInt(s.maxBufferLines, 5000, 100, 50000, warnings, 'settings.maxBufferLines');
    if (s.theme !== undefined) {
      if (THEMES.has(s.theme)) cfg.settings.theme = s.theme;
      else warnings.push('settings.theme unknown; using system');
    }
    if (typeof s.showTimestamps === 'boolean') cfg.settings.showTimestamps = s.showTimestamps;
    if (s.activeHostId !== undefined) {
      if (cfg.hosts.some((h) => h.id === s.activeHostId)) cfg.settings.activeHostId = s.activeHostId;
      else warnings.push('settings.activeHostId not in hosts; using the first host');
    }
    if (!cfg.hosts.some((h) => h.id === cfg.settings.activeHostId)) {
      cfg.settings.activeHostId = cfg.hosts[0].id;
    }
  }

  // eventFilter
  if (raw.eventFilter !== undefined) {
    const types = raw.eventFilter && Array.isArray(raw.eventFilter.types) ? raw.eventFilter.types : null;
    if (types) {
      const kept = types.filter((t) => {
        if (EVENT_TYPES.has(t)) return true;
        warnings.push(`eventFilter.types contains unknown type ${JSON.stringify(t)}; dropped`);
        return false;
      });
      if (kept.length) cfg.eventFilter.types = kept;
    } else {
      warnings.push('eventFilter.types is not an array; using defaults');
    }
  }

  return { config: cfg, warnings };
}

// D-021: DOCKER_HOST overrides the `local` host entry and marks it
// environment-managed (not editable from the UI).
function parseDockerHost(value) {
  const u = new URL(value);
  if (u.protocol === 'unix:') return { access: 'socket', socketPath: u.pathname };
  if (['tcp:', 'http:', 'https:'].includes(u.protocol)) return { access: 'tcp', url: value.replace(/^tcp:/, 'http:') };
  if (u.protocol === 'ssh:') {
    return { access: 'ssh', sshHost: u.hostname, sshUser: decodeURIComponent(u.username || 'root'), sshPort: u.port ? Number(u.port) : 22 };
  }
  throw new ConfigError('CONFIG_INVALID', `Unsupported DOCKER_HOST protocol ${u.protocol}`);
}

function applyEnvOverrides(config, env) {
  const cfg = JSON.parse(JSON.stringify(config));
  if (env.composeFolder) cfg.compose.folder = env.composeFolder;
  if (env.logTailLines !== null) cfg.settings.logTailLines = Math.min(10000, Math.max(1, env.logTailLines));
  if (env.stopTimeoutSeconds !== null) cfg.settings.stopTimeoutSeconds = Math.min(300, Math.max(0, env.stopTimeoutSeconds));
  if (env.dockerHost) {
    const entry = { id: 'local', name: 'This host', managedByEnv: true, ...parseDockerHost(env.dockerHost) };
    const idx = cfg.hosts.findIndex((h) => h.id === 'local');
    if (idx >= 0) cfg.hosts[idx] = entry;
    else cfg.hosts.unshift(entry);
    if (!cfg.hosts.some((h) => h.id === cfg.settings.activeHostId)) cfg.settings.activeHostId = 'local';
  }
  return cfg;
}

function deepFreeze(obj) {
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') deepFreeze(v);
  }
  return Object.freeze(obj);
}

module.exports = {
  ConfigError,
  defaultConfig,
  validate,
  applyEnvOverrides,
  parseDockerHost,
  deepFreeze,
  EVENT_TYPES
};
