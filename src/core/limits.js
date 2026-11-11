'use strict';

// Stream and job caps (design §3.6.3). The 11th log or stats stream gets an
// SSE error frame then a close; the oldest /api/stream connection is closed
// when the bus cap is reached rather than refusing the newest.

const { DockerError } = require('../docker/errors');

const MAX_LOG_STREAMS = 10;   // NFR-022
const MAX_STATS_STREAMS = 10;
const MAX_BUS_STREAMS = 20;   // four times NFR-021 to cover reloads
const IDLE_STREAM_MS = 2 * 60 * 60 * 1000; // 2 h
const MAX_LINE_BYTES = 8 * 1024;
const MAX_VIEW_BYTES = 16 * 1024 * 1024;
const MAX_WRITE_BACKLOG = 4 * 1024 * 1024;

function createLimiter() {
  const counts = { logs: 0, stats: 0, bus: 0 };
  const caps = { logs: MAX_LOG_STREAMS, stats: MAX_STATS_STREAMS, bus: MAX_BUS_STREAMS };

  return {
    acquire(kind) {
      if (counts[kind] >= caps[kind]) {
        throw new DockerError('STREAM_LIMIT', `Too many concurrent ${kind} streams (cap ${caps[kind]}).`);
      }
      counts[kind] += 1;
      return kind;
    },
    release(kind) {
      if (counts[kind] > 0) counts[kind] -= 1;
    },
    counts
  };
}

module.exports = {
  createLimiter,
  MAX_LOG_STREAMS,
  MAX_STATS_STREAMS,
  MAX_BUS_STREAMS,
  IDLE_STREAM_MS,
  MAX_LINE_BYTES,
  MAX_VIEW_BYTES,
  MAX_WRITE_BACKLOG
};
