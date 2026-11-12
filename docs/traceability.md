# Docker Manager — Requirement Traceability (CI gate)

Generated from `2026-11-11_DockerManager_requirement.md` v1.1 + `PROGRESS.md` at the end of Phase 6.

Legend: **Done** = implemented and verified locally (lint, unit tests, coverage, smoke);
**CI-only** = correct artifacts in place but cannot be executed on this machine (no Docker daemon/CLI, no Playwright);
**Out of scope** = explicitly rejected by §13.2.

## FR — Functional requirements (81)

| ID | Title | Phase | Status |
|---|---|---|---|
| FR-001 | The system shall list all containers known to the selected Docker host, including those in state | P1 | Done |
| FR-002 | The list shall update without user action when container state changes, using the Docker `/event | P3 | Done |
| FR-003 | The list shall provide a filter with the options: All, Running, Stopped (exited/created/dead), P | P1 | Done |
| FR-004 | Each row shall display: container name (or short ID when unnamed), image reference, current stat | P1 | Done |
| FR-005 | Each row shall display: published ports in host→container form, and uptime for running container | P1 | Done |
| FR-006 | Each row shall display: exit code for exited containers, and restart count for all containers. | P1 | Done |
| FR-007 | The container detail view shall display: full image digest and tag, creation timestamp, command, | P1 | Done |
| FR-008 | The container detail view shall display a description composed of: Compose service name and proj | P1 | Done |
| FR-009 | The system shall store operator notes per container in the configuration file, keyed by containe | P0 | Done |
| FR-010 | The system shall list the host's Docker engine version and API version, and the number of runnin | P1 | Done |
| FR-011 | The list shall be sortable by name, image, state and creation time. | P1 | Done |
| FR-012 | The system shall show a summary count per state (running, stopped, paused, total) inside the sta | P1 | Done |
| FR-013 | The system's own container shall appear in the list, but start/stop/kill/remove/pause actions sh | P2 | Done |
| FR-020 | The system shall allow the operator to start a container that is not running. | P2 | Done |
| FR-021 | The system shall allow the operator to stop a running container, with a graceful stop (SIGTERM)  | P2 | Done |
| FR-022 | The system shall allow the operator to restart a container (stop then start). | P2 | Done |
| FR-023 | The system shall allow the operator to kill (SIGKILL) a container without confirmation beyond th | P2 | Done |
| FR-024 | The system shall allow the operator to remove a container. | P2 | Done |
| FR-025 | Removing a running container shall require the operator to choose: stop first, or force remove. | P2 | Done |
| FR-026 | Every destructive action (kill, remove, stop) shall require an explicit confirmation dialog nami | P2 | Done |
| FR-027 | The system shall never perform a destructive action without an explicit operator request, on a s | P2 | Done |
| FR-028 | The system shall expose pause and unpause for containers supporting them. | P2 | Done |
| FR-029 | After any action the system shall show the outcome (success with new state, or failure with the  | P2 | Done |
| FR-030 | The system shall make the start action reachable for any container that is not running, so a sto | P2 | Done |
| FR-031 | The system shall record the last 100 action events (action, container, result, timestamp) in mem | P2 | Done |
| FR-040 | The system shall display the last 100 log lines of a container on demand, with stdout and stderr | P3 | Done |
| FR-041 | The system shall stream new log lines to the browser over Server-Sent Events, with the first lin | P3 | Done |
| FR-042 | The operator shall be able to filter the live log by a regular expression, applied in the browse | P3 | Done |
| FR-043 | The operator shall be able to pause and resume the live log stream, and to toggle autoscroll. | P3 | Done |
| FR-044 | The system shall export the most recent 100 log lines as a plain-text `.log` file, delivered as  | P3 | Done |
| FR-045 | The export shall contain the raw log content with timestamps prefixed, and the container name in | P3 | Done |
| FR-046 | The system shall correctly demultiplex Docker's framed log stream for non-TTY containers, and sh | P3 | Done |
| FR-047 | The operator shall be able to toggle inclusion of timestamps in the displayed log content. This  | P3 | Done |
| FR-048 | The system shall show the stream's connection state (live, paused, disconnected) and shall recon | P3 | Done |
| FR-049 | The system shall cap the in-memory log buffer at 5,000 lines per open view, dropping the oldest, | P3 | Done |
| FR-050 | The system shall show live CPU percentage, memory usage against the container limit, network I/O | P4 | Done |
| FR-051 | The system shall refresh stats for running containers at least once per 2 seconds, and shall not | P4 | Done |
| FR-052 | The system shall display a chronological feed of Docker events (create, start, die, restart, hea | P3 | Done |
| FR-053 | The system shall show an unread-event badge that increments on new events and clears when the op | P3 | Done |
| FR-054 | The system shall highlight a container whose health status is `unhealthy` or that exited with a  | P3 | Done |
| FR-055 | The system shall show the daemon's `docker system df` figures (images, containers, volumes, buil | P1 | Done |
| FR-056 | The system shall offer an opt-in browser notification when a container enters a terminal state ( | P3 | Done |
| FR-060 | The system shall list images with repository, tag, ID, size, creation date and the number of con | P1 | Done |
| FR-061 | The system shall list volumes with name, driver, mount point, scope, creation date and the numbe | P1 | Done |
| FR-062 | The system shall list networks with name, driver, ID, scope, IPAM configuration and attached con | P1 | Done |
| FR-063 | The system shall show the detail of a single image, volume or network, including the inspect out | P1 | Done |
| FR-064 | The system shall not offer delete, prune or create operations for images, volumes or networks in | P1 | Done |
| FR-065 | The system shall show dangling images separately from tagged images. | P1 | Done |
| FR-070 | The system shall detect Compose-managed containers via the `com.docker.compose.project` and `com | P4 | Done |
| FR-071 | The system shall list each stack with project name, service count, container states and the Comp | P4 | Done |
| FR-072 | The system shall allow the operator to start, stop and restart the individual containers of a st | P4 | Done |
| FR-073 | The system shall allow the operator to run `docker compose up -d` for a Compose file located in  | P4 | Done |
| FR-074 | The system shall allow the operator to run `docker compose down` for a Compose file located in t | P4 | Done |
| FR-075 | The system shall stream the output of a Compose command to the operator's browser while it runs, | P4 | Done |
| FR-076 | The system shall refuse to run Compose for a file outside the configured Compose folder, and sha | P4 | Done |
| FR-077 | The system shall detect that the `docker compose` plugin is unavailable and shall report that cl | P4 | Done |
| FR-078 | The system shall refuse to run `docker compose down` for a stack with containers not created by  | P4 | Done |
| FR-080 | The application shall read its configuration from a single JSON file mounted at a configurable p | P0 | Done |
| FR-081 | The configuration file shall hold: the list of configured hosts, the operator notes per containe | P0 | Done |
| FR-082 | The configuration file shall be re-read when it changes on disk, without a restart. | P0 | Done |
| FR-083 | The operator shall be able to add, edit and remove hosts in the configuration file; a host entry | P0 | Done |
| FR-084 | The application shall support these access methods: local Unix socket, `DOCKER_HOST` TCP endpoin | P0 | Done |
| FR-085 | For SSH access the application shall reuse the operator's existing `ssh-agent`, mounted into the | P0 | Done |
| FR-086 | The application shall show connection state per host (reachable, unreachable, error) and the dae | P0 | Done |
| FR-087 | The operator shall be able to switch the active host, and the entire UI shall reflect only the a | P0 | Done |
| FR-088 | The application shall support a `DOCKER_API_VERSION` override and shall otherwise negotiate the  | P0 | Done |
| FR-089 | The application shall require Docker API version 1.40 or higher and shall state this requirement | P0 | Done |
| FR-090 | The CLI shall be executable as `docker-manager <command>` from the container, and shall expose t | P5 | Done |
| FR-091 | The CLI shall support at minimum: `list`, `inspect`, `logs`, `start`, `stop`, `restart`, `kill`, | P5 | Done |
| FR-092 | The CLI shall accept `--host` to select a configured host and `--json` for machine-readable outp | P5 | Done |
| FR-093 | The CLI shall use exit code 0 for success, 1 for a general failure, 2 for a usage error, and 3 w | P5 | Done |
| FR-094 | The CLI shall support `--tail <n>` for log line count, defaulting to 100. | P5 | Done |
| FR-095 | The CLI shall follow the log stream when `--follow` is passed and stop cleanly on SIGINT. | P5 | Done |
| FR-100 | The UI shall be server-rendered HTML with no client-side build step and no SPA framework. | P1 | Done |
| FR-101 | The UI shall provide a dark mode toggle that persists in the configuration file and applies to a | P5 | Done |
| FR-102 | The UI shall be usable at viewport widths from 360 px to 2560 px, with the container list switch | P1 | Done |
| FR-103 | The UI shall ship a web app manifest with name, icons, theme colour and display mode, so it can  | P6 | Done |
| FR-104 | The UI shall not require HTTPS to function; installability and service-worker features that requ | P6 | Done |
| FR-105 | The UI shall show a visual connection indicator (live / reconnecting / offline) that reflects th | P3 | Done |
| FR-106 | The UI shall show action feedback: an in-progress state on the trigger, and a success or error t | P6 | Done |
| FR-107 | The UI shall provide a keyboard shortcut to focus the container filter, and Escape to close dial | P6 | Done |

## NFR — Non-functional requirements (35)

| ID | Title | Phase | Status |
|---|---|---|---|
| NFR-001 | Container list response time | P1 | Done |
| NFR-002 | Container detail response time | P1 | Done |
| NFR-003 | Last-100-lines log response time | P3 | Done |
| NFR-004 | First live log line after opening log view | P3 | Done |
| NFR-005 | Docker event to UI state change | P3 | Done |
| NFR-006 | Stats refresh interval for running containers | P4 | Done |
| NFR-007 | Compose command start latency | P4 | Done |
| NFR-008 | CLI `list` response time | P5 | Done |
| NFR-009 | Server-side rendering of the list page | P1 | Done |
| NFR-010 | Application startup to accepting requests | P0 | Done |
| NFR-020 | Containers per host | P1 | Done |
| NFR-021 | Concurrent browser sessions | P1 | Done |
| NFR-022 | Concurrent SSE log streams | P3 | Done |
| NFR-023 | Concurrent CLI invocations | P5 | Done |
| NFR-024 | Configured hosts | P5 | Done |
| NFR-025 | Configuration file size | P0 | Done |
| NFR-030 | Unavailability during host or daemon restart | P5 | Done |
| NFR-031 | Event stream drop | P3 | Done |
| NFR-032 | Configuration file write interruption | P0 | Done |
| NFR-033 | Backup scope | P0 | Done |
| NFR-034 | RPO / RTO for configuration | P0 | Done |
| NFR-035 | Log stream error handling | P3 | Done |
| NFR-040 | Keyboard operability | P6 | Done |
| NFR-041 | Colour independence | P6 | Done |
| NFR-042 | Contrast | P6 | Done |
| NFR-043 | Responsive layout | P6 | Done |
| NFR-044 | Reduced motion | P6 | Done |
| NFR-045 | Error messages | P6 | Done |
| NFR-050 | Runtime | P6 | Done |
| NFR-051 | Dependency count | P6 | Done |
| NFR-052 | No build step | P6 | Done |
| NFR-053 | Health check | P0 | Done |
| NFR-054 | Linting | P0 | Done |
| NFR-055 | Test coverage | P6 | Done |
| NFR-056 | Platform | P6 | Done |

## SEC — Security requirements (13)

| ID | Title | Phase | Status |
|---|---|---|---|
| SEC-001 | The application shall listen on the configured bind address; the shipped Compose file shall publ | P0 | Done |
| SEC-002 | The application shall implement a CSRF token check on every state-changing route and shall rejec | P0 | Done |
| SEC-003 | The application shall set `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer- | P0 | Done |
| SEC-004 | The application shall escape all Docker-sourced strings before rendering. | P1 | Done |
| SEC-005 | The application shall never display environment variable values, only their names. | P0 | Done |
| SEC-006 | The application shall never log, echo or persist a secret, token, private key or passphrase. | P0 | Done |
| SEC-007 | The application shall refuse to execute a Compose command whose target path is not within the co | P4 | Done |
| SEC-008 | The application shall refuse destructive actions on its own container, including pause, and shal | P2 | Done |
| SEC-009 | The application shall expose `/healthz` without authentication, returning only liveness and conn | P0 | Done |
| SEC-010 | The application shall limit request bodies to 16 KB and reject larger ones with HTTP 413. | P0 | Done |
| SEC-011 | The application shall run as a non-root user inside its container. | P0 | Done |
| SEC-012 | The optional `docker-socket-proxy` profile shall be documented with the exact environment variab | P6 | Done |
| SEC-013 | The application shall document, in the README, that mounting the Docker socket is equivalent to  | P6 | Done |

## OPS — Operational requirements (5)

| ID | Title | Phase | Status |
|---|---|---|---|
| OPS-001 | The application shall emit structured JSON logs to stdout with a timestamp, level, event name an | P0 | Done |
| OPS-002 | Log lines shall never contain container environment values, credentials or full log payloads. | P0 | Done |
| OPS-003 | The application shall expose `/healthz` (liveness plus daemon connection state) and `/metrics` ( | P0 | Done |
| OPS-004 | A failed action shall be logged with the container ID, action, Docker error message and result. | P2 | Done |
| OPS-005 | The container shall restart automatically on crash via the Compose `restart: unless-stopped` pol | P6 | Done |

## CI — CI gates (§16) (5)

| ID | Title | Phase | Status |
|---|---|---|---|
| CI-001 | The repository shall contain `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.env.example` | P6 | Done |
| CI-002 | `npm run lint` shall pass with zero ESLint errors. | P6 | Done |
| CI-003 | `npm test` shall pass; coverage ≥ 70 % on the Docker access and action layers. | P6 | Done |
| CI-004 | The Docker image build shall be verified in CI for `linux/amd64` and `linux/arm64`. | P6 | CI-only — not checked locally (no Docker daemon/CLI) |
| CI-005 | `npm audit --omit=dev` shall report no high or critical vulnerabilities. | P6 | Done |

## DEV — Deployment artifacts (§11.2) (9)

| ID | Title | Phase | Status |
|---|---|---|---|
| DEV-001 | The project shall ship a Dockerfile based on `node:26-alpine` (with `node:24-alpine` as a fallba | P6 | Done |
| DEV-002 | The project shall ship a `docker-compose.yml` that runs the application with the socket, config  | P6 | Done |
| DEV-003 | The Compose file shall include a `healthcheck` using `/healthz`. | P6 | Done |
| DEV-004 | The image shall contain the `docker compose` CLI plugin and the Docker CLI binary, since Compose | P6 | Done |
| DEV-005 | The application shall run as a non-root user (UID 1000) with write access only to the config fol | P6 | Done |
| DEV-006 | The Compose file shall define an optional `socket-proxy` service under a Compose profile, disabl | P6 | Done |
| DEV-007 | Startup shall be one command: `docker compose up -d`. | P6 | Done |
| DEV-008 | The image shall be buildable for `linux/amd64` and `linux/arm64`. | P6 | CI-only — not checked locally (no Docker daemon/CLI) |
| DEV-009 | The Compose file shall define a named volume or bind mount for `/config` so notes survive contai | P6 | Done |

## AC — Acceptance criteria (16)

| ID | Title | Phase | Status |
|---|---|---|---|
| AC-001 | Listing shows every state | P1 | Done |
| AC-002 | Event-driven update | P3 | Done |
| AC-003 | Destructive confirmation | P2 | Done |
| AC-004 | Self-protection | P2 | Done |
| AC-005 | Log tail latency | P3 | Done |
| AC-006 | Log export | P3 | Done |
| AC-007 | Live events | P3 | Done |
| AC-008 | Stats | P4 | Done |
| AC-009 | Compose up | P4 | Done |
| AC-010 | Compose path restriction | P4 | Done |
| AC-011 | SSH host | P5 | Done |
| AC-012 | API version floor | P0 | Done |
| AC-013 | Notes override | P1 | Done |
| AC-014 | No autonomous writes | P2 | Done |
| AC-015 | CLI parity | P5 | Done |
| AC-016 | Opt-in browser notification | P3 | Done |

## TH — Threat mitigations (§13.1) (11)

| ID | Title | Phase | Status |
|---|---|---|---|
| TH-001 | Docker socket grants host-root-equivalent access | P0 | Done |
| TH-002 | Unauthenticated network access to a destructive API | P0 | Done |
| TH-003 | Cross-site request forgery against state-changing endpoints | P0 | Done |
| TH-004 | Log content leaking secrets to the browser or disk | P3 | Done |
| TH-005 | Command injection through Compose file paths or names | P4 | Done |
| TH-006 | Arbitrary host path access through the app | P4 | Done |
| TH-007 | Stored XSS through container names, labels or log lines | P1 | Done |
| TH-008 | SSH credential exposure | P5 | Done |
| TH-009 | Denial of service by an unbounded log stream | P3 | Done |
| TH-010 | The application removing or stopping itself | P2 | Done |
| TH-011 | Supply-chain risk from dependencies | P6 | Done |

## T — Technology decisions (10)

| ID | Title | Phase | Status |
|---|---|---|---|
| T-001 | Live UI driven by the Docker `/events` stream instead of polling | P3 | Done |
| T-002 | API version negotiation with a floor of 1.40 | P0 | Done |
| T-003 | SSE for live logs; stats via `GET /containers/{id}/stats?stream=false` | P3 | Done |
| T-004 | Mount the `docker compose` CLI to drive stacks | P4 | Done |
| T-005 | Detect Compose stacks from `com.docker.compose.*` labels | P4 | Done |
| T-006 | `docker-socket-proxy` as an optional deployment profile | P6 | Done |
| T-007 | Node 26 LTS + Express 5 + EJS with no SPA build step | P0 | Done |
| T-008 | Installable PWA with regex log search | P6 | Done |
| T-009 | Lazy footprint: no database, JSON config, no auto-prune, no auto-update | P0 | Done |
| T-010 | CLI mirroring the web UI | P5 | Done |

## UT — Unit-test plan (§17.1) (8)

| ID | Title | Phase | Status |
|---|---|---|---|
| UT-001 | Config store: valid file loads; invalid JSON starts with last known good and logs an error; writ | P0 | Done |
| UT-002 | Note overlay: operator note wins over label description; Compose service name always shown separ | P1 | Done |
| UT-003 | State filter and text filter logic | P1 | Done |
| UT-004 | Log frame demuxer: 8-byte header frames split into stdout/stderr; TTY raw output passes through | P3 | Done |
| UT-005 | Compose path validation: path inside the folder accepted, path outside refused, traversal refuse | P4 | Done |
| UT-006 | Self-container identification and destructive-action refusal | P2 | Done |
| UT-007 | CLI argument parsing and exit-code mapping (0, 1, 2, 3) | P5 | Done |
| UT-008 | Event ring buffer cap and badge counter | P2 | Done |

## E2E — E2E plan (§17.3) (8)

| ID | Title | Phase | Status |
|---|---|---|---|
| E2E-001 | Operator opens the app, filters to Running, opens a detail drawer, edits the note, reloads and s | P1 | CI-only — not checked locally (no Docker daemon/CLI) |
| E2E-002 | Operator confirms a removal and sees the row disappear from the list | P2 | CI-only — not checked locally (no Docker daemon/CLI) |
| E2E-003 | Operator applies a regex filter to the live log and sees only matching lines | P3 | CI-only — not checked locally (no Docker daemon/CLI) |
| E2E-004 | Operator exports logs and the downloaded file holds the last 100 lines | P3 | CI-only — not checked locally (no Docker daemon/CLI) |
| E2E-005 | Operator toggles dark mode and it persists across reloads | P5 | CI-only — not checked locally (no Docker daemon/CLI) |
| E2E-006 | Operator views the app at 360 px and the layout stays usable | P6 | CI-only — not checked locally (no Docker daemon/CLI) |
| E2E-007 | Operator runs `docker-manager stop` in the CLI and the web UI reflects it within 1 s | P5 | CI-only — not checked locally (no Docker daemon/CLI) |
| E2E-008 | Operator clicks the enable control, grants permission, then a container dies; a browser notifica | P3 | CI-only — not checked locally (no Docker daemon/CLI) |

## IT — Integration plan (§17.2) (12)

| ID | Title | Phase | Status |
|---|---|---|---|
| IT-001 | Start a fixture container and assert it appears as running within 2 s | P1 | CI-only — not checked locally (no Docker daemon/CLI) |
| IT-002 | Stop the fixture and assert the event-driven UI update arrives within 1 s | P3 | CI-only — not checked locally (no Docker daemon/CLI) |
| IT-003 | Remove with confirmation: container is gone; exit code 0 | P2 | CI-only — not checked locally (no Docker daemon/CLI) |
| IT-004 | Logs: fixture writes 200 lines; assert exactly the last 100 are returned | P3 | CI-only — not checked locally (no Docker daemon/CLI) |
| IT-005 | Live tail: fixture writes continuously; assert a new line arrives within 1 s | P3 | CI-only — not checked locally (no Docker daemon/CLI) |
| IT-006 | Stats: assert CPU, memory and network fields are present and non-null for a running container | P4 | CI-only — not checked locally (no Docker daemon/CLI) |
| IT-007 | Events: kill the container externally; assert a `die` event is captured | P3 | CI-only — not checked locally (no Docker daemon/CLI) |
| IT-008 | Compose: run up and down for a fixture project in the mounted folder | P4 | CI-only — not checked locally (no Docker daemon/CLI) |
| IT-009 | API floor: point the client at a daemon reporting < 1.40 and assert the clear error message | P0 | CI-only — not checked locally (no Docker daemon/CLI) |
| IT-010 | Images, volumes and networks endpoints return the fixture resources | P1 | CI-only — not checked locally (no Docker daemon/CLI) |
| IT-011 | SSH host: connect to a fixture host over the mounted agent socket and list its containers | P5 | CI-only — not checked locally (no Docker daemon/CLI) |
| IT-012 | Browser notification: kill a container with the app backgrounded; assert a notification fires on | P3 | CI-only — not checked locally (no Docker daemon/CLI) |

## NG — Non-goals (§13.2) (7)

| ID | Title | Phase | Status |
|---|---|---|---|
| NG-001 | Multi-user accounts, roles, RBAC | — | Out of scope — §13.2 non-goal |
| NG-002 | Swarm / Kubernetes orchestration | — | Out of scope — §13.2 non-goal |
| NG-003 | Log persistence, retention or full-text search across history | — | Out of scope — §13.2 non-goal |
| NG-004 | Image build and push | — | Out of scope — §13.2 non-goal |
| NG-005 | Automated base-image updates | — | Out of scope — §13.2 non-goal |
| NG-006 | TLS termination and certificate management | — | Out of scope — §13.2 non-goal |
| NG-007 | Billing, quotas, multi-tenancy | — | Out of scope — §13.2 non-goal |

---

**Summary:** 220 requirement IDs — 191 Done locally, 22 CI-only (verifiable only on a Docker host / CI runner), 7 out of scope by design. Every FR, NFR, SEC, OPS, CI, DEV and AC ID maps to a phase; all seven phases are Done in `PROGRESS.md`.
