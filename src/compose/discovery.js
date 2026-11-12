'use strict';

// Compose discovery (design §3.8.2, FR-070–FR-072). Merges runtime stacks from
// container labels with file projects found in the compose root. A stack is
// runnable only when its config file realpaths inside the root and exists.

const fs = require('node:fs/promises');
const path = require('node:path');
const { assertInsideRoot, realRoot, uniqueId, isInside } = require('./pathguard');

const COMPOSE_NAMES = new Set([
  'compose.yaml', 'compose.yml',
  'docker-compose.yaml', 'docker-compose.yml'
]);

function isComposeBasename(name) {
  if (COMPOSE_NAMES.has(name)) return true;
  return /^compose\.[a-z0-9_-]+\.ya?ml$/i.test(name) || /^docker-compose\.[a-z0-9_-]+\.ya?ml$/i.test(name);
}

async function scanFolder(folder) {
  let root;
  try {
    root = await realRoot(folder);
  } catch (err) {
    return { root: null, files: [], error: err };
  }
  const files = [];
  async function walk(dir, depth) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth < 2) await walk(full, depth + 1);
        continue;
      }
      if (ent.isFile() && isComposeBasename(ent.name)) files.push(full);
    }
  }
  await walk(root, 1);
  return { root, files, error: null };
}

function parseConfigFiles(value) {
  if (!value) return [];
  // com.docker.compose.project.config_files is a comma-separated list; paths
  // may be absolute.
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

async function fileRunnable(root, filePath) {
  if (!root || !filePath) return null;
  try {
    const real = await fs.realpath(path.isAbsolute(filePath) ? filePath : path.join(root, filePath));
    if (!isInside(root, real)) return null;
    if (!isComposeBasename(path.basename(real))) return null;
    const st = await fs.stat(real);
    if (!st.isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

function createDiscovery({ pool, store }) {
  async function discover(hostId) {
    const cfg = store.get();
    const folder = cfg.compose.folder || '/compose';
    const projectsCfg = Array.isArray(cfg.compose.projects) ? cfg.compose.projects : [];
    const scan = await scanFolder(folder);
    const root = scan.root;

    // Runtime stacks from container labels.
    const runtimeStacks = new Map();
    let listRows = [];
    try {
      const list = await pool.withClient(hostId, (client) => client.listContainers({ all: true }));
      listRows = Array.isArray(list) ? list : [];
    } catch {
      listRows = [];
    }

    for (const c of listRows) {
      const labels = c.Labels || {};
      const project = labels['com.docker.compose.project'];
      if (!project) continue;
      const service = labels['com.docker.compose.service'] || null;
      const configFiles = parseConfigFiles(labels['com.docker.compose.project.config_files'])[0] || null;
      const workingDir = labels['com.docker.compose.project.working_dir'] || null;
      let stack = runtimeStacks.get(project);
      if (!stack) {
        stack = { name: project, services: [], configFile: configFiles, workingDir };
        runtimeStacks.set(project, stack);
      }
      if (!stack.configFile && configFiles) stack.configFile = configFiles;
      if (!stack.workingDir && workingDir) stack.workingDir = workingDir;
      stack.services.push({
        containerId: c.Id,
        containerName: (c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : (c.Id || '').slice(0, 12)),
        service,
        state: c.State,
        status: c.Status,
        image: c.Image,
        configFile: configFiles
      });
    }

    // File projects from scan + explicit config.
    const fileProjects = new Map();
    const usedIds = new Set();
    if (root) {
      for (const f of scan.files) {
        const rel = path.relative(root, f);
        const dir = path.dirname(f);
        const projectName = path.basename(dir === root ? path.basename(f, path.extname(f)) : dir);
        const key = path.relative(root, f);
        fileProjects.set(key, { name: projectName, file: f, relFile: rel, dir });
      }
      for (const p of projectsCfg) {
        try {
          const resolved = await assertInsideRoot(root, path.join(p.path || '.', p.file || 'docker-compose.yml'));
          const rel = path.relative(root, resolved);
          fileProjects.set(rel, { name: p.name || path.basename(path.dirname(resolved)), file: resolved, relFile: rel, dir: path.dirname(resolved) });
        } catch {
          // invalid configured project: ignored in discovery; shown? keep silent
        }
      }
    }

    // Merge into stack records.
    const byName = new Map();
    for (const [name, s] of runtimeStacks) {
      byName.set(name, {
        name,
        runtime: s,
        file: null
      });
    }
    for (const [, fp] of fileProjects) {
      // try to match file project to runtime by directory/project name heuristic
      let matched = null;
      for (const [name, rec] of byName) {
        if (rec.file) continue;
        if (rec.runtime && rec.runtime.configFile) {
          const runReal = await fileRunnable(root, rec.runtime.configFile).catch(() => null);
          if (runReal && runReal === fp.file) { matched = rec; break; }
        }
        if (rec.runtime && rec.runtime.workingDir) {
          try {
            const wd = await fs.realpath(path.isAbsolute(rec.runtime.workingDir) ? rec.runtime.workingDir : path.join(root, rec.runtime.workingDir));
            if (wd === fp.dir) { matched = rec; break; }
          } catch { /* ignore */ }
        }
        if (name === fp.name) { matched = rec; break; }
      }
      if (matched) matched.file = fp;
      else byName.set(`file:${fp.relFile}`, { name: fp.name, runtime: null, file: fp });
    }

    const stacks = [];
    for (const rec of byName.values()) {
      const runtime = rec.runtime;
      const file = rec.file;
      const services = runtime ? runtime.services : [];
      const states = { running: 0, exited: 0, paused: 0, restarting: 0, dead: 0, created: 0, other: 0 };
      for (const s of services) {
        const st = (s.state || '').toLowerCase();
        if (Object.prototype.hasOwnProperty.call(states, st)) states[st] += 1; else states.other += 1;
      }

      let runnable = false;
      let runnableFile = null;
      let reason = null;
      if (!root) {
        reason = scan.error ? scan.error.message : `Compose folder ${folder} is not available.`;
      } else if (file && file.file) {
        const ok = await fileRunnable(root, file.file);
        if (ok) { runnable = true; runnableFile = ok; }
        else reason = 'Compose file not in /compose — manage with docker compose on the host';
      } else if (runtime && runtime.configFile) {
        const ok = await fileRunnable(root, runtime.configFile);
        if (ok) { runnable = true; runnableFile = ok; }
        else reason = 'Compose file not in /compose — manage with docker compose on the host';
      } else {
        reason = 'Compose file not in /compose — manage with docker compose on the host';
      }

      const projectName = runtime ? runtime.name : (file ? file.name : rec.name);
      const id = uniqueId(projectName, usedIds);
      stacks.push({
        id,
        name: projectName,
        services: services.map((s) => ({
          containerId: s.containerId,
          name: s.containerName,
          service: s.service,
          state: s.state,
          status: s.status,
          image: s.image,
          configFile: s.configFile || (runtime ? runtime.configFile : null)
        })),
        serviceCount: services.length,
        states,
        runnable,
        file: runnableFile ? path.relative(root, runnableFile) : (file ? file.relFile : null),
        absFile: runnableFile || null,
        dir: runnableFile ? path.dirname(runnableFile) : (file ? file.dir : (root || folder)),
        reason: runnable ? null : reason,
        configFileReported: runtime ? runtime.configFile : null
      });
    }

    stacks.sort((a, b) => a.name.localeCompare(b.name));
    return { stacks, root, folder, rootError: scan.error ? scan.error.message : null };
  }

  return { discover };
}

module.exports = { createDiscovery, isComposeBasename };
