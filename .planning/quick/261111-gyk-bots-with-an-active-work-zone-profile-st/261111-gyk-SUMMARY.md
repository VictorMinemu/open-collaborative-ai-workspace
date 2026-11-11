---
quick_id: 261111-gyk
status: complete
---

# Summary: bots with an active Work Zone profile start sessions directly

- `turnPolicy`: a delivery that offers the four `ocw_work_session_*` tools removes `ocw_start_work_zone` and
  `ocw_work_zone_projects` from the turn. Room for the four is counted without them; with no room the proposal tools
  stay, so the bot can still propose.
- Proposals still happen where they must: the start route falls back to one after outside content (ADR-0038 §10).
- Bots without a profile or with an inactive one: unchanged (`work-session-taint.int.test.ts` "bots without a
  profile keep today's behaviour" passes).
- ADR-0038: amendment (owner testing, 2026-11-11).

Verification: `work-session-offer.int.test.ts` 20/20, `work-session-taint.int.test.ts` 15/15, api `tsc --noEmit`
clean, biome clean.
