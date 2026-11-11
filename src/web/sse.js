'use strict';

// SSE writer (design §3.5.6, §4.2.4): headers, advisory retry, heartbeat
// comments, id/replay support, backpressure kill, cleanup on close. Bus
// frames are {v:1,kind,data}; stream frames carry `t` mirroring the event
// name. Consumers ignore unknown frame types and fields.

const { MAX_WRITE_BACKLOG } = require('../core/limits');
const metrics = require('../core/metrics');

const HEARTBEAT_MS = 20 * 1000;

function openSse(req, res, { heartbeat = true } = {}) {
  // Same-origin check: when Origin is present it must match Host; there is
  // no CORS header anywhere in the app, so a cross-origin EventSource cannot
  // read the stream anyway.
  const origin = req.headers.origin;
  if (origin && origin !== `${req.protocol}://${req.headers.host}`) {
    res.status(403).end();
    return null;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');
  res.flushHeaders?.();
  metrics.inc('sse', 'open');
  metrics.inc('sse', 'total');

  let closed = false;
  const hb = heartbeat ? setInterval(() => {
    if (!closed) res.write(`: hb ${new Date().toISOString()}\n\n`);
  }, HEARTBEAT_MS) : null;
  hb && hb.unref && hb.unref();

  function raw(chunk) {
    if (closed) return false;
    if (res.writableLength > MAX_WRITE_BACKLOG) { // 4 MB backlog kill
      close();
      req.destroy();
      return false;
    }
    res.write(chunk);
    return true;
  }

  // Bus frame: one JSON object on one data: line, event: = kind, id: = seq.
  function send(kind, data, id) {
    const head = id === undefined ? '' : `id: ${id}\n`;
    return raw(`${head}event: ${kind}\ndata: ${JSON.stringify({ v: 1, kind, data })}\n\n`);
  }

  // Stream frame (logs, stats, compose): event: = t, data carries t too.
  function sendT(obj) {
    return raw(`event: ${obj.t}\ndata: ${JSON.stringify(obj)}\n\n`);
  }

  function comment(text) {
    return raw(`: ${text}\n`);
  }

  function close() {
    if (closed) return;
    closed = true;
    if (hb) clearInterval(hb);
    metrics.add('sse', 'open', -1);
    try { res.end(); } catch { /* already ended */ }
  }

  req.on('close', close);
  return { send, sendT, comment, close, get closed() { return closed; } };
}

module.exports = { openSse, HEARTBEAT_MS };
