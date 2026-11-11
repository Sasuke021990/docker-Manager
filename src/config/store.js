'use strict';

// The only writer to the config folder (design §4.1). Load pipeline:
// read (≤1 MB) → JSON.parse → validate+normalise → merge env overrides →
// freeze → publish. Writes are atomic (temp file + rename) and serialised
// through a queue (NFR-032, D-022). A failed write never changes what the
// server believes is on disk.

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ConfigError, validate, defaultConfig, applyEnvOverrides, deepFreeze } = require('./schema');

const MAX_CONFIG_BYTES = 1024 * 1024;

async function fingerprint(file) {
  const st = await fs.stat(file);
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
}

async function fsyncDir(dir) {
  try {
    const fh = await fs.open(dir, 'r');
    try { await fh.sync(); } finally { await fh.close(); }
  } catch {
    // best effort: some filesystems refuse fsync on a directory handle
  }
}

function createStore({ configPath, env, log, onChange }) {
  let current = null;            // frozen validated config
  let lastKnownGood = null;
  let state = 'ok';              // ok | created | degraded | read-only
  let writable = true;
  let selfWriteFingerprint = null;
  let writeQueue = Promise.resolve();
  let watcher = null;
  let debounceTimer = null;
  let rearmTimer = null;
  let rearmAttempts = 0;
  let closed = false;

  function publish(reason) {
    if (typeof onChange === 'function' && current) onChange(current, { reason });
  }

  async function doSave(next) {
    const json = JSON.stringify(next, null, 2) + '\n';
    if (Buffer.byteLength(json) > MAX_CONFIG_BYTES) {
      throw new ConfigError('CONFIG_TOO_LARGE', 'The configuration would exceed 1 MB and was not written.');
    }
    if (!writable) throw new ConfigError('CONFIG_READ_ONLY', 'Config folder is not writable');
    const tmp = `${configPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      const fh = await fs.open(tmp, 'w', 0o600);
      try {
        await fh.writeFile(json, 'utf8');
        await fh.sync(); // durability before rename
      } finally {
        await fh.close();
      }
      await fs.rename(tmp, configPath); // atomic within the same directory
      await fsyncDir(path.dirname(configPath));
      selfWriteFingerprint = await fingerprint(configPath);
      lastKnownGood = next;
      current = deepFreeze(JSON.parse(JSON.stringify(next)));
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      if (err instanceof ConfigError) throw err;
      throw new ConfigError('CONFIG_WRITE_FAILED', `Could not write the configuration file: ${err.message}`);
    }
  }

  function save(next) {
    const task = writeQueue.then(() => doSave(next));
    writeQueue = task.catch(() => {}); // serialise writers; failures do not poison the queue
    return task.then(() => {
      publish('save');
      return current;
    });
  }

  function adoptValidated(config, warnings) {
    for (const w of warnings) log.warn('config.validation', { warning: w });
    current = deepFreeze(applyEnvOverrides(config, env));
    lastKnownGood = JSON.parse(JSON.stringify(current));
    return current;
  }

  function degradedParseFailure() {
    state = 'degraded';
    current = lastKnownGood ? deepFreeze(JSON.parse(JSON.stringify(lastKnownGood))) : deepFreeze(applyEnvOverrides(defaultConfig(), env));
    log.warn('config.parse_error', { file: configPath });
  }

  async function load() {
    try {
      await fs.access(path.dirname(configPath), fs.constants.W_OK);
    } catch {
      writable = false;
    }
    let text;
    try {
      const st = await fs.stat(configPath);
      if (st.size > MAX_CONFIG_BYTES) {
        degradedParseFailure();
        return current;
      }
      text = await fs.readFile(configPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        current = deepFreeze(applyEnvOverrides(defaultConfig(), env));
        state = 'created';
        try {
          await doSave(JSON.parse(JSON.stringify(current)));
          state = 'created';
        } catch {
          writable = false;
          state = 'read-only';
        }
        log.info('config.load', { state });
        return current;
      }
      degradedParseFailure();
      return current;
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      degradedParseFailure();
      return current;
    }
    try {
      const { config, warnings } = validate(parsed);
      adoptValidated(config, warnings);
      state = writable ? 'ok' : 'read-only';
    } catch (err) {
      if (err instanceof ConfigError) degradedParseFailure();
      else throw err;
    }
    log.info('config.load', { state });
    return current;
  }

  async function reloadFromDisk() {
    let text;
    try {
      const st = await fs.stat(configPath);
      if (st.size > MAX_CONFIG_BYTES) {
        degradedParseFailure();
        return;
      }
      text = await fs.readFile(configPath, 'utf8');
    } catch {
      // file deleted or unreadable: keep the current config, app stays up (D-020)
      degradedParseFailure();
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      degradedParseFailure();
      return;
    }
    try {
      const { config, warnings } = validate(parsed);
      const before = JSON.stringify(current);
      adoptValidated(config, warnings);
      state = writable ? 'ok' : 'read-only';
      if (JSON.stringify(current) !== before) publish('reload');
      log.info('config.load', { state, reason: 'reload' });
    } catch {
      degradedParseFailure();
    }
  }

  function armWatch() {
    if (closed) return;
    fs.watch(path.dirname(configPath), { persistent: false })
      .then((w) => {
        watcher = w;
        watcher.on('change', () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(async () => {
            debounceTimer = null;
            try {
              const fp = await fingerprint(configPath);
              if (fp === selfWriteFingerprint) return; // our own write, no reload loop
            } catch {
              // file gone: fall through to reload, which keeps the current config
            }
            await reloadFromDisk();
          }, 150);
        });
        watcher.on('error', () => {
          try { watcher.close(); } catch { /* already closed */ }
          watcher = null;
          rearm();
        });
        rearmAttempts = 0;
      })
      .catch(() => rearm());
  }

  function rearm() {
    if (closed || rearmTimer) return;
    if (rearmAttempts >= 5) return;
    rearmAttempts += 1;
    rearmTimer = setTimeout(() => {
      rearmTimer = null;
      reloadFromDisk().finally(armWatch);
    }, 2000);
  }

  async function close() {
    closed = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (rearmTimer) clearTimeout(rearmTimer);
    if (watcher) {
      try { watcher.close(); } catch { /* already closed */ }
      watcher = null;
    }
  }

  // ---- notes (FR-009, D-003, design §4.1.6) -----------------------------
  // Keyed by container name so a note survives recreation; the container ID
  // is metadata that detects a name now belonging to a different container.
  // A lookup is a read: it never writes to the file on a GET.

  function lookupNote(container, liveIds) {
    const entry = current.notes[container.name];
    if (!entry) return { status: 'none', note: null };
    if (!entry.containerId || entry.containerId === container.id) return { status: 'exact', note: entry.note, updatedAt: entry.updatedAt };
    if (!liveIds.has(entry.containerId)) return { status: 'recreated', note: entry.note, updatedAt: entry.updatedAt };
    return { status: 'foreign', note: null };
  }

  async function saveNote(name, note, containerId) {
    if (typeof note !== 'string' || note.length > 2000) {
      throw new ConfigError('CONFIG_INVALID', 'A note must be a string of at most 2,000 characters.');
    }
    const next = JSON.parse(JSON.stringify(current));
    const updatedAt = new Date().toISOString();
    if (note.trim() === '') delete next.notes[name];
    else next.notes[name] = { note, updatedAt, ...(containerId ? { containerId } : {}) };
    await save(next);
    return { note, updatedAt };
  }

  function staleNoteNames(liveNames) {
    return Object.keys(current.notes).filter((name) => !liveNames.has(name));
  }

  async function pruneNotes(names) {
    const next = JSON.parse(JSON.stringify(current));
    let removed = 0;
    for (const name of names) {
      if (typeof name === 'string' && next.notes[name]) {
        delete next.notes[name];
        removed += 1;
      }
    }
    if (removed) await save(next);
    return { removed };
  }

  // ---- settings (FR-081) -------------------------------------------------

  const SETTING_KEYS = new Set(['theme', 'showTimestamps', 'logTailLines', 'stopTimeoutSeconds', 'statsIntervalMs', 'maxBufferLines', 'activeHostId']);

  async function saveSettings(patch) {
    for (const key of Object.keys(patch)) {
      if (!SETTING_KEYS.has(key)) {
        throw new ConfigError('CONFIG_INVALID', `Unknown setting: ${key}`);
      }
    }
    const { config, warnings } = validate({ ...JSON.parse(JSON.stringify(current)), settings: { ...current.settings, ...patch } });
    for (const w of warnings) log.warn('config.validation', { warning: w });
    const next = applyEnvOverrides(config, env);
    await save(next);
    return current.settings;
  }

  return {
    load,
    reload: reloadFromDisk,
    save,
    close,
    get: () => current,
    getState: () => state,
    isWritable: () => writable,
    get path() { return configPath; },
    lookupNote,
    saveNote,
    staleNoteNames,
    pruneNotes,
    saveSettings
  };
}

module.exports = { createStore, MAX_CONFIG_BYTES, ConfigError };
