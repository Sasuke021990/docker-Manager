'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { derive, sumNet, sumBlock, clampInterval } = require('../src/docker/stats');

test('clampInterval bounds to 500..10000 with default', () => {
  assert.equal(clampInterval(undefined), 2000);
  assert.equal(clampInterval(100), 500);
  assert.equal(clampInterval(20000), 10000);
  assert.equal(clampInterval(1500), 1500);
});

test('sumNet sums all interfaces', () => {
  assert.deepEqual(sumNet(null), { rx: 0, tx: 0 });
  assert.deepEqual(sumNet({ eth0: { rx_bytes: 10, tx_bytes: 20 }, lo: { rx_bytes: 5, tx_bytes: 1 } }), { rx: 15, tx: 21 });
});

test('sumBlock sums Read/Write ops', () => {
  assert.deepEqual(sumBlock(null), { read: 0, write: 0 });
  assert.deepEqual(sumBlock({ io_service_bytes_recursive: [
    { op: 'Read', value: 100 }, { op: 'Write', value: 50 }, { op: 'Read', value: 7 }, { op: 'Async', value: 9 }
  ] }), { read: 107, write: 50 });
});

test('derive computes cpu/mem/net/block and is null-safe', () => {
  const sample = {
    cpu_stats: { cpu_usage: { total_usage: 200, percpu_usage: [1, 2] }, system_cpu_usage: 1000, online_cpus: 2 },
    precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 500 },
    memory_stats: { usage: 300, limit: 1000, stats: { inactive_file: 50 } },
    networks: { eth0: { rx_bytes: 12, tx_bytes: 34 } },
    blkio_stats: { io_service_bytes_recursive: [{ op: 'Read', value: 5 }, { op: 'Write', value: 6 }] },
    pids_stats: { current: 9 }
  };
  const d = derive(sample);
  assert.equal(d.cpuPct, 40); // (100/500)*2*100
  assert.equal(d.memUsed, 250);
  assert.equal(d.memLimit, 1000);
  assert.deepEqual(d.net, { rx: 12, tx: 34 });
  assert.deepEqual(d.block, { read: 5, write: 6 });
  assert.equal(d.pids, 9);
});

test('derive yields null cpu on first sample or missing deltas', () => {
  const d = derive({ cpu_stats: {}, precpu_stats: {}, memory_stats: {}, networks: null, blkio_stats: null });
  assert.equal(d.cpuPct, null);
  assert.equal(d.memUsed, null);
  assert.equal(d.memLimit, null);
  assert.equal(d.pids, null);
});
