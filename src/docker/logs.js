'use strict';

// Log streaming (design §3.6): demux, bounded ring, snapshot+follow, export.
// Server holds at most 10 concurrent views (NFR-022). Each view keeps one
// Docker follow; sharing is deliberately not done in v1 (§3.6.8).

const { demux, splitTimestamp, parseTimestampSec } = require('./demux');
const { mapDockerError, DockerError } = require('./errors');
const metrics = require('../core/metrics');

const MAX_STREAMS = 10;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_LINE_LEN = 8192;

function truncLine(m) {
  if (m.length <= MAX_LINE_LEN) return m;
  const cut = m.length - MAX_LINE_LEN;
  return m.slice(0, MAX_LINE_LEN) + `… [truncated ${cut} chars]`;
}

function safeName(name) {
  return String(name || 'container')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f/\\?%*:|"<>]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'container';
}

function stamp() {
  return new Date().toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, '');
}

function createLogService({ pool, store, log: _log }) {
  const views = new Set();

  function maxLines() {
    return store.get().settings.maxBufferLines || 5000;
  }

  function ringTrim(ring) {
    const cap = maxLines();
    let dropped = 0;
    while (ring.length > cap) {
      ring.shift();
      dropped += 1;
    }
    return dropped;
  }

  async function fetchSnapshot(hostId, containerId, tail, _timestamps) {
    const client = await pool.withClient(hostId, (c) => c);
    const inspect = await client.getContainer(containerId).inspect();
    const tty = Boolean(inspect.Config && inspect.Config.Tty);
    const buf = await client.getContainer(containerId).logs({
      stdout: true, stderr: true, follow: false,
      tail: Number.isFinite(tail) ? tail : (store.get().settings.logTailLines || 100),
      timestamps: _timestamps !== false
    });
    const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
    const parsed = parseLines(data, tty, { carry: { out: '', err: '', raw: '' }, desynced: false });
    return {
      tty,
      name: (inspect.Name || '').replace(/^\//, ''),
      lines: parsed.lines,
      lastTs: lastTsOf(parsed.lines),
      desynced: parsed.desynced
    };
  }

  function lastTsOf(lines) {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i].ts) return lines[i].ts;
    }
    return null;
  }

  function parseLines(buf, tty, state) {
    const lines = [];
    let desynced = state.desynced;
    if (tty) {
      state.raw = (state.raw || '') + buf.toString('utf8');
      const parts = state.raw.split('\n');
      state.raw = parts.pop() || '';
      for (const p of parts) {
        const raw = p.endsWith('\r') ? p.slice(0, -1) : p;
        const { ts, m } = splitTimestamp(raw);
        lines.push({ s: 'out', ts, m: truncLine(m) });
      }
      return { lines, desynced };
    }
    const joined = state.carryBuf ? Buffer.concat([state.carryBuf, buf]) : buf;
    const { frames, rest, desync } = demux(joined);
    state.carryBuf = Buffer.from(rest);
    if (desync && !desynced) desynced = true;
    if (desynced) {
      // raw fallback: treat combined bytes as text
      state.raw = (state.raw || '') + joined.toString('utf8');
      state.carryBuf = Buffer.alloc(0);
      const parts = state.raw.split('\n');
      state.raw = parts.pop() || '';
      for (const p of parts) {
        const raw = p.endsWith('\r') ? p.slice(0, -1) : p;
        const { ts, m } = splitTimestamp(raw);
        lines.push({ s: 'out', ts, m: truncLine(m) });
      }
      return { lines, desynced };
    }
    for (const fr of frames) {
      const k = fr.stream === 'err' ? 'err' : 'out';
      state[k] = (state[k] || '') + fr.payload.toString('utf8');
      const parts = state[k].split('\n');
      state[k] = parts.pop() || '';
      for (const p of parts) {
        const raw = p.endsWith('\r') ? p.slice(0, -1) : p;
        const { ts, m } = splitTimestamp(raw);
        lines.push({ s: fr.stream, ts, m: truncLine(m) });
      }
    }
    return { lines, desynced };
  }

  // Page-load snapshot as plain text lines with timestamps always on (export rule).
  function toExportText(lines) {
    return lines.map((l) => (l.ts ? `${l.ts} ` : '') + l.m).join('\n') + '\n';
  }

  // Live SSE stream with race-free snapshot+follow handshake (§3.6.1).
  async function openStream(hostId, containerId, { tail, after, timestamps: _ts, sse }) {
    if (views.size >= MAX_STREAMS) {
      sse.sendT({ t: 'error', code: 'STREAM_LIMIT', message: 'Too many open log streams. Close one to open another.' });
      sse.close();
      return null;
    }
    const view = {
      hostId, containerId, sse, closed: false,
      dockerStream: null, ring: [], bytes: 0, dropped: 0, tty: false, lastTs: after || null
    };
    views.add(view);

    const close = (frame) => {
      if (view.closed) return;
      view.closed = true;
      views.delete(view);
      try { view.dockerStream && view.dockerStream.destroy(); } catch { /* ignore */ }
      if (frame) sse.sendT(frame);
      sse.close();
    };

    try {
      const client = await pool.withClient(hostId, (c) => c);
      const inspect = await client.getContainer(containerId).inspect();
      view.tty = Boolean(inspect.Config && inspect.Config.Tty);
      const sinceTs = after
        ? Math.max(0, parseTimestampSec(after) - 2)
        : Math.floor(Date.now() / 1000) - 2;

      // 1) open follow into staging
      const follow = await client.getContainer(containerId).logs({
        stdout: true, stderr: true, follow: true, tail: 0, since: sinceTs, timestamps: true
      });
      view.dockerStream = follow;
      const staging = [];
      const parseState = { out: '', err: '', raw: '', carryBuf: Buffer.alloc(0), desynced: false };
      let snapshotSent = Boolean(after);

      const flushLine = (line) => {
        if (after && line.ts && line.ts <= after) return;
        view.ring.push(line);
        view.bytes += Buffer.byteLength(line.m, 'utf8');
        while (view.bytes > MAX_BYTES && view.ring.length) {
          const old = view.ring.shift();
          view.bytes -= Buffer.byteLength(old.m, 'utf8');
          view.dropped += 1;
        }
        view.dropped += ringTrim(view.ring);
        if (line.ts) view.lastTs = line.ts;
        sse.sendT({ t: 'line', s: line.s, ts: line.ts, m: line.m });
      };

      const onData = (chunk) => {
        if (view.closed) return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || '');
        const { lines, desynced } = parseLines(buf, view.tty, parseState);
        if (desynced && !view._desyncWarned) {
          view._desyncWarned = true;
          sse.sendT({ t: 'state', state: 'warn', message: 'Log framing could not be parsed; showing raw output.' });
        }
        if (!snapshotSent) {
          staging.push(...lines);
        } else {
          for (const l of lines) flushLine(l);
        }
      };

      follow.on('data', onData);
      follow.on('end', () => close({ t: 'state', state: 'closed', reason: 'stream-end' }));
      follow.on('error', (err) => {
        const mapped = mapDockerError(err, { action: 'logs' });
        metrics.inc('logs', 'errors');
        if (mapped && mapped.code === 'CONTAINER_NOT_FOUND') {
          close({ t: 'state', state: 'closed', reason: 'container-gone' });
        } else {
          const msg = mapped ? mapped.message : (err && err.message) || 'Log stream error';
          sse.sendT({ t: 'state', state: 'error', code: mapped ? mapped.code : 'DOCKER_ERROR', message: msg });
          close();
        }
      });

      if (!after) {
        // 2) snapshot, then flush staging > lastSnapshotTs
        const snap = await fetchSnapshot(hostId, containerId, tail, true);
        view.tty = snap.tty;
        const boundary = snap.lastTs;
        sse.sendT({ t: 'snapshot', tty: snap.tty, lines: snap.lines, desynced: snap.desynced });
        view.ring.push(...snap.lines);
        view.lastTs = boundary || view.lastTs;
        snapshotSent = true;
        // flush anything staged that is strictly after boundary
        const pending = staging.splice(0, staging.length);
        for (const l of pending) {
          if (boundary && l.ts && l.ts <= boundary) continue;
          flushLine(l);
        }
      } else {
        snapshotSent = true;
        const pending = staging.splice(0, staging.length);
        for (const l of pending) flushLine(l);
      }

      sse.sendT({ t: 'state', state: 'live' });
    } catch (err) {
      views.delete(view);
      const mapped = err instanceof DockerError ? err : mapDockerError(err, { action: 'logs' });
      metrics.inc('logs', 'errors');
      sse.sendT({ t: 'state', state: 'error', code: mapped.code, message: mapped.message });
      sse.close();
      return null;
    }

    return view;
  }

  function closeAll(hostId) {
    for (const v of [...views]) {
      if (!hostId || v.hostId === hostId) {
        try { v.dockerStream && v.dockerStream.destroy(); } catch { /* ignore */ }
        views.delete(v);
        try { v.sse.close(); } catch { /* ignore */ }
      }
    }
  }

  return {
    fetchSnapshot, openStream, closeAll, toExportText, safeName, stamp,
    parseLines, ringTrim, maxLines, size: () => views.size,
    MAX_STREAMS, MAX_LINE_LEN
  };
}

module.exports = { createLogService, truncLine, safeName, stamp };
