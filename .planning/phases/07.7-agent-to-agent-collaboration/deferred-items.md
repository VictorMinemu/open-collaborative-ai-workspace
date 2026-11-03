# Phase 07.7 deferred items

## Found during 07.7-09 (out of scope, not fixed)

- **`guard.test.ts` › "no legacy role check or legacy helper in the web" fails at the phase tip (90503c2e).**
  `apps/web/components/settings/agent-consult-settings.tsx:29-33` names a local `canRead`, which the legacy-helper
  pattern (`WEB_PATTERNS` in `apps/api/src/modules/organization/permissions/guard.test.ts`) flags. Introduced by
  07.7-08 (`a0579d09`). Fix: rename the local (e.g. `mayReadRules`); the decision already comes from `useCan("rule.read")`.
  `pnpm verify` fails on this one unit test until then.
