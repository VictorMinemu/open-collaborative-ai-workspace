# @ocw/openclaw-channel

OpenClaw (pinned `2026.9.7`) native channel plugin. Each OCW bot becomes an OpenClaw agent, and the
plugin is their bridge to the workspace. The plugin talks only to the **Agent Channel API v1**
(AGENTS principle 9). It never connects to the database, Redis or `/api/v1`. License: Apache-2.0.

**Contract:** the canonical source is `packages/contracts/src/agent-channel.ts` together with
`.planning/phases/01-mvp-0-multiplayer-ai-chat-slice/01-AGENT-CHANNEL-API.md`.
`src/agent-channel-protocol.ts` is a TEMP mirror of it; swap in `@ocw/contracts` once this package
is in the workspace.

## How it works

1. **Start (`gateway.startAccount`): sync the cell.**
   - Calls `GET /cell` and reconciles `models.providers.<id>` and `agents.entries.ocw-<botId>` through
     `runtime.config.mutateConfigFile`. The changes are hot-applied without restarting the account.
     Verified on a real 2026.9.7 gateway, so no supervisor or restart script is needed.
   - Each agent entry gets the bot's `modelRef`, its name and `tools.deny: ["*", …]`.
   - **Provider keys:** they are set in the gateway process env as `OCW_PROVIDER_KEY_<ID>`. The
     config file only holds the reference `${OCW_PROVIDER_KEY_<ID>}`, so keys never reach disk or
     logs (verified with grep).
   - **Removed bots:** removals are declared with `writeOptions.allowedAgentRosterRemovals`.
     Without it, OpenClaw refuses writes that drop agents.
   - **Status ack:** for every bot it provisioned, the plugin calls `POST /agents/:id/status
     {status:"ready"}`. This flips the UI chip from provisioning to ready. A bot whose provider is
     missing gets `{status:"error", detail}`.
2. **Stream.** The plugin opens `GET /ws` (Bearer cell token) and sends
   `{op:"sub", topic:"cell:<cellId>", afterSeq}`.
   - The cursor is persisted per topic in `$OPENCLAW_STATE_DIR/ocw-channel/cursor-default.json`.
   - With no cursor, the plugin subscribes from the snapshot's `lastSeq`, so a fresh cell never
     re-answers old mentions.
   - On `{op:"resync"}` it re-baselines from `GET /cell`.
   - Cursor commits: only contiguous completed events are committed. Events interrupted by an
     account stop (for example when OpenClaw swaps the plugin instance) are left for the successor
     instance to replay.
   - Reconnects use jittered backoff, plus app and ws pings.
3. **`agent.mention.v1`.** The plugin dispatches the mention to OpenClaw agent `ocw-<agent.id>` in
   session `…:channel:<conversation.id>:thread:<thread.rootMessageId>`, so there is one lane per
   (bot, thread). Identity is passed as structured fields, never as text prefixes:
   - `SenderId` / `SenderName`
   - `GroupMembers` = `Name <id>, …, Bot (agent) <id>`
   - `threadHistory` as a `chat_window` (`#<msgId> time Name <id>: text`); OpenClaw collapses
     forged newlines
   - persona (name, description, instructions) as the trusted `GroupSystemPrompt`
   - `disableTools: true` and `toolsAllow: []` on every turn. The captured model request showed
     **0 tools**.
   - A turn that fails before anything was delivered is retried twice (1.5 s and 3 s). A
     just-provisioned agent can be briefly unpublished.
4. **Reply.** The plugin sends `POST /messages` with `{agentId, conversationId, threadRootMessageId,
   inReplyToMessageId: message.id, text, idempotencyKey: "evt:<eventId>"}`.
   - Further chunks use `evt:<eventId>:<n>`.
   - Retries cover 5xx, 408, 425, 429 and network errors.
   - If the turn still fails, one notice is posted with key `evt:<eventId>:failed`.
   - Typing: `POST /typing {typing:true}` every 4 s, then `{typing:false}`.
5. **`cell.config.changed`:** re-read `/cell`, reconcile, then send the status acks again.

## Notes from running against the real gateway

- If a provider's id matches a bundled provider plugin (for example `anthropic`), OpenClaw
  auto-enables that plugin as a runtime overlay. The persisted config keeps `plugins.allow: ["ocw"]`.
  OpenClaw then swaps our plugin instance once; the cursor and replay rules above make that safe.
- Memory: the gateway uses about 1.1–1.2 GB RSS during a turn with the anthropic provider loaded.
  Use a 512 MB V8 heap; 256 MB caused a V8 OOM.

## Env

| Variable | Purpose |
|---|---|
| `OCW_API_URL` | Agent Channel API base, e.g. `http://api:4000` (required) |
| `OCW_CELL_TOKEN_FILE` / `OCW_CELL_TOKEN` | cell token, re-read on every request so it can rotate |

Model provider keys are **not** env inputs. They come from `GET /cell`, which serves the keys
admins enter in Settings › Models.

## Development

```bash
pnpm --filter @ocw/openclaw-channel typecheck
pnpm --filter @ocw/openclaw-channel test     # vitest: contract tests vs src/testing/fake-agent-channel-api.ts
pnpm --filter @ocw/openclaw-channel build    # → dist/ (what OpenClaw loads)
node src/testing/run-fake-api.ts             # standalone fake API (POST /__test/mention, /__test/cell; GET /__test/state)
```

There is no `openclaw` devDependency: it is about 740 MB and has a postinstall script. The narrow
SDK surface used here is declared in `src/openclaw-sdk.d.ts`, and the real contract is exercised by
`infra/openclaw/test/run-container-smoke.sh`.
