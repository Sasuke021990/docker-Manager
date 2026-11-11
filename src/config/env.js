'use strict';

// Environment surface (spec §13.2, design §4.1.5). Precedence is
// environment > file > defaults. Values are read at boot; nothing here is
// ever displayed or logged (D-023).

function intVar(raw, def, min, max) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function parse(raw = process.env) {
  return Object.freeze({
    port: intVar(raw.PORT, 8080, 1, 65535),
    bindAddress: raw.BIND_ADDRESS || '0.0.0.0',
    configPath: raw.CONFIG_PATH || '/config/config.json',
    composeFolder: raw.COMPOSE_FOLDER || null,
    dockerHost: raw.DOCKER_HOST || null,
    dockerApiVersion: raw.DOCKER_API_VERSION || null,
    dockerCertPath: raw.DOCKER_CERT_PATH || null,
    sshAuthSock: raw.SSH_AUTH_SOCK || '/run/ssh-agent.sock',
    logTailLines: raw.LOG_TAIL_LINES === undefined ? null : intVar(raw.LOG_TAIL_LINES, 100, 1, 10000),
    stopTimeoutSeconds: raw.STOP_TIMEOUT_SECONDS === undefined ? null : intVar(raw.STOP_TIMEOUT_SECONDS, 10, 0, 300),
    selfContainerId: raw.SELF_CONTAINER_ID || null,
    logLevel: raw.LOG_LEVEL || 'info'
  });
}

module.exports = { parse };
