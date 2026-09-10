# ADR-0005: Local Runtime daemon is a standalone process supervised by the desktop app

- **Status:** Accepted (to be validated by the adapter spike in the daemon phase)
- **Date:** 2026-09-10
- **Deciders:** Víctor Ruiz (Autofy Labs)

## Context

PRD §32 requires the Electron desktop app to include a separate Local Runtime daemon that launches
Codex / Claude Code / OpenCode, owns git, terminal, filesystem and the device connection. Project
research produced two candidate process models:

- **Electron `utilityProcess`** (STACK.md): simplest packaging, shares Electron's Node ABI, but
  cannot pipe stdin, dies with the app, cannot use `safeStorage`, and blocks the MVP6 headless mode.
- **Standalone detached process** (ARCHITECTURE.md, PITFALLS.md): survives app restarts, can run
  headless on servers or CI hosts later, needs its own transport and lifecycle management.

## Decision

- `apps/local-runtime` is a **standalone Node process with no Electron imports**. The desktop app
  acts as its supervisor: starts it if absent, shows its status, restarts it on crash, and stops it on
  explicit user action (not on window close).
- Shell ↔ daemon transport is a **Unix domain socket (macOS/Linux) or named pipe (Windows)** with a
  per-install token. No listening TCP port on localhost.
- The daemon keeps its own state directory (identity keys, offline event log, pidfile, worktrees),
  uses OS-encrypted storage for device secrets, and reaps child process groups on start.
- Daemon and shell exchange a `protocolVersion` in the handshake from day one.
- `utilityProcess` remains the documented fallback if native-module ABI rebuilds prove too costly;
  switching would be a packaging change because the daemon package has no Electron dependency.

## Consequences

- Positive: MVP6 (remote Work Zone) and future managed workers reuse the same daemon binary.
- Positive: laptop sleep, app crash or update do not kill running sessions; they reconnect.
- Negative: two binaries to sign and ship, and native modules (`node-pty`) must be built for the
  daemon's Node ABI as well as Electron's.
- Negative: lifecycle edge cases (orphans, double start, version skew between shell and daemon) are
  ours to handle; the handshake and pidfile rules above exist for that reason.
