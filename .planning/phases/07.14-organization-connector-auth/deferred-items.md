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
