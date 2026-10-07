---
phase: 06-multiplayer-ai-chat
plan: 07
subsystem: api, contracts, web
status: complete
tags: [agents, personas, permissions, resolver, unit-leads, bots-ui, AGENT-01]
requires:
  - phase: 06-01
    provides: "agents.unit_id (ON DELETE RESTRICT), relaxed owner check, bot.manage_unit, LEAD_PERMISSIONS"
  - phase: 03.1
    provides: "personal bots, capability model, per-bot viewerCan, governance"
provides:
  - "Shared bots as scoped personas: organization, department, team or project (agents.unit_id), with an optional owner"
  - "Admins create personas anywhere; unit leads only in the subtrees they lead (bot.manage_unit), and configure them (bot.configure)"
  - "unit_agent precondition: a unit persona is seen, mentioned and messaged only by its subtree, path leads, owner and admins"
  - "409 unit_has_bots on unit deletion; 400 personal_bot_unit; 404 owner_not_found / unit_not_found (tenant-checked)"
  - "Bots UI: Who can use it (scope, unit, owner) in New bot and in the detail; scope badge; New bot for leads"
affects: [06-08, 06-09, 06-10, 06-14]
actuals:
  tokens: 31700
  tasks: 2
  commits: 8
tech-stack:
  added: []
  patterns:
    - "Unit-scoped resources: agentResource carries the unit path, so unit rules and LEAD_PERMISSIONS apply without new resolver branches"
    - "Audience-routed realtime: a unit persona's events go to each reader's user: topic; users who lose it get agent.deleted"
key-files:
  created:
    - apps/api/src/modules/agent/personas.int.test.ts
    - e2e/tests/agent-personas.spec.ts
  modified:
    - packages/contracts/src/agent.ts
    - apps/api/src/modules/organization/permissions/{policy,resolve,resolve.test}.ts
    - apps/api/src/modules/agent/{index,service}.ts
    - apps/api/src/modules/bot-capabilities/{routes,turn-policy}.ts
    - apps/api/src/modules/chat/{directory,index}.ts
    - apps/api/src/modules/organization/units.ts
    - apps/web/lib/bots-queries.ts
    - apps/web/components/bots/{bot-form,new-bot-sheet,bot-detail-sheet,bot-bits,bot-card,bots-gallery}.tsx
key-decisions:
  - "Profile edits on a shared persona need bot.configure (admins, its owner, leads of its unit path), not bot.manage; enable/delete need bot.manage (organization) or bot.manage_unit (unit persona)"
  - "Leads of an ancestor unit also see a unit persona (they configure it through LEAD_PERMISSIONS on the subtree)"
  - "Unit persona realtime goes to its readers' user: topics (never org:); a move or owner change sends agent.deleted to whoever lost it"
  - "bot.manage_unit is reported in viewerCan only for unit personas, so organization bots keep the Phase 1 set"
  - "Mentions, reply mode, DMs, group DMs and channel adds all require bot.read on a unit persona (the plan named only the two mention paths)"
requirements-completed: [AGENT-01]
coverage:
  - id: D1
    description: "Resolver: lead rights on the subtree, unit_agent visibility, owner relation on shared personas"
    requirement: AGENT-01
    verification:
      - kind: unit
        ref: "apps/api/src/modules/organization/permissions/resolve.test.ts#unit personas (Phase 6, AGENT-01, P-04)"
        status: pass
  - id: D2
    description: "API: scoped creation, lead configuration, visibility, mention gate, moves, owners, unit_has_bots, cross-tenant"
    requirement: AGENT-01
    verification:
      - kind: integration
        ref: "apps/api/src/modules/agent/personas.int.test.ts"
        status: pass
  - id: D3
    description: "Bots UI: admin and lead create scoped personas, Jo cannot see them, owner reassigned live, Phase 1 bot shows Organization"
    requirement: AGENT-01
    verification:
      - kind: e2e
        ref: "e2e/tests/agent-personas.spec.ts (desktop + mobile)"
        status: pass
metrics:
  duration: "~50 min"
  completed: 2026-10-07
---

# Phase 6 Plan 07: Agent personas (scope, owner, lead creation) Summary

Shared bots are now scoped personas. `agents.unit_id` sets the scope (organization, department, team or project), and an optional owner is accountable for the persona. Admins create personas anywhere. Unit leads create and configure them only inside the units they lead, tools included. The resolver's `unit_agent` precondition decides who sees and mentions a persona: members of its unit subtree, leads on its path, its owner and admins.

## What was built

- **Contracts (add-only):**
  - `Agent.unitId` and `Agent.unit` (`{id, name, kind}`).
  - `CreateAgentRequest.unitId` and `CreateAgentRequest.ownerUserId`.
  - `UpdateAgentRequest.unitId` and `UpdateAgentRequest.ownerUserId` (both nullable).
  - `AgentList.create` (`{organization, unitIds}`).
- **Resolver:**
  - `AgentFacts.unitPath` travels on `agentResource`, with state `unit_scoped`.
  - New precondition on `bot.read`: `unit_agent`. It holds even against allow rules.
  - Leads get `bot.manage_unit` and `bot.configure` on the personas of their subtree. Unit-scoped rules now reach unit personas.
- **Agent API:**
  - `POST /agents`:
    - With no unit it needs `bot.manage`. With a unit it needs `bot.manage_unit` on that unit.
    - The unit is read under tenant RLS, so a unit from another organization returns 404 `unit_not_found`. This closes the 06-01 open item: the foreign key bypasses RLS.
    - The owner must be an active member (404 `owner_not_found`). By default a unit persona's owner is its creator.
  - `PATCH /agents/:id`:
    - Editing fields or changing the owner needs `bot.configure`.
    - Enabling or disabling needs `bot.manage` or `bot.manage_unit`.
    - A move needs the right on both the old and the new place.
    - Personal bots refuse a unit (400 `personal_bot_unit`) and another owner (400 `personal_bot_owner`).
  - `DELETE /agents/:id`: deleting a unit persona needs `bot.manage_unit`.
  - `GET /agents` filters unit personas per caller and returns the create hint.
  - Audit rows carry `unitId` and `ownerUserId` (ids only).
- **Realtime:** unit persona events go to each reader's `user:` topic, never to `org:`. Users who lose a persona after a move or an owner change get `agent.deleted`.
- **Chat:** a unit persona is reached only by humans who hold `bot.read` on it. This applies to mentions, reply mode, DMs, group DMs and channel adds (404).
- **Units:** `DELETE /units/:id` returns 409 `unit_has_bots` while live personas remain. The unit reference of deleted personas is cleared, so the RESTRICT foreign key never blocks a unit that has only deleted personas.
- **Web:**
  - New bot shows a "Who can use it" section with these parts:
    - Scope: Organization, Department, Team or Project. Personal is not offered here and stays one-click.
    - A unit picker filtered by kind and by the create hint.
    - An owner picker.
  - Leads see New bot, with only their own units offered.
  - Cards of unit personas show a scope badge.
  - The detail header shows the scope badge and "Owner: …". People with `bot.configure` can edit the placement in place. A move is offered only where the create hint allows it.

## Verification

- `pnpm typecheck --force`: 8 of 8 tasks passed.
- Unit tests: `resolve.test.ts` passes 81 tests, 9 of them new.
- Integration tests:
  - `personas.int.test.ts` passes 19 tests. RED came first: all 19 failed before the implementation.
  - Bot regression suites, run one file at a time, all green: personal (15), team-dm (7), capabilities (23), agent-channel (23), units (11), mcp-cell (14), tool-calls (12), plugins-cell (12), usage (14), provider-auth (9), reply-mode (14), memory (13), dm-privacy (12), dm (16), prefs (15), group-dm (12), marketplace (17), providers-secret-ref (12) and mcp (19).
- Isolated e2e (`scripts/e2e-isolated.sh --rebuild-web agent-personas bots.spec personal-bots bot-capabilities team-bot-dm`): 15 passed, 0 flaky, on desktop and mobile.
- Screenshots reviewed:
  - `personas-new-<1440|390>[-dark]`
  - `personas-gallery-<1440|390>`
  - `personas-gallery-admin-<1440|390>`
  - `personas-detail-<1440|390>[-dark]`
  - `personas-detail-viewer-<1440|390>`
- `pnpm verify`: lint and typecheck pass. Tests: 2448 passed, 1 failed. The failure (`ai-chat/grants.int.test.ts`) already exists on the base commit; see Deferred Issues.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 2 - Missing critical] Realtime leaked unit personas to the whole organization**
- **Found during:** Task 1
- **Issue:** `publishAgent` sends every shared bot, with its full DTO and instructions, on `org:`. A unit persona would have reached every browser in the org (T-06-07-02).
- **Fix:** Events now go to each reader's `user:` topic, and users who lose access are sent `agent.deleted`. The web refetches the bot list on `units.updated`.
- **Commit:** c20aa17

**2. [Rule 2 - Missing critical] Other ways to reach a persona bypassed visibility**
- **Found during:** Task 1
- **Issue:** Reply mode, DMs, group DMs, `POST /dms` participants and `POST /channels/:id/members` did not use the persona's unit path.
- **Fix:** All of them now decide `bot.read` with the unit path. A channel add or a DM with an invisible persona returns 404.
- **Commit:** c20aa17

**3. [Rule 1 - Bug] A soft-deleted persona would block its unit's deletion**
- **Issue:** The RESTRICT foreign key would fire on a unit whose only personas were deleted.
- **Fix:** Unit deletion clears `unit_id` on deleted personas, after the `unit_has_bots` check on live ones.
- **Commit:** c20aa17

**4. [Rule 1 - Bug] The web cache dropped `AgentList.create`**
- **Issue:** Realtime upserts and deletes rebuilt the list as `{agents}` only, so the create hint was lost.
- **Fix:** The list is rebuilt as `{...prev, agents}`.
- **Commit:** 51356dc

**5. [Adjustment] Riley's org role is Lead, not standard, in the integration and e2e tests**
- **Reason:** The units API lets only Lead or Admin roles lead a unit (`lead_requires_role`).
- **Coverage:** The Lead role grants no bot right. The resolver test covers a standard-role lead.
- **Actor names:** The e2e uses its own actors, Lena Ortega (the plan's Riley) and Kai Moreno (the plan's Alex). The isolated database is shared by every spec in a run, and another spec already uses "Alex Kim" and "Riley Park".

**6. [Adjustment] Field edits on organization personas need `bot.configure` instead of `bot.manage`**
- **What changed:** Both owners and leads can now edit a persona's profile. Admins hold both permissions, so nothing changes for them.
- **Side effect:** A member with `bot.configure` from an explicit allow rule can now also edit team bot profiles. That rule could already change their tools.
- **Phase 1 checks unchanged:** In `agent-channel.int`, lead and developer still get 403 on PATCH and DELETE.

## Deferred Issues

- `apps/api/src/modules/ai-chat/grants.int.test.ts › "the owner's next turn still attributes former grantees' messages…"` fails on base `40ab283`, before any 06-07 change. I confirmed this in a temporary detached worktree, since removed. The fake model's echo of an earlier turn contains a `<notice>` line, so `not.toContain("shared this chat with")` fails. This comes from the 06-04 + 06-05 merge and is out of scope here. I did not create `deferred-items.md`, to avoid merge conflicts with the parallel plans.

## Known Stubs

None.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: info-disclosure | apps/api/src/modules/chat/directory.ts | Mention resolution still resolves a unit persona's handle for anyone who types it, so its display name renders in messages to channel readers. It is never delivered or added for them. |

## Self-Check: PASSED

- Files exist: `personas.int.test.ts`, `agent-personas.spec.ts`, and `personas-detail-*.png` (6 files, at least 2 required).
- Commits exist: a6d2d77, 2f6445e, f7c65c6, c20aa17, 51356dc, 7e35daf, 9c823a5.
- Acceptance greps:
  - `unit_agent` appears in `policy.ts`.
  - `bot.manage_unit` appears in `agent/index.ts`.
  - `unit_has_bots` appears in `units.ts`.

Ledger line for the orchestrator: `gsd windows append --kind deviation --phase 6 --file apps/api/src/modules/ai-chat/grants.int.test.ts --description "pre-existing grants.int failure (notice echoed by fake model) from 06-04+06-05 merge"`
