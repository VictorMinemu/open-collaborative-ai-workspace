# OpenClaw cell (`infra/openclaw`)

This is the official `ghcr.io/openclaw/openclaw:2026.9.7-slim` image (pinned by digest), plus
`apps/openclaw-channel` and a locked-down base config. `entrypoint.mjs` renders that base config
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
- **Plugins:** `allow: ["ocw", "openai"]` and `deny: ["codex"]`, memory slot `none`, mDNS off. Boot log:
  `2 plugins: ocw, openai`.
  - Why `openai`: OpenClaw's bundled OpenAI plugin owns the ChatGPT/Codex device-code sign-in, the OAuth
    refresh and the Codex model catalog behind the "ChatGPT subscription" provider (ADR-0006). It is
    loaded at boot because enabling it later swaps plugin instances and would abort a sign-in. Its GPT-5
    "friendly personality" layer is off (`plugins.entries.openai.config.personality: "off"`).
  - Why the `codex` deny: with no providers at boot, `doctor --fix` would otherwise add `codex` to
    the allowlist.
  - A provider id that matches a bundled provider plugin (for example `anthropic`) is enabled by
    OpenClaw as a runtime overlay. The persisted allowlist does not change.
- **Tools:** `profile: minimal`, `deny: ["*", …]`, `toolSearch: false`, `elevated` off.
  - Each agent also gets its own `tools.deny`.
  - Every dispatch passes `disableTools: true` and `toolsAllow: []`.
  - The fake model reports `[tools: 0]`.
- **No background model calls:** heartbeat `0m`, no memory/dreaming, update check off.

## Env

| Variable | Notes |
|---|---|
| `OCW_API_URL` | required, e.g. `http://api:4000` |
| `OCW_CELL_TOKEN_FILE` / `OCW_CELL_TOKEN` | required; same token the API verifies |
| `NODE_OPTIONS` | compose default `--max-old-space-size=512` (see Memory) |

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
`SMOKE_BUILD=1` to rebuild). It bind-mounts the working-tree plugin and entrypoint into the
container, so plugin changes never need an image rebuild.
