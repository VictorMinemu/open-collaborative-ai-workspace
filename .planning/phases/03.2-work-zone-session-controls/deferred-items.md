# Deferred items (Phase 03.2)

- **03.2-01:** `turbo.json` `typecheck` has `dependsOn: []`, so changing `@ocw/contracts` does not invalidate dependent packages' cached typecheck; `pnpm verify` can replay a stale green from the shared worktree cache. Workaround: `pnpm typecheck --force`. Fix candidate: `"dependsOn": ["^typecheck"]` or declare internal deps as inputs. Out of scope for 03.2-01.
