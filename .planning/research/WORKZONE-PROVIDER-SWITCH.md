# Work Zone: switch provider inside the same session (research, 2026-10-05)

**Question:** a Work Zone session started on Claude Code (Agent SDK, user's Claude subscription) continues on Codex (`codex app-server`, user's ChatGPT subscription), or the reverse, with continuity.
**Recommendation:** a **platform-side handoff**. Park the old runtime. Build a deterministic, sanitised **handoff pack** from *our* persisted event log, plus fresh git state from the device. Start a **fresh** session on the new runtime and seed it through the best channel that runtime offers: `thread/inject_items` on Codex, a first-turn prefix on Claude. An optional "handoff note" written by the outgoing runtime is the only way to carry its private reasoning. Native cross-vendor import is not viable for live sessions. T3 Code reached the same design and calls it "lossy" [T1][T2].

## 0. Repo facts (what we have to build from)

- Neutral log: `SessionEvent` (`packages/contracts/src/session-events.ts`) persists `assistant.message` (full text), `tool.started{name,summary}`, `tool.completed{ok,summary,output}`, `approval.*`, `prompt.*`, `runtime.raw`. Prompts with author live in `WorkPrompt` (`work-session.ts`). The diff comes from `GET /diff` (`WorkSessionDiff`).
- Lossy already: tool output is capped at **4 KB** on the device (`TOOL_OUTPUT_MAX_BYTES`, `apps/local-runtime/src/claude/mapper.ts:9`). Claude thinking blocks are dropped (`claude/mapper.ts:184`). Codex reasoning and plan deltas are ignored (`codex/mapper.ts:28-31`). Sub-agent detail is collapsed. Everything is redacted and contained.
- Codex tool names are already normalised to `Bash`/`Edit`/`mcp__s__t` (`codex/mapper.ts` `toolNameForItem`), so the trail reads the same for both runtimes.
- `work_sessions.runtime` is a fixed enum column, with one `runtime_session_id` (`packages/db/src/schema/app.ts:~725,~748`). Resume is native only: `resumeRuntimeSessionId` → SDK `resume` / Codex `thread/resume` (`claude-runtime.ts`, `codex-runtime.ts`). Nothing models a runtime change today.
- `AgentRuntime` (`apps/local-runtime/src/runtime.ts`) has no "seed history" hook. Both adapters already enforce the same permission modes (`default|acceptEdits|plan`) and the same secret-path policy (`claude/tool-policy.ts`, reused by Codex).

## 1. What transfers vs what cannot

| Context | Transfer? | How |
| --- | --- | --- |
| User prompts (with author) and assistant final texts | Yes | From our log (`WorkPrompt` + `assistant.message`), attributed structurally |
| Tool calls and results | As a **text trail** only | `name + summary + ok + truncated output`. Never as native tool_use/function_call items: foreign formats leak and weaker models mimic them [O1] |
| File edits / current tree | Yes, **re-read live** | `git status`, the diff stat and branch/HEAD from the device at switch time. The tree itself is the source of truth; no need to replay edits |
| Plan / todo state | Partial | Claude `TodoWrite` survives as a tool summary. Codex plan items are not normalised yet (gap). T3 carries "the latest unimplemented plan" [T1] |
| Pending approvals | **No** | Settle them as `deny` ("session switched") before parking. "Allow for session" grants are **not** carried over (least privilege) |
| Queued prompts | Yes | They stay in the platform queue and dispatch to the new runtime |
| Project instructions | Re-loaded natively | Claude reads CLAUDE.md, or AGENTS.md when no CLAUDE.md exists [C3]. Codex reads AGENTS.md, plus `project_doc_fallback_filenames` (e.g. `CLAUDE.md`, 32 KiB cap) [X3]. Do not paste them into the pack |
| MCP / skills config | Re-resolved by the platform | Same effective MCP set from the Control Plane. Not from either vendor's local config |
| Images / attachments | Needs a decision | Not in the event log today. T3 drops them [T2] |
| Open questions / last assistant ask | Yes | It is the last `assistant.message` |
| Thinking / reasoning | **No** | Claude thinking is signed and readable only by certain Claude models [C2]. OpenAI reasoning `encrypted_content` is opaque and decrypted only by OpenAI [O2]. We never persist either |
| Provider session/thread ids, prompt caches, compaction summaries, undo checkpoints | **No** | Vendor-internal. Codex `compaction` items carry `encrypted_content` (`ResponseItem`, codex 0.160.0 schema). The SDK `forkSession` drops file-history snapshots (`sdk.d.ts:824-835`) |

## 2. Mechanisms checked

**Codex app-server (installed `codex-cli 0.160.0`; schema via `codex app-server generate-ts [--experimental]`):**
- `thread/inject_items {threadId, items: ResponseItem[]}`: "Append raw Responses API items to a loaded thread's model-visible history without starting a user turn" [X1]. The docs list it under `experimentalApi`, **but** it is in the stable-generated schema. A local probe (ephemeral read-only thread, no model call) returned `{}` with `experimentalApi: false` **and** `true`. It accepts `message` items with role `user`/`assistant`(`output_text`)/`developer`, so it can seed real assistant turns. Not yet proven: that the model *uses* the injected items on the next turn.
- `thread/resume` accepts `history: ResponseItem[]` or `path`. Both are **experimental** and `history` is marked "[UNSTABLE] FOR CODEX CLOUD - DO NOT USE" (experimental `v2/ThreadResumeParams.ts`). Rejected.
- `thread/fork` (by `lastTurnId`) and `thread/compact/start` work within Codex only [X1].
- `externalAgentConfig/detect|import` with item type `SESSIONS` (`SessionMigration{path,cwd,title}`) imports **Claude Code session files** from disk [X1][X2]. It is a one-shot migration of whole local files: absolute paths, the owner's home dir, no redaction, no attribution, not our log. **Rejected** for live switching (principles 1 and 7).

**Claude Agent SDK 0.3.282** (`node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.3.282*/.../sdk.d.ts`):
- `resume`, `forkSession`, `resumeSessionAt`, `sessionId` (lines ~1706, 2084-2098) and `forkSession()` / `getSessionMessages()` (lines 835, 899) all work on **Claude's own JSONL transcripts**. No API imports foreign history.
- `sessionStore` (`@alpha`, line 1826) mirrors and materialises transcripts, but entries are opaque internal JSONL (`SessionStoreEntry`, line 6531). Synthesising them would forge an undocumented format: fragile, so **rejected**.
- `SDKUserMessage` is **user-role only** (line 6137). `shouldQuery: false` "appended to the transcript without triggering an assistant turn… merged into the next user message" (line ~6180). `systemPrompt: {type:'preset', preset:'claude_code', append}` (line 2400). Do **not** set `client_composed`: it skips the CLAUDE.md/rules attachment pass (line ~6190).
- So on Claude the pack is user-side context (a prefix or a `shouldQuery:false` message), never real assistant turns.

**Prior art:** T3 Code stops the old provider session, starts a fresh one "with no resume cursor", and "the first turn is prefixed with a transcript handoff": user/assistant messages plus a tool/command trail, budgeted to a share of the target context window, keeping the newest history and the opening request. Its own docs call it "lossy" and recommend delegating to another harness instead [T1][T2][T3]. T3 bug #4766: a provider switch silently lost the resume cursor; the fix is to warn when a thread with turns starts with no cursor [T4]. OpenClaw #15043: foreign tool-call formats in history made the new model mimic them; the fix is to summarise tools as text [O1]. OpenCode, Cursor and Aider switch *models* under one harness, so the tool history stays native. That case is not comparable to ours (harness changes too).

## 3. Differences that matter

- **Tools:** Claude `Edit/Write/Bash/TodoWrite` vs Codex `apply_patch`/shell/plan. The trail must stay neutral prose ("ran `pnpm test` → failed (exit 1): …", "edited `src/a.ts` (+12/−3)").
- **Approvals/sandbox:** Claude uses `canUseTool` + deny rules. Codex uses `on-request` + `workspace-write`/`read-only` (plan). The same `PermissionMode` maps cleanly in both adapters. Never escalate on a switch.
- **Context windows:** both report them (`ModelUsage.contextWindow`, `sdk.d.ts:1440`; Codex `ThreadTokenUsage.modelContextWindow`). Budget the pack to a share of the target window (T3 uses 128k when unknown [T1]).
- **Steer:** Codex supports it, Claude queues (`RuntimeCapabilities`). The UI must re-read capabilities after a switch.
- **Billing:** each side runs on the *switching user's* local login. Our adapters strip API keys by default.

## 4. Constraints

1. **One execution authority.** The switch is an arbiter transition on the session row lock: `idle` (or interrupt) → settle approvals → `stop()` the old runtime → `start()` the new one on the **same cwd/worktree/branch**. Never run both at once. Refuse the switch while a turn is running unless the user interrupts it.
2. **BYO subscription.** The target runtime must be `installed && loggedIn` on the session's device (`RuntimeInfo`). Switching to a different device is out of scope (needs a working-tree transfer).
3. **Privacy.** The pack sends content produced under vendor A, including other collaborators' prompts, to vendor B. Gate it behind an org/project policy (`workSession.switchRuntime` permission, plus an allowed-runtimes list in the intersected policy) and show a confirmation that names the destination vendor. Build the pack only from already-redacted, repo-relative events (principles 7 and 8).
4. **Audit.** Emit `work_session.runtime_switched{from,to,actor,device,packHash,eventsIncluded,truncated}`, plus a durable `runtime.switched` session event so the timeline shows the boundary.

## 5. Proposal

**Flow**
1. User picks "Continue with Codex" in the session header. API checks permission, policy, device capability and session state.
2. API (arbiter) marks the session `switching`, interrupts or waits, denies pending approvals, sends `session.stop`, and clears `runtime_session_id` (archive the old one in `runtime_history` for a possible switch back).
3. API builds the **handoff pack** (pure function in `packages/contracts` or the API module, unit-tested). It has: a header (project, branch, "you are continuing a session started on X"), the participant roster, the opening request, the newest N turns (attributed prompts + assistant texts + tool trail), the last plan/todo, and open questions. Budget it to about 30-40% of the target window, keep the newest history and the opening request, and state how much was omitted.
4. Device, on `session.start{runtime: codex, handoff}`: fetch live git status, branch and HEAD, and append them to the pack locally (repo-relative). Then seed. **Codex:** `thread/start`, then `thread/inject_items` with a `developer` header message, the user/assistant text pairs, and the tool trail as text. **Claude:** `query()` with `systemPrompt.append` (short header) plus the pack as a `shouldQuery:false` user message (fallback: prefix of the first prompt).
5. New `session.started{runtime, runtimeSessionId}` → API stores the new id and audits. The queue resumes.
6. Optional "handoff note": before step 2, if the old runtime is online, run one extra turn on it ("summarise state, decisions, next steps for another agent"). This costs one turn of the *old* subscription and some seconds. It is the only way to carry intent the old agent never wrote out. Off by default.

**Technical requirements:** contracts (`SwitchRuntimeRequest`, `runtime.switched` event, `handoff` field on `SessionStartPayload`). DB: `runtime` becomes mutable plus a `work_session_runtimes` history (migration, so plan mode is required). `AgentRuntime.start()` gains `seed?: HandoffPack`. Codex adapter adds `thread/inject_items` (regenerate types; the `generated/` dir is a subset). Claude adapter adds the `shouldQuery:false` seed. Mapper gap: normalise Codex `plan` items and Claude `TodoWrite` into one plan event. Fixtures recorded for the seeded first turn on both runtimes.

**Limitations:** no reasoning, caches or compaction state carry over. Tool outputs carry at most 4 KB. The first turn after a switch is cold (no prompt cache, larger input). Prompt-cache warmth and per-turn rollback do not span the boundary [T3]. Switching back to the original runtime *can* resume natively (keep its old id), but it will not see turns made on the other runtime unless those are seeded too.

**Pending decisions:** (1) Is the switch a new runtime in the *same* `WorkSession` (recommended) or a linked child session? (2) Policy default: switch allowed or org opt-in? (3) Ship the handoff note in v1? (4) Switch back: native resume + delta seed, or always a fresh pack? (5) Images: drop (T3) or persist as artifacts and re-attach?

## 6. Confirmed vs needs validation

**Confirmed (source):** `thread/inject_items` exists and is accepted without `experimentalApi` on codex 0.160.0 (local probe, schema) [X1]. Resume-by-history is experimental and "DO NOT USE" (generated schema). Codex can import Claude Code sessions from disk (`SessionMigration`) [X1][X2]. The Claude SDK has no foreign-history import; user-only messages; `shouldQuery:false` and `systemPrompt.append` exist (`sdk.d.ts`). Thinking signatures are not portable across vendors [C2]. Encrypted reasoning is OpenAI-only [O2]. Codex reads `CLAUDE.md` only via fallback config [X3]. Claude reads AGENTS.md only without a CLAUDE.md [C3]. T3's approach and its "lossy" caveat [T1-T3]. Tool-format mimicry risk [O1].
**Needs validation:** (a) the model actually uses `inject_items` content on the next `turn/start`; the docs say "model-visible", but one recorded fixture is needed (it costs one subscription turn). (b) Injected items persist across `thread/resume` after a daemon restart (doc says "persisted to the rollout"; not tested). (c) `shouldQuery:false` merge behaviour with the streaming-input queue in our adapter. (d) Pack quality: an eval with 5 to 10 real sessions, switch then "what were we doing?" both directions. (e) Whether the docs will gate `inject_items` behind `experimentalApi` in later versions (pin and fixture-test). (f) `project_doc_fallback_filenames` can be passed per thread via `config` on `thread/start`.

## Sources

- [T1] T3 Code PR #14197 (closed): https://github.com/pingdotgg/t3code/pull/14197; [T2] T3 nightly 0.0.46 notes: https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610; [T3] T3 PR #3799: https://github.com/pingdotgg/t3code/pull/3799; [T4] T3 issue #4766: https://github.com/pingdotgg/t3code/issues/4766
- [X1] Codex App Server docs: https://learn.chatgpt.com/docs/app-server, plus `codex app-server generate-ts` output (0.160.0); [X2] Codex migration overview: https://codex.danielvaughan.com/2026/05/13/codex-cli-agent-migration-system-import-claude-code-sessions-skills-config/; [X3] AGENTS.md config: https://learn.chatgpt.com/docs/agent-configuration/agents-md
- [C2] Claude thinking (encryption, model switching): https://platform.claude.com/docs/en/build-with-claude/thinking; [C3] Claude Code memory / AGENTS.md: https://code.claude.com/docs/en/memory
- [O1] OpenClaw issue #15043: https://github.com/openclaw/openclaw/issues/15043; [O2] OpenAI reasoning (encrypted_content): https://developers.openai.com/api/docs/guides/reasoning
