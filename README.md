# Docker Manager

Inspect and control the containers on your own Linux host — a small, self-hosted
web UI plus a CLI that share one core layer.

- Server-rendered UI (no client build step), live logs and events, container
  actions with confirmations, compose stack control, host switching (local
  socket, TCP/TLS, SSH).
- Node 22+ required (no transpile, no polyfills). Runtime dependencies: 4.

## ⚠️ Security warning — read first

**Mounting `/var/run/docker.sock` gives this application the same power as root
on the host.** Any bug becomes a host-level compromise. Compensating controls
are built in (private bind, CSRF, path containment, self-container guard), but
the boundary is your network: bind the port to a private network and never
expose it publicly. The optional `socket-proxy` profile (see below) reduces the
API blast radius but cannot restrict access by container — it is a reduction,
not a boundary.

## Quick start

```bash
git clone <this repo> && cd DockerManager
npm install

# Web UI (no Docker daemon needed to boot; pages render a degraded state)
CONFIG_PATH=./config/config.json PORT=8080 node src/server.js
# → http://localhost:8080

# CLI
node bin/docker-manager --help
node bin/docker-manager list
```

## Docker deployment (DEV-001…DEV-009)

One command:

```bash
mkdir -p config compose
sudo chown -R 1000:1000 config
echo "DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)" >> .env   # copy from .env.example
docker compose up -d
curl -fsS localhost:8080/healthz
```

- Runs as non-root (UID 1000) with write access to `./config` only; the root
  filesystem is read-only with a tmpfs `/tmp`.
- If the socket is `root:root 0600`, `group_add` cannot help: either add UID
  1000 to the host's `docker` group and use that GID, or run the socket proxy:
  `docker compose --profile proxy -f docker-compose.yml -f docker-compose.proxy.yml up -d`.
- SSH hosts: mount your agent socket with the override —
  `docker compose -f docker-compose.yml -f docker-compose.ssh.yml up -d`.
  Private keys and passphrases are never stored in the config file.

## Configuration

`CONFIG_PATH` (default `./config/config.json`, overridable) holds hosts,
theme and per-view settings; the file is created with safe defaults on first
run. Environment variables (see `.env.example`): `DOCKER_GID`, `NODE_IMAGE`,
`LOG_TAIL_LINES`, `STOP_TIMEOUT_SECONDS`, `LOG_LEVEL`. Docker hosts may also
come from `DOCKER_HOST`; SSH hosts reuse a mounted `SSH_AUTH_SOCK`.

## CLI

`bin/docker-manager` mirrors the UI against the same core layer:

```
list inspect logs start stop restart kill rm pause unpause stats
events images volumes networks compose ls|up|down hosts config
```

Global flags: `--host <id> --json --help --version`. Exit codes: `0` success,
`1` failure (daemon unreachable, action error, compose unavailable), `2` usage
error, `3` unknown host/container. `logs --follow` and `events` stream NDJSON
in `--json` mode; `compose down` requires `--yes` on non-TTY.

## PWA (FR-103, FR-104)

A web app manifest with icons is served at `/manifest.webmanifest`; the
service worker is pass-through only — **nothing is cached and there is no
offline screen**, because every screen is live data. Installability needs a
secure context (HTTPS or localhost): over plain HTTP the app works identically
and Settings explains that install is unavailable.

## Development

```bash
npm run lint          # eslint, CI-002
npm test              # node:test, CI-003
npm run test:coverage # c8 gate: ≥70 % lines on src/docker/** + src/compose/**, NFR-055
npm audit --omit=dev  # CI-005
```

No Docker daemon locally? Lint and the full unit suite still pass; the web UI
boots and shows degraded host states. Building the image (`CI-004`, amd64 +
arm64 per DEV-008) and end-to-end streaming checks need a Docker host.

## Project layout

```
src/            server + core (config, docker, compose, web)
  cli.js        CLI mirror (bin/docker-manager)
public/         hand-written assets, manifest, icons, service worker
tests/          node:test unit + integration (no daemon required)
docs/           traceability matrix
```
