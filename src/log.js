'use strict';

// Structured JSON logger (OPS-001). One JSON object per line on stdout.
// A redaction pass over values whose key looks secret is the last line of
// defence (OPS-002, SEC-006): the primary control is that callers never pass
// payloads, env values or log text into the logger.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /pass|secret|token|key|auth|cert/i;
const REDACTED = '[redacted]';

let threshold = LEVELS[(process.env.LOG_LEVEL || 'info')] ?? LEVELS.info;

function redact(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 4) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) && typeof v === 'string' ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

function emit(level, event, fields) {
  if (LEVELS[level] < threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...redact(fields || {})
  };
  process.stdout.write(JSON.stringify(line) + '\n');
}

module.exports = {
  setLevel(level) {
    if (LEVELS[level]) threshold = LEVELS[level];
  },
  debug: (event, fields) => emit('debug', event, fields),
  info: (event, fields) => emit('info', event, fields),
  warn: (event, fields) => emit('warn', event, fields),
  error: (event, fields) => emit('error', event, fields)
};
