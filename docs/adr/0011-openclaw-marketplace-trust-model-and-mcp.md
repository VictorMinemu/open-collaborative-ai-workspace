# ADR-0011: OpenClaw Marketplace trust model and MCP servers for bots

## Status

Accepted. **Date:** 2026-10-05. **Deciders:** Víctor Ruiz (Autofy Labs).

## Context

The owner's done-criterion for Phase 3.1 is that bots can attach MCP servers and use plugins installed from the OpenClaw
Marketplace (ClawHub), in a real conversation (BOT-08, BOT-09, BOT-10).

Both features bring third-party code and content into the OpenClaw cell:

- **Native OpenClaw plugins** are npm packages loaded **in-process** by the gateway. They are not sandboxed and run
  with the gateway's privileges.
- **MCP servers** are either remote endpoints that receive credentials, or stdio programs that would otherwise run
  inside the gateway container.

ADR-0010 already gates every tool call per turn. This ADR decides what may be installed or attached at all, who
decides it, and what risk is left.

## Decision

### Marketplace (D-14)

**The API is the only door to ClawHub.**
- The API proxies ClawHub at `OCW_CLAWHUB_URL` (default `https://clawhub.ai`; set it identically on the api and the
  cell in `compose.yaml`).
- Requests are anonymous, with a fixed user agent and no telemetry (`CLAWHUB_DISABLE_TELEMETRY=1` in the cell).
- Search is cached for 10 minutes, and reviews ask ClawHub first. Only `plugin.manage` holders can trigger an outbound
  call.
- The cell never browses. Code: `apps/api/src/modules/plugins/{clawhub,service,routes}.ts`.

**Every version is scored, and only official plugins are the default.**
- `scorePluginRisk` (`plugins/risk.ts`) is pure and deterministic. It rates a version `refuse | high | medium | low`
  from:
  - the channel and the verification tier;
  - scan and moderation state;
  - compatibility with OpenClaw 2026.9.7;
  - the declared surface.
- **Refused:**
  - channels and gateway method or HTTP routes;
  - CLI backends, extension factories and tool-result middleware;
  - trusted tool policies, memory or context slots and external auth;
  - bundled MCP servers and code executors;
  - dangerous tool names;
  - ClawHub blocks, an incompatible host and a missing digest.
- **High:** community packages need a typed acknowledgement and are never available to personal bots unless the
  admin allows them.

**Approvals are pinned and bound to what was reviewed.**
- An approval is one exact (package, version, sha256). It must match `reviewTokenOf`, a hash of the reviewed release
  and its declared surface, re-read live from ClawHub at approval time. A release that changed after the review gets
  409 `review_changed`.
- Updates are manual and need a fresh review. Auto-update is off.

**The cell's executor is not the authority.**
- The executor (`apps/openclaw-channel/src/plugin-installer.ts`) accepts only events that match the API's approved
  list.
- It downloads the artifact only from the configured ClawHub origin and verifies the approved sha256, the npm
  integrity and ClawHub's digest header.
- Redirects are refused. The real ClawHub serves `/versions/{v}/artifact/download` directly (HTTP 200, observed
  2026-10-05), and the digest check would still catch a swapped artifact.
- Downloads get 120 s, because ClawHub streams slowly.
- It then runs `openclaw plugins install npm-pack:<file> --force --accept-capabilities` as an argv array, never a
  shell.

**Install gate (API-authoritative, fail closed).**
- OpenClaw's own `security.installPolicy` runs `infra/openclaw/install-policy.mjs` (root-owned, in `trustedDirs`) on
  each of the three policy calls of an install.
- The gate re-hashes the staged archive itself and accepts only `npm-pack:` sources.
- It allows the install only when `POST /agent-channel/v1/plugins/verify-install` answers that this exact tuple is an
  approved install in flight. A refusal, an error or a 5 s timeout blocks the install.
- The gateway-writable `ocw-plugins.json` is a boot cache only, never an approval. At boot the allowlist comes from
  `GET /agent-channel/v1/plugins`, and the cache is used only when the API is unreachable.
- **Remaining window:** while a row is `installing`, someone with a shell in the cell could run the same approved
  install by hand. The gate binds the digest, so the result is the approved artifact anyway.

**After install.**
- The cell inspects the plugin and turns its hooks off (`allowConversationAccess: false`,
  `allowPromptInjection: false`). It then reports the declared surface.
- The API re-scores that report with neutral trust inputs and rejects the plugin when it finds:
  - a refused surface;
  - another plugin id or version than approved;
  - tools named like built-ins, or malformed tool names.
- A rejected plugin is uninstalled automatically and its grants are removed. Accepted tools become per-bot,
  side-effecting tools behind the ADR-0010 gate.
- Uninstalling removes every grant first. A web-search provider plugin makes internet `configured` only while it is
  installed.

### Residual risk (native plugins)

**An approved native plugin runs with the gateway's privileges, and no tool policy contains it.** It can read:

- provider API keys in the process environment;
- the cell token;
- ChatGPT-subscription OAuth tokens;
- every transcript in the state directory.

It can also tamper with our own `ocw` plugin, including the tool gate it relies on.

**What bounds this:**
- official-only default, scoring with refusals and pinned digests;
- an API-authoritative install gate and no auto-update;
- hooks off;
- automatic uninstall on a refused surface;
- an audit trail for every step (`plugin.install_requested`, `plugin.installed`, `plugin.install_blocked`,
  `plugin.rejected_after_install`, `plugin.uninstall_requested`, `plugin.uninstalled`).

**Treat approving a plugin as granting it the cell.** The future option is a separate cell, or a sandboxed plugin host,
per trust level (e.g. official-only versus community).

### MCP servers (D-13)

**Remote first.**
- Admins (`mcp.manage`) register `streamable-http` or `sse` servers: HTTPS, or http to private or compose hosts only
  (`apps/api/src/modules/mcp/url-policy.ts`).
- **Credentials are write-only.** Header values are stored as `SecretReference`s (`app.secrets`, kind
  `mcp_credential`) and reach OpenClaw only as `${OCW_MCP_<SAFE>_<N>}` env references. They are never written to its
  config, to logs or to probe errors.
- **Names are immutable** safe server names (`m` + 8 hex). OpenClaw exposes the tools as `<safe>__<tool>`, mirrored
  exactly by `mcp/names.ts`.

**Probe through the cell.**
- The cell probes each server with the official MCP SDK client (`apps/openclaw-channel/src/mcp-probe.ts`). Redirects
  are refused, and the probe has 20 s.
- The API stores the tools with their read-only and destructive hints.

**Grants are per bot and exact.**
- Bot managers enable individual tools per bot. Personal bots only get tools from servers with `personal_allowed`.
- The cell renders only servers with an enabled tool, with an exact `toolFilter.include`.
- Each server's output taints the turn unless the admin marks it trusted for chained calls (`trusted_chaining`).

**stdio only in the sidecar.**
- Vetted, pinned stdio servers run only in the hardened `ocw-mcp-sandbox` sidecar: compose profile `mcp-sandbox`,
  `infra/mcp-sandbox`, landed in 03.1-14.
- The sidecar is non-root, read-only, with no capabilities and on an internal network shared with the cell alone.
- It exposes each server to the cell as a remote streamable-HTTP server. No third-party MCP code runs in the gateway
  container.

**Deferred:** per-human MCP OAuth. It needs a public gateway origin for the callback.

## Consequences

- Admins can safely say yes to the official DuckDuckGo plugin or a company MCP server, and the review shows why each
  verdict was given.
- Real-cell evidence:
  - CI `cell-smoke` (scenarios `mcp`, `marketplace`, `sandbox`, offline with fakes);
  - the on-demand `cell-proof` workflow, which uses the real ClawHub and real DuckDuckGo
    (`scripts/cell-proof.sh`, PR label `cell-proof`).
- The trust boundary for native plugins is the cell, not the tool gate. Documentation, the review sheet ("Plugins run
  inside your bots' runtime. Only install plugins you trust.") and this ADR say so plainly.
- **Every OpenClaw bump re-checks:**
  - the install-policy contract (stdin/stdout shape, `trustedDirs`, three calls per `npm-pack:` install);
  - `plugins install / uninstall / inspect` flags and output;
  - the hook policy keys.
- A ClawHub outage degrades to cached search and reviews. Approvals stay strictly live (503), and chat is unaffected.
