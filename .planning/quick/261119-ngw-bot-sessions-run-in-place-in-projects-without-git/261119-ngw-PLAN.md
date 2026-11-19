---
quick_id: 261119-ngw
slug: bot-sessions-run-in-place-in-projects-without-git
date: 2026-11-19
type: fix
---

# Bot Work Zone sessions run in place in projects without git, also when the device never said

## Problem

Owner testing on v0.3.4: a bot whose Work Zone profile asks for an isolated worktree started a session in
`preinpección` (a folder without git) on Server-1, and the device refused it with "this project has no git repository;
isolated worktrees need git". The bot then told the person to turn the worktree off in its profile.

Quick 261113-hu7 already runs a bot start in place when `projects.git` is `false`. But the API learns that only from
the device's announcement, and a daemon announces `git` only for entries it registered after the flag existed
(`ProjectRegistry.add`, v0.3.0). An older entry, or a folder whose git changed after it was added, is announced without
the flag, so the server keeps `null` and the profile's worktree stands.

## Fix

1. **The runtime re-detects git live.** `ProjectRegistry.refreshGit()` runs the same check an isolated worktree makes
   (`isGitRepo`) for every registered project and saves on a change. A folder that is gone keeps its flag. The daemon
   calls it before every announcement (the handshake's `projects.sync` and every later sync). A failure is logged with
   paths stripped and never holds the announcement back.
2. **The API learns from the refusal.** When a `session.start` that asked for a worktree is refused with
   `NO_GIT_WORKTREE_MESSAGE` (moved to `@ocw/contracts`), the API sets `projects.git = false` for that project of that
   device. The session's `lastError`, which the bot reads, says that a new session there runs in the project folder. This works
   with any daemon, so the server fix alone unblocks Server-1 after one failed start.

Unchanged: one executor per tree (D-15). A start in place still gets `tree_busy` next to another active session on the
checkout. No permission, audience or approval check changes, and there are no migrations.

## Tests (failing first)

- `config.test.ts`: `refreshGit` sets false for a plain folder without the flag, true for a repository marked false,
  keeps a missing folder's flag, saves, and reports no change on a second run.
- `daemon.test.ts`: the handshake announces an older entry's git as it is now.
- `work-sessions.int.test.ts`: a worktree refused for no git marks the project, `lastError` says a new start works, and
  the next bot start runs in place. Any other refusal leaves `git` as it was.
