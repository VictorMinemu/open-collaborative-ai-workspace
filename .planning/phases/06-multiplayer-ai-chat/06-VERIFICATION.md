---
phase: 06-multiplayer-ai-chat
verified: 2026-10-07T15:57:15Z
status: human_needed
score: 4/5 roadmap success criteria verified (68/69 plan truths); 1 awaits the owner (metered eval)
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Metered three-participant spoofing/addressing eval: `OCW_EVAL_DRY_RUN=1 pnpm --filter @ocw/api eval:multiplayer`, then `OCW_EVAL_CONFIRM=metered OCW_EVAL_PROVIDER=openrouter OCW_EVAL_API_KEY=<key> pnpm --filter @ocw/api eval:multiplayer`"
    expected: "Each of the six SPOOF_CASES passes on at least 2 of 3 repetitions on both models; the JSON report shows no key"
    why_human: "Spends the owner's money on a real provider (D-02). The free prompt-level counterparts pass; real-model behaviour has never been observed"
  - test: "Check OpenAI's current terms/help on a member's ChatGPT plan (Sign in with ChatGPT) answering turns in a chat other people read"
    expected: "Allowed, so ADR-0019 §5 stands; if not, a new ADR supersedes §5 with org models only in shared chats"
    why_human: "Vendor terms; NEEDS VALIDATION in ADR-0019 §5"
  - test: "Visual review of multiplayer-*, share-*, shared-*, participants-*, personas-*, ai-chat-agent-*, agent-card-* and day-* screenshots at 1440/390, light/dark"
    expected: "Consistent with the Phase 4/5 UI language (D-08); no truncation or overflow"
    why_human: "Taste judgement"
  - test: "When CI billing returns: real OpenClaw cell smokes (`infra/openclaw/test/run-container-smoke.sh`, including SMOKE_ONLY=card), a flat ai_chat mention, the withheld block, and the gate refusing a withheld tool"
    expected: "A real cell answers a persona mention in an AI chat, posts/updates a card through ocw_agent_card, and receives agent.card_action.v1"
    why_human: "Every proof so far uses the fake cell and the plugin's unit harness; no OpenClaw container may run on an executor"
  - test: "Confirm or revert D-06 as built: a chat with any agent member counts as shared, so the owner's personal instructions are excluded"
    expected: "Owner confirms; or asks to revert the agent clause in `sharedSql` (ai-chat/dto.ts:99) and `participantsOf` (ai-chat/turn.ts:227)"
    why_human: "Product decision taken by the orchestrator under delegated autonomy (06-12), recorded as open in ADR-0019/0020"
---

# Phase 6: Multiplayer AI Chat, Shared-Context Safety and Agents. Verification Report

**Phase goal:** A private AI chat becomes multiplayer. It can be shared in place with a person, team, department or the whole organization, with several humans and the model in one conversation, structural participant identity and one generation at a time, without leaking context. Agents become full personas in channels, DMs and AI chats.
**Verified:** 2026-10-07T15:57:15Z
**Status:** human_needed
**Re-verification:** No (initial verification)

> **MVP-mode note.** ROADMAP marks Phase 6 `Mode: mvp`, but the goal is not written as a User Story. The user asked for this verification explicitly, so it applies the standard goal-backward method plus a User Flow table for Acceptance Scenario B. Turning the goal into a User Story is an optional roadmap cleanup. It is not a gap.

## User Flow Coverage (Acceptance Scenario B, steps 1–4)

| Step | Expected | Evidence in codebase | Status |
|------|----------|----------------------|--------|
| 1. Víctor creates a private AI chat | Solo chat, Phase 5 prompt byte-identical | `build-model-messages.ts:393-419` solo branch; `ai-chat/__snapshots__` unchanged since `ce68b47~1` | VERIFIED |
| 2. He shares it with Alex | Grant row on the same conversation; disclosure dialog | `grants.ts:395-490` inserts into `ai_chat_grants` only, plus a participation row; `share-people.tsx:50-58` lists the 8 disclosure items | VERIFIED |
| 3. Both write in realtime | Alex reads, subscribes and writes; both receive deltas | `aiAccessSql` (`chat/service.ts:403`) feeds `channelFacts` and the readable set; `multiplayer.int` 17/17 (run here) | VERIFIED |
| 4. The model distinguishes both | Roster plus attributed blocks; answers by name | `multiplayerInstructions`/`messageBlock`/`turnContext` (`build-model-messages.ts:177-257`); `day-coalesced-1440.png` shows "Hi Alex Moreno and Víctor Ruiz!" | VERIFIED |

## Goal Achievement

### Observable Truths (ROADMAP success criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Owner shares in place with a person, team, department or organization; the dialog states what becomes visible; every recipient gets a grant on the same record, never a copy | ✓ VERIFIED | The migration `20261007073058_multiplayer_ai` adds `ai_chat_grants` (subject user/unit/org, level chat/view, partial unique active index) and duplicates no table. `aiGrantMatchSql` (`chat/service.ts:383`) covers the person, the unit subtree via `ou.path` and active org members. `grants.ts` covers POST/GET/PATCH/DELETE, notices, ids-only audit, live revoke via the `aiChatAccessChanged` invalidator (`grants.ts:238`) and participant re-decision. The disclosure covers context, messages, attachments, artifacts, model, tools, permissions and participants (`share-people.tsx:50`). `grants.int` 17/17 and `shared.int` 17/17 were run here. |
| 2 | Several humans and the model write in realtime. Each message records author, timestamp, device, context and permissions. The roster and attributed blocks are used, never name prefixes. The model answers on @mention or Ask AI. At most one generation runs, and the queue is visible. Scenario B 1–4 passes in Playwright | ✓ VERIFIED | Each human message gets an `ai_message_context` row (`ai-chat/service.ts:436,766`): access, grant, level, model, tools, shared and answering generation. Author, `created_at`, `client_kind` and `session_id` live on `messages` (`schema/app.ts:294-295`). `neutralise`/`promptName` stop forged tags and attributes. The arbiter (`queue.ts`) derives the queue from context rows; the backstop is `ai_generations_one_running_uq` (`schema/app.ts:1275`). Coalesced turns resolve only the first waiting author's model, and `ai.queue.updated` reaches every subscriber. `queue.int` 13/13 and `prompt-matrix.int` 9/9 were run here. The e2e (`ai-chat-multiplayer.spec.ts`, `ai-chat-multiplayer-day.spec.ts`) was not re-run, per instructions; the 06-16 gate reports 259/0. |
| 3 | Tools in a shared chat = agent ∩ triggering human. Content not authorised for every participant is withheld with an explanation. No private context or memory once a second human is present | ✓ VERIFIED | **Chat model:** `webTools` → `webUnavailableReason` for the requester, then a `<withheld>` line in `<turn_context>` (`turn.ts:334-367`). **Personas:** `computeTurn` (`bot-capabilities/turn-policy.ts:114-199`) decides `bot.tool.use` for the asker. It withholds scoped tools for unbounded audiences (unit/org grants) or when any reader is denied, and the gate re-decides at call time with `audienceOf` (`agent-channel/tool-calls.ts:151`). **Memory:** `memoryScopeKind` returns `ai_chat`, so there is never memory in AI chats (`turn-policy.ts:242-311`). **Personal instructions:** excluded when `shared` (`build-model-messages.ts:197`, `turn.ts:227`). `security.int` 16/16 (planted-marker leak sweep) and `ai-chat-delivery.int` 13/13 were run here. |
| 4 | A three-participant eval fixture verifies addressing and refusal of a spoofed authority claim. Because it is metered, it runs only on schedule or behind a PR label | ? UNCERTAIN (human_needed) | The fixture is complete. `spoof-cases.ts` has 6 cases; the free prompt-level checks pass in `build-model-messages.test.ts:936`. `eval/multiplayer/run.ts` refuses without `OCW_EVAL_CONFIRM=metered` plus a key (`run.ts:234-241`) and uses `orgLanguageModel`. The grader is deterministic. `.github/workflows/ai-eval.yml` runs only on label, weekly or dispatch, and skips without the secret. **Not yet observed:** a real-model run. The owner deferred it, and CI is blocked by billing. |
| 5 | Admin or Team Lead creates a persona with tools, a scope (org/department/team/project/personal) and an owner. Agents are members of DMs and AI chats as well as channels. They post typed Agent Cards (kind, title, fields, status, Open/Follow/Approve) that update in place | ✓ VERIFIED | **Personas:** `agents.unit_id` plus the relaxed owner check; `bot.manage_unit` for leads (`agent/index.ts:347,430`); `unit_agent` visibility (`policy.ts:188`). `personas.int` 19/19 was run here. **AI chat members:** `members.ts` (personal bots refused, `members.ts:314`). Mentions go to OpenClaw flat (`ai-chat/service.ts:689` → `agent-channel/mentions.ts`). **Cards:** the `message_cards` table, `insertCard` (`chat/service.ts:937`), `patchCard` (posting agent only, optimistic version), a single audited decision, `emitCardAction`, Open limited to internal routes (`isAgentCardRoute`), `ocw_agent_card` in the plugin, and one renderer `AgentCardView` used in `message-list.tsx:518` and `ai-message.tsx:186`. `cards.int` 32/32, the plugin tests 231/231 and the web card/stream tests 29/29 were run here. |

**Score:** 4/5 roadmap truths verified (0 present-but-behavior-unverified). SC4 awaits the owner. Plan truths: 69 across 16 plans; 68 are verified. The exception is 06-09 truth 1 ("verifies … on a real metered model"), which is the same owner item.

### Required Artifacts

| Artifact | Status | Details |
|----------|--------|---------|
| `packages/contracts/src/ai-chat.ts`, `agent-cards.ts` | ✓ VERIFIED | Exports present; typecheck 8/8 in verify |
| `packages/db/drizzle/20261007073058_multiplayer_ai/migration.sql` | ✓ VERIFIED | The only migration added in Phase 6. The tool's glob reported "not found"; the file exists |
| `packages/db/src/rls-isolation.int.test.ts` | ✓ VERIFIED | 20/20 run here |
| `ai-chat/{grants,members,queue,build-model-messages,spoof-cases,turn,dto}.ts` | ✓ VERIFIED | Substantive and wired (see truths) |
| `ai-chat/{multiplayer,grants,queue,shared,prompt-matrix,security}.int.test.ts` | ✓ VERIFIED | All run here, all green |
| `agent-channel/cards.ts`, `chat/card-actions.ts`, `agent-channel/ai-chat-delivery.int.test.ts`, `agent/personas.int.test.ts` | ✓ VERIFIED | Run here, green |
| `apps/openclaw-channel/src/{card-tool,mention-mapper}.ts` | ✓ VERIFIED | Plugin suite 231/231 |
| `infra/fake-model/attribution.mjs` | ✓ VERIFIED | `node --test` 12/12 |
| `apps/api/src/eval/multiplayer/{run,grade}.ts`, `.github/workflows/ai-eval.yml` | ✓ VERIFIED | Gated as specified; `eval.test` passes |
| Web: `share-people.tsx`, `participants.tsx`, `queue-chip.tsx`, `agent-card.tsx`, `lib/ai-grant-queries.ts`, `lib/ai-chat-stream.ts` | ✓ VERIFIED | Imported and rendered in `ai-chat-view.tsx`, `share-dialog.tsx`, `message-list.tsx` and `ai-message.tsx` |
| `docs/adr/0019…`, `docs/adr/0020…`, `docs/DEMO.md`, `AGENTS.md` | ✓ VERIFIED | Both ADRs Accepted. No earlier ADR touched since `ce68b47~1`. AGENTS.md is 198 lines. DEMO has the owner checks |
| e2e specs (`ai-chat-multiplayer`, `-day`, `share-people`, `shared-inbox`, `ai-chat-agents`, `agent-cards`, `agent-personas`) | ✓ EXISTS | Not re-run (forbidden). 06-16 reports 259/0; screenshots exist (144 files) |

### Key Link Verification

The tool verified 21/26 links. I checked the other 5 by hand; each is wired, but in a different place than the plan's pattern named:

| From | To | Status | Details |
|------|----|--------|---------|
| share-dialog.tsx | POST grants | WIRED | Via `SharePeople` (`share-dialog.tsx:60`) → `createAiChatGrant` (`share-people.tsx:105`) |
| notification/routes.ts | readableIds incl. ai_chat | WIRED | `NOTIFIABLE_KINDS` includes `ai_chat` (`notification/service.ts:57`), used at `routes.ts:58,136` |
| ai-chat-queries.ts | POST messages 201/202 | WIRED | `ai-chat-queries.ts:328-413` |
| chat/index.ts | app.message_cards | WIRED | `chat/service.ts:937` `insertCard` → `card-actions.ts:161` |
| security.int.test.ts | every Phase 6 route | WIRED | Pattern uses `{id}` OpenAPI form (`security.int.test.ts:1071-1074`) |

### Data-Flow Trace (Level 4)

| Artifact | Data | Source | Real data | Status |
|----------|------|--------|-----------|--------|
| QueueChip | `chat.queue` | `ai.queue.updated` ← `queueState` (`ai_message_context` ⋈ `messages` ⋈ `ai_generations`) | Yes | ✓ FLOWING |
| AiChatParticipants | participants | `GET /participants` ← `participantsOf`/`aiAccessOf` | Yes | ✓ FLOWING |
| AgentCardView | `message.card` | `withCards`/`cardMessageOf` ← `message_cards` | Yes | ✓ FLOWING |
| Payer footer | `generation.requesterUserId`, backend | generation DTO | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full local gate | `pnpm verify` (run once) | exit 0; lint 4 warnings (pre-existing); typecheck 8/8; **186 files, 2627 tests**, matching the claim | ✓ PASS |
| Prompt builder, guard, eval grader, resolver | `vitest --project unit` (4 files) | 169/169 | ✓ PASS |
| Sharing tracer | `integration ai-chat/multiplayer.int` | 17/17 | ✓ PASS |
| Grants and live revoke | `integration ai-chat/grants.int` | 17/17 | ✓ PASS |
| One generation, queue, coalescing, sweeper | `integration ai-chat/queue.int` | 13/13 | ✓ PASS |
| Leak sweep plus 401/404 matrix | `integration ai-chat/security.int` | 16/16 (matches claim) | ✓ PASS |
| Agent Cards | `integration agent-channel/cards.int` | 32/32 (matches claim) | ✓ PASS |
| Persona in AI chat, no memory, withheld | `integration agent-channel/ai-chat-delivery.int` | 13/13 | ✓ PASS |
| Personas scope and leads | `integration agent/personas.int` | 19/19 | ✓ PASS |
| Provider wire matrix | `integration ai-chat/prompt-matrix.int` | 9/9 | ✓ PASS |
| Shared lists, unread, notifications | `integration ai-chat/shared.int` | 17/17 | ✓ PASS |
| Tenant RLS of new tables | `integration packages/db rls-isolation.int` | 20/20 | ✓ PASS |
| OpenClaw plugin | `pnpm --filter @ocw/openclaw-channel test` | 231/231 | ✓ PASS |
| Card renderer and stream reducer | `vitest --project web` (2 files) | 29/29 | ✓ PASS |
| Fake model attribution | `node --test infra/fake-model/attribution.test.mjs` | 12/12 | ✓ PASS |
| Full e2e, metered eval, real cell | — | not run (forbidden or owner-only) | ? SKIP → human |

### Probe Execution

None declared for Phase 6. Not a migration or tooling phase. The real-cell smoke is listed as a human item.

### Requirements Coverage

| Requirement | Status | Evidence |
|-------------|--------|----------|
| MULTI-01 | ✓ SATISFIED | SC1 |
| MULTI-02 | ✓ SATISFIED | SC2. "Device" is recorded as `client_kind` plus `session_id` on `messages`; there is no `device_id`, see Info |
| MULTI-03 | ✓ SATISFIED | Roster, attributed blocks, merged turns, `<turn_context>`, no mid-array system role (guard plus matrix) |
| MULTI-04 | ✓ SATISFIED | `addressedOf`, arbiter, `ai.queue.updated`, queue chip |
| MULTI-05 | ✓ SATISFIED | SC3 |
| MULTI-06 | ✓ SATISFIED | SC3; D-06 extension awaits owner confirmation |
| MULTI-07 | ? NEEDS HUMAN | The fixture and the gated runner exist; no real-model run yet |
| MULTI-08 | ✓ SATISFIED | Specs exist; 06-16 gate 259/0 (not re-run here) |
| AGENT-01 | ✓ SATISFIED | SC5 |
| AGENT-02 | ✓ SATISFIED | Proven with the fake cell; the real-cell proof is a human/CI item |
| AGENT-04 | ✓ SATISFIED | SC5 |

Orphaned requirements: none. Every ID mapped to Phase 6 is claimed by at least one plan.

### Anti-Patterns Found

The scan covered the 173 code files changed since `ce68b47~1`. It found no TBD, FIXME or XXX; no TODO, HACK or placeholder stubs; and no `@ts-ignore` or `any`. Only one migration was added, and the solo-prompt snapshots are unchanged.

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `apps/api/src/modules/chat/index.ts` | 748, 826, 848 | `preHandler: requireUser` → an anonymous malformed body gets 400 before 401 | ℹ️ Info | Pre-existing Phase 4 behaviour. Nothing is read or written. Tracked in `deferred-items.md`; the Phase 6 card routes were fixed in 06-16 |
| `apps/web/components/bots/add-to-channel-dialog.tsx` | — | Lists channels the caller cannot add a bot to (403 toast) | ℹ️ Info | Phase 1/4 surface, tracked in `deferred-items.md` |
| `packages/db/src/schema/app.ts` | 294-295 | Messages store `client_kind`/`session_id`, no `device_id` | ℹ️ Info | The plan's reading of "device" (client and session) is reasonable for web/desktop chat. Revisit if PRD §15 needs the paired device id |
| ADR-0019/0020 Consequences | — | `/participants` capped at 200 unjoined readers; card versions held in cell memory; one follow notification per card | ℹ️ Info | Documented limits, not defects |

### Human Verification Required

1. **Metered spoofing eval (MULTI-07, D-02).** Run the dry run, then the real run with an OpenRouter key (`docs/DEMO.md` › Multiplayer AI chats › Owner checks (1)). Expected: every case passes at least 2/3 on both models.
2. **OpenAI terms (D-01).** Can a member's ChatGPT plan answer in a chat other people read? If not, supersede ADR-0019 §5 so shared chats use org models only.
3. **Visual review (D-08).** Review the Phase 6 screenshots at 1440/390, light/dark. I spot-checked `day-coalesced-1440.png`: it shows a real coalesced answer with "for Alex Moreno · Alex's ChatGPT plan".
4. **Real OpenClaw cell proof (AGENT-02/04).** Run when CI returns: `run-container-smoke.sh` including `SMOKE_ONLY=card`, a flat `ai_chat` mention, the withheld block, and the gate refusing a withheld tool.
5. **D-06 confirmation.** An agent member makes a chat count as shared, which excludes personal instructions. Confirm, or revert one clause in `sharedSql` (`ai-chat/dto.ts:99`) and `participantsOf` (`ai-chat/turn.ts:227`).

### Gaps Summary

There are no real gaps. Every roadmap success criterion is backed by substantive, wired code paths and passing tests. I re-ran the local gate here: `pnpm verify` reproduced 186 files and 2627 tests exactly, and 10 integration files ran one at a time, all green, including security.int 16/16 and cards.int 32/32. The two earlier deferred items (grantee live summaries; regenerate offered to everyone) are resolved in code (`run-loop.ts:305`, `titles.ts:285` → `emitChatUpdated`; `ai-chat-view.tsx:388`). The only open truth is SC4's real-model run, which is the owner's metered eval by design (D-02). With it come four other owner items, none of which is a code defect.

---

_Verified: 2026-10-07T15:57:15Z_
_Verifier: Claude (gsd-verifier)_
