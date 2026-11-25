# ADR-0035: Work Zone sessions drive a browser on their own device

## Status

Status: Accepted. **Date:** 2026-11-25. **Deciders:** Víctor Ruiz (Autofy Labs). Recorded at the end of the phase
(plan 07.13-23), after every behaviour below landed. The number was reserved for this phase when it was planned, so it
comes after ADR-0044 in time. The owner, quoted from the phase context:

> "como los bots" (the same capability and governance as the bots' browser, 2026-11-06)

> "quiero que tengan navegador y que el usuario pueda logear en una página y se guarde el login para ese user"
> (2026-11-25: sessions get a browser, and a person can sign in to a site and keep that sign-in for themselves)

> "ya hay usuarios, el upgrade debería instalar el navegador" (existing teams get it by upgrading)

The decisions are D-01 … D-35 in `.planning/phases/07.13-work-zone-local-browser/07.13-CONTEXT.md`, the planner
decisions PD-01 … PD-29, the prohibitions P1 … P7 and the flagged assumptions A-1 … A-9 in `07.13-01-PLAN.md` (the
phase hub), the research in `07.13-RESEARCH.md` and the measured spikes in `07.13-SPIKES.md`. They were taken by the
agent under the owner's full-autonomy grant, which makes CONTEXT's decisions the acceptance.

**Extends, without editing them:**

- [ADR-0029](0029-bot-sandboxes-plugins-and-live-browser.md), the bots' browser. The engine, the redaction, the live
  view, the takeover lease and the per-member sign-ins are reused. What differs for the Work Zone: the browser runs on
  the session's device, not in a `brw` container; live frames and typed input may cross API instances over Redis in
  transit (§ 5, D-33), where ADR-0029 says a person's typed input is never published; and sign-ins are a separate scope
  that never opens a bot's seal, nor the other way round (§ 6, D-30).
- [ADR-0012](0012-full-access-mode-and-shared-devices.md), Full access and shared devices. Its pattern (organization
  policy ∩ the device owner's local opt-in, checked by the server and again on the device) is applied to a new switch.
  Full access skips the browser's host prompts, but never the member's approval on a page with their sign-in loaded.

**Builds on:**

- [ADR-0013](0013-work-zone-session-settings-protocol.md): settings apply between turns; the image capability of a model
  comes from the runtime catalog.
- [ADR-0026](0026-per-tool-approvals-and-work-zone-proposals.md): the admins' per-tool rules, honoured here for their
  mode only (D-34).
- [ADR-0031](0031-work-zone-sidebar-and-per-viewer-session-fields.md): the session's shared browser state never names a
  host or a member.
- [ADR-0032](0032-runtime-cli-updates.md), [ADR-0033](0033-headless-work-zone-server.md) and
  [ADR-0040](0040-runtime-self-update.md): the served runtime bundle, the doctor and the self-update that delivers
  runtime 0.5.0.
- [ADR-0034](0034-public-releases-and-bundled-claude-agent-sdk.md): releases and `ocw upgrade` (v0.5.0).
- [ADR-0003](0003-infrastructure-baseline.md): secrets sealed in the secret store.

## Context

The main use case is a coding agent that checks the app it just changed on the device's own `localhost`. The bots'
browser cannot do that: it runs in a server-side container and reaches only the internet, through the egress proxy.
Principle 3 ("local when necessary") puts this browser on the device that runs the session, the desktop app's machine
or a headless server, governed like the bots' one where that applies.

Both runtimes can take extra tools without anything outside the adapter knowing their internals (principle 5):

- **Claude Code** through the Agent SDK's in-process MCP server (`createSdkMcpServer`), whose tools are named
  `mcp__<server>__<tool>`; the SDK reports a server's provenance (`source: "sdk"` only for a server the host
  registered).
- **Codex** through a stdio MCP server configured with `-c mcp_servers.*` overrides on `codex app-server`.

The spikes measured what the plans relied on, offline (PD-29: no login, no subscription, no owner's runtime home). The
results, with the commands that reproduce them, are in `07.13-SPIKES.md`:

| Assumption | Result | Decision |
| --- | --- | --- |
| A-1 Codex 0.172 starts a stdio server from `-c` overrides | Proven with the real binary; tools offered as one `namespace` tool | `-c` overrides at spawn, no thread `config` |
| A-2 `default_tools_approval_mode = "approve"` stops Codex asking | Proven, with a `prompt`-mode control (one elicitation per call) | `approve`; elicitations still handled (§ 3) |
| A-3 Codex forwards MCP images to image models | Proven for baseline JPEGs; a progressive grayscale JPEG was dropped | Never `setImageInput(false)` for Codex; screenshots stay baseline |
| A-4 Our `ocw_browser` wins over a project `.mcp.json` one (Claude) | Proven from the SDK types and an in-memory round trip, not live | Trust keys on `source`; a shadowing server makes the browser unavailable |
| A-5 A same-user process reaches the browser through `/proc` | Measured: pipe ends cannot be reopened, environ and memory can without Yama | Residual risk (Consequences) |
| A-6 Ubuntu 24.04 `t64` package names | Measured on bookworm, 22.04 and 24.04 | The doctor builds the apt line from `ldd` |

Teams already ran headless servers on runtimes from v0.2.x and later. The upgrade had to bring the browser without a
manual step where the self-update (ADR-0040) already exists, and without installing Chromium into the desktop
installers.

## Decision

### 1. Engine and child (D-01 … D-04, PD-02, PD-19, PD-24)

- **The bots' engine, on the device.** `playwright-core` (pinned 1.64.1, a bundle external installed beside the
  bundle) only launches a pinned **Chrome for Testing headless shell** over Playwright's **pipe**. There is no
  remote-debugging port and no listening port of any kind (P4). Everything else is raw CDP, as in the bots' agent.
- **One browser per session, in a child of the daemon** (`ocw-runtime browser-agent`, `BrowserChild`), speaking the
  sandboxd frame codec over stdio, so a Chromium crash never takes the daemon down. It starts on the first browser call
  and ends on session end, on `close`, after 10 minutes idle, or by crashing (a `crashed` event; the next `open` starts
  a new child). **One page per session** (the bots' rule; a pop-up's URL opens in that one page).
- **A throwaway profile.** Each session's run dir `<browsersRoot>/run/<sessionId>` (0700) is the child's
  `TMPDIR`/`TMP`/`TEMP` (research corrected D-03: not `--user-data-dir`). It is removed on close and after a crash,
  and swept at daemon start. Pages live in an in-memory browser context, so cookies (a loaded sign-in included) are
  never written where the agent's shell could read them. The user's own browser profiles and the system Chrome are
  never used. Downloads are refused.
- **One redaction.** `packages/browser-engine` (`@ocw/browser-engine`) holds the bots' redaction, isolated world,
  capture, safe zip extraction and site filter. The `brw` image and the runtime both use it, so a Work Zone agent reads
  exactly what a bot reads: passwords, one-time codes and secret fields show as `[redacted]`.

### 2. Delivery (D-05, D-06, D-16 … D-19, PD-20 … PD-22)

- **The runtime fetches the browser itself**, on first use or ahead of time with `ocw-runtime browser install`, for its
  platform, from the fixed Chrome for Testing storage URL, into `~/.ocw/browsers/<version>/` (or `OCW_BROWSERS_DIR`, a
  location only). The sha256 and the size of each platform's zip are pinned in the runtime's source
  (`apps/local-runtime/src/browser/pins.ts`), equal to the `brw` Dockerfile for Linux. A mismatch is a hard refusal.
  The server never sends a version, a URL or a hash. `install --from-zip <zip>` (CI, the proofs, offline hosts) still
  checks the pinned sha256.
- **Linux libraries.** The doctor runs `ldd` on the installed binary and prints one `apt-get install -y …` line built
  from the missing sonames (Ubuntu 24.04's `t64` names where they apply), and, where Ubuntu restricts unprivileged user
  namespaces, the AppArmor profile line. **The runtime never runs sudo** (P5).
- **Upgrade path.** Server: `ocw upgrade` (one additive migration, `work_zone_browser`). Headless runtimes from v0.3.1
  update themselves to 0.5.0 under the runtime updates level (ADR-0040). The desktop app passes its version
  (`OCW_APP_VERSION` → `DeviceInfo.appVersion`), checks GitHub's latest release once a day and shows "Update available"
  with the release link; it never installs anything (the builds are unsigned until Phase 9).
- **Capability.** `hello.browser = { version: 1, optIn }`, and `capabilities.browser` when the opt-in changes. The API
  stores `devices.browser_version` / `browser_opt_in` and never sends a browser frame or a grant to a device without it.
  A session on such a device shows "Update this device to use the browser", and its tools are simply not offered.

### 3. Bridges (D-07 … D-09, PD-06 … PD-08, PD-11, PD-23)

- **One tool set**: `open`, `snapshot`, `act`, `screenshot`, `wait`, `close` and `signin`, with the bots' Zod bodies
  and limits (one shared refinement). The MCP server is `ocw_browser`; Claude shows `mcp__ocw_browser__open`; audit,
  approvals and admin rules use `ocw_browser_open`.
- **The daemon owns the browser** in both runtimes, behind one `BrowserManager` that decides every call.
- **Claude**: the in-process SDK server is registered only while the session's browser is available, and swapped
  between turns with `setMcpServers`. `mcp__ocw_browser__*` is allowed only from that registered server: `canUseTool`
  and a `PreToolUse` hook (which also runs in Full access) refuse a call whose server `source` is not `sdk`, and a
  repository server named `ocw_browser` (a non-`sdk` source in `mcpServerStatus()`) makes the browser unavailable for
  that session.
- **Codex**: the app-server starts with `-c mcp_servers.ocw_browser.*` overrides (`command` = the runtime's Node,
  `args` = the runtime's `browser-mcp`, `default_tools_approval_mode = "approve"`, `tool_timeout_sec = 960`). When the
  browser becomes unavailable, the app-server restarts without the overrides between turns and resumes the thread.
  - **Shim token path rule.** The shim authenticates to the daemon with a 256-bit token (64 hex) in exactly
    `<browsersRoot>/run/<sessionId>/shim-token` (0600, a regular file). The token is never in argv or env (both are
    visible to `ps`); the env names only the session and that file (plus `OCW_HOME` / `OCW_BROWSERS_DIR`, paths, since
    Codex passes an MCP server only a short list of variables). Any other path, or a bad token, makes the shim exit
    before serving, or the daemon answer "not allowed". Calls go over the control socket, a Unix socket or named pipe.
  - **Elicitations.** `mcpServer/elicitation/request` and `item/tool/requestUserInput` are accepted only for
    `ocw_browser` and only while this app-server runs our overrides, so a configured server of the same name never gets
    a yes; every other server's request is declined. The manager decides each call anyway. `requestUserInput` is matched
    to `ocw_browser` through the `item/started` `mcpToolCall` seen before it; none was ever recorded (with `approve`
    Codex sends none), and a question that arrives first is declined (fail closed).
  - **A user's `config.toml`.** A `mcp_servers.ocw_browser` entry there is overridden key by key (command, args, env,
    approval mode, timeout). Its other keys, such as `enabled_tools`, could still narrow the tools offered. Unverified,
    accepted: it can only take tools away.
  - An elicitation's `_meta.tool_params` and a completed `mcpToolCall`'s `result` carry the call's arguments and the
    screenshot's base64: never logged, persisted or forwarded.
- **Screenshots** reach the model as image content only when the session's model accepts images in the runtime catalog;
  otherwise the tool answers that screenshots need an image-capable model. Codex images stay baseline JPEGs (A-3).
- **Timeline**: browser tool rows carry only the action and the origin ("Opened `localhost:3000`"); every result's first
  text line is that summary, and the mappers never emit an `output`. Page text reaches the model only inside an
  untrusted-content block (D-13).

### 4. Governance and approvals (D-10 … D-14, D-34, D-35, PD-09, PD-10, PD-25, PD-26)

- **Three switches, all off by default, all required**: the organization's `WorkZonePolicy.allowBrowser` (Settings ›
  Work Zone policy › Browser), the device owner's `browser.optIn` in `~/.ocw/runtime.json` (the desktop's "Allow the
  browser on this computer", `ocw-runtime browser on|off`, `OCW_ALLOW_BROWSER` wins), and the device's `browser`
  capability.
- **Per turn, then per call.** The API computes a `SessionBrowserGrant` per turn (`browserGrantFor`: policy ∩ opt-in ∩
  capability ∩ the asker's prompt access ∩ the admins' rule modes ∩ the sign-in audience rule) and adds it only to the
  sent copy of `session.start` / `prompt`, never to `device_commands`. A running turn keeps its grant, as it keeps its
  permission mode. The device re-checks per call: its live opt-in (an opt-out closes every page), the running turn's
  grant, the scheme and host, and the lease pause.
- **Only `http:` and `https:`** pages open, before navigation and through links, redirects and pop-ups (D-12).
- **Cloud metadata hosts are refused** (D-35): `169.254.169.254`, `fd00:ec2::254`, `metadata.google.internal`,
  `metadata.goog`, `metadata`, `instance-data`, `instance-data.ec2.internal`, `100.100.100.200`, `169.254.170.2` and
  the IPv4-mapped spellings of the addresses, at
  three layers: the manager before navigation, Chromium's `--host-resolver-rules` (redirects included), and an abort of
  every request to them (subresources and frames too). DNS rebinding remains (Consequences).
- **Approvals** go through the Work Zone approval flow, decided by the manager (auto and bypass modes skip
  `canUseTool`, so the adapters never decide them): `host`, once per origin per session (10 minutes; "Allow for
  session" remembers it), never for `localhost`, `127.0.0.1` and `[::1]`, skipped by Full access; `admin_rule` for the
  admins' `always` and `when_tainted` modes on `ocw_browser_*` (loopback and Full access included; approver kinds are
  not honoured in v1, D-34); `signed_in_host` and `signin` (§ 6). **Who may answer is the API's decision**, from its own
  state, never from the request's fields: `host` and `admin_rule` → `work_session.approve`; `signed_in_host` → only the
  member whose sign-in is loaded; `signin` → only the author of the in-flight turn.
- **"Needs you" uses the same rule.** A member-only browser approval appears in another person's "Needs you" sidebar
  section only if that person may answer it: the indicator reads the same decision as the answer route, so an admin no
  longer sees a request that would answer 403.
- **Audit** (D-14, D-28): `work_browser.opened`, `.navigated`, `.acted`, `.closed`, `.refused`, `.signin_requested`,
  `.takeover_started`, `.takeover_ended`, `.signin_saved`, `.signin_loaded`, `.signin_revoked`, with `actorKind:
  "device"`, the device, the session, the user who asked the turn, and metadata of `scheme://host:port` and enum codes
  only. Never a path, a query, typed text, page text, a cookie or an absolute path (P1, P3).

### 5. Live view and the Redis transit exception (D-15, D-33, PD-12, PD-13)

- **Frames only while watched.** An API instance with viewers sends `browser.frames { on: true }` every 10 s; the device
  streams JPEG screencast frames (at most 4 fps, 960×600, quality 55) until `on: false` or 25 s without a ping. Frames
  ride the Device Link as binary frames (a 21-byte header, under the 256 KiB device frame cap, never split, latest wins)
  to a dedicated socket, `GET /api/v1/live/work-browser/:sessionId`.
- **Who sees them** (the research corrected D-15 to `work_session.read`): each frame is decided for the session's
  audience. While someone holds the lease, only the holder's socket receives frames (others: "Private sign-in in
  progress"); while a member's sign-in is loaded, only that member (others: "Private browsing for {member}").
- **The exception (D-33).** ADR-0029 says a person's typed input is never published. In the Work Zone the viewer's
  socket, the lease holder's socket and the device link may sit on different API instances, so two things cross Redis
  pub/sub **in transit only**, never persisted, logged or replayed:
  - live frames, as base64 on `ocw:wb:frames:<sessionId>`, published only while another instance announced viewers on
    `ocw:wb:watch:<sessionId>` within the last 25 s;
  - the holder's typed input, **only** inside the `browser.input` control frames the device hub forwards to the instance
    that holds the device link (`ocw:device:<deviceId>`), never on any other channel.

  Everything else on Redis carries ids only: lease announcements on `ocw:wb:lease` (organization and session ids), the
  takeover focus hint on `ocw:wb:focus` (organization, session and lease ids plus one "sensitive field" flag, never the
  value), the watch announcements, and the used upload ids. A storage state never touches Redis (P7). The leak sweep
  (WZB-11) watches Redis with `MONITOR` for the cookie and typed-text canaries.

### 6. Takeover and sign-ins (D-20 … D-32, PD-03, PD-14 … PD-17)

- **Take control** (D-20): only a person who can prompt the session and asked its current or last turn. One holder by
  a conditional update on `app.work_browsers`; the lease lasts 10 minutes after the latest input, with a warning at 9;
  it ends on hand back, socket close, access loss or page end. While it is held the agent's browser tools answer
  `paused`, with no budget or timeout spent. Input reaches the page only through CDP `Input.dispatch*`.
- **The web sends input only while holding control.** The web sends keyboard, pointer, wheel and paste events only
  after the server's first `lease` frame and only while it holds the lease. Input sent before that frame, or from any
  socket but the holder's, is dropped; the API records `lease_input` before it forwards any. A lease lost after input is
  abandoned: the page closes (`takeover_abandoned`).
- **The agent asks** (D-21): `ocw_browser_signin { host, reason }` posts a sign-in card addressed to the turn's asker
  only ("{agent} needs you to sign in to {site}", "Open and sign in", "Not now"), and the turn waits like an approval
  (15 minutes). A "yes" does not finish the call: the device waits for the save.
- **Hand back seals** (D-22, PD-15): "Done, save my sign-in" makes the API mint a one-use upload id (5 minutes, bound to
  session, member and origin) and send only `browser.handback { save: true, uploadId }`. The device exports only the
  cookies that domain-match the host (RFC 6265) and that host's origin storage (the bots' site filter), and PUTs it with
  the device JWT. The API filters again and seals only when the state changed since the takeover and still holds
  items. A sealed save closes the page. "Done" seals nothing.
- **The 1 MiB export cap.** The child answers in one frame of at most 1 MiB, so an exported state between about 1 MiB
  and `storageStateMaxBytes` (2 MiB) answers `too_large` and is neither uploaded nor re-sealed. Real sign-in states are
  far smaller.
- **Storage** (D-23, PD-03): the sibling table `app.work_browser_signins`, one row per organization × member × site,
  sealed as a `browser_session` secret with the AAD `<orgId>:<userId>:browser:workzone:<siteKey>`, which never opens a
  bot's seal nor the other way round (D-30). Owner-only in the API and under a restrictive RLS policy (admins
  included). Expiry = min(the kept cookies' expiry, the organization's sign-in maximum, default 30 days). Settings ›
  Keychain › Work Zone lists them with **Revoke**; revoking or expiry ends any page that has it loaded.
- **Load only in the member's own turns** (D-24, D-32, PD-16): on `open`, the device asks `browser.signin.load` (turn
  and origin bound). The API answers with the sealed state, on the requesting socket only, only when: the asker of the
  running turn is that member; the session was started by a person, not a bot; the device runs the session now; the
  policy and the opt-in still allow the browser; the sign-in has not expired; and the session's audience is that member
  plus at most the device's owner. The state rides only that reply frame and the device-JWT upload (never
  `device_commands`, events, audit, logs, Redis or a column) and is set into a new in-memory context (`storageState`,
  the research's correction of D-24), locked to its site.
- **The site lock** (D-26): on a page with a loaded sign-in, a navigation to another host needs the member's approval
  (`signed_in_host`, 15 minutes; Full access never skips it). The child aborts the navigation, remembers its URL and
  replays it after the member's yes; a **blocked form POST is replayed as a GET** (its body is not kept), and that
  host stays allowed on that page for the rest of the turn.
- **A loaded sign-in lives at most one member turn** (D-25, D-32, PD-17). It is re-sealed and closed before a turn of
  anyone else (or a bot) runs a browser tool, at the end of each of the member's turns (the transcript keeps what the
  agent read, the bots' lesson), at session end and on close: export → re-seal → close the whole browser process →
  `signin_unloaded`. A `browser.close { reason: "revoked" }` closes without re-sealing; one sent while the device was
  offline is covered by that end-of-turn unload.
- **Honest copy** (D-29): "Your sign-in will be used by the agent on {device} in your own turns only. The owner of
  {device} controls that computer." and "Sign-ins work only in sessions only you (and the owner of {device}) can see."
  In a wider session the agent's `signin` answers "Sign-ins work only in sessions only you can see."

### 7. Chromium's sandbox, and the container mode (PD-18)

Chromium's sandbox is always on. The only exception is the `container` mode: allowed only when the daemon itself runs
in a container (`/.dockerenv` or `/run/.containerenv`) **and** the owner set `browser.sandbox: "container"` in
runtime.json (or `OCW_BROWSER_SANDBOX=container`). It is never an automatic fallback; outside a container the doctor
fails it. The preferred way to run the runtime in a container is with the sandbox on, under the `brw` seccomp profile
(`infra/sandbox/browser/seccomp.json`). The headless server proof (`scripts/headless-server-proof.sh`) shows exactly
that in a clean container from the pinned `node:24.22.1-bookworm-slim` image: the install from the API,
`ocw-runtime browser on`, the pinned zip copied in and installed with `--from-zip`, the doctor's apt line run by the
proof as root, then a member's session reading a page served on the container's own `127.0.0.1`, with no Chromium
process started with `--no-sandbox`.

### 8. Existing teams (D-35, ROADMAP success criterion 5)

A team on v0.3.1 or newer that runs `ocw upgrade` gets the browser with no manual step on headless devices: they update
their runtime themselves (ADR-0040). Runtimes older than v0.3.1 lack the self-update and run the install command once.
Desktop users are told by "Update available". A device on an older runtime shows "Update this device to use the
browser" in the session instead of failing.

### 9. This record

Written at the end of the phase, from the decisions and every plan's SUMMARY. It edits no accepted ADR.

## Consequences

### Positive

- A coding agent can open, read and click through the app it is building on the device's `localhost`, in both
  runtimes, through one tool set and one decision point on the device.
- Bots and Work Zone sessions read pages through the same redaction and site filter (one package, one set of tests).
- The browser is governed like Full access: an admin, the device's owner and the device's own version must all agree.
- Members sign in once and reuse it in their own later turns, on any device that runs their sessions, without the
  sign-in ever touching the device's disk or another person's turn.
- Teams on v0.3.1 or newer get it by upgrading; Chromium is not in the installers.

### Negative and residual risks

- **The device is the boundary (A-5, measured).** On Docker Desktop's LinuxKit kernel 6.12.76 (no Yama, so
  `ptrace_scope` is absent): `fd_open=no environ_read=yes mem_open=yes`. The CDP pipe ends are socketpairs and cannot
  be reopened through `/proc/<pid>/fd` (ENXIO). But a program running as the device's user can read the browser's
  `/proc/<pid>/environ` and, where `kernel.yama.ptrace_scope` is 0 or Yama is absent, open `/proc/<pid>/mem`: it may
  attach to the browser and read its memory, a loaded sign-in's cookies included. With `ptrace_scope` ≥ 1 (Ubuntu's
  default) a process that is not an ancestor cannot attach. Hence: no secret in the child's env or argv, a sign-in
  loaded only for the member's turn, and the copy that tells the member the device's owner controls that machine.
- **DNS rebinding to metadata (D-35).** The refusal works on host names and address literals. A public name that
  resolves, or rebinds after the check, to a metadata address is not refused by name. Such a host is not loopback, so it
  asks once per session unless Full access is on. On cloud servers, operators should block the metadata address for
  the runtime's user (a host firewall rule) or run the runtime where that route does not exist.
- **Typed input and frames cross Redis in transit** between API instances (§ 5). Redis is part of the trusted control
  plane; nothing is stored there, and the leak sweep covers it.
- **Sign-ins only in personal sessions** (D-32): a session that a wider team can read never loads one. A member who
  needs a signed-in site works in a session only they (and the device owner) can see.
- **One page per session**, no downloads, no uploads, no visible window.
- **Runtimes older than v0.3.1** need the install command once.
- **Codex `config.toml`** keys we do not override (such as `enabled_tools`) could narrow the tools (unverified).
- **Large sign-in states** (above about 1 MiB) cannot be saved.

### Not in this phase

- Platform MCP connectors inside Work Zone sessions (the next phase reuses these bridges).
- Sign-ins in sessions started by bots.
- A visible browser window on the desktop, several tabs, downloads and file uploads.
- Desktop auto-install of updates (signed builds, Phase 9).
