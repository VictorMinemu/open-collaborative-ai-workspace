---
phase: 02-identity-and-organization
plan: 10
subsystem: agent, agent-channel (authorization), web bots
status: complete
tags: [authorization, resolver, bots, providers, openclaw-cell, agent-principal, confused-deputy, client-kind]
requires: [02-02, 02-03, 02-04]
provides:
  - "agent module: provider.manage / bot.manage / bot.read through requirePermission; config.authz user on all 9 routes"
  - "Agent Channel API: config.authz cell on every route, cell.sync decided for the cell principal (scope preHandler) and on the cell WebSocket before the upgrade"
  - "POST /messages passes inReplyToMessageId to chat (agent principal + agent ∩ human decided in chat, 02-04)"
  - "POST /typing decided as the bot's channel.read (agent gate, membership, agent rules)"
  - "Admin cell routes on cell.manage, subscription sign-in routes on provider.manage"
  - "Provider, bot, cell-token and subscription sign-in audits carry the caller's real client kind"
  - "Web bots surfaces gated by useCan; useIsAdmin deleted"
affects: [02-15]
tech-stack:
  added: []
  patterns:
    - "Scope-level preHandler perms.requirePermission(\"cell.sync\") for every Agent Channel route (new routes inherit it)"
    - "Settings pages show a skeleton while /me/permissions loads, then either the controls or the 'ask an admin' state"
key-files:
  created: []
  modified:
    - apps/api/src/modules/agent/index.ts
    - apps/api/src/modules/agent-channel/index.ts
    - apps/api/src/modules/agent-channel/gateway.ts
    - apps/api/src/modules/agent-channel/provider-auth.ts
    - apps/api/src/modules/agent-channel/agent-channel.int.test.ts
    - apps/api/src/modules/agent-channel/provider-auth.int.test.ts
    - apps/web/lib/bots-queries.ts
    - apps/web/components/bots/bots-gallery.tsx
    - apps/web/components/bots/models-settings.tsx
    - apps/web/components/bots/bots-runtime-settings.tsx
    - apps/web/components/bots/new-bot-sheet.tsx
    - apps/web/components/bots/bot-detail-sheet.tsx
    - e2e/tests/bots.spec.ts
    - .planning/phases/01-mvp-0-multiplayer-ai-chat-slice/01-AGENT-CHANNEL-API.md
decisions:
  - "cell.sync is decided by one scope-level preHandler (perms.requirePermission) rather than inside each handler's transaction: same decision, memoised per request, and a future Agent Channel route cannot forget it"
  - "NoModels (\"Configure a model provider first\" + link to Settings › Models) is gated by provider.manage, not bot.manage, because the link only works for provider managers"
  - "A non-member bot is refused with code agent_not_member on layer resource (the resolver's membership precondition), not layer agent"
  - "provider-auth start/cancel receive the caller's clientKind explicitly (ProviderAuthCaller): they open their own withTenant without the request's tenant context, so the transaction default would have been null"
metrics:
  duration: "~25 min"
  completed: "2026-10-04"
  tasks: 2
  files: 14
actuals:
  tokens: 17000
  tasks: 2
  commits: 3
---

# Phase 2 Plan 10: Bots, model providers and the OpenClaw cell on the resolver Summary

The resolver now decides bots, model providers and the OpenClaw cell. Only `provider.manage`, `bot.manage` and `cell.manage` holders can administer them, and every role can read and mention bots (`bot.read`). The cell is a `cell.sync` principal on every Agent Channel route and on its WebSocket. Each bot is decided as an agent principal: disabled bots, non-member bots and bots hit by a deny rule are refused. A reply is also refused when the human it answers can no longer read the channel. The web derives every bot, model and runtime control from `useCan`, so no role check is left. Audits record the real client kind (desktop from the Electron app).

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | `fcffcef` | feat(02-10): providers and bots decided by the resolver; web bot surfaces gated by useCan |
| 2 | `7048783` | feat(02-10): the cell and its bots act as resolver principals |

## Verification

| Command | Result |
|---------|--------|
| `pnpm exec vitest run --project integration …/agent-channel/agent-channel.int.test.ts` (Task 1) | 17 passed. RED check: the same tests against the old `agent/index.ts` give 3 failures (lead/developer 403 + audit, admin deny rule on layer org, desktop client kind) |
| `pnpm exec vitest run --project integration …/agent-channel.int.test.ts …/provider-auth.int.test.ts …/chat/chat.int.test.ts` (Task 2) | **59 passed** (3 files). RED check: against the old `index.ts`/`gateway.ts`/`provider-auth.ts`, 9 failures. Removing only `inReplyToMessageId: body.inReplyToMessageId` makes the private-channel reply test fail |
| `pnpm verify` (after each task) | exit 0. Biome 387 files clean, typecheck 8/8, **52 files / 515 tests passed** |
| `pnpm --filter @ocw/openclaw-channel test` | 6 files / 51 passed |
| `pnpm --filter @ocw/local-runtime test` / `pnpm --filter @ocw/desktop test` | 107 / 58 passed |
| `bash scripts/e2e-isolated.sh` (screenshots on) | **13 passed (1.2 min)**, exit 0. Setup, then bots (admin), the **new developer bots view**, chat (bot reply), codex-subscription, smoke and work-zone, each at desktop 1440 and mobile 390. The web was rebuilt from this worktree |

New integration coverage:
- **Admin routes:** lead and developer get 403 on every provider and bot write route, with `authz.denied` rows for `provider.manage` and `bot.manage`. Admin, lead, developer and standard can all read `/agents`, `/agents/:id` and `/models`.
- **Deny rules:** a rule denying `provider.manage` to role `admin` gives the admin 403 on layer `org` with `denied_by_rule`.
- **Client kind:** provider, bot and subscription start/cancel audits record `desktop` when signed in from Electron and `web` otherwise.
- **Cell and sign-in routes:** a developer gets 403 on `cell.manage` (agent-cell, token) and on `provider.manage` (the three `/auth` routes).
- **Bot denials on POST /messages:** a disabled bot gets `agent_disabled` (layer agent). A non-member bot gets `agent_not_member`. A deny rule on the bot gives layer `agent` and is audited with actor `agent`.
- **Agent ∩ human:** a reply to a human removed from a private channel gets 403 `private_channel` and stores 0 messages. The same bot can still reply to a reader, in the thread.
- **Typing:** a non-member bot gets 403 `agent_not_member`, a member gets 200, an unknown bot gets 404.
- **Route registry:** every `/agent-channel/v1` route is registered `cell`, every agent, cell and provider route is registered `user`, and no undecided 2xx is recorded.

Acceptance greps:
- `requireActiveAgent|requireMembership|requireRole` in `agent/` and `agent-channel/`: no hits.
- `authz-legacy`: 0 in `agent/index.ts`, `agent-channel/index.ts`, `bots-queries.ts` and every file in `components/bots`.
- `clientKind: "web"`: 0 in `agent-channel/index.ts`, `provider-auth.ts` and `agent/index.ts`.
- `agent/index.ts` contains all three `requirePermission(...)` literals.
- `agent-channel/index.ts` contains `inReplyToMessageId: body.inReplyToMessageId` and `authz: "cell"`.
- `models-settings.tsx` contains `useCan("provider.manage")`.

**Demo stack (hard rule):** `:4000/health` and `:3000/login` returned 200 before and after, and `ocw-demo-openclaw` stayed Up (healthy). The e2e ran only through `scripts/e2e-isolated.sh`, which waited for the shared lock. No compose down/stop/restart, no `db:migrate`, no `demo:*`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Subscription sign-in audits would have lost the client kind**
- **Found during:** Task 2
- **Issue:** `provider-auth.ts` start/cancel open `withTenant({ organizationId, userId })` without the request's session or client kind. Dropping the `"web"` literal would therefore have written `client_kind = null`.
- **Fix:** A new `ProviderAuthCaller` type carries `clientKind` from `authOf(req)`, and both audits set it explicitly. The tests assert `web` for the browser and `desktop` for Electron.
- **Commit:** `7048783`

**2. [Rule 2 - UX regression guard] No "admins only" flash while permissions load**
- `useCan` is false until `/me/permissions` resolves. Models and Bots runtime now show a skeleton while it loads, then the controls or the existing "Only workspace admins…" message. Layout, copy and testids are unchanged.

### Other notes

- **Error layer:** a non-member bot is refused with code `agent_not_member` on layer **resource**, which is the resolver's membership precondition. Layer `agent` is used for disabled bots and for rules that target a bot.
- **NoModels gate:** it uses `provider.manage` in the gallery and in the new-bot sheet, not `bot.manage`, because its link opens Settings › Models. Today both permissions are admin-only, so nothing changes visibly.
- **Files outside the plan's list:**
  - `e2e/tests/bots.spec.ts` gained the developer case that the plan's behavior asks for: no New bot, no runtime banner, a read-only detail sheet, and "admins only" on Models and Bots runtime.
  - `01-AGENT-CHANNEL-API.md`: the `/messages` checks now say `agent_not_member`, not `not_a_member`, and describe the resolver decisions. The OpenClaw plugin never reads error codes; its 51 tests are green.
- **Error order on POST /messages:** the conversation lookup (404) and the thread-root check (400) now run before chat's agent decision. Before, a disabled bot got 403 first. The cell can already read its whole organization, so this exposes nothing new.
- **TDD ordering:** as in 02-01 to 02-09, each task's tests were committed with its implementation (one `feat` commit per task). The RED checks above show the tests fail without the change.
- **For 02-15:** `agent-channel/gateway.ts` now declares `config: { authz: "cell" }` and calls `markDecided(req)` after `perms.decide(...)`. `registerCellGateway` takes a fifth `perms` argument.

## Known Stubs

None.

## Threat Flags

None. No new surface. T-02-10-01 to 05 are mitigated and tested: 403 for lead and developer, the agent gate and membership, the confused-deputy reply through POST /messages, `cell.sync` per request and on the socket, and the real client kind in audits.

## Self-Check: PASSED

Commits `fcffcef` and `7048783` are on `wt/02-10`. All modified files exist. Stub scan of the touched files: none.
