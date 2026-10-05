# ADR-0009: Realtime presence, live re-authorisation and the latency budget

- **Status:** Accepted
- **Date:** 2026-10-04
- **Deciders:** Víctor Ruiz (Autofy Labs)

## Context

Phase 3 covers three requirements:

- **RT-01:** subscriptions are authorised by the permission resolver, and losing access stops the stream.
- **RT-03:** messages, typing and presence reach the other members within 500 ms.
- **RT-04:** people see who is here now in a conversation, as active or away.

Phase 2 left one item open: live subscriptions were decided once, at subscribe time. A member removed from a
private channel, or downgraded below Developer, kept receiving the stream until the socket closed.

The PRD sets two more expectations:

- PRD §25 shows who is in a Work Zone session in its header.
- PRD §90 asks for realtime that feels live, but never at the cost of the permission model.

The Phase 1 gateway already fans out each topic over its own Redis channel `ocw:rt:<topic>`, replays durable
events by `seq` from PostgreSQL, and closes sockets on session revocation (ADR-0008). Self-hosters run a stock
Redis (`docker compose up`), so the design cannot rely on server-side Redis configuration.

## Decision

**D-01 Presence is per conversation.** It is tracked per topic for `conv:` (channels, threads) and `ws:` (Work
Zone sessions). A user is "here" while at least one of their sockets holds a live subscription that the
resolver authorised and that asked for presence. The sidebar's background watchers do not count. The states
are `online` (shown as Active) and `away`. Org-wide "online anywhere" presence is out of scope.

**D-02 Redis sorted sets scored by expiry.**

- **Storage:** one key per organization and topic, `ocw:presence:<orgId>:<topic>`. Each member is
  `<conn>|<userId>|<state>`, scored with its expiry time in ms.
- **Refresh:** the owning API instance re-scores its entries every 15 s (`PRESENCE_HEARTBEAT_MS`) with a 45 s
  TTL (`PRESENCE_TTL_MS`). The key itself expires after 2 × TTL without writes.
- **Sweep:** every instance sweeps expired entries of the topics it has local subscribers on, inside one
  `MULTI { ZRANGEBYSCORE; ZREMRANGEBYSCORE }`, so exactly one sweeper claims each entry and announces it as
  `offline`.
- **Liveness:** the WebSocket protocol ping runs on the same tick. A socket that misses one pong is
  terminated.
- **Bounds:**

  | Case | Gone within |
  |---|---|
  | Clean close or unsub | 1 s (measured 1–3 ms) |
  | Half-open socket (sleeping laptop, dead network) | 30 s |
  | Crashed API instance | 60 s |

**D-03 Frames.**

- Server → client `{ op: "presence", topic, full, entries: [{ conn, userId, state }] }`:
  - `full: true` is the snapshot sent right after `subscribed`.
  - `full: false` is a per-connection delta, where `offline` removes the entry.
- Deltas travel on the topic's existing Redis channel. A subscriber buffers them until its snapshot is sent.
- `conn` is a random UUID per socket, never the session id. `userId` comes from the verified JWT.
- Clients aggregate per user, and online beats away.
- Client → server `{ op: "presence", state }` names no user, topic or connection, so it can only change the
  socket's own entries.
- Server → client `{ op: "revoked", topic, reason: "forbidden" }` (D-05).

**D-04 Away is detected in the client.**

- A hidden tab is away at once.
- A visible tab with no input for 5 minutes (`AWAY_AFTER_IDLE_MS`) is away.
- Any input or focus in a visible tab is online again.

The state is sent only on change, through a 500 ms leading and trailing throttle. The server applies at most 30
changes per socket per 10 s and answers `rate_limited` beyond that. A reconnecting client reports `away` before
it re-subscribes.

**D-05 Live re-authorisation.** A module registers a subscription invalidator for each durable event type that
can take read access away, the same way it registers topic authorizers:

| Event | Invalidates |
|---|---|
| `conversation.member_removed` (chat) | that user on that `conv:` topic |
| `member.updated` with `role` or `status` | every live subscription of that user |
| `units.updated` | every live subscription of the organization |
| `permission_rules.updated` | every live subscription of the organization |
| `member.updated` with profile fields only | nothing |

The path from an access change to a revoked stream:

1. `appendEvent` computes the scope inside the domain transaction.
2. After commit, it publishes the scope on `ocw:realtime:authz-invalidated`.
3. Every API instance re-decides the matching live subscriptions through the same topic authorizers, which
   means through `resolveEffectivePermissions`.

The outcomes:

- **Denied:** the gateway drops the subscription, leaves its presence and sends `revoked`. The web shows "You
  no longer have access to …" in the channel or the Work Zone session.
- **Error:** a transient lookup failure keeps the subscription until the next check. New subscribes still deny
  on error.

Three safeguards keep re-decisions correct and cheap:

- **Concurrency:** re-decisions are coalesced per (connection, topic), with at most 4 running per instance.
- **In-flight subscribes:** a per-connection authz epoch re-decides a subscribe that was still being decided
  when an invalidation arrived.
- **Overlapping subscribes:** a per-topic generation lets the latest `sub`/`unsub` frame win.

Redis pub/sub is at-most-once. As a backstop, the existing 5-minute per-socket recheck (session active, member
active) also re-decides every live subscription. A lost invalidation is therefore closed within one interval.

**D-06 Public channels follow the resolver.** Removing someone from a public channel keeps their subscription,
because `channel.read` is still allowed in preview mode, the same answer REST gives. Private channels, explicit
denies and Work Zone sessions the user can no longer read are revoked.

**D-07 Latency budget, enforced in CI.** A Playwright spec drives two real web clients on one channel and
stamps both ends inside the pages (`performance.timeOrigin + performance.now()`). Samples run one at a time
and the warm-up is discarded. It fails when the p50 or p95 of messages, typing or presence reaches 500 ms. The
CI e2e job uploads the JSON report as the `realtime-latency` artifact on every run.

Measured on the isolated stack (2026-10-04, three runs):

| Kind | p50 | p95 | max |
|---|---|---|---|
| message | 13.6–21.8 ms | 20.9–45.7 ms | 47.2 ms |
| typing | 2.9–3.3 ms | 3.5–8.0 ms | 8.0 ms |
| presence | 2.2–2.4 ms | 3.5–4.6 ms | 5.2 ms |

Messages are slower than typing and presence because they go through HTTP POST, a PostgreSQL insert and a
`seq`-ordered publish. Typing and presence are ephemeral Redis frames. The worst p95 is more than 10 times
under the budget.

Revocation latency, measured from the access change to the `revoked` frame:

| Path | Measured |
|---|---|
| Integration: channel removal or leave | 10–17 ms |
| Integration: explicit deny rule | 16 ms |
| Integration: role downgrade on a Work Zone session | 16 ms |
| Integration: lost invalidation caught by a 200 ms recheck | 91 ms |
| E2E: access-lost state visible in the other person's tab | 20–52 ms |

**D-08 UI.**

- **Channel header:** a stack of the other people here now (3 avatars, 2 below 640 px), each with a dot
  (`bg-success` Active, `bg-warning` Away, dimmed when away) and a "Here now" tooltip.
- **Members dialog:** the same dots, present people listed first, and "N here now" in the description.
- **Work Zone session header:** a "watching now" stack, on desktop and mobile.
- **Access lost:** a calm Lock empty state with a way back.

Everything uses shadcn tokens and was reviewed at 1440 and 390 px in light and dark.

**D-09 No new dependencies.** node-redis, `ws`, Zod and zustand were already in the lockfile.

## Consequences

**Operational.**

- **Redis additions:**
  - keys `ocw:presence:<orgId>:<topic>`, which are volatile and expire on their own;
  - the pub/sub channel `ocw:realtime:authz-invalidated`.

  Presence deltas reuse the existing `ocw:rt:<topic>` channels. No PostgreSQL table was added, and no
  heartbeat is ever written to PostgreSQL.
- **Shared pub/sub:** pub/sub ignores Redis logical databases. Two stacks on one Redis server (for example the
  isolated e2e stack on DB 9 next to a demo on DB 0) see each other's messages. Nothing crosses over, because
  topics carry UUIDs and invalidations carry the organization id and are filtered by it. Presence keys live in
  the selected DB.
- **Keep for self-hosters:**
  - The presence TTL must stay at three heartbeats or more.
  - `SESSION_RECHECK_MS` bounds how long a lost invalidation can leave a stream open. Raising it widens that
    window.
  - A Redis eviction policy that drops volatile keys only makes presence flicker. The next refresh re-adds
    and re-announces the entry.
- **Cost of a revocation:**
  - A role or status change re-decides one user's subscriptions.
  - A rule or unit change re-decides the whole organization's live subscriptions, coalesced and capped at 4
    concurrent decisions per instance.
  - Every socket costs one round of re-decisions every 5 minutes.

**Future.**

- PRD §25 states beyond online and away (Controlling, Viewing diff, Following) and org-wide presence extend
  the closed `PresenceState` enum through a contract change. Old clients ignore unknown frames.
- Any new module that can take read access away registers a subscription invalidator for its durable event.
  The backstop covers it until it does, but only within the recheck interval.
- The 500 ms budget is a constant in the spec, so a regression fails CI. The uploaded report shows the trend.

## Alternatives considered

- **Redis keyspace notifications for expiry.** Rejected. They need `notify-keyspace-events` on the server,
  which a stock self-hosted Redis does not have. They also fire on every instance and are fire-and-forget.
- **Hash-field TTL (`HEXPIRE`).** Rejected. It needs Redis 7.4+ and does not work on older Redis or on
  Valkey < 9. The scored sorted set works on any Redis 6+ or Valkey.
- **Lua scripts for server-side per-user aggregation.** Rejected. Per-connection entries with a single writer
  each stay ordered without Lua, and clients aggregate per user.
- **A vitest-based latency test.** Rejected. Integration tests run the API in-process with no web client.
  SC1 asks for propagation between two real clients through the deployed processes.
- **Revoking public-channel previews on removal.** Rejected. It would contradict the resolver and REST, which
  both allow `channel.read` as a preview (D-06).
- **Re-checking every subscription on a short timer instead of invalidations.** Rejected. Revocation would
  take seconds and every socket would pay a constant load. Invalidations revoke in milliseconds, and the
  5-minute timer remains only as the backstop.
