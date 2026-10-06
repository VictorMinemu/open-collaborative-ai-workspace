---
created: 2026-10-05
title: Cell stays Offline after OpenClaw's restart-loop breaker suppresses the ocw channel
area: openclaw-cell
done: 2026-10-06
---

## Problem
On a saturated Docker VM the demo cell restarted several times (exit 0, not OOM). OpenClaw's
restart-loop breaker ("6 unclean boots within 300000ms") then suppresses channel auto-start, so the
`ocw` channel never connects: Settings › Bots runtime shows Offline / "last seen just now" while the
container is healthy. Fixed by hand with `openclaw gateway call channels.start --params '{"channel":"ocw"}'`
(token from the gateway process env).

## Solution
- Entrypoint/health watcher: when the breaker suppresses `ocw` (the cell's only channel), start it after a
  back-off instead of staying silent; log why.
- Report the suppression to the API so the UI shows the reason ("bot runtime paused after repeated restarts")
  instead of a bare Offline.
- Investigate the exit-0 restarts under VM CPU starvation (OpenClaw watchdog?).

## Done (stability batch 2026-10-06)
- The plugin's restart-loop breaker guard (`apps/openclaw-channel/src/autostart-guard.ts`, on `gateway_start`) reports
  the pause and starts `ocw` with OpenClaw's manual `channels.start` (in process) after `OCW_BREAKER_BACKOFF_MS`.
- `POST /agent-channel/v1/runtime` → `AgentCellStatus.paused` → Settings › Bots runtime shows "Paused" and when it
  restarts. Report: `.planning/debug/stability-batch-2026-10-06.md`.
- Still open: why the cell exits 0 under VM CPU starvation (not reproduced; no local OpenClaw containers).
