---
created: 2026-10-05
title: Optional isolation boundary for Full access sessions
area: local-runtime
---

## Problem
ADR-0012 Full access runs Claude Code `bypassPermissions` / Codex `danger-full-access` in the device user's raw
environment once org policy ∩ device opt-in ∩ grain allow it. An automated security review flagged this
(agent/subprocess permission bypass). Owner accepted the risk; the ADR recommends dedicated hosts.

## Solution (hardening, not a blocker)
- Detect whether the daemon runs inside a container/VM and show it in the device opt-in dialog.
- Optional per-session sandbox for Full access (macOS sandbox-exec / Linux bubblewrap with the worktree as the only
  writable root, egress policy), selectable by the device owner.
- Keep the secret deny rules and PreToolUse hook active in bypass (already true for Claude).
