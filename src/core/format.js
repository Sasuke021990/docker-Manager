'use strict';

// Formatting rules from design §6.9.2. One place decides how a value is
// shown, so the web UI and the CLI cannot drift.

function plural(n, unit) {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

// Coarse uptime, largest two units: "up 3h 12m", "up 12d", "up 45s".
function uptime(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '—';
  const s = Math.max(0, Math.floor(sec));
  const units = [
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
    ['s', 1]
  ];
  const parts = [];
  let rest = s;
  for (const [label, size] of units) {
    if (rest >= size || (parts.length === 0 && label === 's')) {
      const n = Math.floor(rest / size);
      rest -= n * size;
      if (n > 0 || parts.length) parts.push(`${n}${label}`);
      if (parts.length === 2) break;
    }
  }
  return `up ${parts.join(' ') || '0s'}`;
}

// The Up/Exit column: "up 3h 12m" | "exit 1" | "never" | "—".
function upExit(row) {
  if (row.state === 'running' || row.state === 'paused' || row.state === 'restarting') {
    return uptime(row.uptimeSec);
  }
  if (row.state === 'created') return 'never';
  if (row.exitCode !== null && row.exitCode !== undefined) return `exit ${row.exitCode}`;
  return '—';
}

// 1024-based, one decimal, trailing ".0" dropped: "52.1 MB", "431 MB", "4.2 GB".
function bytes(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const sign = n < 0 ? '-' : '';
  const fixed = v.toFixed(1);
  return `${sign}${fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed} ${units[i]}`;
}

function date(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (x) => String(x).padStart(2, '0');
  return `${date(iso)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function timeOfDay(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Relative time, only for "updated N s ago" (§6.9.2).
function relTime(fromMs) {
  const delta = Math.max(0, Math.floor((Date.now() - fromMs) / 1000));
  if (delta < 5) return 'just now';
  if (delta < 60) return `${delta} s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)} m ago`;
  return `${Math.floor(delta / 3600)} h ago`;
}

function cmd(arr) {
  if (!arr || !arr.length) return '—';
  return arr.join(' ');
}

module.exports = { uptime, upExit, bytes, date, dateTime, timeOfDay, relTime, cmd, plural };
