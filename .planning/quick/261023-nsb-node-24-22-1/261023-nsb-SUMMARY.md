---
phase: quick-261023-nsb
plan: 01
status: complete
subsystem: infra
tags: [security, node, docker, supply-chain]
requires: []
provides:
  - "Node.js 24.22.1 everywhere the repo pins Node: .nvmrc, engines, every node:*-bookworm-slim base (index digest), CI step image default"
affects: [".nvmrc", "package.json", "apps/api", "apps/web", "apps/sandboxd", "infra/openclaw", "infra/fake-model", "infra/mcp-sandbox", "infra/sandbox", "infra/ci", "scripts/e2e-isolated.sh"]
tech-stack:
  added: []
  patterns:
    - "Every node:*-bookworm-slim FROM pins tag and index digest (api, web, openclaw build stage, fake-model and mcp-sandbox were tag-only)"
key-files:
  created: []
  modified:
    - .nvmrc
    - package.json
    - apps/api/Dockerfile
    - apps/web/Dockerfile
    - apps/sandboxd/package.json
    - infra/openclaw/Dockerfile
    - infra/openclaw/test/run-container-smoke.sh
    - infra/fake-model/Dockerfile
    - infra/mcp-sandbox/Dockerfile
    - infra/mcp-sandbox/package.json
    - infra/mcp-sandbox/package-lock.json
    - infra/ci/Dockerfile
    - infra/sandbox/README.md
    - infra/sandbox/sbx/Dockerfile
    - infra/sandbox/egress/Dockerfile
    - infra/sandbox/sandboxd/Dockerfile
    - infra/sandbox/browser/Dockerfile
    - infra/sandbox/browser/package.json
    - infra/sandbox/browser/package-lock.json
    - infra/sandbox/test/run-packages-smoke.sh
    - infra/sandbox/test/run-egress-smoke.sh
    - infra/sandbox/test/run-stack-smoke.sh
    - infra/sandbox/test/run-browser-smoke.sh
    - infra/sandbox/test/run-orphans-check.sh
    - scripts/e2e-isolated.sh
decisions:
  - "Patch bump within the ADR-0001 LTS line; ADR-0001 and ADR-0029 left untouched (they record history)"
  - "@types/node stays at 24.13.6: no types release tracks 24.22.x, and a types bump is not part of a security patch"
  - "The OpenClaw runtime image (ghcr.io/openclaw/openclaw:2026.9.7-slim) still ships Node 24.21.0; upgrading OpenClaw is a separate task"
metrics:
  duration: "~1 h"
  completed: 2026-10-23
actuals:
  tokens: 3000
  tasks: 1
  commits: 2
---

# Quick 261023-nsb: Node.js 24.22.1 security bump — Summary

**Node goes from 24.21.0 to 24.22.1, the October 2026 security release (10 CVEs, 4 high, incl. CVE-2026-111497, an
out-of-bounds write in the brotli decoder). Every image the repo builds now starts from
`node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205`.**

## Release source

- `nodejs.org/dist/index.json` lists v24.22.1 (2026-10-20 dist date, `lts: Krypton`, `security: true`).
- The release post `nodejs.org/en/blog/release/v24.22.1` reads "2026-10-21, Version 24.22.1 'Krypton' (LTS). This is a
  security release." It lists CVE-2026-111497 (brotli, High) plus OpenSSL 3.5.9, c-ares 1.34.9 and undici 7.30.1.
- Docker Hub `library/node:24.22.1-bookworm-slim` has OCI index digest `sha256:55fb5f5a…b55d205`, built from docker-node
  `80f02a54` on 2026-10-21. A container from that image prints `v24.22.1`, openssl `3.5.9`.
- The CI step image (`node:${NODE_VERSION}-bookworm`, full variant) stays tag-only, because `build-image.sh` passes the
  version from `.nvmrc`. `node:24.22.1-bookworm` index: `sha256:6449e19d…e4240a`.

## Not covered

The bot cell's runtime stage is the OpenClaw image (`ghcr.io/openclaw/openclaw:2026.9.7-slim`). That image ships
`NODE_VERSION=24.21.0`, so the cell's gateway still runs 24.21.0 and only the cell's build stage moved. OpenClaw
`2026.10.6-slim` (published 2026-10-22) ships 24.22.1. Upgrading OpenClaw needs its own task with the cell proof.

## Verification (local Node 24.22.1 via nvm; images on 24.22.1)

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` | up to date (pnpm-lock unchanged); on 24.21.0, engineStrict now refuses |
| npm lockfiles (`npm install --package-lock-only`) | no change beyond the `engines` line |
| `pnpm verify` | green: 366 files, 5943 tests |
| `pnpm typecheck --force` | green |
| `node --test 'scripts/**/*.test.mjs'` / `'infra/**/*.test.mjs'` | 161/161, 334/334 |
| `docker build` api, web, openclaw, fake-model, mcp-sandbox, sandboxd, sbx, browser, egress, ci | all built; `node --version` = v24.22.1 in each (openclaw runtime: v24.21.0, see above) |
| sandbox, egress, browser, stack smokes | all passed (egress 31/31, stack 74/74) |
| OpenClaw container smoke | every scenario passes except `marketplace` |

The `marketplace` failure is not caused by this bump. The scenario fails the same way on the 24.21.0 baseline images
(built from the parent commit): "install policy failed closed: …/opt/ocw/install-policy.mjs must be owned by the
current user (uid=1000) or root". The likely cause is that the `docker cp` of the policy script keeps the host uid
on Docker Desktop for macOS. The Woodpecker cell-smoke on Linux will confirm this on the PR.

All images built for this check were removed afterwards.
