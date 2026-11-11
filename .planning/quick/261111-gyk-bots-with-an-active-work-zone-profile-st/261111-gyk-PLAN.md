---
quick_id: 261111-gyk
description: Bots with an active Work Zone profile start sessions directly; no proposal tools on their turns
---

# Bots with an active Work Zone profile start sessions directly

Owner report (ocw.autofy.ing, v0.3.0): with an active profile and Full access consent, Histolab BOT kept posting a
proposal card ("Start session") and said it could not start sessions. Cause: `turnPolicy` offered both the 07.16
session tools and the 07.5 proposal tools, and the model chose the proposal.

## Task 1: offer the session tools instead of the proposal tools

- files: `apps/api/src/modules/bot-capabilities/turn-policy.ts`,
  `apps/api/src/modules/agent-channel/work-session-offer.int.test.ts`, `docs/adr/0038-bot-work-zone-orchestration.md`
- action: when the Work Zone offer is applied, remove `ocw_start_work_zone` and `ocw_work_zone_projects` from the turn;
  count room for the four session tools without them; keep them when there is no room. Amend ADR-0038 §12.
- verify: `pnpm exec vitest run --project integration apps/api/src/modules/agent-channel/work-session-offer.int.test.ts`
  and `work-session-taint.int.test.ts`; api typecheck; biome.
- done: a profile bot's turn lists `ocw_work_session_start` and neither proposal tool; a bot without a profile is
  unchanged.
