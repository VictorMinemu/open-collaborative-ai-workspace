---
quick_id: 261119-ngw
slug: bot-sessions-run-in-place-in-projects-without-git
date: 2026-11-19
type: fix
status: complete
subsystem: local-runtime, work-session
tags: [work-zone, bots, worktree, git]
key-files:
  modified:
    - apps/local-runtime/src/config.ts
    - apps/local-runtime/src/daemon.ts
    - apps/local-runtime/src/git.ts
    - packages/contracts/src/work-session.ts
    - apps/api/src/modules/work-session/service.ts
---

# Summary

Bot sessions in projects without git now run in the project folder even when the device never said the project has no
git.

- **Runtime.** `ProjectRegistry.refreshGit()` re-detects every project's git with the worktree's own check. The daemon
  runs it before every `projects.sync`, so entries registered before the flag, and folders whose git changed, are
  announced as they are now.
- **API.** A worktree start that the device refuses with `NO_GIT_WORKTREE_MESSAGE` (now in `@ocw/contracts`) sets
  `projects.git = false` for that device's project. Its `lastError` says that a new session there runs in the project
  folder, so the bot retries instead of asking for a profile change. This works with older daemons.

## Verification

- Local runtime, contracts and the API device module: 2256 passed. API work-session plus bot work-session integration (ephemeral
  PostgreSQL): 562 passed.
- The new API test fails without the service change.
- `pnpm lint` and `pnpm typecheck` are clean.
