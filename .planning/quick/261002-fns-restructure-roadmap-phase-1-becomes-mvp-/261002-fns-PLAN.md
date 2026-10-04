---
phase: quick-261002-fns
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - .planning/REQUIREMENTS.md
  - .planning/ROADMAP.md
  - .planning/STATE.md
  - .planning/PROJECT.md
autonomous: true
# Intentionally empty. This quick task RE-MAPS v1 requirement IDs to phases; it implements none of
# them. Listing IDs here would make the executor's update_requirements step mark them Complete in
# REQUIREMENTS.md, which would be false. Every v1 requirement must stay Pending.
requirements: []

estimate:
  tokens: 45000
  raw_tokens: 45000
  tasks: 3
  confidence: low

must_haves:
  truths:
    - "REQUIREMENTS.md lists 127 v1 requirements (122 existing + SLICE-01..05) and every v1 ID appears exactly once in the traceability table"
    - "Phase 1 in ROADMAP.md is 'MVP 0 — Multiplayer AI Chat Slice' with the 22 decided requirement IDs, the decided goal and the 5 decided success criteria"
    - "No v1 requirement ID appears in more than one phase's **Requirements** line, and the union of all phase Requirements lines equals the v1 ID set in REQUIREMENTS.md"
    - "The ROADMAP coverage table sums to 127 and the Milestone Boundary table has an MVP 0 row for Phase 1 with MVP 1 covering 2–7 on top of it"
    - "Phases 2, 3, 6 and 7 carry the narrowed or extended requirement lists and rewritten success criteria; Phases 4, 5 and 8–12 keep their requirement lists and success criteria"
    - "STATE.md focuses on Phase 1 — MVP 0, logs the 2026-10-02 restructure, records the ADR amendments as accepted, and retags the Work Zone messages-rows blocker to Phase 8"
    - "PROJECT.md Key Decisions records 'MVP 0 thin slice first' as Pending"
    - "All v1 requirements remain Pending and unchecked; phase numbering 1–12 is unchanged"
  artifacts:
    - path: ".planning/REQUIREMENTS.md"
      provides: "SLICE section (5 requirements) and remapped traceability for 127 v1 IDs"
      contains: "### MVP 0 Slice (SLICE)"
    - path: ".planning/ROADMAP.md"
      provides: "Phase 1 as MVP 0 slice, narrowed Phases 2/3/6, FOUND-07 in Phase 7, coverage 127, restructure note"
      contains: "### Phase 1: MVP 0 — Multiplayer AI Chat Slice"
    - path: ".planning/STATE.md"
      provides: "Current focus on MVP 0 and the 2026-10-02 roadmap decision"
      contains: "[Roadmap 2026-10-02]"
    - path: ".planning/PROJECT.md"
      provides: "Key Decisions row for the MVP 0 thin slice"
      contains: "MVP 0 thin slice first"
  key_links:
    - from: ".planning/REQUIREMENTS.md traceability table"
      to: ".planning/ROADMAP.md phase **Requirements** lines"
      via: "identical ID → phase mapping for all 127 IDs"
      pattern: "^\\| [A-Z]+-[0-9]+ \\| Phase [0-9]+ \\| Pending \\|$"
    - from: ".planning/ROADMAP.md Coverage table and Total line"
      to: ".planning/REQUIREMENTS.md Coverage block"
      via: "both state 127 total / 127 mapped"
      pattern: "127"
    - from: ".planning/STATE.md Current focus"
      to: ".planning/ROADMAP.md Phase 1 heading"
      via: "same phase name MVP 0 — Multiplayer AI Chat Slice"
      pattern: "MVP 0"
---

<objective>
Restructure the roadmap so Phase 1 becomes "MVP 0 — Multiplayer AI Chat Slice": two people from the
same organization share one AI chat in realtime on a `docker compose up` instance and the model
distinguishes who is speaking, built on the foundations that are ruinous to retrofit (RLS tenant
boundary, unified conversations/messages model, per-stream seq/replay, same-transaction audit).

The design is DECIDED by the product owner (Víctor) and must be encoded exactly, not revisited.
Docs-only change to four `.planning/` files, in English. Phase numbering 1–12 stays the same.

Purpose: the core value was only demonstrable at Phase 6, after a near-complete Slack clone; MVP 0
ships it in 1–2 weeks and Phases 2–7 widen it into MVP 1.
Output: updated REQUIREMENTS.md (SLICE section, remapped traceability, 127 total), ROADMAP.md
(new Phase 1, narrowed Phases 2/3/6, FOUND-07 in Phase 7, coverage 127, restructure note),
STATE.md (focus, decisions, blockers) and PROJECT.md (Key Decisions row, footer).
</objective>

<execution_context>
@~/.claude/gsd-core/workflows/execute-plan.md
@~/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/REQUIREMENTS.md
@AGENTS.md

Target phase → requirement mapping after this plan (the verify gates enforce these exact counts):

| Phase | Requirement IDs | Count |
|-------|-----------------|-------|
| 1 | FOUND-01..06, SLICE-01..05, AUTH-01..03, ORG-05, RT-01, RT-02, RT-05, MULTI-02, MULTI-03, MULTI-04, MULTI-08 | 22 |
| 2 | AUTH-04, AUTH-05, AUTH-06, ORG-01, ORG-02, ORG-03, ORG-04, ORG-06 | 8 |
| 3 | RT-03, RT-04 | 2 |
| 4 | CHAT-01..14 (unchanged) | 14 |
| 5 | AICHAT-01..09 (unchanged) | 9 |
| 6 | MULTI-01, MULTI-05, MULTI-06, MULTI-07, AGENT-01..04 | 8 |
| 7 | SELF-01..07, FOUND-07 | 8 |
| 8 | DEV-01..07 (unchanged) | 7 |
| 9 | RUNTIME-01..10, DESK-01..05 (unchanged) | 15 |
| 10 | WZ-01..16 (unchanged) | 16 |
| 11 | WZUI-01..10, DESK-06, DESK-07 (unchanged) | 12 |
| 12 | ART-01..06 (unchanged) | 6 |
| **Total** | | **127** |

Hard rules for every task:
- Do not touch AGENTS.md or CLAUDE.md (GSD-managed blocks live there).
- Do not change any requirement's wording except where a task explicitly says so (none do for existing IDs).
- Do not mark any requirement complete; every checkbox stays `[ ]` and every traceability Status stays `Pending`.
- Edit with scoped `Edit` calls, never a whole-file `Write`, so untouched sections survive byte-for-byte.
- Run every verify command from the repository root (the commands `cd` there themselves).
</context>

<tasks>

<task type="auto">
  <name>Task 1: REQUIREMENTS.md — add the SLICE section and remap traceability to 127 IDs</name>
  <files>.planning/REQUIREMENTS.md</files>
  <action>
Encode the decided requirement changes in `.planning/REQUIREMENTS.md`.

1. New section. Insert a new section `### MVP 0 Slice (SLICE)` immediately AFTER the Foundation (FOUND) section (after the FOUND-07 bullet) and BEFORE `### Identity and Authentication (AUTH)`. Under the heading add one intro line: "Thin requirements that exist so Phase 1 (MVP 0) ships the core value end to end; each names the full requirement or phase that later widens it." Then add these five bullets verbatim, in the same `- [ ] **ID**: text` format the file already uses:
   - `**SLICE-01**`: The operator configures one model provider (Anthropic by default) and its model through env / `*_FILE` secrets read via the `env`/`file` `SecretStore` provider; no admin UI yet (full admin configuration is AICHAT-01, Phase 5)
   - `**SLICE-02**`: User creates a private AI chat and sees the model's response stream in realtime with the single configured model (model choice, stop, regenerate are AICHAT-02/03, Phase 5)
   - `**SLICE-03**`: Owner shares an AI chat in place with a specific member of the same organization; sharing is a grant on the same conversation, never a copy (teams/departments/org and the share dialog copy are MULTI-01, Phase 6)
   - `**SLICE-04**`: A minimal responsive web UI (Next.js + shadcn/ui) covers setup, invite acceptance, login, AI chat list, live conversation view and share action, verified at mobile and desktop widths
   - `**SLICE-05**`: End-to-end tests use a deterministic mock language model so CI never calls a metered provider; the real provider is exercised manually

2. Traceability table (under `## Traceability`). Change only the Phase column of these rows:
   - AUTH-01, AUTH-02, AUTH-03 → `Phase 1`
   - ORG-05 → `Phase 1`
   - RT-01, RT-02, RT-05 → `Phase 1`
   - MULTI-02, MULTI-03, MULTI-04, MULTI-08 → `Phase 1`
   - FOUND-07 → `Phase 7`
   Then insert five new rows directly after the FOUND-07 row: `| SLICE-01 | Phase 1 | Pending |` through `| SLICE-05 | Phase 1 | Pending |`. Keep every Status as `Pending`. FOUND-01..06 stay Phase 1; all other rows stay as they are.

3. Coverage block (after the table). Replace the three bullets with: `- v1 requirements: 127 total (122 + 5 SLICE requirements added 2026-10-02 for the MVP 0 restructure)`, `- Mapped to phases: 127`, `- Unmapped: 0 ✓`. Keep the existing DESK-06/DESK-07 sentence and append one paragraph: "Phase 1 became the MVP 0 slice on 2026-10-02: FOUND-01…06, SLICE-01…05, AUTH-01…03, ORG-05, RT-01, RT-02, RT-05 and MULTI-02, MULTI-03, MULTI-04, MULTI-08 map there; FOUND-07 moved to Phase 7. ORG-05 is satisfied for the sensitive actions that exist at each point; later phases extend audit coverage to the actions they introduce."

4. Footer. Replace the `*Last updated: ...*` line with `*Last updated: 2026-10-02 after MVP 0 restructure (Phase 1 slice, SLICE-01…05 added, traceability remapped)*`. Leave `*Requirements defined: 2026-09-10*` as is.

Do not alter the wording of any existing requirement, the v2 section or Out of Scope.
  </action>
  <verify>
    <automated>cd "$(git rev-parse --show-toplevel)" && f=.planning/REQUIREMENTS.md && V1=$(awk '/^## v1 Requirements/,/^## v2 Requirements/' $f | grep -oE '^- \[ \] \*\*[A-Z]+-[0-9]+\*\*' | grep -oE '[A-Z]+-[0-9]+' | sort) && TR=$(awk '/^## Traceability/,0' $f | grep -E '^\| [A-Z]+-[0-9]+ \|' | awk -F'|' '{gsub(/ /,"",$2); print $2}' | sort) && test "$(printf '%s\n' "$V1" | grep -c .)" = 127 && test "$V1" = "$TR" && test -z "$(printf '%s\n' "$TR" | uniq -d)" && bad=0 && for id in FOUND-01 FOUND-02 FOUND-03 FOUND-04 FOUND-05 FOUND-06 SLICE-01 SLICE-02 SLICE-03 SLICE-04 SLICE-05 AUTH-01 AUTH-02 AUTH-03 ORG-05 RT-01 RT-02 RT-05 MULTI-02 MULTI-03 MULTI-04 MULTI-08; do grep -qE "^\| $id \| Phase 1 \|" $f || { echo "not Phase 1: $id"; bad=1; }; done && grep -qE '^\| FOUND-07 \| Phase 7 \|' $f && for pc in 1:22 2:8 3:2 4:14 5:9 6:8 7:8 8:7 9:15 10:16 11:12 12:6; do p=${pc%%:*}; n=${pc##*:}; c=$(grep -cE "^\| [A-Z]+-[0-9]+ \| Phase $p \|" $f); test "$c" = "$n" || { echo "Phase $p: $c rows, expected $n"; bad=1; }; done && test "$bad" = 0 && test "$(grep -cE '^\| [A-Z]+-[0-9]+ \| Phase [0-9]+ \| Pending \|$' $f)" = 127 && ! grep -qE '^- \[x\]' $f && grep -q '^### MVP 0 Slice (SLICE)$' $f && grep -q 'v1 requirements: 127 total' $f && grep -q 'Mapped to phases: 127' $f && grep -q 'Last updated: 2026-10-02 after MVP 0 restructure' $f && echo TASK1_OK</automated>
  </verify>
  <done>REQUIREMENTS.md has a `### MVP 0 Slice (SLICE)` section with SLICE-01..05 verbatim; 127 v1 IDs each appear exactly once in the traceability table with the per-phase counts 22/8/2/14/9/8/8/7/15/16/12/6; all rows Pending, no checkbox checked; coverage says 127; footer dated 2026-10-02. The command prints TASK1_OK.</done>
</task>

<task type="auto">
  <name>Task 2: ROADMAP.md — Phase 1 becomes MVP 0, narrow Phases 2/3/6, FOUND-07 to Phase 7, coverage 127</name>
  <files>.planning/ROADMAP.md</files>
<!-- planner-discipline-allow: Scenario B -->
  <action>
Encode the decided roadmap in `.planning/ROADMAP.md` with scoped edits. Keep every `**Mode:**`, `**Plans**: TBD` line and the field order used by existing phase blocks.

A. Overview. Rewrite the first paragraph so it says: this milestone delivers PRD v1.0 MVP 1 and MVP 2 as twelve vertical phases; Phase 1 is now the **MVP 0 slice** that proves the core value first — two people from the same organization share one AI chat in realtime on a `docker compose up` instance and the model knows who is speaking — on top of the foundations that are ruinous to retrofit (RLS tenant boundary, unified `conversations`/`messages` model, per-stream `seq`/replay, same-transaction audit); Phases 2–7 widen it into MVP 1 (permission resolver and org hierarchy, presence and latency, the chat surface, admin-configured direct AI chat, team-wide sharing with shared-context safety and agents, and the self-hosted release with the MVP 1 acceptance scenario in CI); keep the existing sentence describing Phases 8–12. In the design-rules paragraph change the arbiter reference so the arbiter is built once for AI chats in Phase 1 (not Phase 6) and reused for Work Zones in Phase 10. Change the header line to `**Requirements covered:** 127/127 v1 requirements (see Coverage)`.

B. Milestone Boundary table. Add a first row `| **MVP 0 — Multiplayer AI Chat Slice** | 1 | Acceptance Scenario B steps 1–4 pass as a Playwright E2E on `docker compose up`; Autofy's team can use it internally |`. Change the MVP 1 row's Phases cell from `1–7` to `2–7 (on top of MVP 0)` and keep its exit condition. MVP 2 row unchanged.

C. Phase checklist under `## Phases`. Put a bold sub-heading `**MVP 0 — Multiplayer AI Chat Slice**` above the Phase 1 line and move the existing `**MVP 1 — Collaborative Workspace**` sub-heading to sit between Phase 1 and Phase 2. Replace these checklist lines (keep the `- [ ] **Phase N: Name** - description` format):
   - Phase 1: `MVP 0 — Multiplayer AI Chat Slice` - Strict monorepo with RLS tenant boundary and unified conversation model, setup token / invite / login, one authenticated WebSocket with seq replay, a private streaming AI chat shared in place with a colleague, structural participant identity and Scenario B steps 1–4 as a Playwright E2E with a mock model
   - Phase 2: `Identity and Organization` - Password reset, session management, org hierarchy with four roles, one effective-permission resolver adopted by every Phase 1 route, JWT/JWKS auth, admin console and profiles
   - Phase 3: `Realtime Presence and Latency` - Sub-500 ms propagation test on the compose stack, presence and typing with expiry, subscription loss resolved through the Phase 2 resolver
   - Phase 5: `Direct AI Chat` - Admin-configured providers replace the env-configured model; private streaming AI chats with model choice, stop, regenerate, titles, instructions, usage metering and attachments
   - Phase 6: `Sharing, Shared-Context Safety and Agents in Conversations` - Team / department / org sharing with an exact-visibility dialog, intersected tool permissions and withholding, no private memory in multi-human chats, the spoofing eval fixture, agents as first-class members with Agent Cards
   - Phase 7: `Self-hosted Release` - append "CI guardrails (bypass tokens, skipped policy tests, licenses, CODEOWNERS)" to its existing description
   Phase 4 and Phases 8–12 checklist lines stay as they are.

D. Phase 1 details block. Replace the whole current Phase 1 block (heading through `**UI hint**`) with:
   - Heading `### Phase 1: MVP 0 — Multiplayer AI Chat Slice`
   - `**Goal**: Two people from the same organization share one AI chat in realtime on a `docker compose up` instance and the model correctly distinguishes who is speaking — the core value proven end to end in the first phase, on top of the foundations that are ruinous to retrofit (RLS tenant boundary, unified conversations/messages model, per-stream seq/replay, same-transaction audit)`
   - `**Mode:** mvp`; `**Depends on**: Nothing (first phase)`
   - `**Requirements**: FOUND-01, FOUND-02, FOUND-03, FOUND-04, FOUND-05, FOUND-06, SLICE-01, SLICE-02, SLICE-03, SLICE-04, SLICE-05, AUTH-01, AUTH-02, AUTH-03, ORG-05, RT-01, RT-02, RT-05, MULTI-02, MULTI-03, MULTI-04, MULTI-08`
   - `**Success Criteria** (what must be TRUE):` with these five numbered items verbatim:
     1. `pnpm install && pnpm verify` is green on Node 24 in the strict monorepo; `docker compose up` (minimal profile) starts, the API answers health and serves OpenAPI from the Zod contracts, and a missing required secret (including the model API key) fails fast with a clear message
     2. A CI test proves, as the `app` role, that cross-tenant reads return zero rows and writes fail for every org-scoped table; application code reaches the database only through `withTenant()`; `packages/contracts` publishes the unified `conversations`/`messages` model
     3. An admin redeems the one-time setup token to create the organization, invites a colleague by copyable link, and the colleague signs up and stays logged in across refresh; setup, invite, signup and sharing write audit events in the same transaction
     4. A user creates a private AI chat, the response streams in realtime, shares the chat with the colleague, and both write in the same conversation over one authenticated WebSocket with per-stream seq; a client that reconnects replays missed events exactly once (automated test)
     5. The model receives structural participant identity (roster + server-generated attributed blocks), responds when @mentioned or addressed while idle with at most one generation per conversation, and Acceptance Scenario B steps 1–4 pass as a Playwright E2E against the compose stack with the mock model
   - `**Plans**: TBD`
   - `**Research:** standard for foundations; needed for prompt assembly with structural identity on the configured provider (Anthropic default) and the deterministic mock model used by E2E` (the ADR-amendment decision is gone because it was accepted on 2026-09-10)
   - `**UI hint**: yes`

E. Phase 2 block (keep the heading name). Goal: "Every route — including the Phase 1 setup, invite, AI chat and sharing routes — is permission-checked through one resolver, an Organization Admin arranges members into departments, teams and projects with the four PRD roles, and users manage their passwords, sessions and profiles". Depends on: Phase 1. Requirements: `AUTH-04, AUTH-05, AUTH-06, ORG-01, ORG-02, ORG-03, ORG-04, ORG-06`. Replace the five success criteria with:
     1. User resets their password (email when SMTP is configured, admin-issued link otherwise) and views and revokes their active sessions, each carrying a device/client identifier used for message attribution
     2. Admin creates and rearranges Organization → Department → Team → Project (including moving units), assigns members with one of Standard User / Developer / Team Lead-Manager / Organization Admin, and manages users, roles, units and memberships from CRUD pages in the admin console
     3. A single `resolveEffectivePermissions` intersection (Org ∩ Department ∩ Team ∩ Project ∩ User ∩ Agent ∩ Tool ∩ Device) with explicit-deny precedence decides every route, and every Phase 1 route (setup, invite, AI chat, sharing, realtime subscription) is migrated to it with no ad-hoc membership check left
     4. API and WebSocket connections authenticate with short-lived JWTs verifiable against a JWKS endpoint; the Phase 1 WebSocket authentication moves to short-lived JWT/JWKS verification without breaking reconnect and replay
     5. Users view and edit their own profile (display name, avatar, status) and see other members' profiles; hierarchy, role, membership and session-revocation actions extend the Phase 1 same-transaction audit log
   Research: "needed (mapping flat better-auth orgs/teams onto the ltree hierarchy, oauthProvider/JWKS for WS and daemon verification; better-auth schema generation into Drizzle already happens in Phase 1)". UI hint: yes.

F. Phase 3 block. Heading becomes `### Phase 3: Realtime Presence and Latency`. Goal: "Collaborative events reach other connected clients in under 500 ms on the compose stack and people see who is online and typing in each conversation, on top of the Phase 1 WebSocket, seq replay and shared realtime client". Depends on: Phase 2. Requirements: `RT-03, RT-04`. Success criteria (three):
     1. An automated test against the compose stack measures typical propagation of collaborative events between two connected clients under 500 ms
     2. Presence (online/away) and typing indicators for other connected users appear per conversation and expire automatically when a client disappears
     3. A client loses a subscription automatically when its membership is removed, with authorisation resolved through the Phase 2 `resolveEffectivePermissions` resolver
   Research: "standard (Redis-backed presence with expiry over the Phase 1 WebSocket is a known pattern)". UI hint: yes (Claude's discretion: the indicators now render in the Phase 1 web UI).

G. Phase 4 block. Requirements and success criteria unchanged. Change Depends on to "Phase 3 (builds on the Phase 1 conversation model and realtime client)" and change its Research note so the Slack-model chat is built over the Phase 1 conversation model and realtime client instead of "the Phase 3 primitives".

H. Phase 5 block. Requirements and success criteria unchanged. Replace the Goal with: "A user holds a private, streaming AI conversation with organization-configured models and every generation metered — extending the Phase 1 run loop so admin-configured providers and an allowed-models list replace the env-configured single model".

I. Phase 6 block. Heading becomes `### Phase 6: Sharing, Shared-Context Safety and Agents in Conversations`. Goal: "Shared AI chats widen from one colleague to teams, departments and the whole organization without leaking context — tools run with intersected permissions, private memory stays out of multi-human chats and spoofed authority is refused under evaluation — and agents take part in channels, DMs and AI chats as first-class members". Depends on: Phase 5. Requirements: `MULTI-01, MULTI-05, MULTI-06, MULTI-07, AGENT-01, AGENT-02, AGENT-03, AGENT-04`. Replace the success criteria with:
     1. Owner shares an AI chat in place with a team, department or the whole organization, extending the Phase 1 person-to-person share; the share dialog states exactly what becomes visible (context, messages, attachments, artifacts, model, tools, permissions, participants), and every recipient gets a grant on the same record, never a copy
     2. Tools invoked in a shared chat run with the intersection of the agent's and the triggering human's permissions, and content not authorised for every participant is withheld with an explanation from the model
     3. No user-private context or personal memory is injected into a conversation once a second human participant is present
     4. A three-participant evaluation fixture verifies correct addressing and refusal of a spoofed authority claim; because it calls a metered model it runs in CI on a schedule or behind an explicit PR label, never on every PR
     5. Admin or Team Lead creates an agent persona (name, username, avatar, model, instructions, tools, scope, owner); the agent is a member of channels, DMs and AI chats like a human, replies in-thread when mentioned using the thread's context within its permissions, and posts typed Agent Cards (kind, title, fields, status, Open / Follow / Approve actions) that update in place
   The old claim that Scenario B steps 1–4 pass in this phase must not appear anywhere in the Phase 6 block (it now belongs to Phase 1). Research: "needed (prompt assembly beyond the Phase 1 Anthropic default — OpenAI / Google / openai-compatible alternation rules, mid-conversation system messages, prompt caching; the participant-spoofing eval fixture and its metered-model budget)". UI hint: yes.

J. Phase 7 block. Change Requirements to `SELF-01, SELF-02, SELF-03, SELF-04, SELF-05, SELF-06, SELF-07, FOUND-07`. Append success criterion 6: "`pnpm verify` fails a change that introduces a permission-bypass token (Semgrep), a skipped policy test or a license violation, and CODEOWNERS covers db policies, auth, adapters and policy paths". Goal and the other criteria stay.

K. Phases 8–12: requirements, goals and success criteria unchanged. Make only two stale cross-reference corrections: in Phase 8's Depends on line, the streams it builds on are now Phase 1 streams (was Phase 3); in Phase 10's Research note, the arbiter shape it reuses is the Phase 1 arbiter (was Phase 6). Record both in the SUMMARY as cross-reference fixes.

L. Coverage section. Replace the table body with these rows (Category | Requirements | Phase): FOUND | FOUND-01 … FOUND-06 (6) | 1; FOUND | FOUND-07 (1) | 7; SLICE | SLICE-01 … SLICE-05 (5) | 1; AUTH | AUTH-01 … AUTH-03 (3) | 1; AUTH | AUTH-04 … AUTH-06 (3) | 2; ORG | ORG-05 (1) | 1; ORG | ORG-01 … ORG-04, ORG-06 (5) | 2; RT | RT-01, RT-02, RT-05 (3) | 1; RT | RT-03, RT-04 (2) | 3; CHAT | CHAT-01 … CHAT-14 (14) | 4; AICHAT | AICHAT-01 … AICHAT-09 (9) | 5; MULTI | MULTI-02, MULTI-03, MULTI-04, MULTI-08 (4) | 1; MULTI | MULTI-01, MULTI-05, MULTI-06, MULTI-07 (4) | 6; AGENT | AGENT-01 … AGENT-04 (4) | 6; then the existing SELF, DEV, RUNTIME, DESK (5, phase 9), DESK (2, phase 11), WZ, WZUI and ART rows unchanged. Each count stays in the `(N)` form right before the Phase cell, because the verify gate sums those. Change the Total line to `**Total:** 127 v1 requirements, 127 mapped, 0 orphaned, 0 duplicated.` Keep the existing "Adjustments to the research suggestion" paragraph and add after it one paragraph starting with `**Restructure 2026-10-02 (MVP 0):**` saying: the core value (multiplayer AI chat) was only demonstrable at Phase 6, after a near-complete Slack clone, so Phase 1 became a thin vertical slice deliverable in 1–2 weeks; it keeps the foundations that are ruinous to retrofit (FOUND-01…06) and pulls forward AUTH-01…03 (setup token, invite, signup), ORG-05 (same-transaction audit, applied to the sensitive actions that exist in each phase; later phases extend it), RT-01, RT-02, RT-05 (one WebSocket, seq replay, shared realtime client) and MULTI-02, MULTI-03, MULTI-04, MULTI-08 (live multi-human AI chat, structural identity, one generation per conversation, Scenario B steps 1–4), plus five thin SLICE requirements (single env-configured model, private streaming chat, person-to-person share, minimal responsive web UI, deterministic mock model for E2E); FOUND-07 (CI guardrails) moved to Phase 7; Phases 2, 3 and 6 were narrowed to what remains; numbering 1–12 is unchanged and the total grew from 122 to 127.

M. Progress table. Rename rows: `| 1. MVP 0 — Multiplayer AI Chat Slice | MVP 0 | 0/TBD | Not started | - |`, `| 3. Realtime Presence and Latency | MVP 1 | ...`, `| 6. Sharing, Shared-Context Safety and Agents in Conversations | MVP 1 | ...`. Execution Order stays as is.

N. Footer. Keep `*Roadmap created: 2026-09-10*`, add a line `*Restructured: 2026-10-02 (Phase 1 → MVP 0 Multiplayer AI Chat Slice)*`, and change the Source line count from 122 to 127 v1 requirements.
  </action>
  <verify>
    <automated>cd "$(git rev-parse --show-toplevel)" && r=.planning/ROADMAP.md && V1=$(awk '/^## v1 Requirements/,/^## v2 Requirements/' .planning/REQUIREMENTS.md | grep -oE '^- \[ \] \*\*[A-Z]+-[0-9]+\*\*' | grep -oE '[A-Z]+-[0-9]+' | sort) && RM=$(grep -E '^\*\*Requirements\*\*:' $r | sed 's/^\*\*Requirements\*\*: //' | tr ',' '\n' | tr -d ' ' | grep -E '^[A-Z]+-[0-9]+$' | sort) && test -z "$(printf '%s\n' "$RM" | uniq -d)" && test "$(printf '%s\n' "$RM" | grep -c .)" = 127 && test "$V1" = "$RM" && bad=0 && for pc in 1:22 2:8 3:2 4:14 5:9 6:8 7:8 8:7 9:15 10:16 11:12 12:6; do p=${pc%%:*}; n=${pc##*:}; c=$(awk "/^### Phase $p:/,/^\*\*Plans/" $r | grep '^\*\*Requirements' | tr ',' '\n' | grep -cE '[A-Z]+-[0-9]+'); test "$c" = "$n" || { echo "Phase $p: $c IDs, expected $n"; bad=1; }; done && test "$bad" = 0 && test "$(awk '/^## Coverage/,/^\*\*Total/' $r | grep -oE '\([0-9]+\) \|' | grep -oE '[0-9]+' | awk '{s+=$1} END {print s}')" = 127 && grep -q '^\*\*Total:\*\* 127 v1 requirements, 127 mapped' $r && grep -q 'Requirements covered:\*\* 127/127' $r && grep -q '^### Phase 1: MVP 0 — Multiplayer AI Chat Slice$' $r && grep -q '^### Phase 3: Realtime Presence and Latency$' $r && grep -q '^### Phase 6: Sharing, Shared-Context Safety and Agents in Conversations$' $r && ! grep -qE '^### Phase (1: Foundation|3: Realtime Core|6: Multiplayer AI Chat)' $r && grep -q '^| \*\*MVP 0 — Multiplayer AI Chat Slice\*\* | 1 |' $r && grep -q '^| \*\*MVP 1 — Collaborative Workspace\*\* | 2–7 (on top of MVP 0) |' $r && grep -q '^| 1\. MVP 0 — Multiplayer AI Chat Slice |' $r && grep -q '^| 3\. Realtime Presence and Latency |' $r && grep -q '^| 6\. Sharing, Shared-Context Safety and Agents in Conversations |' $r && grep -q '^\*\*Restructure 2026-10-02' $r && awk '/^### Phase 1:/,/^\*\*Plans/' $r | grep -q 'mock model' && awk '/^### Phase 1:/,/^\*\*Plans/' $r | grep -q 'withTenant()' && awk '/^### Phase 2:/,/^\*\*Plans/' $r | grep -q 'JWKS' && awk '/^### Phase 2:/,/^\*\*Plans/' $r | grep -q 'every Phase 1 route' && awk '/^### Phase 6:/,/^\*\*Plans/' $r | grep -q 'metered' && ! awk '/^### Phase 6:/,/^\*\*Plans/' $r | grep -q 'Scenario B' && awk '/^### Phase 7:/,/^\*\*Plans/' $r | grep -q 'FOUND-07' && echo TASK2_OK</automated>
  </verify>
  <done>ROADMAP.md: Phase 1 is "MVP 0 — Multiplayer AI Chat Slice" with the decided goal, 22 requirements and 5 success criteria; Phases 2/3/6 narrowed and rewritten; Phase 7 owns FOUND-07 with a sixth criterion; Phases 4/5 updated only as specified; Phases 8–12 differ only by the two cross-reference fixes; the union of Requirements lines equals the 127 v1 IDs with no duplicates; coverage sums to 127; MVP 0 milestone row, restructure note, progress names and footer updated. The command prints TASK2_OK.</done>
</task>

<task type="auto">
  <name>Task 3: STATE.md and PROJECT.md — record the MVP 0 focus and decision</name>
  <files>.planning/STATE.md, .planning/PROJECT.md</files>
  <action>
STATE.md (`.planning/STATE.md`), scoped edits only:
1. In Project Reference, change `See: .planning/PROJECT.md (updated 2026-09-09)` to `(updated 2026-10-02)` and set the Current focus line to `**Current focus:** Phase 1 — MVP 0 Multiplayer AI Chat Slice`.
2. In Current Position, change the Phase line to `Phase: 1 of 12 (MVP 0 — Multiplayer AI Chat Slice)`. Leave the Plan, Status, Last activity and Progress lines exactly as they are (the orchestrator updates Last activity and adds the quick-task tracking itself; do not add either). Frontmatter stays as is (`total_phases: 12`).
3. In Decisions, add a bullet after the existing `[Roadmap]` bullets: `- [Roadmap 2026-10-02]: Phase 1 restructured into the MVP 0 slice (multiplayer AI chat on `docker compose up`, deliverable in 1–2 weeks): FOUND-01…06, AUTH-01…03, ORG-05, RT-01/02/05, MULTI-02/03/04/08 and new SLICE-01…05 (22 requirements); FOUND-07 → Phase 7; Phase 2 narrowed to AUTH-04…06 + ORG-01…04/06, Phase 3 to RT-03/04 (Realtime Presence and Latency), Phase 6 to MULTI-01/05/06/07 + AGENT-01…04; v1 total 127; numbering 1–12 unchanged.`
4. In Decisions, replace the still-open bullet that asks to accept or reject the research ADR amendments (Node 24 LTS, TS 7 with `typescript@6` alias, Grafana Tempo, env/file secret provider with OpenBao optional) with a resolved bullet: `- [ADR amendments]: Node 24 LTS, TS 7 with `typescript@6` alias, Grafana Tempo in the observability profile and the env/file secret provider with OpenBao as an optional profile — accepted 2026-09-10 (commit 87972fe).` Keep the ADR-0005 bullet and the other bullets.
5. In Blockers/Concerns, retag the bullet about deciding whether Work Zone prompts/assistant messages are also `messages` rows in a `work_session` conversation from its current Phase 1 tag to `[Phase 8]` (MVP 0 does not need it; Phase 8 fixes the Work Zone contracts). Keep its text and keep the other three blockers unchanged, so the section still has four bullets.
6. Do not touch Performance Metrics, Pending Todos, Deferred Items or Session Continuity.

PROJECT.md (`.planning/PROJECT.md`):
7. Append a row at the end of the Key Decisions table: `| MVP 0 thin slice first (Phase 1 = multiplayer AI chat on compose) | Core value was only demonstrable at Phase 6; ship it in 1–2 weeks and widen afterwards; keep RLS, unified conversation model, seq replay and audit since they are ruinous to retrofit | — Pending |`
8. Change the footer to `*Last updated: 2026-10-02 after MVP 0 roadmap restructure*`. No other PROJECT.md change.
  </action>
  <verify>
    <automated>cd "$(git rev-parse --show-toplevel)" && s=.planning/STATE.md && p=.planning/PROJECT.md && grep -q '^\*\*Current focus:\*\* Phase 1 — MVP 0 Multiplayer AI Chat Slice$' $s && grep -q '^Phase: 1 of 12 (MVP 0 — Multiplayer AI Chat Slice)$' $s && grep -q '^  total_phases: 12$' $s && grep -q 'PROJECT.md (updated 2026-10-02)' $s && grep -q '^- \[Roadmap 2026-10-02\]: Phase 1 restructured into the MVP 0 slice' $s && ! grep -q 'Phase 1 pending' $s && grep -q 'accepted 2026-09-10' $s && grep -qE '^- \[Phase 8\]:.*Work Zone prompts' $s && ! grep -qE '^- \[Phase 1\]:.*Work Zone prompts' $s && test "$(awk '/^### Blockers/,/^## Deferred/' $s | grep -c '^- \[')" = 4 && grep -q '^Last activity: 2026-09-10 — Roadmap created' $s && grep -q '^| MVP 0 thin slice first (Phase 1 = multiplayer AI chat on compose) | Core value was only demonstrable at Phase 6' $p && grep -q 'ruinous to retrofit | — Pending |$' $p && grep -q '^\*Last updated: 2026-10-02 after MVP 0 roadmap restructure\*$' $p && echo TASK3_OK</automated>
  </verify>
  <done>STATE.md focuses on Phase 1 — MVP 0 Multiplayer AI Chat Slice, logs the [Roadmap 2026-10-02] decision, shows the ADR amendments as accepted 2026-09-10, retags the Work Zone messages-rows blocker to Phase 8 (four blockers total), and leaves Last activity untouched; PROJECT.md has the MVP 0 Key Decisions row (Pending) and a 2026-10-02 footer. The command prints TASK3_OK.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Planning docs → future phase planners/executors | ROADMAP.md and REQUIREMENTS.md are the authority later agents plan from; a dropped or double-mapped ID silently removes or duplicates scope |
| Repo → public (AGPL open source) | Planning docs are committed; they must not carry secrets |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-261002-01 | Tampering | REQUIREMENTS.md traceability / ROADMAP.md Requirements lines | medium | mitigate | Task 1 and Task 2 gates prove set equality of the 127 v1 IDs across the requirement list, the traceability table and the phase Requirements lines, no duplicates, and exact per-phase counts |
| T-261002-02 | Tampering | REQUIREMENTS.md status columns | medium | mitigate | `requirements: []` in frontmatter so the executor marks nothing complete; Task 1 gate requires 127 `Pending` rows and no checked box |
| T-261002-03 | Elevation of Privilege | Phase 1 routes authorised before the Phase 2 resolver exists | medium | mitigate | Phase 2 success criteria (Task 2, section E) require every Phase 1 route to migrate to `resolveEffectivePermissions` and Phase 1 WebSocket auth to move to short-lived JWT/JWKS; Phase 1 keeps RLS and the cross-tenant CI test (criterion 2) |
| T-261002-04 | Repudiation | Undocumented roadmap change | low | mitigate | Decision recorded in three places: STATE.md [Roadmap 2026-10-02] bullet, PROJECT.md Key Decisions row, ROADMAP.md Restructure note |
| T-261002-05 | Information Disclosure | SLICE-01 secret handling wording | low | accept | Docs name only the mechanism (env / `*_FILE` via `SecretStore`); no key, token or value is written |
| T-261002-06 | Denial of Service (cost) | Metered model in CI | low | mitigate | SLICE-05 mandates a deterministic mock model for E2E; Phase 6 criterion 4 runs the metered spoofing eval only on a schedule or PR label |
</threat_model>

<verification>
Run from the repository root after all three tasks:
1. The three task commands print TASK1_OK, TASK2_OK and TASK3_OK.
2. `git diff --quiet -- AGENTS.md CLAUDE.md` succeeds (GSD-managed blocks untouched).
3. `git diff --name-only` lists only `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, `.planning/STATE.md`, `.planning/PROJECT.md` (plus this quick task's own directory).
4. `grep -cE '^\| [A-Z]+-[0-9]+ \| Phase [0-9]+ \| Pending \|$' .planning/REQUIREMENTS.md` prints 127 (nothing was marked complete).
5. `git diff .planning/ROADMAP.md` shows no change inside the Phase 8–12 requirement and success-criteria lines; only the two cross-reference fixes in Phase 8 Depends on and Phase 10 Research.
</verification>

<success_criteria>
- Phase 1 is "MVP 0 — Multiplayer AI Chat Slice" with exactly the decided goal, 22 requirements, 5 success criteria, research note and UI hint
- 127 v1 requirements, each mapped to exactly one phase in both REQUIREMENTS.md and ROADMAP.md; coverage table sums to 127
- Phases 2, 3, 6 and 7 match the decided changes; Phases 4 and 5 carry only the notes asked for; Phases 8–12 unchanged except two cross-reference fixes
- STATE.md and PROJECT.md record the decision; no requirement marked complete; AGENTS.md / CLAUDE.md untouched
</success_criteria>

<output>
Create `.planning/quick/261002-fns-restructure-roadmap-phase-1-becomes-mvp-/261002-fns-SUMMARY.md` with `status: complete` in its frontmatter when done. List the per-phase requirement counts, the two Phase 8 / Phase 10 cross-reference fixes, and the verify output.

Do NOT run `requirements.mark-complete` for this plan: the frontmatter `requirements` list is intentionally empty and every v1 requirement stays Pending.
</output>
