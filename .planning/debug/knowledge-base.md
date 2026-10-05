# GSD Debug Knowledge Base

Resolved debug sessions. Used by `gsd-debugger` to surface known-pattern hypotheses at the start of new investigations.

---

## 03.1-tool-gate — OpenClaw plugin hook registered in registerFull never runs during agent turns
- **Date:** 2026-10-05
- **Error patterns:** before_tool_call not invoked, after_tool_call not invoked, tool runs ungated, no POST /tool-calls, tool calls [], outcomes [], hook registered but never fires, real cell only, fake runtime passes
- **Root cause(s):** gate registered from defineChannelPluginEntry registerFull; OpenClaw 2026.9.7 dispatches hooks from the prepared turn generation's registry only, which is a non-activated load (discovery mode, registerFull skipped) whenever the config changed after boot (the OCW reconciler always changes it)
- **Fix:** register typed hooks from registerCapabilities (full, discovery, tool-discovery); keep tools in registerFull
- **Files changed:** apps/openclaw-channel/src/register-capabilities.ts, register-full.ts, index.ts, openclaw-sdk.d.ts, tool-guard.ts, openclaw-registration.test.ts, testing/openclaw-host.ts, infra/openclaw/test/run-container-smoke.sh
- **Why not caught:** contract tests called registerFull directly against a fake runtime; no test modelled OpenClaw registration modes; the real-cell smoke had never run green
- **Recurrence guard:** apps/openclaw-channel/src/openclaw-registration.test.ts (every registration mode + turn registry) and the cell-smoke `capabilities` scenario; re-check testing/openclaw-host.ts against /app/dist on every OpenClaw bump
---

