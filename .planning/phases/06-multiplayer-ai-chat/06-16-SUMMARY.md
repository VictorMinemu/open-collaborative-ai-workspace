---
phase: 06-multiplayer-ai-chat
plan: 16
subsystem: api (security sweep, card routes), web (agent card, select), e2e (Phase 6 day, full-run fixes), docs (ADR-0019/0020, AGENTS, DEMO, requirements, validation)
status: complete
tags: [phase-gate, security, multiplayer-ai, agents, agent-cards, adr, e2e]
requires:
  - "06-01 … 06-15 merged on feat/phase-6-multiplayer-ai at 0868158"
provides:
  - "ai-chat/security.int.test.ts: Phase 6 leak sweep, owner/chat/view/revoked/admin/org-B matrix, anonymous 401 sweep over every Phase 6 route and the Agent Channel card routes"
  - "e2e/tests/ai-chat-multiplayer-day.spec.ts: one Phase 6 day on a fresh stack at 1440 and 390"
  - "docs/adr/0019-multiplayer-ai-chats.md and docs/adr/0020-agent-personas-and-agent-cards.md (Accepted)"
  - "AGENTS.md (phases 1–6, 198 lines), docs/DEMO.md Multiplayer AI chats + owner checks, REQUIREMENTS traceability, 06-VALIDATION signed off"
affects: [phase 6 verification, the orchestrator's STATE/ROADMAP/WINDOWS updates]
tech-stack:
  added: []
  patterns:
    - "OpenAPI-driven anonymous sweep plus a per-route actor matrix (expected status and code per actor), run in a fixed actor order so writes happen last"
    - "Leak sweep by planted markers: personal instructions and memory notes must appear only in their own columns"
key-files:
  created:
    - e2e/tests/ai-chat-multiplayer-day.spec.ts
    - docs/adr/0019-multiplayer-ai-chats.md
    - docs/adr/0020-agent-personas-and-agent-cards.md
    - .planning/phases/06-multiplayer-ai-chat/screenshots/day-*.png (31 files)
  modified:
    - apps/api/src/modules/ai-chat/security.int.test.ts
    - apps/api/src/modules/chat/card-actions.ts
    - apps/web/components/chat/agent-card.tsx
    - apps/web/components/ui/select.tsx
    - e2e/tests/{admin-org,admin-members,bots,ai-chat-share-people}.spec.ts
    - AGENTS.md
    - docs/DEMO.md
    - .planning/REQUIREMENTS.md
    - .planning/phases/06-multiplayer-ai-chat/06-VALIDATION.md
    - .planning/phases/06-multiplayer-ai-chat/deferred-items.md
    - .planning/phases/06-multiplayer-ai-chat/screenshots/agent-card-*.png (recaptured)
decisions:
  - "Task 3 checkpoint resolved as 'eval deferred' by the orchestrator under the owner's delegated autonomy: no metered eval, no real provider call; recorded as human_needed (06-VALIDATION, DEMO owner checks)"
  - "D-06 (any agent member makes a chat shared) is recorded as open for the owner's confirmation in ADR-0019 and ADR-0020, not as settled"
  - "ADR numbers 0019 and 0020; no accepted ADR (0001–0018) edited"
  - "Full-run screenshots go to /tmp; only day-* and the recaptured agent-card-* are kept in the phase folder"
metrics:
  duration: "~2h10m"
  completed: 2026-10-07
estimate:
  tokens: 150000
actuals:
  tokens: 27000   # chars/4 over the added lines of the diff, screenshots excluded (≈ 108 000 chars incl. this summary)
  tasks: 3        # Task 3 = checkpoint recorded as "eval deferred"
  commits: 10
---

# Phase 6 Plan 16: Phase 6 gate Summary

Phase 6 is proven end to end on a fresh stack and documented. A new day spec runs it at 1440 and 390: private chat, shared with Alex, Scenario B 1–4, the Backend team at Can view, the queue and one coalesced answer billed to Alex, a persona's reply and approval card, and Alex's approval. The extended security sweep found one real defect: the Agent Card routes answered an anonymous caller with 400 before 401. It is fixed. ADR-0019 and ADR-0020 are accepted. AGENTS.md, DEMO.md, the requirements and the validation are signed off. The full local regression is green: 259 e2e tests passed, 0 failed, 0 flaky. The owner's metered eval and the OpenAI terms check are recorded as **eval deferred** (`human_needed`), not passed.

## Tasks

| Task | Name | Commits |
|------|------|---------|
| 1 (tracer) | Phase 6 day on a fresh stack + leak and access sweep | 4f2fa0c (fix), b18aee0 (sweep), 790a7c1 (card fix), 481fa52 (day spec + screenshots) |
| 2 | ADRs, AGENTS.md, DEMO.md, traceability, validation, full regression | c468d85, 699a112, b33e1a5, 3edb233 (select fix), 0e96adb (full-run fixes), final docs commit |
| 3 (checkpoint, blocking-human) | Owner's metered eval + OpenAI terms | not run: **eval deferred** (`human_needed`) |

## What was built

- **Security sweep** (`ai-chat/security.int.test.ts`, 11 new cases).
  - **Shared session:**
    - Sam is the owner, with personal instructions on and his own plan reconnected through the fake sign-in.
    - Alex holds a `chat` grant and asks on the organization's Anthropic key.
    - Riley holds a `view` grant.
    - Robin is granted, reads, then is revoked.
    - Jo holds a throwaway grant.
    - Two team personas take part: `@scribe` (memory on, with memory notes about Sam and Alex) and `@extra`.
    - The fake cell replies and posts an approval card.
  - **Leak checks:**
    - After the share, no model request carries the instructions, a `personal_instructions` block or a memory note. The shared prompt is proven multiplayer: it has a `<participants>` roster.
    - No cell delivery carries them either, and `turn.memory` is `[]`.
    - The same holds for every frame on `conv:` and the grantees' `user:` topics, and for every response another participant received.
    - The instructions exist only in `app.ai_user_preferences.instructions` and the notes only in `app.agent_memories.text`.
    - None of these hold a plan token, the sign-in secrets, the Anthropic key, the cell token or a provider-key shape (`sk-or-v1-`, `sk-ant-`, `sk-proj-`): responses, frames (Phase 5 and Phase 6), audit rows, logs, and every text or jsonb column of `app.*` and `auth.*`.
  - **Access matrix:** owner / chat / view / revoked / admin without a grant / org-B admin, over these routes:
    - grants: GET, POST, PATCH, DELETE
    - participants: GET
    - agents: POST, DELETE
    - the chat itself: snapshot, page, read marker, send
    - cards: GET, follow, unfollow, decision

    Readers get 2xx. Owner-only routes answer the chat's 404 to everyone else. A view grantee gets 403 `ai_chat_view_only` on a send and on a card decision. The chat grantee decides once, after which the owner gets 409 `card_already_decided`. Nobody without access becomes a member by probing.
  - **Other organizations:** another organization's cell token gets 404 on `POST /cards` and `PATCH /cards/:id`, both as org A's agent and as its own, and the card is unchanged.
  - **Anonymous 401 sweep:** now lists the 12 Phase 6 routes, including `GET /api/v1/cards/{messageId}` (06-15) and `/participants` (06-12, which now lists unjoined readers). The Agent Channel card routes answer 401 with no token, a wrong token, or a user's session.
- **Day spec** (`ai-chat-multiplayer-day.spec.ts`). Fresh colleagues per project (Alex Moreno and Riley Santos on desktop, Alex Navarro and Riley Ortega on mobile). Steps:
  1. Víctor, with personal instructions on, gets a solo answer.
  2. He shares the chat with Alex. The dialog states the disclosure and the personal-instructions note.
  3. Alex writes and the model answers "Hi Alex …" with the participant list, on both pages.
  4. Víctor shares with Engineering › Backend at Can view. Riley reads with no composer, and his presence reaches Víctor.
  5. Víctor's slow answer streams. Alex and Víctor both ask, and both show as Queued. The chip says "AI is answering Víctor Ruiz · Alex … and Víctor Ruiz are next".
  6. One coalesced answer comes: "Hi Alex … and Víctor Ruiz! …". The footer says "for Alex … · Alex's ChatGPT plan", and "for you · your ChatGPT plan" on Alex's page.
  7. Víctor adds @backend from the participants list. The notice appears on all three pages.
  8. Alex @mentions @backend from the suggestions, with Ask AI off. The fake cell receives a flat `ai_chat` mention with no memory, replies, and posts an approval card. All three pages show it, and the chat model never answers.
  9. Riley sees Follow but never Approve. His forced API decision gets 403 `ai_chat_view_only`.
  10. Alex approves after a confirmation that names the card. Every page shows "Approved by Alex …", and the cell receives `agent.card_action.v1` once.
  11. The API's participants list agrees: the audience is `units`, Riley has `view` and the persona `agent`.

  Victor's preferences are restored and @backend is deleted at the end.
- **Docs.**
  - **ADR-0019:** grants decide (`aiAccessSql`); the permission split; live revocation; the prompt format and why; requester pays, with NEEDS VALIDATION on OpenAI's stance; the arbiter and derived queue; context safety; the eval policy. Open items: D-06 and the real-cell proof.
  - **ADR-0020:** unit-scoped personas and lead rights; personas in AI chats through OpenClaw only; Agent Cards with server-decided actions; `ocw_agent_card`. Open: the real-cell proof and D-06.
  - **AGENTS.md:** phases 1–6, two stack rows (0019, 0020), and the multiplayer and Agent Channel rules. 198 lines, GSD blocks untouched.
  - **DEMO.md:** a "Multiplayer AI chats (Phase 6)" section, the owner checks (dry run, then the metered eval command, the OpenAI terms, the visual review, the D-06 confirmation), the open items and two troubleshooting rows.
  - **REQUIREMENTS.md:** MULTI-01…08 and AGENT-01/02/04 are Delivered, with plans and tests. MULTI-07 reads "fixture + opt-in run; metered run deferred; CI awaits Actions billing". Counts: 86 Delivered, 31 Partial, 25 Pending.
  - **06-VALIDATION.md:** `status: validated`, `nyquist_compliant: true`, `wave_0_complete: true`, every task row filled, and the gate run recorded. The manual rows are `human_needed` or open.

## Gate results (all local; CI unavailable)

| Command | Result |
|---------|--------|
| `vitest --project integration ai-chat/security.int.test.ts` | **16/16** (5 Phase 5 + 11 new). RED first: anonymous `POST /cards/{id}/decision` → 400 |
| `vitest --project integration agent-channel/cards.int.test.ts` | **32/32** (after the hook change) |
| `e2e-isolated.sh --rebuild-web ai-chat-multiplayer-day` | **3/3** (setup, desktop, mobile); with `agent-cards` after the card fix **7/7** |
| `pnpm verify` (last run, on `0e96adb`) | exit 0: lint (4 pre-existing local-runtime warnings), typecheck 8/8, **185 files, 2,624 tests** |
| `pnpm typecheck --force` | **8/8**, 0 cached |
| `pnpm --filter @ocw/openclaw-channel test` | **16 files, 231/231** |
| `node --test 'infra/**/*.test.mjs'` | **130/130** |
| `node --test 'scripts/**/*.test.mjs'` | **4/4** |
| `pnpm --filter @ocw/local-runtime test` (temp HOME) | **17 files, 286/286** |
| `env -u ELECTRON_RUN_AS_NODE pnpm --filter @ocw/desktop test` (temp HOME) | **11 files, 88/88** |
| `vitest --project web` | **16 files, 220/220** |
| Full e2e `e2e-isolated.sh --rebuild-web`, run 1 | 251 passed, 6 failed, 2 skipped, 2 did not run (causes below) |
| Full e2e `e2e-isolated.sh --rebuild-web`, run 2 (final) | **259 passed, 2 skipped, 0 failed, 0 flaky** in 29.9 min; skips by design (`attachments-api`, `realtime-latency` are desktop-only) |
| Subset between runs (`admin-members admin-org agent-cards agent-personas ai-chat-multiplayer ai-chat-share-people bots.spec`) | 38 passed, 1 failed (admin-org's second Lena, then fixed) |

Integration files were run one at a time. The full e2e ran alone on the machine. No real provider, OpenRouter, OpenAI or SearXNG was called, and no OpenClaw container was started. The demo was untouched: `ocw-demo-*` and the `t3code-81d72154-*` containers kept their uptimes, and the e2e used its own `ocw_e2e` database, Redis DB 9 and the `ocw-e2e-storage` Garage.

## Deviations from Plan

### Auto-fixed issues

1. **[Rule 1 - Security] The Agent Card routes validated the body before authenticating.**
   - Found by: the extended anonymous sweep.
   - Problem: `POST /api/v1/cards/{messageId}/decision` answered an anonymous malformed body with 400. ADR-0018 §13 and ADR-0020 require 401 first.
   - Fix: `chat/card-actions.ts` now uses `onRequest: requireUser`, as every AI chat route does.
   - Commit: `4f2fa0c`. Proven by the sweep and by cards.int 32/32.
2. **[Rule 1 - UI] An Agent Card's decision line hid the decider's name at 390.**
   - Found by: the day screenshot review ("Approved by Alex Na…").
   - Fix: the line wraps; the time follows inline.
   - Commit: `790a7c1`. The `agent-card-*` captures were re-taken.
3. **[Rule 1 - UI] Select popups overflowed the viewport.**
   - Found by: full run 1, where agent-personas failed on mobile.
   - Problem: with many members, the persona owner picker opened above the trigger and past the top of the screen, so most people could not be picked.
   - Fix: `components/ui/select.tsx` caps the popup at `--available-height` and scrolls it. This is a shared primitive; the whole full e2e passed after it.
   - Commit: `3edb233`.
4. **[Rule 3 - Tests] Specs tripped over each other's data in the first full run since Phase 5.**
   - The day and share-people specs now pick exactly Engineering › Backend; admin-org leaves "Backend <suffix>" teams behind.
   - bots.spec now adds the bot to `#general`; 06-15's `backend-*` channel is one the admin cannot add to.
   - admin-members finds the admin's own row by e-mail; there is a second "Víctor Ruiz".
   - admin-org removes unit personas before clearing units (409 `unit_has_bots`) and searches Lena by her whole name (agent-personas adds "Lena Ortega").
   - Commit: `0e96adb`. No security assertion was changed.

### Process deviations

5. **The full-regression e2e screenshots went to `/tmp/ocw-06-16-shots`, not the phase folder.** A full run writes every phase's captures, so it would have flooded `screenshots/`. Only `day-*` (31 files) and the recaptured `agent-card-*` are committed. `setup-*` captures were dropped from the commit.
6. **The RED runs were observed but not committed separately.** The security test and the card fix were committed in that order (fix `4f2fa0c`, then test `b18aee0`), so `pnpm verify` is green at every commit, as the orchestrator required. The RED run is recorded above.
7. **Task 3 was not run.** As instructed, the orchestrator recorded it as "eval deferred". The metered eval and the OpenAI terms check are `human_needed` in 06-VALIDATION, with steps in DEMO.md. Nothing is marked passed.
8. **The acceptance grep for provider keys** (`git grep … sk-ant-…`) prints matches. All of them are pre-existing fake fixtures in test files (e.g. `sk-ant-e2e-fake-key-not-real-0000`, `sk-ant-…-SECRET-0123456789-…`). The 06-16 diff adds no key-shaped string (checked over `git diff 0868158..HEAD`).

## Checkpoint (Task 3): eval deferred

- **Resume signal (from the orchestrator, under the owner's delegated autonomy):** "eval deferred".
- **Metered spoofing eval:** not run, nothing spent.
- **OpenAI's stance on a member's ChatGPT plan answering in a shared chat:** not checked. NEEDS VALIDATION stays in ADR-0019 §5.
- **Recorded as:** `human_needed` in 06-VALIDATION (`manual_pending: human_needed`, Manual-Only rows).
- **Owner steps:** in `docs/DEMO.md` › Multiplayer AI chats › Owner checks (1) and (2).

## Open items

- **Owner: the metered spoofing eval** (dry run first, ≈ $0.15–0.40) **and OpenAI's terms** for a ChatGPT plan answering in a shared chat. A negative answer means a new ADR superseding ADR-0019 §5, with org models only in shared chats.
- **D-06 awaits the owner's confirmation.** A chat with any agent member counts as shared, so the owner's personal instructions are excluded. The orchestrator decided this under the owner's delegated autonomy in 06-12. Reverting it is one clause in `sharedSql` / `isShared`.
- **Real OpenClaw cell proof is pending.** CI is blocked by GitHub billing. Still to run when CI comes back:
  - the real-cell smokes (`run-container-smoke.sh`, including `SMOKE_ONLY=card`)
  - a flat `ai_chat` mention
  - the withheld block
  - the gate refusing a withheld tool
- **The CI run of `ai-eval.yml`** waits for Actions billing and the `OCW_EVAL_API_KEY` secret.
- **Owner visual review** of `multiplayer-*`, `share-*`, `shared-*`, `participants-*`, `personas-*`, `ai-chat-agent-*`, `agent-card-*` and `day-*`.
- **Carried from 06-12/14/15** (in the ADRs' Consequences):
  - `/participants` lists at most 200 unjoined readers.
  - A grantee's chip says "N people" for unit grants.
  - Card versions live in the cell's memory.
  - Followers are notified once per card.
  - The inbox shows no card title.
  - Pins and Saved show a card as its summary.
- **New in `deferred-items.md`:**
  - Phase 4 chat routes still authenticate in `preHandler` (400 before 401 for a malformed anonymous body).
  - Bots › Add to channel lists channels the caller cannot add a bot to.

## Known Stubs

None.

## Threat Flags

None. No new route or trust boundary. The fix narrows an existing one: the card routes reject anonymous callers before parsing the body.

## Broken-windows ledger (not written by this executor; for the orchestrator)

- `--kind unrun-verify --phase 06 --file .planning/phases/06-multiplayer-ai-chat/06-16-PLAN.md --description "06-16 Task 3: metered spoofing eval and OpenAI ChatGPT-plan terms check not run (eval deferred, human_needed)"`
- `--kind unrun-verify --phase 06 --file infra/openclaw/test/run-container-smoke.sh --description "Phase 6 personas in AI chats and ocw_agent_card not proven against a real OpenClaw cell (CI billing)"` (already proposed by 06-14; keep one entry)
- `--kind deviation --phase 06 --file apps/api/src/modules/chat/index.ts --description "Phase 4 chat routes authenticate in preHandler: anonymous malformed bodies get 400 before 401 (card routes fixed in 06-16)"`
- `--kind deviation --phase 06 --file apps/web/components/bots/add-to-channel-dialog.tsx --description "Add to channel lists channels where the caller gets 403; bots.spec now picks #general"`

## TDD Gate Compliance

- **Security sweep:** RED was observed (the 400 on the decision route) before the fix. Both were committed with the fix first, to keep `pnpm verify` green at every commit.
- **Day spec:** a gate spec over existing behaviour. It passed on its first run; its first full-run failure was a test race, fixed in `0e96adb`.

## Self-Check: PASSED

- Files exist: `e2e/tests/ai-chat-multiplayer-day.spec.ts`, `docs/adr/0019-multiplayer-ai-chats.md`, `docs/adr/0020-agent-personas-and-agent-cards.md`, and 31 `screenshots/day-*.png` (at least 4 required).
- Commits on `wt/06-16`: `4f2fa0c`, `b18aee0`, `790a7c1`, `481fa52`, `c468d85`, `699a112`, `b33e1a5`, `3edb233`, `0e96adb`.
- Acceptance greps:
  - `/grants` is in security.int.
  - Both ADRs have `## Status` with "Accepted".
  - "NEEDS VALIDATION" is in ADR-0019.
  - `eval:multiplayer` is in DEMO.md.
  - `nyquist_compliant: true` is in 06-VALIDATION.
  - `wc -l AGENTS.md` = 198.
- The `.env` symlink was removed. The demo was not touched.
