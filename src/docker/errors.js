'use strict';

// One error type crosses every layer (design §3.4.8). `message` is the
// daemon's or system's own text, verbatim (NFR-045); `code` is ours and is
// what the UI and the CLI branch on. The table is the single source of the
// HTTP status and CLI exit code for each code.

const TABLE = {
  DOCKER_UNREACHABLE: { http: 503, cli: 1 },
  DOCKER_SSH_AGENT_MISSING: { http: 503, cli: 1 },
  DOCKER_TLS_MATERIAL_MISSING: { http: 503, cli: 1 },
  DAEMON_TOO_OLD: { http: 409, cli: 1 },
  API_VERSION_UNSUPPORTED: { http: 409, cli: 1 },
  CONTAINER_NOT_FOUND: { http: 404, cli: 3 },
  HOST_NOT_FOUND: { http: 404, cli: 3 },
  SELF_PROTECTED: { http: 403, cli: 1 },
  SELF_UNVERIFIED: { http: 409, cli: 1 },
  SELF_PROJECT: { http: 409, cli: 1 },
  CONTAINER_STATE_CONFLICT: { http: 409, cli: 1 },
  COMPOSE_OUTSIDE_ROOT: { http: 403, cli: 1 },
  COMPOSE_BAD_FILENAME: { http: 403, cli: 1 },
  COMPOSE_ROOT_MISSING: { http: 503, cli: 1 },
  COMPOSE_UNAVAILABLE: { http: 503, cli: 1 },
  COMPOSE_BUSY: { http: 429, cli: 1 },
  COMPOSE_TIMEOUT: { http: 504, cli: 1 },
  COMPOSE_MIXED_PROJECT: { http: 409, cli: 1 },
  STREAM_LIMIT: { http: 429, cli: 1 },
  CSRF_INVALID: { http: 403, cli: 1 },
  BODY_TOO_LARGE: { http: 413, cli: 1 },
  CONFIG_INVALID: { http: 422, cli: 1 },
  CONFIG_TOO_LARGE: { http: 413, cli: 1 },
  CONFIG_WRITE_FAILED: { http: 500, cli: 1 },
  CONFIG_READ_ONLY: { http: 503, cli: 1 },
  BAD_REQUEST: { http: 400, cli: 2 },
  NOT_FOUND: { http: 404, cli: 3 },
  DOCKER_ERROR: { http: 500, cli: 1 }
};

class DockerError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'DockerError';
    this.code = TABLE[code] ? code : 'DOCKER_ERROR';
    this.httpStatus = TABLE[this.code].http;
    this.cliExit = TABLE[this.code].cli;
    if (extra.action) this.action = extra.action;
    if (extra.containerId) this.containerId = extra.containerId;
    if (extra.cause) this.cause = extra.cause;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.action ? { action: this.action } : {}),
        ...(this.containerId ? { containerId: this.containerId } : {})
      }
    };
  }
}

// Compose failures share the taxonomy; the alias keeps call sites readable.
class ComposeError extends DockerError {}

const CONNECT_ERRNO = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOENT', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EACCES']);

// Map a raw dockerode/docker-modem error into the taxonomy. Unmapped errors
// become DOCKER_ERROR with the message preserved and the stack logged, never
// returned.
function mapDockerError(err, ctx = {}) {
  if (err instanceof DockerError) return err;
  const message = (err && err.json && err.json.message) || (err && err.message) || 'Unknown Docker error';
  const status = err && err.statusCode;
  if (status === 404) return new DockerError('CONTAINER_NOT_FOUND', message, ctx);
  if (status === 409) return new DockerError('CONTAINER_STATE_CONFLICT', message, ctx);
  if (status === 304) return null; // already in the desired state: not an error
  const errno = err && err.code;
  if (CONNECT_ERRNO.has(errno)) {
    if (ctx.access === 'ssh' && /agent|ssh/i.test(message)) {
      return new DockerError('DOCKER_SSH_AGENT_MISSING', message, ctx);
    }
    return new DockerError('DOCKER_UNREACHABLE', message, ctx);
  }
  if (/agent/i.test(message) && ctx.access === 'ssh') {
    return new DockerError('DOCKER_SSH_AGENT_MISSING', message, ctx);
  }
  return new DockerError('DOCKER_ERROR', message, { ...ctx, cause: err });
}

module.exports = { DockerError, ComposeError, mapDockerError, TABLE };
