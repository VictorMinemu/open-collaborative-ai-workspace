@AGENTS.md

## Claude Code

Everything above comes from `AGENTS.md`, the single source of truth shared with every other coding
agent. Edit that file, not this one, for anything that is not Claude-specific.

- Use plan mode for changes under `apps/api/` modules that touch permissions, policies, audit or
  tenant isolation, and for any schema migration.
- Superpowers workflow applies: brainstorm before new subsystems, TDD for implementation, verify
  before claiming completion.
- GSD commands (`/gsd-*`) are the planning and execution entry points for this repo.
