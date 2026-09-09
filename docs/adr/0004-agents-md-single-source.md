# ADR-0004: AGENTS.md is the single source of truth for AI coding agents; CLAUDE.md imports it

- **Status:** Accepted
- **Date:** 2026-09-09
- **Deciders:** Víctor Ruiz (Autofy Labs)

## Context

The project will be built largely by AI coding agents from several vendors (Claude Code, Codex,
OpenCode, and possibly Cursor/Copilot). Each reads a different instruction file. `AGENTS.md` is the
cross-tool standard maintained under the Agentic AI Foundation and is read natively by Codex, Cursor,
Windsurf, Cline, Copilot and others. Claude Code reads `CLAUDE.md`, not `AGENTS.md`, but its
documentation explicitly supports importing other files with `@path` syntax and recommends exactly
this pattern for repositories that already use `AGENTS.md`. Maintaining two parallel files drifts.

## Decision

- `AGENTS.md` at the repository root holds **all** shared instructions: project summary,
  non-negotiable principles, stack, layout, commands, conventions, security rules and workflow.
  Target under 200 lines. Human-authored sections come first; GSD-managed sections are delimited by
  `<!-- GSD:... -->` markers and are updated only by GSD commands.
- `CLAUDE.md` contains the single import line `@AGENTS.md` followed by a short `## Claude Code`
  section for instructions that only apply to Claude Code (plan-mode triggers, skill workflow).
  The import is used instead of a symlink so that Claude-specific content is possible and so the
  setup works on Windows checkouts.
- Personal, uncommitted preferences go to `CLAUDE.local.md` (gitignored).
- Path-scoped rules, when needed, go to `.claude/rules/*.md` for Claude Code; equivalent
  per-directory `AGENTS.md` files may be added for other tools. Both must point to the same content.

## Consequences

- Positive: one file to edit; every agent sees identical instructions; Claude Code loads the import
  at session start (verify with `/context` → Memory files).
- Negative: imported content still counts toward Claude Code's context budget, which is another
  reason to keep `AGENTS.md` short and push procedures into `docs/` and skills.
- Negative: `/init` in Claude Code must not be used to regenerate `CLAUDE.md`; it would duplicate
  content. Improvements go to `AGENTS.md`.

## References

- Claude Code docs, "How Claude remembers your project" — section *AGENTS.md*:
  https://code.claude.com/docs/en/memory
- AGENTS.md standard: https://agents.md
