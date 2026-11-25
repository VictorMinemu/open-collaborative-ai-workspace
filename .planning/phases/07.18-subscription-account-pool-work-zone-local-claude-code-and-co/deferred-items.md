# Phase 07.18: deferred items

Found while executing 07.18-16 (browser journey). Out of that plan's scope; not fixed there.

## 1. Every ChatGPT bot account off: the cell logs every profile out

- **Where:** `apps/api/src/modules/agent-channel/cell-pool.ts` (`withheldSubscriptions`) and
  `apps/openclaw-channel/src/subscription-auth.ts` (`sync`, the "not listed but a credential exists" branch).
- **What:** when the pool manages ChatGPT and no bot account is enabled, the API leaves `openai-codex` out of the
  snapshot's `subscriptions` (plan 14, on purpose: OpenClaw cannot hold an empty order). The plugin's next sync reads a
  provider that is not listed while credentials exist as "disconnected while offline" and logs out **every** profile.
  So turning all ChatGPT bot accounts off destroys their sign-ins, and turning one back on later needs a new sign-in.
- **Suggested fix:** when the snapshot carries `accountPool`, the plugin keeps the stored profiles of a withheld
  provider (bots just do not use it) instead of logging them out; a test in `subscription-auth.test.ts`.
- **Status:** FIXED in `38de9162` (07.18-18). `GET /cell` names a connected subscription the pool withholds in
  `accountPool.withheldByPool`; the plugin keeps that provider's profiles. A real disconnect still signs out.

## 2. Disconnect on Settings › Models leaves the pool's ChatGPT bot rows "Ready"

- **Where:** `DELETE /api/v1/model-providers/:provider` (`apps/api/src/modules/agent/index.ts`).
- **What:** the route deletes the provider row and revokes every profile in the cell, but leaves the live
  `cell_profile` pool rows. Once the provider is gone the snapshot no longer lists it, so no credential state report
  reconciles them: Settings › Account pool keeps showing them as Ready although the cell holds nothing.
- **Suggested fix:** the same transaction marks the provider's `cell_profile` rows removed (audited
  `account_pool.account_removed`, reason `provider_disconnected`).
- **Status:** FIXED in `30b6db1f` (07.18-18). The route calls `removeCellProfiles` in its transaction; integration test
  includes tenant isolation.
