---
created: 2026-10-05
title: Cell stays Offline after OpenClaw's restart-loop breaker suppresses the ocw channel
area: openclaw-cell
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
