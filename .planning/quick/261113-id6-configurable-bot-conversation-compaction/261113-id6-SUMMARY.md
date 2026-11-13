---
quick_id: 261113-id6
slug: configurable-bot-conversation-compaction
date: 2026-11-13
type: fix
status: complete
subsystem: bot-capabilities, openclaw-channel
tags: [bots, openclaw, compaction, bot-policy, migration, settings]
key-files:
  created:
    - packages/db/drizzle/20261113182003_bot_policy_conversations/migration.sql
    - apps/openclaw-channel/src/conversation-compaction.test.ts
    - docs/self-hosting/bot-conversations.md
  modified:
    - packages/contracts/src/bot-capabilities.ts
    - packages/contracts/src/agent-channel.ts
    - packages/db/src/schema/app.ts
    - apps/api/src/upgrade.int.test.ts
    - apps/api/src/modules/bot-capabilities/policy.ts
    - apps/api/src/modules/agent-channel/index.ts
    - apps/openclaw-channel/src/agent-channel-protocol.ts
    - apps/openclaw-channel/src/reconciler.ts
    - apps/openclaw-channel/src/openclaw-port.ts
    - apps/openclaw-channel/src/openclaw-sdk.d.ts
    - apps/openclaw-channel/src/bridge.ts
    - apps/openclaw-channel/src/testing/fake-agent-channel-api.ts
    - infra/openclaw/render-config.mjs
    - apps/web/components/settings/bot-policy-settings.tsx
    - docs/INSTALL.md
decisions:
  - "Recovery uses OpenClaw's public deleteSessionEntry (openclaw/plugin-sdk/session-store-runtime, transcript archived), loaded with a literal dynamic import like gateway-runtime; no session-key rotation needed."
  - "The bridge recovers once per turn, only before the model ran (WR-01: a run with a tool call is never re-dispatched) and only while nothing was posted; the retry is a new attempt (inbound id eventId:attempt) outside the normal retry budget."
  - "The reconciler manages compaction only when the caller passes the current block (the real port always does); owned keys only, other OpenClaw compaction keys are kept and never cause a write."
  - "render-config pins the same lenient defaults (incl. keepRecentTokens 20000) so the first sync of a cell without an admin choice writes nothing."
---

# Quick 261113-id6: configurable bot conversation compaction, and recovery when it fails

An admin now chooses in Settings › Bot policy › Conversations how long bot conversations are summarized: Strict
summaries (default off), Keep exact identifiers (off), Recent history kept (20 000 tokens, 2 000 to 100 000) and Start a
fresh session when a summary fails (on). The cell boots with the lenient defaults, so the production DM stuck on
"Context is too large and auto-compaction could not recover this turn" (quality guard `guard_blocked`) summarizes again;
if a summary still fails, the bot starts that session over once and answers from the chat window.

## OpenClaw keys confirmed in `ocw-openclaw:local` (2026.9.7)

| Key | Evidence |
| --- | --- |
| `agents.defaults.compaction` | `zod-schema-BRat_tFr.mjs:91` `AgentDefaultsSchema`, `:166` `compaction: object({` |
| `compaction.mode` `"default" \| "safeguard"` | `zod-schema-BRat_tFr.mjs:170` |
| `compaction.keepRecentTokens` int positive | `zod-schema-BRat_tFr.mjs:180`; read in `agent-settings-r6upqdTw.mjs:17`; default `2e4` in `compaction-DXVbohZE.mjs:403` |
| `compaction.identifierPolicy` `"strict" \| "off"` | `zod-schema-BRat_tFr.mjs:182`; runtime default strict `builtin-openclaw-C3TPPZUQ.mjs:16152` |
| `compaction.qualityGuard.enabled` | `zod-schema-BRat_tFr.mjs:186-191` (comment "Default: false"); runtime `qualityGuardCfg?.enabled ?? true` at `builtin-openclaw-C3TPPZUQ.mjs:17249` |
| `compaction.memoryFlush.enabled` | `zod-schema-BRat_tFr.mjs:214` |
| `mode` defaulted to safeguard when unset | `validation-core-CniWjnAE.mjs:542-559` `applyCompactionDefaults` |
| Failure texts | `commentary-progress-owner-BjXHlbFf.mjs:103` ("Context is too large and auto-compaction could not recover this turn." / "…timed out before it could finish."), `agent-runner.runtime-BCfOL1BB.mjs:937` ("Auto-compaction could not recover this turn.") |
| `deleteSessionEntry` | exported by `dist/plugin-sdk/session-store-runtime.js` (package.json export `./plugin-sdk/session-store-runtime`), body `session-store-runtime-CKTYUFii.mjs:342` (`{ sessionKey, agentId?, storePath?, env?, archiveTranscript?, expectedSessionId?, expectedUpdatedAt? } → Promise<boolean>`); `import("openclaw/plugin-sdk/session-store-runtime")` from `/app` resolves to a function |

No field was dropped: every key exists.

## Changes

1. **Contracts:** `BotConversationPolicy`, `DEFAULT_BOT_CONVERSATIONS`, `BOT_CONVERSATION_LIMITS`; `BotPolicy.conversations`
   (required), merged per field by `UpdateBotPolicyRequest`; `CellSnapshot.conversations` additive with defaults.
2. **DB:** four `bot_policies` columns with constant defaults and `bot_policies_conversation_keep_recent_tokens_check`
   (2000..100000); migration `20261113182003_bot_policy_conversations` (additive), in `HEAD_ONLY`.
3. **API:** `loadPolicy`/`savePolicy` read, merge and store them; audit keys `conversations.<field>`; the cell is
   notified (`policy.updated`) as before; `GET /cell` sends `conversations`. The route keeps its admin-only authz.
4. **Plugin:** `render-config.mjs` boot compaction `{ mode: safeguard, qualityGuard.enabled false, identifierPolicy off,
   keepRecentTokens 20000, memoryFlush.enabled false }`; the reconciler owns those keys from the snapshot (no write when
   equal, other keys kept); the port's `resetSession` deletes the turn's session entry in its lane (transcript archived,
   session key logged); the bridge drops the compaction-failure text, resets, dispatches the turn once more
   (`eventId:attempt`), and on a second failure posts "This conversation got too long for me to summarize, so I started
   over with only its recent messages, and that failed too. Try again in a new thread." A reset that fails posts "This
   conversation got too long for me to summarize. Try again in a new thread." Off, a port without `resetSession`, or a
   run whose model already ran: the text passes through unchanged.
5. **Web:** "Conversations" section after Long tasks (switch rows with hints, 44 px number field on phones, inline
   range error disables Save); `toPolicyBody` sends only changed fields.
6. **Docs:** `docs/self-hosting/bot-conversations.md` (no self-hosting page documented the bot policy before), linked
   from `docs/INSTALL.md`.

## Commits

| Commit | Subject |
| --- | --- |
| 5dabdb2c | test(contracts): failing tests for the bot conversations policy |
| 5a1f98a1 | feat(contracts): BotPolicy.conversations and its cell snapshot field |
| 4c9be6c0 | test(api): failing integration tests for the conversations bot policy |
| a9a919f7 | feat(db): bot_policies conversation summary columns (additive migration) |
| e0eaec52 | feat(api): the bot policy reads, saves and audits conversations, and GET /cell sends it |
| 8e0d1ce8 | test(openclaw-channel): failing tests for conversation compaction and fresh-session recovery |
| 1bc30e4d | feat(openclaw-channel): apply the conversations policy to compaction and recover a failed summary |
| e8c13bd0 | style: biome format of the conversations policy changes |
| a5a8920a | test(web): failing tests for the Conversations section of the bot policy |
| b683ae1c | feat(web): Conversations section in Settings › Bot policy |
| 1fa0d6ec | docs: long bot conversations, the four Conversations settings and their OpenClaw keys |
| 4031489f | style(db): biome format of the bot_policy_conversations snapshot |

## Verification

Root vitest config, ephemeral PostgreSQL/Redis only:

| Suite | Result |
| --- | --- |
| unit + web: `packages/contracts`, `apps/api/src/modules/bot-capabilities`, `apps/api/src/modules/agent-channel`, `apps/openclaw-channel`, `apps/web/components/settings` | 99 files, 2241 tests passed |
| integration `apps/api/src/modules/bot-capabilities` + `apps/api/src/upgrade.int.test.ts` | 7 files, 118 tests passed |
| integration `apps/api/src/modules/agent-channel` (3 batches) | 53 files, 997 tests passed (380 + 289 + 328) |
| unit + integration `packages/db` | 19 files, 252 tests passed |
| `node --test infra/openclaw/*.test.mjs` | 33 tests passed (render-config 20) |
| `pnpm lint` | clean (4 pre-existing warnings in untouched `apps/local-runtime`) |
| `pnpm typecheck` | 11/11 tasks successful |
| `pnpm guard` | semgrep, licenses, fields, codeowners ok |

Not run: e2e (no spec asserts the policy shape or the Conversations copy, none changed), the real-container OpenClaw
test, and a browser check of the new section (no local stack; the owner's demo is off limits). The section reuses the
Long tasks field and the existing card/row styles.

## Deviations from Plan

- **[Rule 1 - Test bug] Fixture:** the new bridge tests' DM event first had `thread.rootMessageId: null`, which the
  mirror schema refuses (the event was skipped); fixed to a string in the feat commit 1bc30e4d.
- **Reconciler opt-in:** compaction is planned only when the caller passes `current.compaction` (the real port always
  does, `null` when absent). Without this every existing `planReconcile({}, cell)` test would have reported a change;
  no existing expectation changed.
- **Retry budget:** the recovery dispatch does not count against `dispatchAttempts` (it also runs at
  `dispatchAttempts: 1`); a generic failure on the recovery attempt still follows the normal budget.
- **Docs location:** a new page, since no self-hosting page documented the bot policy.

No existing test expectation was changed.

## Known Stubs

None.

## Self-Check: PASSED

All files listed above exist; all twelve commits are on `fix/bot-worktree-without-git`.
