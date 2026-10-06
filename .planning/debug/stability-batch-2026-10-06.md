---
status: fixing
trigger: "Stability batch: (1) OpenClaw cell stays Offline after the restart-loop breaker; (2) flaky CI e2e hang in codex-subscription.spec.ts; (3) toasts cover the composer send button at 1440"
created: 2026-10-05T22:00:00Z
updated: 2026-10-06T00:30:00Z
---

# Stability batch 2026-10-06 (branch wt/stability, from main b61e623)

## Current Focus

hypothesis: all three root causes confirmed and fixed (commits 5868f9d, 64674f0, b9f712e, 80a786b)
next_action: owner checks the CI cell-smoke `breaker` scenario and the screenshots, then merge

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
"liveness heartbeat delayed … exited with code 0") are not reproduced here. While the breaker is still active, an
OpenClaw hot reload that restarts `ocw` (a `channels.ocw` edit or a plugin generation swap) only stops it
(dist `restartGatewayChannels`, "suppressed hot reload"); OpenClaw's own recovery restarts it once the window drains.

### 1b. CI cell-smoke `breaker` failed on PR #15 (run 37411421709, job 112100473690)

Evidence: the real gateway tripped the breaker (`3 unclean boot(s) within 300000ms`), refused ocw
(`[ocw] channel autostart suppressed by crash-loop breaker`) and ran the gateway_start hooks
(`startup outcomes: … gateway-start-hooks=scheduled`, after "starting channels and sidecars", so timing was right),
yet the guard logged nothing: it took its silent `not-suppressed` path. dist/channels-*.mjs `channels.status` builds
the account snapshot with `buildChannelAccountSnapshotFromAccount` (dist/status-*.mjs): without a plugin
`status.buildAccountSnapshot` it uses `projectSafeChannelAccountSnapshotFields`, which drops `lastError`, and
`applyChannelAccountState` then sets `lastError: null`. The refusal message lives only in the channel manager's
runtime. The host model had returned the raw runtime (with `lastError`), so the contract test passed on a contract the
real gateway does not offer.

Fix: the ocw channel plugin gets `status.buildAccountSnapshot` (channel-status.ts: explicit fields, `lastError`
bounded to 500 chars, never the account's token reader), so `channels.status` (and `openclaw channels status`) carries
the refusal; the host's channels.status now mirrors the dist projection (the breaker contract test went red with it,
green with the plugin snapshot); the guard logs every non-running outcome.

## 2. "Flaky CI e2e hang" in codex-subscription.spec.ts — FIXED (it was not a test hang)

Evidence: the incident is run 37341305017 attempt 1, job "e2e (Playwright, desktop)" (16:30:07 → cancelled 17:00:25).
- `pnpm exec playwright install --with-deps chromium` (browsers were a cache hit) spent 16:31:38 → 16:58:01 in apt:
  "Fetched 32.1 MB in 26min 7s (20.4 kB/s)" (fonts-wqy-zenhei alone 19 min) from the runner's Ubuntu mirror.
- `pnpm e2e` started at 16:58:06; tests ran normally (21 passed in 2 m 17 s, each a few seconds); chat.spec passed at
  17:00:23 and the job hit its 30-minute timeout at 17:00:25, two seconds into codex-subscription (test 22).
- Attempt 2: the same 32.1 MB in 2 s (19.4 MB/s); codex-subscription passed in 8.4 s; 36 passed in 5.9 min.
- Playwright 1.63 races every test, hook and fixture teardown against its timeout (worker `TimeoutManager`): a test
  outlives it only with a blocked event loop or a disabled timeout. A job-level timeout cancels the job, so the
  `if: failure()` report/log steps never ran and the log simply ended after chat.spec.

Root cause: an unbounded, network-bound CI step (apt via `playwright install --with-deps`) shared the e2e job's
30-minute budget with the test run; one slow mirror consumed it and the cancellation looked like a hung spec.

Fix: the install step has its own `timeout-minutes: 8` (ci.yml e2e and cell-proof.yml), the Playwright step 17, and
`globalTimeout` is 15 min in CI (e2e/playwright.config.ts), so each phase fails on its own, as a failed step that
keeps the report and logs. Proof of the safety net: a spec that never settles with `test.setTimeout(0)` ran forever
without it and failed after 5 s with "Timed out waiting 5s for the test suite to run" with it (CI=1, temp config).
No spec change: codex-subscription.spec has no await outside its timeout scope.

## 3. Toasts cover the Work Zone composer's send button at 1440 — FIXED

Evidence: `components/ui/sonner.tsx` places toasts bottom-right (24 px) from 640 px up; the Work Zone composer
(`max-w-3xl`, centred in the session column) reaches x ≈ 1328 at 1440, so a 356 px toast at the right edge sits on
its right end and send button (03.2-REFERENCE-REVIEW observation 3). Phones (< 640 px) already drop toasts from the
top. New e2e assertion in work-zone-slash.spec (toast box ∩ `composer-form` box) failed at 1440 before the fix
("Received: true").

Fix: the composer publishes its clearance (viewport bottom → composer top, ResizeObserver + resize) as
`--toast-clearance` on <html> while mounted (`hooks/use-toast-clearance.ts`); the Toaster's bottom offset is
`calc(var(--toast-clearance, 0px) + 24px)`, so on Work Zone pages toasts stack just above the composer and everywhere
else keep Sonner's 24 px. Phones unchanged (top-center).

## Eliminated

- hypothesis: codex-subscription.spec (or its fake device-auth server / fake cell) can outlive Playwright's test timeout
  evidence: the job log shows the spec ran 2 s before the job timeout; attempt 2 passed in 8.4 s; Playwright 1.63
  bounds test body, hooks and teardown with timers
  timestamp: 2026-10-05T23:30:00Z

- hypothesis: the plugin can reach OpenClaw's channel manager through `api.runtime.gateway.request`
  evidence: dist/server-plugins-*.mjs `dispatchTrustedPluginGatewayMethod` throws for non-bundled, non-official
  plugins; docs/plugins/sdk-runtime: operator.write only
  timestamp: 2026-10-05T22:40:00Z

## Resolution

root_cause: (1) OpenClaw's restart-loop breaker suppresses the cell's only channel for a full window and nothing reacted
  or reported it; (2) an unbounded apt step consumed the e2e job budget, the cancellation looked like a hung spec;
  (3) bottom-right toaster over a bottom-pinned composer at 1440.
fix: see sections 1-3.
verification: pnpm typecheck --force (8/8); pnpm verify: lint clean, 113 files / 1480 tests; openclaw-channel 14 files /
  200 tests; node --test infra 71/71; isolated e2e full suite 94 passed, 1 skipped (realtime-latency mobile, pre-existing)
  in 11.9 min incl. bots.spec paused step, codex-subscription and work-zone-slash at 1440 and 390; screenshots
  wz-slash-1440(-dark), wz-slash-390, bots-runtime-paused-1440/390 checked. Cell smoke `breaker` runs in CI only.
files_changed: [packages/contracts/src/agent.ts, packages/contracts/src/agent-channel.ts,
  apps/api/src/modules/agent-channel/{index,presence}.ts, apps/web/components/bots/{bots-runtime-settings,bots-gallery}.tsx,
  apps/openclaw-channel/src/{autostart-guard,active-account,channel,register-full,api-client,agent-channel-protocol,
  openclaw-sdk.d}.ts, apps/openclaw-channel/src/testing/{openclaw-host,fake-agent-channel-api}.ts,
  infra/openclaw/test/run-container-smoke.sh, infra/openclaw/README.md, e2e/playwright.config.ts,
  .github/workflows/{ci,cell-proof}.yml, apps/web/hooks/use-toast-clearance.ts, apps/web/components/ui/sonner.tsx,
  apps/web/components/work-zone/composer.tsx, tests alongside]
