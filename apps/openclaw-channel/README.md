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
   - **MCP servers (D-13):** every snapshot server with at least one enabled tool becomes
     `mcp.servers.<safeName>` (`m` + 8 hex) with `url`, `transport`, `headers` as `${OCW_MCP_<SAFE>_<i>}` references
     (the values only in the gateway env, removed with the server) and `toolFilter.include` = the exact enabled MCP
     tool names. A server without enabled tools is not rendered, so the cell never connects to it. Only `m<8hex>`
     entries are ever touched.
   - **`mcp.probe`:** the plugin connects to the snapshot server with the official MCP SDK client
     (`@modelcontextprotocol/sdk` 1.30.0, the version OpenClaw bundles; streamable HTTP or SSE, no redirects,
     20 s), lists its tools and reports `POST /mcp/probe-results`. Errors are classified and never carry a header
     value; the server's metadata is bounded and treated as untrusted.
   - **MCP calls** go through the same `before_tool_call` gate as every tool (OpenClaw hands the hook a
     lower-cased name; the gate resolves it to the turn's exact `<safe>__<tool>`), are audited with the server,
     and MCP output taints the turn unless the admin trusts the server for chained calls.

6. **Subscription sign-in (`provider.auth.*`, ADR-0006).** On `provider.auth.start` the plugin runs
   OpenClaw's own ChatGPT/Codex device-code login (`runModelsAuthLoginFlow` from
   `openclaw/plugin-sdk/provider-auth-login-flow-runtime`, provider `openai`, method `device-code`, agent
   `main` = the shared auth store every `ocw-*` agent reads through). Its prompter forwards the
   verification URL and one-time code to `POST /provider-auth` and nothing else; OpenClaw's own console
   output is swallowed so the code is never logged.
   - Approved → OpenClaw stores the OAuth profile (`openai:<email>`) and refreshes it from then on; the
     plugin reports `connected` with email + plan. Errors are classified (`expired`, `denied`,
     `unsupported`, `failed`). `provider.auth.cancel` aborts; a 409 from the API (another instance owns
     the flow) stops the attempt silently. Sign-ins run in the background; mentions keep flowing.
   - `provider.auth.revoke` removes the provider's profiles (`removeProviderAuthProfilesWithLock`).
   - Every cell sync checks the stored sign-in: missing → reports `disconnected` once and acks those bots
     `error`; present but not listed (disconnected while offline) → removed.
   - `openai-codex/<model>` bots become `openai/<model>` pinned to the embedded runtime; with an OpenAI
     API key configured as well, the key-based provider is written as `ocw-openai`.
   - A provider 401/403 during a turn is answered once with "the provider rejected my credentials… reconnect
     in Settings › Models" instead of OpenClaw's own text.

7. **Marketplace plugins (`plugin.install.v1` / `plugin.uninstall.v1`, D-14).** `plugin-installer.ts` installs
   only an event that matches the snapshot's approved `plugins` (one refresh). It downloads from `OCW_CLAWHUB_URL`
   only, verifies the approved sha256 and npm integrity, and runs
   `openclaw plugins install npm-pack:<file> --force --accept-capabilities` (argv array, no shell). OpenClaw's
   install gate (`infra/openclaw/install-policy.mjs`) then asks the API again.
   - Before the install, the executor writes `plugins.entries["<id>"].hooks` through `openclaw config set`
     (conversation access and prompt injection off).
   - After it, the executor checks the inspected id, version, integrity, hook restriction and `enabled`.
   - It reports the declared surface and keeps `<state>/ocw-plugins.json` as a boot fallback (never trusted for an
     install).
   - Jobs run detached, one at a time per process. The handler returns when OpenClaw stops the channel for the
     plugin-generation swap the job itself causes; see `infra/openclaw/README.md`.
   - A replay finds the plugin installed and re-reports it without reinstalling.
   - A job that outlives its plugin instance reports from a short-lived child process.
   - Reports carry classified codes, never CLI output.
   - Details and the trust model: `infra/openclaw/README.md` › Marketplace plugins.

## Notes from running against the real gateway

- The ChatGPT sign-in was verified on a real 2026.9.7 gateway: the plugin obtained a device code from
  auth.openai.com through OpenClaw's login flow, and a turn on `openai/gpt-6-astra` with a stored profile
  reached the ChatGPT Codex backend (`401: Could not parse your authentication token` for a fake token).
- `runModelsAuthLoginFlow` is a JS-only ("production-private") SDK export. It is declared narrowly in
  `src/openclaw-sdk.d.ts`; re-run `infra/openclaw/test/run-container-smoke.sh` on every OpenClaw bump.

- If a provider's id matches a bundled provider plugin (for example `anthropic`), OpenClaw
  auto-enables that plugin as a runtime overlay. The persisted config keeps `plugins.allow: ["ocw"]`.
  OpenClaw then swaps our plugin instance once; the cursor and replay rules above make that safe.
- Memory: the gateway uses about 1.1–1.2 GB RSS during a turn with the anthropic provider loaded, about
  0.6–0.8 GB idle and up to about 1.35 GB during a ChatGPT-subscription turn with the `openai` plugin.
  Use a 512 MB V8 heap; 256 MB caused a V8 OOM.

## Env

| Variable | Purpose |
|---|---|
| `OCW_API_URL` | Agent Channel API base, e.g. `http://api:4000` (required) |
| `OCW_CELL_TOKEN_FILE` / `OCW_CELL_TOKEN` | cell token, re-read on every request so it can rotate |
| `OCW_CLAWHUB_URL` | the only origin marketplace artifacts are downloaded from (default `https://clawhub.ai`) |

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
