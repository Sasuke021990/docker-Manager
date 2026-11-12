'use strict';

// Docker log frame demultiplexing (design §3.6.2, UT-004).
// TTY containers produce raw bytes (no framing). Non-TTY containers use an
// 8-byte header per frame: byte 0 = stream (1 stdout, 2 stderr), bytes 1–3
// zero, bytes 4–7 big-endian payload length, then payload.

function demux(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 8) {
    const stream = buf[off];
    const len = buf.readUInt32BE(off + 4);
    if (stream < 1 || stream > 2 || len > 4 * 1024 * 1024) {
      return { frames, rest: buf.subarray(off), desync: true }; // caller falls back to raw
    }
    if (buf.length - off - 8 < len) break;
    frames.push({
      stream: stream === 2 ? 'err' : 'out',
      payload: buf.subarray(off + 8, off + 8 + len)
    });
    off += 8 + len;
  }
  return { frames, rest: buf.subarray(off), desync: false };
}

// Split `timestamps=1` prefix: RFC3339Nano + space + message. A line without a
// parseable prefix keeps ts: null rather than being mangled.
const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (.*)$/s;

function splitTimestamp(line) {
  const m = TS_RE.exec(line);
  if (m) return { ts: m[1], m: m[2] };
  return { ts: null, m: line };
}

function parseTimestampSec(ts) {
  if (!ts) return 0;
  const t = Date.parse(ts.slice(0, 23) + (ts.endsWith('Z') ? 'Z' : ''));
  return Number.isNaN(t) ? 0 : t / 1000;
}

module.exports = { demux, splitTimestamp, parseTimestampSec, TS_RE };
