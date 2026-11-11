'use strict';

// Transport construction and API version negotiation (design §3.4.2, §3.4.3).
// The dockerode constructor object is passed straight to docker-modem; the
// options below are the complete set used — nothing else is accepted from
// configuration. `timeout: 0` disables the idle-socket timer so long log
// streams are not killed; `connectionTimeout` bounds the connect; per-call
// AbortSignals bound unary operations.

const fs = require('node:fs');
const Dockerode = require('dockerode');
const { DockerError } = require('./errors');

const APP_MAX_API = '1.56';
const API_FLOOR = '1.40';

function normalise(v) {
  const s = String(v).replace(/^v/i, '').trim();
  if (!/^\d+\.\d+$/.test(s)) throw new DockerError('API_VERSION_UNSUPPORTED', `Invalid Docker API version: ${v}`);
  return s;
}

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function minVersion(a, b) {
  return cmpVersion(a, b) <= 0 ? a : b;
}

// Reads ca.pem/cert.pem/key.pem contents once at client build. A missing or
// unreadable file names the file in the error, never its contents (SEC-006).
function readTlsMaterial(tlsOrDir) {
  const paths = typeof tlsOrDir === 'string'
    ? { ca: `${tlsOrDir}/ca.pem`, cert: `${tlsOrDir}/cert.pem`, key: `${tlsOrDir}/key.pem` }
    : { ca: tlsOrDir.ca, cert: tlsOrDir.cert, key: tlsOrDir.key };
  const out = {};
  for (const kind of ['ca', 'cert', 'key']) {
    try {
      out[kind] = fs.readFileSync(paths[kind]);
    } catch (err) {
      throw new DockerError('DOCKER_TLS_MATERIAL_MISSING', `Could not read TLS file ${paths[kind]}: ${err.message}`);
    }
  }
  return out;
}

function modemOptions(host, env) {
  if (host.access === 'socket') {
    return { socketPath: host.socketPath, timeout: 0, connectionTimeout: 5000 };
  }
  if (host.access === 'tcp') {
    const u = new URL(host.url); // tcp:// | http:// | https://
    const tls = u.protocol === 'https:' || Boolean(host.tls);
    return {
      host: u.hostname,
      port: Number(u.port || (tls ? 2376 : 2375)),
      protocol: tls ? 'https' : 'http',
      ...(tls ? readTlsMaterial(host.tls ?? env.dockerCertPath) : {}),
      timeout: 0,
      connectionTimeout: 5000
    };
  }
  const agent = env.sshAuthSock || '/run/ssh-agent.sock';
  if (!fs.existsSync(agent)) {
    throw new DockerError('DOCKER_SSH_AGENT_MISSING',
      `SSH host ${host.id} needs an ssh-agent socket at ${agent}; none is mounted.`);
  }
  return {
    protocol: 'ssh',
    host: host.sshHost,
    port: host.sshPort ?? 22,
    username: host.sshUser,
    sshOptions: { agent },
    timeout: 0,
    connectionTimeout: 5000
  };
}

function buildClient(host, env) {
  return new Dockerode(modemOptions(host, env));
}

// Negotiation runs once per host at first use and is cached for the process
// lifetime. APP_MAX_API is the highest API this build is written against: a
// newer daemon is pinned down rather than trusted to be wire-compatible.
async function negotiate(client, env) {
  const v = await client.version();
  const daemon = normalise(v.ApiVersion);
  if (cmpVersion(daemon, API_FLOOR) < 0) {
    throw new DockerError('DAEMON_TOO_OLD',
      `Docker API ${daemon} is not supported. Docker Manager requires API ${API_FLOOR} or newer.`);
  }
  let chosen;
  if (env.dockerApiVersion) {
    chosen = normalise(env.dockerApiVersion);
    if (cmpVersion(chosen, daemon) > 0) {
      throw new DockerError('API_VERSION_UNSUPPORTED',
        `DOCKER_API_VERSION ${chosen} is above the daemon's maximum API version ${daemon}.`);
    }
  } else {
    chosen = minVersion(daemon, APP_MAX_API);
  }
  client.modem.version = `v${chosen}`; // docker-modem reads modem.version on every dial
  return { apiVersion: chosen, maxApiVersion: daemon, engineVersion: v.Version };
}

module.exports = { buildClient, negotiate, modemOptions, readTlsMaterial, cmpVersion, minVersion, normalise, APP_MAX_API, API_FLOOR };
