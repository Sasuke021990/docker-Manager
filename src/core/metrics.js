'use strict';

// Per-process counters for GET /metrics (OPS-003). Counters are per process
// (reset on restart), which is enough for a single-container app.

const startedAt = Date.now();

const counters = {
  actions: { start: 0, stop: 0, restart: 0, kill: 0, rm: 0, pause: 0, unpause: 0, failed: 0 },
  sse: { open: 0, total: 0, rejected: 0 },
  logs: { streams: 0, opened: 0, errors: 0, droppedLines: 0 },
  compose: { jobs: 0, failed: 0, busyRejects: 0 },
  docker: { requests: 0, errors: 0, reconnects: 0 }
};

function inc(group, key) {
  if (counters[group] && typeof counters[group][key] === 'number') counters[group][key] += 1;
}

function add(group, key, n) {
  if (counters[group] && typeof counters[group][key] === 'number') counters[group][key] += n;
}

function snapshot() {
  const mem = process.memoryUsage();
  return {
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    actions: { ...counters.actions },
    sse: { ...counters.sse },
    logs: { ...counters.logs },
    compose: { ...counters.compose },
    docker: { ...counters.docker },
    process: { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed }
  };
}

module.exports = { inc, add, snapshot };
