---
phase: 02-identity-and-organization
plan: 04
subsystem: chat (authorization), api, web
status: complete
tags: [authorization, resolver, chat, confused-deputy, client-kind, viewerCan]
requires: [02-02, 02-03]
provides:
  - "Every chat route (channels, membership, messages, threads, read markers, test routes) and the conv topic authorizer decided by the permission service; config.authz on all 17 chat routes"
  - "ChannelSummary.viewerCan (channel.post, channel.members.add, channel.members.remove, channel.archive) on list, detail, create, join and archive responses"
  - "PostAgentMessageInput.inReplyToMessageId (optional): a bot reply needs the bot's channel.post AND the answered human's channel.read (agent ∩ human)"
  - "Messages stored with the session's client kind (desktop sessions → client_kind desktop)"
  - "chat/service.ts: listChannels returns ChannelRow {summary, facts}; channelRow; channelFacts(tx, conv, member) (thread → parent channel)"
affects: [02-10, 02-15]
tech-stack:
  added: []
  patterns:
    - "readableChannel(req, tx, conv): channel.read with hideAs404, then the mutation permission on channelResource / channelMemberResource"
    - "List routes: rows with facts → perms.filter(channel.read) → perms.viewerCan per row"
key-files:
  created: []
  modified:
    - apps/api/src/modules/chat/index.ts
    - apps/api/src/modules/chat/service.ts
    - apps/api/src/modules/chat/test-routes.ts
    - apps/api/src/lib/chat-agent-bridge.ts
    - apps/api/src/modules/chat/chat.int.test.ts
    - apps/web/components/chat/channel-view.tsx
decisions:
  - "Bot reply = agent channel.post (agent alone) + agent channel.read on behalf of the answered human. The plan's single channel.post-on-behalf call would report not_a_member instead of private_channel and would block replies to a human who left a public channel they can still read"
  - "Membership domain checks stay as data (410 archived before the archived precondition, mention auto-add only for agents not yet members); every authorization outcome comes from the resolver"
  - "Test-only chat routes require org.read (any active org member), config.authz user"
metrics:
  duration: "~10 min"
  completed: "2026-10-04"
  tasks: 2
  files: 6
actuals:
  tokens: 12800
  tasks: 2
  commits: 3
---

# Phase 2 Plan 04: Chat on the permission resolver Summary

The resolver now decides every chat route and the `conv:<id>` realtime topic. No membership or role comparison is left in the chat module or in `channel-view.tsx`, and both legacy markers are gone. Each channel summary carries `viewerCan`, and the web Archive entry follows it. A bot reply needs two things: the bot may post, and the human it answers may still read the channel. Messages now record the real client kind. Users see the same behaviour: 404 for hidden channels, `not_a_member`, 410 `channel_archived` and 400 `default_channel` are all unchanged.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | `cbde688` | feat(02-04): decide channel visibility with the resolver and expose viewerCan |
| 2 | `46a7aa2` | feat(02-04): decide every chat mutation and bot reply with the resolver |

## What changed (research inventory)

| Site | Now |
|------|-----|
| M1 conv authorizer | `perms.decide(user, "channel.read", channelResource(facts))` |
| M2/M3 `canRead` / `requireReadable` / `requireWritable` | deleted from `service.ts` |
| M4 POST /channels | `preHandler: [requireUser, perms.requirePermission("channel.create")]` |
| M5 every read path | `readableChannel()` → `channel.read`, `hideAs404` (detail, join, leave, read, members, messages, thread, archive) |
| M6 read marker | now 404s on hidden or missing channels (it used to silently update nothing) |
| M7 add member | `channel.members.add` on `channelResource(facts)` after the existing 410 |
| R8 remove member | `channel.members.remove` on `channelMemberResource(facts, self)`; inline admin/owner check deleted |
| M8 post | `channel.post` after the existing 410; `clientKind: auth.clientKind` |
| M9 mention auto-add | `perms.decide(poster, "channel.members.add", posterFacts)`; when denied, the agent is skipped and not delivered |
| M10 bot post | agent `channel.post` (principal gate, membership, agent rules) + agent `channel.read` on behalf of `inReplyToMessageId`'s human author |

## Verification

| Command | Result |
|---------|--------|
| `pnpm exec vitest run --project integration apps/api/src/modules/chat/chat.int.test.ts` (Task 1) | 21 passed. Mutation check: listing unfiltered rows plus a topic authorizer that always allows → 2 failures |
| `pnpm --filter @ocw/web typecheck` | exit 0 |
| `pnpm exec vitest run --project integration …/chat/chat.int.test.ts …/agent-channel/agent-channel.int.test.ts` (Task 2) | **41 passed** (chat 28). Mutation check: dropping the human check, hard-coding `"web"`, ignoring the mention decision, and always treating removal as self → 4 failures |
| `pnpm verify` (after each task) | exit 0. Biome 369 files (4 pre-existing warnings in apps/local-runtime), typecheck 8/8, **42 files / 404 tests passed** |
| `pnpm --filter @ocw/local-runtime test` / `pnpm --filter @ocw/desktop test` | 107 / 58 passed |
| `bash scripts/e2e-isolated.sh` | **11 passed (40.6 s)**, exit 0: setup, then bots, chat, codex-subscription, smoke and work-zone at desktop 1440 and mobile 390 |

Acceptance greps:
- `canRead|requireReadable|requireWritable` in `chat/` and `lib/`: no hits.
- `authz-legacy` in `chat/index.ts` and `channel-view.tsx`: 0 in each.
- `clientKind: "web"` in `chat/index.ts`: 0.
- `inReplyToMessageId?: string` is present in the bridge.
- Routes vs `authz:` entries: `index.ts` 13/13, `test-routes.ts` 4/4.
- `perms.filter(req, tx` and `"channel.read"` are in `index.ts`, and `viewerCan` is in `channel-view.tsx`.

The suite ends with this assertion: `authz.undecided` has no URL under `/api/v1/channels`, `/conversations`, `/messages` or `/test/chat`, and all 17 chat routes are registered as `user`.

**Demo stack (hard rule):**
- `:4000/health` returned 200 before and after; `:3000/login` returned 200 before and after.
- `ocw-demo-openclaw` is still running, with start time 2026-10-04T15:54:27Z.
- :4290 was free after the run.
- No compose down/stop/restart, no `db:migrate`, no `demo:*`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The bot-reply intersection checks the human's read access, not the human's posting**
- **Found during:** Task 2
- **Issue:** The plan's code does `perms.decide(agent onBehalfOf human, "channel.post", agentRes, humanRes)`. The human's `channel.post` precondition reports `not_a_member`, but the plan's own expected result is `private_channel`. That call would also refuse a reply to a human who left a public channel they can still read, which is a regression. The must-have truth is "the bot may post AND the human may read".
- **Fix:** Two decisions. First, the agent's `channel.post` on its own facts, which gives `agent_disabled`, `agent_not_member` and agent-rule denials. Second, the agent's `channel.read` on behalf of the human with the human's facts, which gives `private_channel` on layer `resource`.
- **Commit:** `46a7aa2`

**2. [Rule 1 - Bug] `authorId` can be null**
- System messages have no author, so the human check only runs when the answered message has `authorKind === "user"` and an author id. This came from the typecheck.

### Other notes

- `AuthzDeniedError` signature: the real constructor is `new AuthzDeniedError(denial, opts)`. The plan text `new AuthzDeniedError(403, d.denial)` predates 02-02's final API.
- `channelSummary` was replaced by `channelRow`, which returns `{summary, facts}`. The routes add `viewerCan` through `withViewerCan` and `summaryOf`. This is the plan's "let callers attach viewerCan" written as a row type, so the API response never carries internal facts.
- Order change for an unknown conversation with a disabled bot: the 404 for the missing conversation now comes before the agent gate. Previously `agent_disabled` came first. It has no user-visible effect.
- TDD ordering: as in 02-01 to 02-03, each task's tests were committed with its implementation (one `feat` commit per task, each passing `pnpm verify`). Mutation checks (listed above) show the tests catch the regressions.

## Notes for 02-10 / 02-15

- 02-10: pass `AgentChannelPostMessage.inReplyToMessageId` through to `postAgentMessage`. The agent-channel route already resolves `triggeredBy`. The chat side re-reads the message itself, so the bridge input is the only thing needed.
- The bridge throws `AuthzDeniedError` (403). On the cell route, the error handler audits it with the cell actor.
- `provideThreadContext` and `provideAgentTyping` are unchanged. They are gated in agent-channel (`requireActiveAgent` / `requireMembership`).

## Known Stubs

None.

## Threat Flags

None. No new surface: T-02-04-01 to 06 are mitigated and tested (hidden list/detail/topic, plain member remove 403, human removed from a private channel 403, disabled bot 403, desktop `client_kind`, undecided-registry assertion).

## Self-Check: PASSED
