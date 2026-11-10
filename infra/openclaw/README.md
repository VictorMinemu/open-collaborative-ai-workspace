# OpenClaw cell (`infra/openclaw`)

This is the official `ghcr.io/openclaw/openclaw:2026.9.7-slim` image (pinned by digest), plus
`apps/openclaw-channel`, the pinned official keyless search plugins, the marketplace install gate
(`install-policy.mjs`) and a locked-down base config. `entrypoint.mjs` renders that base config
with `render-config.mjs`, then hands over to the image's own entrypoint (`doctor --fix`, then the
gateway).

Bots and model providers, keys included, are **not** in this config. The rendered config is authoritative
on every boot: the entrypoint deletes `openclaw.json.bak` (and `.last-good`) first, otherwise OpenClaw sees
the much smaller base config as a suspicious "size drop" and restores last run's backup, undoing base-config
changes such as the plugin allowlist. ChatGPT-subscription sign-ins live in OpenClaw's auth store
(`state/openclaw.sqlite` on the state volume), not in the config, so they survive restarts. At start, and on every
`cell.config.changed`, the plugin provisions them from `GET /agent-channel/v1/cell`:

- Provider keys stay in the gateway process env (`OCW_PROVIDER_KEY_<ID>`). The config holds only
  `${…}` references.
- Plugin-owned entries are re-provisioned on every boot, which takes about 1 s.

## Lockdown (asserted by `render-config.test.mjs` and the container smoke test)

- **Gateway:** `bind: loopback` inside the container, Control UI off, no published ports. The
  operator token is random per boot unless `OPENCLAW_GATEWAY_TOKEN[_FILE]` is set.
- **Plugins:** `allow: ["ocw", "openai", "duckduckgo", "searxng"]` and `deny: ["codex"]`, memory slot `none`,
  mDNS off. `ocw` and `openai` load at boot; the search plugins are activated lazily (their manifests say
  `onStartup: false`), so the boot line `http server listening (N plugins: …)` lists them only once loaded. The
  smoke test accepts exactly these four ids and nothing else.
  - Why `openai`: OpenClaw's bundled OpenAI plugin owns the ChatGPT/Codex device-code sign-in, the OAuth
    refresh and the Codex model catalog behind the "ChatGPT subscription" provider (ADR-0006). It is
    loaded at boot because enabling it later swaps plugin instances and would abort a sign-in. Its GPT-5
    "friendly personality" layer is off (`plugins.entries.openai.config.personality: "off"`).
  - Why the `codex` deny: with no providers at boot, `doctor --fix` would otherwise add `codex` to
    the allowlist. The Codex plugin also owns OpenAI's hosted search, which would bypass our tool gate.
  - A provider id that matches a bundled provider plugin (for example `anthropic`) is enabled by
    OpenClaw as a runtime overlay. The persisted allowlist does not change.
- **Tools (lockdown v2, an allowlist; Phase 3.1 D-08).** Three independent guards:
  1. **Config.** Global `tools.profile: "minimal"`, `toolSearch: false`, `elevated` off and an explicit
     `deny: DANGEROUS_TOOLS` (shell/exec/process, filesystem, browser/canvas, gateway/openclaw admin, `message`,
     `nodes`, `x_search`, `code_execution` and the `group:*` sets). There is **no `*` deny any more**: deny always
     wins in OpenClaw, so a wildcard would also kill the web tools. Each bot gets
     `{ profile: "minimal", alsoAllow: <its effective tools>, deny: DANGEROUS_TOOLS }` from the reconciler, so a
     tool nobody granted is never configured (plus `ocw_board_card` for a bot served delivered-turn tools: the API
     offers it only on board channels' turns, which the cell-wide snapshot cannot list; each turn's `toolsAllow`
     still decides, `apps/openclaw-channel/src/turn-scoped-tools.ts`, 07.1-13), and a future OpenClaw tool never becomes reachable just because it
     is not listed. `DANGEROUS_TOOLS` mirrors `DANGEROUS_TOOL_NAMES` in `packages/contracts`
     (parity test in `apps/openclaw-channel/src/reconciler.test.ts`).
  2. **Turn.** Every dispatch passes `toolsAllow = turn.tools ∩ the bot's tools` (OpenClaw only narrows with it);
     an empty set also passes `disableTools: true`. A mention without a `turn` gets no tools (fail closed).
  3. **Call.** The plugin's `before_tool_call` hook (registered unscoped, highest priority) blocks any call outside
     the active turn, over the per-turn caps (8 calls, 5 web calls), or side-effecting after untrusted output, and
     asks `POST /agent-channel/v1/tool-calls` for every gated call (not `ocw_memory_save` and `ocw_board_card`,
     whose own routes check the turn and the taint and count the call). A slow or unreachable API blocks the call
     (fail closed, client timeout 10 s under the hook's 15 s). `after_tool_call` reports the outcome (status,
     result count, host, duration; never the content), which the API audits.
- **Sessions:** one OpenClaw session per DM conversation and per channel thread, plus `session.dmScope:
  "per-channel-peer"` as defence in depth, so two humans' DMs with the same team bot never share context.
- **Time:** `agents.defaults.userTimezone: "UTC"` (OpenClaw always prints the current date); the asking human's
  exact local time comes per turn as a structured context block when the bot's date/time capability is on.
- **MCP (D-13):** no server at boot; the plugin renders `mcp.servers` from `GET /cell` (only servers with an
  enabled tool, credentials as `${OCW_MCP_…}` env references, exact `toolFilter.include`). Bots see an MCP tool
  only through their exact `alsoAllow` name and the turn's `toolsAllow`. `mcp.sessionIdleTtlMs: 600000` evicts
  idle per-session MCP runtimes after 10 minutes.
- **No background model calls:** heartbeat `0m`, no memory/dreaming, no pre-compaction memory flush, update
  check off.

## Web search (D-09)

`web_fetch` is OpenClaw's own guarded fetch (private hosts blocked, redirects re-checked, at most 3, 20 000
characters). `web_search` always goes through a **managed, pinned provider** so every search is a hookable,
audited call: `tools.web.search.provider` is set explicitly and `tools.web.search.openaiCodex.enabled` is
`false` (ChatGPT-subscription hosted search would bypass the hook).

| Provider | How | Notes |
|---|---|---|
| DuckDuckGo (default) | bundled `@openclaw/duckduckgo-plugin` | Keyless, no extra container. Experimental HTML scraping: occasional bot challenges. |
| SearXNG (optional) | bundled `@openclaw/searxng-plugin` + compose profile `search` | Self-hosted meta-search, JSON API, queries stay on your network. |

Enable SearXNG:

```bash
OCW_SEARXNG_URL=http://searxng:8080 OCW_SEARXNG_SECRET=$(openssl rand -hex 32) docker compose --profile search up -d
```

Put both variables in `.env` to keep them, then choose **SearXNG** in Settings › Bot policy. With
`OCW_SEARXNG_URL` set (and the plugin present) the cell renders `provider: "searxng"` with
`plugins.entries.searxng.config.webSearch.baseUrl: "${OCW_SEARXNG_URL}"` (an env reference, never the URL itself).
Without `OCW_SEARXNG_SECRET` the `searxng` container refuses to start (SearXNG rejects its placeholder key).
Settings live in `infra/searxng/settings.yml` (JSON format on, limiter and image proxy off, no published port).

Not used: **Brave** and other API-key providers (paid or metered, credit card required) and **OpenAI/Codex hosted
search** (bypasses the tool gate and the audit, consumes the subscription).

### Bundled plugins

`bundled-plugins.json` pins each official plugin to an exact version and its npm `dist.integrity` (sha512).
`install-bundled-plugins.sh <dest>` runs `npm pack`, checks the sha512, aborts on a mismatch, extracts to
`<dest>/<id>` with no lifecycle scripts and installs runtime dependencies only when the package declares any
(neither does today). The Dockerfile runs it in the build stage and copies the result root-owned to
`/opt/ocw/plugins` (read-only for the gateway user). CI builds this image on every PR (`images` job,
`ocw-openclaw:ci`) and runs the container smoke on the runner (`cell-smoke` job).

To update a pin: bump `version`, set `integrity` from `npm view @openclaw/<id>-plugin@<version> dist.integrity`,
check the plugin's `minHostVersion` against the pinned OpenClaw image, then run the smoke.

`OCW_BUNDLED_PLUGINS` (default `duckduckgo,searxng`, `none` = none) selects what loads; set the same value on the
API so it knows whether internet is `configured`. A bundled plugin whose directory is missing from the image
(an older image, or a local setup that bind-mounts the plugin) is **skipped** with one log line,
`[ocw-cell] bundled plugin <id> missing from the image; skipped`, and the cell boots without it; if it was
SearXNG the provider falls back to DuckDuckGo.

## Marketplace plugins (03.1-12, D-14)

Admins approve exact, pinned ClawHub versions in the API (Settings › Marketplace, 03.1-11/13). The cell then runs
them, and nothing else:

1. **Executor** (`apps/openclaw-channel/src/plugin-installer.ts`, one at a time). `plugin.install.v1` must match a
   row of the last `GET /cell` `plugins` list (package, version, sha256, plugin id). The executor downloads
   `artifactUrl` only from `OCW_CLAWHUB_URL` (no redirects, 50 MB, 60 s) into a private temp file and checks the
   approved sha256, the npm integrity and ClawHub's digest header. Before the plugin exists it writes
   `plugins.entries["<id>"].hooks` with `openclaw config set` (conversation access and prompt injection off). It then
   runs `openclaw plugins install npm-pack:<file> --force --accept-capabilities` as an argv array (120 s), applied
   through the running gateway. `plugins inspect <id> --runtime --json` must show the approved id, version and
   integrity, otherwise the plugin is removed again. OpenClaw's own view must also show the hook restriction and
   the plugin enabled; a reinstall after an uninstall keeps `enabled: false`, so the executor runs
   `plugins enable`. The declared surface is reported to `POST /agent-channel/v1/plugins/report`.
   `plugin.uninstall.v1` runs `openclaw plugins uninstall <id> --force`. Every child process gets
   `CLAWHUB_DISABLE_TELEMETRY=1`.

   **Plugin-generation swaps.** Installing, removing or restricting a plugin makes OpenClaw replace the plugin
   generation. It stops our channel and gives our plugin 5 s to finish its admitted work before it commits. Jobs
   therefore run detached, in a process-wide queue, outside the channel's lifetime. The event handler returns as
   soon as the channel is stopped and leaves the event uncommitted. Otherwise the stop waits for the install, the
   install waits for the stop, the drain times out and OpenClaw rolls the install back (the first CI run of this
   scenario). The successor instance replays the event, queues behind the running job, finds the plugin
   installed (inspect) and reports it again; it never installs twice. A retired instance cannot use OpenClaw's
   wrapped `fetch` or the host's account object. The job therefore reads the token through the plugin's own
   account copy and, if the in-process report still fails, posts it from a short-lived `node` child process.
   The token travels on that child's stdin.
2. **Install gate** (`install-policy.mjs`, OpenClaw's `security.installPolicy` exec, `targets: ["plugin"]`). OpenClaw
   runs it after staging and before committing *every* plugin install or update, CLI or Gateway, and fails closed
   on anything but a well-formed `allow`. It accepts only `npm-pack:<absolute path>` sources. It re-hashes that
   archive itself, reads the package name and version from the archive's own `package.json` and cross-checks
   them with what OpenClaw says it installs. Then it asks `POST /agent-channel/v1/plugins/verify-install` with the
   cell token (5 s). Only `200 {approved: true}` allows, and the API says so only for a row in status
   `installing` with the same package, version and sha256. An unreachable or slow API, a refusal, a missing token,
   a `clawhub:`/`npm:`/`git:`/path source: **block**. It never reads local state. The command is the gateway's
   own node binary, and the script is `/opt/ocw/install-policy.mjs` (root-owned, `0644`). OpenClaw checks both
   against `trustedDirs` and refuses group- or world-writable files, other owners and symlinks.
3. **Boot.** `openclaw.json` is re-rendered every boot, but OpenClaw keeps install records (SQLite machine state)
   and package roots (`<state>/npm/projects/…`) in the state volume. The entrypoint asks
   `GET /agent-channel/v1/plugins` (cell token, 5 s) and re-adds the installed ids to `plugins.allow` with
   `plugins.entries.<id>.hooks {allowConversationAccess: false, allowPromptInjection: false}`. Only when the API is
   unreachable does it use the plugin-written boot cache `<state>/ocw-plugins.json`, and it logs one line. That
   cache can only re-enable plugins already on disk and is never used to approve an install.
4. **API side.** The report re-scores what the cell inspected. A refused surface (channels, dangerous tools,
   gateway methods, tool-result middleware, …), a plugin id or version other than the approved one, or a tool
   named like a built-in rejects the plugin (`failed` + `plugin.uninstall.v1`). Accepted tools become per-bot
   capabilities (BOT-10). They are always side-effecting for the taint rule and always pass the call-time tool
   gate.

**Trust model and residual risk (T-03.1-12-10, ADR-0011).** A native plugin runs **in-process** with the gateway:
it can read the gateway env (provider keys, gateway token), the cell token file and the state dir (sign-ins,
transcripts). The tool policy limits what the model can call. It does not contain plugin code. What limits the
risk:
- official-only by default; community plugins need an explicit high-risk acknowledgement and are never for
  personal bots by default;
- refuse-level scoring, both at review and after install;
- pinned digests;
- the API-authoritative gate;
- hook restrictions;
- auto-update off (`OPENCLAW_NO_AUTO_UPDATE=1`, `update.checkOnStart: false`);
- Control UI off;
- loopback-only gateway.

A separate cell or a sandboxed plugin host per trust level is the recorded future option.

**Updating a plugin.** Updates are manual. The admin opens the new version, reviews it (a grown surface needs a
fresh review) and approves it. The API sends `plugin.install.v1` with `mode: "update"` and the new digest. The
executor reinstalls through the same gate (`--force` replaces the previous version only after the gate allowed
the new one).

**npm without registry egress.** OpenClaw plans each plugin's `openclaw` peer with npm against the registry. A
cell without registry access would wait about 8 minutes per install on npm's default retries. The entrypoint
therefore sets `npm_config_fetch_retries=1` and short retry and fetch timeouts unless the operator set their own.

## Env

| Variable | Notes |
|---|---|
| `OCW_API_URL` | required, e.g. `http://api:4000` |
| `OCW_CELL_TOKEN_FILE` / `OCW_CELL_TOKEN` | required; same token the API verifies |
| `NODE_OPTIONS` | compose default `--max-old-space-size=512` (see Memory) |
| `OCW_BUNDLED_PLUGINS` | bundled search plugins to load: default `duckduckgo,searxng`, `none` disables both |
| `OCW_SEARXNG_URL` | SearXNG base URL as seen from the cell (`http://searxng:8080` with the `search` profile) |
| `OCW_CLAWHUB_URL` | the only origin marketplace artifacts are downloaded from (default `https://clawhub.ai`; same value as the API) |
| `OCW_BREAKER_BACKOFF_MS` | back-off before the plugin starts the `ocw` channel itself after OpenClaw's restart-loop breaker (default `60000`) |

## Restart-loop breaker

OpenClaw 2026.9.7 counts gateway boots that never completed. Three or more within 5 minutes (a starved Docker VM is
enough) trip its breaker: the next boot starts the gateway but refuses every automatic channel start until a stable
process has outlived the window, so the cell answers no bot for 5 to 10 minutes while it looks healthy. On
`gateway_start` the plugin reads the `ocw` account through OpenClaw's own gateway client in process
(`callGatewayFromCli`, loopback with the shared token already in the gateway env, the same call as
`openclaw gateway call`). When the breaker is what keeps the account stopped, it reports the pause to the API
(`POST /agent-channel/v1/runtime`; Settings › Bots runtime shows "Paused" and when it restarts), waits
`OCW_BREAKER_BACKOFF_MS` and then makes OpenClaw's manual `channels.start`, so OpenClaw's channel manager still owns
the account. Failed starts are retried with a doubling back-off (5 attempts, at most 5 minutes apart). The log says
why: `[ocw] OpenClaw's restart-loop breaker suppressed this channel's auto-start (N unclean boots within 300 s) …`.
A path-loaded plugin cannot use `api.runtime.gateway.request` (bundled or trusted official plugins only, and no
operator.admin scope), which is why the guard uses the gateway client.

## Memory

During a turn the gateway uses about 1.1–1.2 GB RSS; at idle it uses about 0.8 GB.

| Heap setting | Result |
|---|---|
| No cap | VM-OOM-killed on a Docker host with about 1.3 GB headroom |
| 256 MB | Enough for the fake provider; V8 heap OOM once the anthropic provider plugin loaded |
| 512 MB | Works (also with the `openai` plugin: idle about 0.6–0.8 GB RSS, a ChatGPT turn up to about 1.35 GB) |

## Test

```bash
node --test 'infra/**/*.test.mjs'                 # renderer, install gate, plugin lock, fake model
pnpm --filter @ocw/openclaw-channel build
infra/openclaw/test/run-container-smoke.sh        # real OpenClaw + plugin + fake model + fake API, internal network
```

The smoke script reuses the existing `ocw-openclaw:local` and `ocw-fake-model:local` images (set
`SMOKE_BUILD=1` to rebuild; `SMOKE_CELL_IMAGE`, `SMOKE_MODEL_IMAGE` and `SMOKE_SANDBOX_IMAGE` pick other tags, so a
smoke next to a running stack builds and runs its own images). It bind-mounts the working-tree plugin, entrypoint, renderer, fake-model server and
the bundled search plugins (installed on the host into a temp dir with `install-bundled-plugins.sh`), so code
changes never need an image rebuild. Scenarios (`SMOKE_ONLY=<comma list>`): `mention`, `signin`, `dm`,
`capabilities` (internet on: the model is offered exactly `web_fetch,web_search`, searches through the gate via
the fake SearXNG, the fake API records the call and its result; internet off: `[tools: 0]`) and `dm-isolation`
(two humans' DMs with one bot never share a prompt; deleting the bot leaves no transcript in the state volume),
`memory`, `card` (06-14: a turn offering `ocw_agent_card` posts one gated card through `POST /cards`, bound to the
turn's conversation, thread and message; an `agent.card_action.v1` approval arrives as a turn in the card's thread
and updates the card with the version it saw), `board` (07.1-13: a board channel's turn offering `ocw_board_card`
runs the plugin tool, which creates one card through `POST /board/cards` bound to the turn's event, never through
`/tool-calls`) and `mcp` (the fake MCP behind a bearer token: probe through the cell, `${OCW_MCP_…}` in the rendered
config and never the token, only the enabled tool offered, a gated and audited `echo`, the tool filter re-rendered
when the admin enables `write_note`, and `write_note` blocked by the taint rule after `echo` in the same turn), and
`marketplace`. That scenario runs with `OCW_BUNDLED_PLUGINS=searxng` and `OCW_CLAWHUB_URL` pointing at the fake
ClawHub on the fake model. The fake ClawHub serves the `npm pack` of the pinned official
`@openclaw/duckduckgo-plugin@2026.9.7` (sha512 checked against `bundled-plugins.json`) and the test-only
`test/fixtures/ocw-echo-plugin`. The scenario proves that:
- DuckDuckGo is installed through the executor and the gate, `enabled` in `openclaw plugins list` and restricted
  in the config;
- a manual `openclaw plugins install` with the gateway's own environment is blocked, also after the test forges
  the local cache, and with the API paused even for a tuple in flight (fail closed);
- the plugin is re-allowed after `docker restart` of the smoke cell from `GET /plugins`;
- `ocw-echo` is installed and a bot calls `ocw_echo` in a conversation through the tool gate
  (`echo marketplace`);
- after uninstall a turn that still lists `ocw_echo` gets `Tool ocw_echo not offered`;
- DuckDuckGo is uninstalled.

`breaker` SIGKILLs the cell until OpenClaw's restart-loop breaker trips on the next boot, then checks that the plugin
noticed the suppressed channel, reported the pause to the fake API and started the channel itself (the smoke cell
runs with `OCW_BREAKER_BACKOFF_MS=5000`).

`bot_attachments` (07.15-10) runs the working-tree plugin's `ocw_attachment_read` in the real cell against the fake
API (`POST /__test/attachments` sets each file's answer) and the fake model. Each case is its own DM, so a model request
carries one turn only:
- files-only body: a DM message with empty text that lists two files is answered, and the model gets
  `(sent 2 attachments; see the Attachments block)` and the metadata-only `Attachments in this conversation` block,
  never the file's content (OpenClaw 2026.9.7 accepts the placeholder body, research A1);
- the turn's ids only: the read posts exactly `agentId,attachmentId,eventId` to `POST /attachments/read`, never to
  `/tool-calls`, and the API's untrusted block reaches the model only as the tool result;
- refusal sentences: a `model_no_images` answer reaches the model as its fixed sentence;
- reads outside the cap of 8: after 8 gated MCP `echo` calls and a 9th blocked at the cap, two reads in the same turn
  still run on their own budget;
- image part for image models: once the fake API flags the bot's model as image-capable, an image answer reaches the
  model as an `image_url` part with the exact bytes, after the labelled tool result;
- no URL, Garage key (`/att/`, `X-Amz-`) or file content outside a read's tool result in any model request, and no file
  content, file name, URL or key in the cell's logs.

`bot_work_sessions` (07.16-14) runs the working-tree plugin's `ocw_work_session_*` tools in the real cell against the
fake API (`POST /__test/work-sessions` sets each route's answer) and the fake model (fixture
`test/mention-work-sessions.json`, a DM turn that carries `turn.workZone`):
- turn-scoped: the four names are in the bot's `alsoAllow`, and the turn offers exactly them;
- start and read with the turn's ids only: one `POST /work-sessions/start` with `agentId,eventId,projectId,prompt`
  and one `POST /work-sessions/read` with `agentId,eventId,workSessionId`, never a device, user, visibility, worktree
  or audience key and never `/tool-calls`; the reply relays the started sentence and the read's header;
- outside content: after `web_search` in the same turn the start still reaches its route (the fake answers
  `proposed`, the reply relays the proposal sentence) while `ocw_start_work_zone` is refused in the cell (no
  `/work-zone/proposals` body);
- session output: after a read, `ocw_memory_save` is blocked in the cell (no `/memories` body) and
  `ocw_work_session_prompt` still reaches its route;
- wake-up: an `agent.work_session.v1` published through `POST /__test/event` is answered on the session's card
  (`inReplyToMessageId` = the card, `eventId` = the event's) and the model sees the `Work Zone session update` block;
- no person's prompt or absolute host path (both only in fields outside the contracts) in any model request or cell
  log line, and the session's output only inside a read's tool result.

`automation-fan-out` (07.17-15) runs the working-tree plugin's `ocw_conversation_open` in the real cell against the
fake API (`POST /__test/conversations` sets the open route's answer) and the fake model (fixture
`test/automation-run-fan-out.json`, an `agent.automation_run.v1` with `automationRun.fanOut` and an escalation target;
its directives are in `message.text`, where the fake model reads them):
- turn-scoped: `ocw_conversation_open` is in the bot's `alsoAllow`, and only the run turn offers it;
- outside content first: after `web_search` (through the gate) the open still reaches its route, with exactly one
  `POST /conversations/open` body of `agentId,eventId,items` (items `body,externalKey,title`), never a conversation,
  automation, run or user key and never `/tool-calls`;
- the reply on the run's anchor relays one "opened" line per item, and the run's model requests carry the fan-out
  instruction and the escalation sentence.

The script `docker cp`s the working-tree `install-policy.mjs` into a reused image instead of bind-mounting it:
OpenClaw refuses a policy script owned by the runner's uid.

The plugin's runtime dependencies are installed with `npm ci` from `plugin-runtime/package-lock.json` (in the image
and in the smoke's plugin copy). `dependencies` there must equal `apps/openclaw-channel/package.json`, and
`overrides` keep transitive versions on the ones `pnpm-lock.yaml` resolved (`plugin-runtime.test.mjs`). To change a
plugin dependency, edit both manifests, then regenerate the lock with
`npm install --package-lock-only --ignore-scripts --legacy-peer-deps` in `infra/openclaw/plugin-runtime`.
