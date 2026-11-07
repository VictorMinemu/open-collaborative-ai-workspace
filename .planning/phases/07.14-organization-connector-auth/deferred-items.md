# Deferred items (Phase 07.14)

## From 07.14-07

- **`mcp/service.ts` `updateMcpServer` reads the organization connection without locking the server row.** The
  organization callback's store transaction holds the server row (`orgAccountServer(tx, id, true)`), so a callback
  that commits after a mode switch has already run stores nothing (`flow_expired`, tested). The other order has a
  narrow window: a PATCH whose `orgConnectionMethodOf` read runs before the callback's commit sees no connection,
  skips the `org_connection_exists` confirmation, then waits on the row lock and switches the mode after the
  callback has stored. The organization row is then left on a server that is no longer in an organization mode. It
  is never used there (`orgAccountServer` requires an org mode, and the DTO shows `orgConnection` only for org modes),
  but it would reappear if the server were switched back. Fix (out of 07's files): `findServer(tx, id)` with
  `for update` in `updateMcpServer` and `deleteMcpServer`, so the check and the switch see the same state.
  **Resolved in 07.14-09:** `findServer(tx, id, true)` in both; `mcp.int.test.ts` › "a mode switch or delete racing
  the organization's connect" holds the row like the connect transaction, commits a connection while the PATCH or
  DELETE waits, and both now answer 409 `org_connection_exists` with the connection left in place.

## From 07.14-08

- **`automation/mailboxes.int.test.ts` flakes under the full `pnpm verify` load.** In one full run all 7 cases that
  inject mail through GreenMail failed with nodemailer's `Greeting never received` (30 s timeouts). The same file run
  alone right after passed 18/18. This plan does not touch that module, so it was not changed. A likely fix is a longer
  SMTP greeting timeout, or waiting for GreenMail's SMTP banner in that suite's setup before the first inject.

## From 07.14-13

- **`agent-channel/browser.int.test.ts` failed to start under the full `pnpm verify` load.** Testcontainers timed out
  after 10 s waiting for the Redis container's ports, before any test ran (other worktrees were running suites on the
  same Docker daemon). Re-run alone right after: 29/29 passed. This plan does not touch that module. A likely fix is a
  longer port-binding wait in `packages/db/src/testing.ts` for Redis.

## From 07.14-14 (the phase gate)

- **`organization/module-access.int.test.ts` failed to start under the full `pnpm verify` load.** Testcontainers timed
  out after 10 s waiting for the Redis container's ports (the same start-up timeout as in 08 and 13; other worktrees'
  suites shared the Docker daemon). Re-run alone right after: 22/22. Not touched by this phase; the likely fix is the
  longer port-binding wait in `packages/db/src/testing.ts` named above.
- **`e2e/tests/automation-triggers.spec.ts` › "Víctor creates “Shopify orders”…" failed once on the mobile project**
  (e2e run 2 only; green on desktop in both runs, on mobile in run 1, and on both projects when the spec was re-run
  alone, 9 passed). axe reported `color-contrast` 1.17 inside the automation agent card (`#e2edea` on `#fafefc`, a
  colour caught mid-transition), so the check ran while the card was still fading in. 07.6 owns the spec and the card;
  the likely fix is to let the card's transition end before the axe check.
