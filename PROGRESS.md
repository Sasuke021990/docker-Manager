# Docker Manager — Progress

Source of truth: `2026-11-11_DockerManager_requirement.md` v1.1 + `2026-11-11_DockerManager_requirement_design.md` v1.1.

Local dev constraints (this machine): Node 22.23.4 (spec targets 26/24 LTS, NFR-050 — code avoids APIs newer than 22); no Docker daemon or CLI, so integration tests (IT-001…IT-012), image builds and live smoke runs happen in CI or on a Docker host.

| Phase | Scope | Requirement IDs | Status | Tests | Date |
|---|---|---|---|---|---|
| 0 | Foundations: repo skeleton, config store (validation, atomic writes, hot reload, notes), dockerode client pool (socket/TCP/SSH, negotiation), error taxonomy, self-identity, security middleware (CSP, CSRF, body limit), SSE writer, /healthz, /metrics, lint + test harness | FR-080…FR-089, FR-009, NFR-032, NFR-053, NFR-054, SEC-002, SEC-003, SEC-005, SEC-006, SEC-009, SEC-010, D-001…D-006, D-020…D-024, OPS-001…OPS-003 | Done | 42 unit (lint clean, /healthz smoke passed) | 2026-11-11 |
| 1 | Read path: container list + detail (all states, filters, sorts, DTOs), images/volumes/networks + df, description precedence, UI shell (layout, tokens, header, filter bar, table/cards, drawer), server-rendered pages | FR-001…FR-012, FR-055, FR-060…FR-065, FR-100, FR-102 | Done | 52 unit (10 new: UT-002, UT-003; lint clean, degraded-mode live smoke passed) | 2026-11-11 |
| 2 | Action path: start/stop/restart/kill/rm/pause/unpause with confirmations, self-guard enforcement, activity ring + drawer, outcome toasts | FR-013, FR-020…FR-031, SEC-008, AC-014 | Done | 59 unit (7 new: actions verb/rm-mode/self-guard/activity recording, UT-008; lint clean, degraded smoke + view renders passed) | 2026-11-11 |
| 3 | Logs + events: snapshot+follow log streaming, demux, SSE log view (buffer, filter, pause, timestamps, export), event pipeline + live list updates, badge, browser notifications | FR-002, FR-040…FR-049, FR-052…FR-054, FR-056, FR-105, NFR-031, NFR-035 | Todo | — | — |
| 4 | Stats + Compose: stats sampling + panel, Compose discovery, path guard, runner with streamed output, up/down with mixed-project + self-project guards | FR-050, FR-051, FR-070…FR-078, SEC-007 | Todo | — | — |
| 5 | Hosts/SSH/CLI: host list + switching + failure states, CLI mirror with exit codes, activity/settings pages | FR-083…FR-087, FR-090…FR-095, FR-101 | Todo | — | — |
| 6 | Polish + hardening: PWA (manifest, SW, icons), animations, a11y pass, responsive bands, README/.env.example, npm audit, coverage ≥70%, traceability gate | FR-103, FR-104, FR-106, FR-107, NFR-040…NFR-056, CI-001…CI-005 | Todo | — | — |
