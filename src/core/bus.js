'use strict';

// Internal pub/sub (design §3.5.4). Four channels, no wildcards. `seq` is a
// process-wide monotonic number assigned once at ingest; SSE `id:` is that
// number and Last-Event-ID replay depends on it.

const { EventEmitter } = require('node:events');

const CHANNELS = ['container.changed', 'docker.event', 'host.health', 'activity.appended'];

class Bus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
    this.seq = 0;
  }

  nextSeq() {
    this.seq += 1;
    return this.seq;
  }

  publish(channel, payload) {
    if (!CHANNELS.includes(channel)) throw new Error(`Unknown bus channel: ${channel}`);
    const seq = this.nextSeq();
    this.emit(channel, { seq, ...payload });
    return seq;
  }
}

module.exports = { Bus, CHANNELS };
