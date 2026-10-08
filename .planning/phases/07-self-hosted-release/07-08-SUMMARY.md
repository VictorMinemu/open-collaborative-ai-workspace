---
phase: 07-self-hosted-release
plan: 08
subsystem: infra
status: complete
tags: [caddy, reverse-proxy, tls, websocket, presigned-urls, trust-proxy, gate]
requires: ["07-03 (gate lib, OCW_PUBLISH_ADDRESS, caddy stub)", "07-04 (env-file helpers, dispatcher)", "07-05 (OCW_TRUST_PROXY)"]
provides:
  - "profile `proxy`: infra/caddy/{Caddyfile,compose.yaml} (+ optional compose.loopback.yaml)"
  - "pnpm ocw enable proxy --site-address <host> [--tls internal] [--no-up] [--env-file|--dir]"
  - "scripts/gate/proxy-check.mjs: run(ctx), enableProxy(ctx), openWs(origin, token); CLI --up [--block NN] | --attach"
  - "identity/client-ip.ts headersForAuth(req): better-auth's session IP follows OCW_TRUST_PROXY"
  - "docs/self-hosting/reverse-proxy.md"
affects: ["07-10 (Scenario B through the proxy: call enableProxy(ctx) + run(ctx), trust Caddy's root the same way)", "07-11 (install guide links reverse-proxy.md)"]
tech-stack:
  added: ["caddy:2.11.7-alpine@sha256:d8542f48… (image, profile proxy only)"]
  patterns:
    - "Caddyfile snippets selected by env (`import tls-{$OCW_PROXY_TLS:auto}`) instead of conditional config"
    - "Gate trusts Caddy's local root with tls.setDefaultCACertificates after proving an untrusted fetch fails"
    - "Builtins-only WebSocket client (https upgrade + RFC 6455 framing) for gate checks"
key-files:
  created:
    - infra/caddy/Caddyfile
    - infra/caddy/compose.loopback.yaml
    - infra/caddy/compose-proxy.test.mjs
    - scripts/ocw/enable-proxy.mjs
    - scripts/ocw/enable-proxy.test.mjs
    - scripts/gate/proxy-check.mjs
    - apps/api/src/modules/identity/client-ip.ts
    - apps/api/src/session-ip.int.test.ts
    - docs/self-hosting/reverse-proxy.md
  modified:
    - infra/caddy/compose.yaml
    - apps/api/src/modules/identity/routes.ts
    - apps/api/src/modules/identity/invitations.ts
decisions:
  - "Keep OCW_TRUST_PROXY=1 + loopback publishing (plan, D-18) rather than a fixed Caddy address: a static IP needs a fixed-subnet network the api must join (compose.yaml change, subnet collisions on every install). The residual (host processes and compose-network peers can forge XFF) is measured by the gate and documented"
  - "better-auth gets X-Forwarded-For = req.ip on setup, sign-in and invitation acceptance, so its stored session IP follows OCW_TRUST_PROXY"
  - "Gate stacks publish Caddy on 127.0.0.1 via infra/caddy/compose.loopback.yaml (07-03 invariant: a gate stack is never reachable from the network); the product default stays all interfaces, IPv4 and IPv6"
  - "OCW_PROXY_TLS=auto|internal (ocw enable proxy --tls internal) for internal names"
metrics:
  duration: "~55 min wall clock (20:33-21:28 local), including three pnpm verify runs and four gate runs"
  completed: 2026-10-07
actuals:
  tokens: 16700
  tasks: 2
  commits: 5
---

# Phase 7 Plan 08: Caddy `proxy` profile Summary

`pnpm ocw enable proxy --site-address <host>` now puts the instance behind Caddy on one HTTPS origin, with web, API,
both WebSockets, `/docs`, `/health` and the attachments bucket all on it. The gate step proves the three SELF-05
behaviours from outside the compose network with TLS verification on: a WebSocket upgrade with frames, presigned
URLs with tampered and unsigned ones refused, and trusted proxy headers.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 (+2 config test) | 77398a0 | feat(infra): Caddy proxy profile and ocw enable proxy |
| security note (better-auth) | 9db184b | fix(api): the session IP follows OCW_TRUST_PROXY |
| 1 | 11a9dcf | feat(gate): proxy-check tracer through Caddy on one HTTPS origin |
| 2 | dc0fb0f | feat(gate): presigned URLs, forged XFF, Secure cookie and agent-channel through the proxy |
| 2 | 51cf9ab | docs(self-hosting): reverse proxy and HTTPS with the proxy profile |

Branch `wt/07-08`, base `e27f267`. Not pushed, not merged.

## Results (exact)

| Check | Result |
|-------|--------|
| `node --test scripts/ocw/enable-proxy.test.mjs infra/caddy/compose-proxy.test.mjs infra/compose.test.mjs` | 39/39 pass, 0 skipped (15 + 9 + 15) |
| `node --test 'scripts/**/*.test.mjs' 'infra/**/*.test.mjs'` | 239/239 pass, 0 skipped |
| `vitest apps/api/src/session-ip.int.test.ts` | 2/2 (RED first: the unset case stored `203.0.113.77` / `198.51.100.9` / `192.0.2.44`) |
| identity + trust-proxy integration regression (7 files) | 52/52 |
| `pnpm verify` baseline (e27f267) | exit 0, 199 files, 2773 tests |
| `pnpm verify` before 77398a0 / 9db184b / 11a9dcf | exit 0, 200 files, 2775 tests |
| `pnpm verify` before dc0fb0f / 51cf9ab | exit 0, 200 files, 2775 tests; guard: semgrep, licenses (998 versions), fields, codeowners ok; lint shows the 4 known `apps/local-runtime` warnings |
| `node scripts/gate/proxy-check.mjs --up --block 35` (final, tree = dc0fb0f) | **exit 0, every step ok**, 253 s total (build 65 s, up 28 s, enable 14 s) |

Final gate run, step by step (`https://localhost:3543`):

| Step | Evidence |
|------|----------|
| proxy-enabled | `ocw enable proxy` exit 0; the three public URLs `https://localhost:3543`, `OCW_TRUST_PROXY=1`, `OCW_PUBLISH_ADDRESS=127.0.0.1` |
| ports-loopback | `compose port api 4000` = `127.0.0.1:3501`, web = `127.0.0.1:3500`; the host's LAN address refuses both |
| tls-trust | an untrusted fetch failed with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, then Caddy's root was trusted |
| web-login / api-health / docs | 200 / 200 / 200 (`/docs/`) |
| ws-upgrade | 101, subprotocol `ocw.v1`, Sec-WebSocket-Accept valid, `ev message.created` seq 1 after a post |
| presign-put-get | signed for `https://localhost:3543`; PUT 200, complete 200, download 302 to the same origin, GET 200, identical bytes |
| presign-tampered-403 | one signature character changed: 403; same signature on another key: 403 |
| presign-unsigned-403 | 403 |
| xff-ignored | forged `203.0.113.77`: failed sign-in 401, audit ip `192.168.112.1`; successful sign-in 200, session ip `192.168.112.1` |
| secure-cookie | `__Secure-ocw.session_token`, attributes Max-Age, Path, HttpOnly, Secure, SameSite |
| agent-channel-404 | `/agent-channel/v1/anything` and `/agent-channel` give Caddy's empty 404 |
| teardown / build-cache / demo-untouched | 4 images removed, 55 cache records pruned, the demo's 3 `:local` images and 5 containers unchanged |

The tracer run (tree 11a9dcf, Task 1 checks only) also passed on its first real attempt: 505 s, every step ok.

## Security notes requested by the orchestrator

- **Trust-proxy exposure.** In proxy mode the api and web are published on `127.0.0.1` only. The gate shows they are
  unreachable from the host's LAN address, and that a forged header sent through Caddy never reaches the audit or the
  session. The residual is measured, not assumed: with `OCW_TRUST_PROXY=1`, a process on the server that calls the
  loopback port directly with `X-Forwarded-For: 203.0.113.77` gets `203.0.113.77` audited (`residualDirectLoopback`
  in the gate JSON). The same holds for containers on the compose network. Hardening is to trust Caddy's address
  instead of a hop count, but that needs a fixed-subnet network the api joins (a compose.yaml change that this plan
  prohibits, and a subnet collision risk on every install). It is documented as the option for stricter threat
  models (reverse-proxy.md) and flagged below.
- **better-auth (finding, with evidence).** better-auth 1.7.6 reads `X-Forwarded-For` by itself for the session IP:
  `@better-auth/core/dist/utils/ip.mjs` `getIP()` reads `DEFAULT_IP_HEADERS = ["x-forwarded-for"]` and accepts a
  single-value header when `trustedProxies` is unset, and `better-auth/dist/db/internal-adapter.mjs:263` stores it.
  Its own rate limiter is disabled here (`rateLimit: { enabled: false }`), so only the stored session IP was
  affected. RED evidence: the API reached directly with `OCW_TRUST_PROXY` unset stored the forged value on setup,
  sign-in and invitation acceptance. Fixed (9db184b): `headersForAuth(req)` sets `x-forwarded-for` to Fastify's
  `req.ip` on those three paths, so the stored IP now follows `OCW_TRUST_PROXY`.
- **Compose.** `OCW_TRUST_PROXY` already reaches the api in `compose.yaml` (`${OCW_TRUST_PROXY:-false}`, from 07-03
  and 07-05), so no compose.yaml change was needed.

## Deviations from Plan

1. **[Rule 2 - Security] better-auth session IP** (orchestrator note). This adds files outside the plan's list:
   `identity/client-ip.ts`, `routes.ts`, `invitations.ts` and `session-ip.int.test.ts`. No permission check or
   policy was changed. Commit 9db184b.
2. **[Rule 2 - Safety] `infra/caddy/compose.loopback.yaml`** (not in the plan). Gate stacks are never reachable from
   the network (07-03), and Caddy's default ports publish on every interface. `enableProxy(ctx)` adds the override to
   the gate's COMPOSE_FILE before it runs `ocw enable proxy`. Operators can use the same file for a front end on the
   same host. Covered by compose-proxy.test.mjs.
3. **[Rule 2] `--tls internal` / `OCW_PROXY_TLS`.** The doc must cover internal names. A Caddyfile snippet
   (`import tls-{$OCW_PROXY_TLS:auto}`) handles this without editing the file.
4. **[Rule 3] `proxy-check --block NN`.** The first two gate attempts could not run:
   - attempt 1: ports 3400-3404 were held by a parallel plan's `--keep` stack (`ocw-gate-muyvhocx6505`);
   - attempt 2: the Docker disk had 1.7 GB free while other stacks ran, below the 6 GB floor.

   Both failed before any build and left nothing behind. The passing runs used block 35 (ports 3500-3504, proxy
   3543/3580). The default block is still 34.
5. **[Process] TDD.**
   - RED was observed for `enable-proxy.test.mjs` (unknown command), `compose-proxy.test.mjs` (Caddyfile missing) and
     `session-ip.int.test.ts` (forged IPs stored).
   - The loopback-override case and the gate checks were written alongside their code, so there was no separate RED.
   - RED commits were not made separately: the orchestrator requires `pnpm verify` green before every commit (same
     as 07-05).
6. **[Process] Commit verification.** One `pnpm verify` run covered the first three commits, since the tree was
   identical for all three. Another covered the last two (`docs/` is excluded from lint and tests).
7. **Plan acceptance `test -z "$(docker ps -aq --filter name=ocw-gate-)"`** cannot hold globally while parallel plans
   keep their own `ocw-gate-*` stacks (07-06's stack was running). Scoped to this plan's four run ids, nothing is
   left: 0 containers, volumes, networks or images.

## Findings for later plans

- **Docker Desktop hides client addresses.** On macOS, published ports reach Caddy through the Docker VM, so every
  client appears as the network gateway (`192.168.112.1` in the gate). The audit then shows the gateway, and all
  clients share one sign-in rate-limit bucket. On Linux, external clients keep their address. This is documented in
  reverse-proxy.md. 07-10's Scenario B through the proxy should keep its sign-ins under 30 per minute.
- **For 07-10:** `import { enableProxy, run } from "./proxy-check.mjs"`. Trust Caddy's root for Playwright too, via
  `NODE_EXTRA_CA_CERTS` for the runner, or `ignoreHTTPSErrors` only for the browser context, which research allowed.
  Base URL = `ctx.urls.public`.
- The gate prints the temp env-file path in `proxy-enabled.stdout`. It is not a secret, but 07-10 may want to trim it.

## Known Stubs

None. The 07-03 stub `infra/caddy/compose.yaml` (`services: {}`) is now filled.

## Broken-windows entries (for the orchestrator to record in WINDOWS.md; not edited here)

- `deviation`, phase 7, `apps/api/src/config/env.ts`: in proxy mode `OCW_TRUST_PROXY=1` trusts any immediate peer.
  Host processes and compose-network containers that reach the API directly can forge `X-Forwarded-For` (measured:
  `residualDirectLoopback.auditIp = 203.0.113.77`). Mitigation option: trust Caddy's fixed address, which needs a
  fixed-subnet network the api joins.
- `deviation`, phase 7, `scripts/gate/proxy-check.mjs`: the passing runs used `--block 35` because a parallel plan
  held block 34. 07-10 should pick a block per run or wait for a free one.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: spoofing | apps/api/src/config/env.ts (via infra/caddy, enable-proxy) | Residual XFF trust for direct loopback and compose-network peers under `OCW_TRUST_PROXY=1` (see above). Not reachable from the network. |
| threat_flag: info-disclosure | infra/caddy/compose.yaml | Caddy publishes 80/443 on every interface by design (it is the public entry). `/agent-channel/*` is blocked; the admin API is off. |

T-07-08-01..06 are all mitigated and checked by the gate: XFF overwritten (01), agent-channel 404 (02), tampered and
unsigned URLs 403 (03), loopback ports (04), `admin off` (05) and `Secure` cookie (06).

## Commands for CI (D-12)

`node --test scripts/ocw/enable-proxy.test.mjs infra/caddy/compose-proxy.test.mjs infra/compose.test.mjs` (needs
Docker for `compose config` and `caddy adapt`), and `node scripts/gate/proxy-check.mjs --up` (full gate stack, about
4-9 min warm).

## Self-Check: PASSED

- FOUND: infra/caddy/{Caddyfile,compose.yaml,compose.loopback.yaml,compose-proxy.test.mjs},
  scripts/ocw/{enable-proxy.mjs,enable-proxy.test.mjs}, scripts/gate/proxy-check.mjs,
  apps/api/src/modules/identity/client-ip.ts, apps/api/src/session-ip.int.test.ts, docs/self-hosting/reverse-proxy.md
- FOUND commits: 77398a0, 9db184b, 11a9dcf, dc0fb0f, 51cf9ab
- Acceptance greps:
  - `admin off` is at Caddyfile line 10.
  - The image digest is at compose.yaml line 9.
  - `grep -c "203.0.113.77\|agent-channel\|Secure\|403" scripts/gate/proxy-check.mjs` = 12 (at least 4 required).
  - `docs/self-hosting/reverse-proxy.md` exists.
