---
status: investigating
trigger: "Stability batch: (1) OpenClaw cell stays Offline after the restart-loop breaker; (2) flaky CI e2e hang in codex-subscription.spec.ts; (3) toasts cover the composer send button at 1440"
created: 2026-10-05T22:00:00Z
updated: 2026-10-05T23:10:00Z
---

# Stability batch 2026-10-06 (branch wt/stability, from main b61e623)

## Current Focus

hypothesis: (2) something in the e2e worker can outlive Playwright's per-test timeout
next_action: read Playwright 1.63 worker stop path and the codex spec's teardown

## 1. Cell stays Offline after OpenClaw's restart-loop breaker — FIXED

Symptom: after a starved Docker VM restarted the demo cell 6 times (exit 0), OpenClaw 2026.9.7 logged "gateway
restart-loop breaker tripped: 6 unclean boot(s) within 300000ms; suppressing channel/provider account auto-start";
the `ocw` channel never started and Settings › Bots runtime said "Offline · last seen just now".

Evidence (dist read with `docker create` + `docker cp`, no container started):
- `dist/gateway-boot-lifecycle-*.mjs`: >= 3 boots without a completion row within 5 min trip the breaker.
- `dist/server-channels-*.mjs` `startChannelProcessOwned`: while suppressed, every automatic start is refused and
  the account gets `lastError` = the breaker message; only `manual: true` (gateway `channels.start`) bypasses it.
- `dist/server-runtime-startup-services-*.mjs`: OpenClaw itself retries only from the 5-minute health monitor and
  only once the whole window has no unclean boot: 5-10 min of a healthy-looking cell that answers no bot (longer if
  the VM keeps restarting it). The plugin never learned why, so the API only saw "no WebSocket".
- In-process routes: `api.runtime.gateway.request` (OpenClaw's in-process dispatcher) is reserved to bundled or
  trusted official plugins and grants operator.write only (channels.start needs operator.admin). The public
  `openclaw/plugin-sdk/gateway-runtime` `callGatewayFromCli` is the code behind `openclaw gateway call`; inside the
  gateway it uses loopback + the shared token already in the process env (no child process, no token in argv).
- `gateway_start` fires once per boot after the startup sidecars (channel auto-start) from the boot registry.

Root cause: OpenClaw's breaker suppresses the cell's only channel for a full window and nothing in the cell
reacted or reported it.

Fix:
- `apps/openclaw-channel/src/autostart-guard.ts` (armed on `gateway_start` from `registerFull`): after a grace
  (<= 10 s) it reads the account with `channels.status`; when the breaker is the reason it reports the pause
  (`POST /agent-channel/v1/runtime`), logs why, waits `OCW_BREAKER_BACKOFF_MS` (60 s) and calls `channels.start`
  (manual), so OpenClaw's channel manager still owns the account. Doubling back-off, 5 attempts, then a report
  without schedule and the manual command in the log. One guard per process, aborted on gateway stop.
- API/contract/UI (commit 5868f9d): `AgentChannelRuntimeReport`, `AgentCellStatus.paused`, "Paused" in Settings ›
  Bots runtime with detail and restart time; cleared by the next connection, `null` or a 10-min TTL.

Tests: `autostart-guard.test.ts` (14), `openclaw-breaker.test.ts` (4, through `testing/openclaw-host.ts`, which now
models the channel manager, the breaker, channels.status/start and gateway_start; red without the guard), registration
and contract tests updated, API `agent-channel.int.test.ts` "cell runtime pause" (incl. cross-tenant), contracts test,
e2e bots.spec paused step, cell-smoke scenario `breaker` (SIGKILL until the breaker trips; CI only).

Left: the exit-0 restarts under VM CPU starvation themselves (OpenClaw liveness watchdog suspected, cf. 03.1-15
"liveness heartbeat delayed … exited with code 0") are not reproduced here.

## Eliminated

- hypothesis: the plugin can reach OpenClaw's channel manager through `api.runtime.gateway.request`
  evidence: dist/server-plugins-*.mjs `dispatchTrustedPluginGatewayMethod` throws for non-bundled, non-official
  plugins; docs/plugins/sdk-runtime: operator.write only
  timestamp: 2026-10-05T22:40:00Z

## Resolution

root_cause: (1) see above
fix: (1) see above
verification: (1) plugin 200 tests, API int 23, pnpm verify 1480 tests green; smoke scenario runs in CI only
files_changed: []
