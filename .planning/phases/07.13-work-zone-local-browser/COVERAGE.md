# API Coverage — Phase 07.13 Work Zone local browser

> Full coverage by default. Opt-outs are explicit, reasoned decisions.

The phase integrates four external surfaces: the browser capability itself (Chromium through `playwright-core` + CDP,
measured against the bots' `ocw_browser_*` capability set of ADR-0029, which is the baseline this second integration
of the same need starts from), the Claude Agent SDK's in-process MCP servers, Codex app-server's MCP server config and
requests, and two fixed public endpoints (Chrome for Testing storage, GitHub releases).

## Browser capability (baseline: the bots' set, ADR-0029)

| capability | decision | reason |
|---|---|---|
| open (http/https, loopback included) | INTEGRATE | |
| navigate on an open page (via open/act) | INTEGRATE | |
| snapshot (redacted accessibility text) | INTEGRATE | |
| act click | INTEGRATE | |
| act type | INTEGRATE | |
| act select | INTEGRATE | |
| act press | INTEGRATE | |
| act scroll | INTEGRATE | |
| wait load / text / time | INTEGRATE | |
| screenshot (masked JPEG, image-capable models) | INTEGRATE | |
| close | INTEGRATE | |
| signin request (agent asks the person) | INTEGRATE | |
| live view frames (screencast) | INTEGRATE | |
| takeover input (pointer, wheel, keys, text, paste, touch) | INTEGRATE | |
| focus sensitivity hint during takeover | INTEGRATE | |
| sealed sign-ins (save, load, re-seal, revoke, expiry) | INTEGRATE | |
| site lock + cross-site approval on a signed-in page | INTEGRATE | |
| per-host approvals and admin per-tool rule modes | INTEGRATE | |
| admin per-tool approver kinds (users, unit leads, admins) | OPT-OUT | D-34: Work Zone approvals are answered by `work_session.approve` holders; approver kinds not honoured in v1 |
| live view resize / expanded / phone viewport modes | OPT-OUT | not needed: D-15 fixes 960×600 frames; the web scales them |
| downloads | OPT-OUT | explicitly out of scope (CONTEXT: downloads refused; Deferred) |
| file uploads | OPT-OUT | explicitly out of scope (CONTEXT Deferred) |
| several tabs / popups as pages | OPT-OUT | explicitly out of scope (one page per session, D-02) |
| headed (visible) window | OPT-OUT | explicitly out of scope (CONTEXT Deferred) |
| page script / DOM / cookie / storage read APIs for the model | OPT-OUT | refused by design (ADR-0029 P-07, D-13): the model reads only redacted snapshots |
| egress proxy for page traffic | OPT-OUT | not needed: device-side navigation is governed by D-10 … D-12 and D-35, not the API egress guard |

## Claude Agent SDK (0.3.282) — in-process MCP

| capability | decision | reason |
|---|---|---|
| `createSdkMcpServer` + `tool()` | INTEGRATE | |
| image tool results | INTEGRATE | |
| `alwaysLoad` (no tool-search round trip) | INTEGRATE | |
| `setMcpServers` between turns | INTEGRATE | |
| `mcpServerStatus` (shadowing check) | INTEGRATE | |
| `canUseTool` for MCP tools | INTEGRATE | |
| per-server `timeout` | INTEGRATE | |
| `permission_policy: "always_ask"` | OPT-OUT | needs SDK ≥ 0.3.301, newer than the pin; the manager decides approvals instead |

## Codex app-server (0.172) — MCP servers

| capability | decision | reason |
|---|---|---|
| `mcp_servers.<name>` via `-c` overrides at spawn | INTEGRATE | |
| `default_tools_approval_mode`, `tool_timeout_sec` | INTEGRATE | |
| `mcpServer/elicitation/request` handling | INTEGRATE | |
| `item/tool/requestUserInput` handling | INTEGRATE | |
| MCP image content in results | INTEGRATE | |
| `thread/start.config` MCP channel | OPT-OUT | not needed: one app-server per session makes `-c` sufficient; used only if 04 records `-c` failing |
| `dynamicTools` / `item/tool/call` | OPT-OUT | requires `experimentalApi`, which the adapter keeps off (research Alternatives) |
| `enabled_tools` filtering | OPT-OUT | not needed: the shim exposes exactly the browser tools |

## Fixed public endpoints

| capability | decision | reason |
|---|---|---|
| Chrome for Testing storage: pinned headless shell zip per platform | INTEGRATE | |
| Chrome for Testing JSON version endpoints | OPT-OUT | not needed: versions and sha256 are pinned in runtime source (D-05) |
| GitHub `releases/latest` (desktop update notice) | INTEGRATE | |
| GitHub release asset download / install | OPT-OUT | explicitly out of scope until signed builds (D-18, Phase 9) |
