# OpenClaw cell (`infra/openclaw`)

This is the official `ghcr.io/openclaw/openclaw:2026.9.7-slim` image (pinned by digest), plus
`apps/openclaw-channel`, the pinned official keyless search plugins and a locked-down base config. `entrypoint.mjs` renders that base config
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
  mDNS off. Boot log: `4 plugins: ocw, openai, duckduckgo, searxng` (fewer when a bundled plugin is disabled or
  missing, see below).
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
     tool nobody granted is never configured, and a future OpenClaw tool never becomes reachable just because it
     is not listed. `DANGEROUS_TOOLS` mirrors `DANGEROUS_TOOL_NAMES` in `packages/contracts`
     (parity test in `apps/openclaw-channel/src/reconciler.test.ts`).
  2. **Turn.** Every dispatch passes `toolsAllow = turn.tools ∩ the bot's tools` (OpenClaw only narrows with it);
     an empty set also passes `disableTools: true`. A mention without a `turn` gets no tools (fail closed).
  3. **Call.** The plugin's `before_tool_call` hook (registered unscoped, highest priority) blocks any call outside
     the active turn, over the per-turn caps (8 calls, 5 web calls), or side-effecting after untrusted output, and
     asks `POST /agent-channel/v1/tool-calls` for every gated call. A slow or unreachable API blocks the call
     (fail closed, client timeout 10 s under the hook's 15 s). `after_tool_call` reports the outcome (status,
     result count, host, duration; never the content), which the API audits.
- **Sessions:** one OpenClaw session per DM conversation and per channel thread, plus `session.dmScope:
  "per-channel-peer"` as defence in depth, so two humans' DMs with the same team bot never share context.
- **Time:** `agents.defaults.userTimezone: "UTC"` (OpenClaw always prints the current date); the asking human's
  exact local time comes per turn as a structured context block when the bot's date/time capability is on.
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

## Env

| Variable | Notes |
|---|---|
| `OCW_API_URL` | required, e.g. `http://api:4000` |
| `OCW_CELL_TOKEN_FILE` / `OCW_CELL_TOKEN` | required; same token the API verifies |
| `NODE_OPTIONS` | compose default `--max-old-space-size=512` (see Memory) |
| `OCW_BUNDLED_PLUGINS` | bundled search plugins to load: default `duckduckgo,searxng`, `none` disables both |
| `OCW_SEARXNG_URL` | SearXNG base URL as seen from the cell (`http://searxng:8080` with the `search` profile) |

## Memory

During a turn the gateway uses about 1.1–1.2 GB RSS; at idle it uses about 0.8 GB.

| Heap setting | Result |
|---|---|
| No cap | VM-OOM-killed on a Docker host with about 1.3 GB headroom |
| 256 MB | Enough for the fake provider; V8 heap OOM once the anthropic provider plugin loaded |
| 512 MB | Works (also with the `openai` plugin: idle about 0.6–0.8 GB RSS, a ChatGPT turn up to about 1.35 GB) |

## Test

```bash
node --test 'infra/**/*.test.mjs'                 # renderer + fake model
pnpm --filter @ocw/openclaw-channel build
infra/openclaw/test/run-container-smoke.sh        # real OpenClaw + plugin + fake model + fake API, internal network
```

The smoke script reuses the existing `ocw-openclaw:local` and `ocw-fake-model:local` images (set
`SMOKE_BUILD=1` to rebuild). It bind-mounts the working-tree plugin, entrypoint, renderer, fake-model server and
the bundled search plugins (installed on the host into a temp dir with `install-bundled-plugins.sh`), so code
changes never need an image rebuild. Scenarios (`SMOKE_ONLY=<comma list>`): `mention`, `signin`, `dm`,
`capabilities` (internet on: the model is offered exactly `web_fetch,web_search`, searches through the gate via
the fake SearXNG, the fake API records the call and its result; internet off: `[tools: 0]`) and `dm-isolation`
(two humans' DMs with one bot never share a prompt; deleting the bot leaves no transcript in the state volume).
