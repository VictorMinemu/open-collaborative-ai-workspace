# ADR-0029: Bot sandboxes, sandbox packages and the live browser

## Status

Status: Accepted. **Date:** 2026-10-22. **Deciders:** Víctor Ruiz (Autofy Labs). Recorded at the phase gate (plan
07.8-29) from the owner's decisions C-01 … C-05 and D-01 … D-14 in
`.planning/phases/07.8-bot-sandboxes-plugins-and-live-browser/07.8-CONTEXT.md`, the research flags F-1 … F-10 in
`07.8-RESEARCH.md`, the three spike outcomes in `spikes/*/OUTCOME.md`, and the coordinator decisions taken while the
phase ran (the 07.8 SUMMARYs, including the policy, floor, DNS and hardening gap fixes).

**Supersedes, by name and without editing it,** three parts of [ADR-0010](0010-personal-bots-capability-model-and-tool-gate.md):

1. *D-08 "Parity"* (one dangerous list for catalogs, grants, plugin reports and the cell) becomes **host-aware**
   (`isDangerousToolName(name, host)`, § Dangerous names below). Without a host the rule is unchanged.
2. *D-08 "Taint"* (side-effecting = `ocw_memory_save`, non-read-only MCP tools, every plugin tool) gains the
   **confined tool flags** of `CONFINED_TOOL_FLAGS` for the 15 `ocw_sandbox_*` / `ocw_browser_*` tools.
3. *D-08 "Caps"* (8 tool calls per turn) no longer applies to confined tools: they have **their own per-turn budget**
   (40, `MAX_SANDBOX_CALLS_PER_TURN`). The 8-call and 5-web-call caps are unchanged for every other tool.

Everything else in ADR-0010 stands: the three layers, the fail-closed gate, the global deny list in the cell (OpenClaw's
own `exec`, `read`, `write`, `process` and `browser` stay denied there) and the residual prompt-injection risk.

**Extends** [ADR-0011](0011-openclaw-marketplace-trust-model-and-mcp.md) with **sandbox packages**: admin-approved,
pinned packages installed into a bot's sandbox instead of the cell. ADR-0011's native-plugin rules are unchanged; a
native plugin whose dangerous tools are only shell, file or browser tools is still refused, now with the reason "Runs
inside the bot runtime, not a sandbox. Use a sandbox package instead." Also builds on
[ADR-0025](0025-per-member-connectors-keychain-and-agent-templates.md) (egress rules, the member-account audience rule,
sealed member secrets) and [ADR-0026](0026-per-tool-approvals-and-work-zone-proposals.md) (`approvalForCall`, the
one-use grant bound to the action hash). None of them is edited.

## Context

A member gave a bot a URL. The bot had only OpenClaw's `web_fetch`: no JavaScript, no session, no way to ask a person to
sign in. The owner asked for two things (2026-10-14): every bot in its own sandbox where it can write files, run
commands and use the plugins ADR-0010 refuses today; and a real browser people can watch in a small floating window and
take over to sign in themselves. The Control Plane must keep deciding, auditing, limiting and stopping all of it
(principles 2, 3, 6, 9, 10 and 12; C-01).

## Decision

### Architecture: a platform sandbox service, option (b) (D-02, D-11, F-1)

- **Rejected, option (a): OpenClaw's own sandbox.** Its Docker backend drives the `docker` CLI from the gateway, so the
  cell would need the host Docker socket and bind-mounted state; named volumes (our cell's) are unsupported; its browser
  needs host-published CDP ports. A socket proxy (Tecnativa) filters by API section only, so `CONTAINERS + EXEC + POST`
  would let the cell create privileged containers next to the API and PostgreSQL. That is new host privilege for the
  cell, which D-02 forbids. OpenClaw's sandbox stays pinned `mode: "off"` (`infra/openclaw/render-config.mjs`).
- **Chosen, option (b).** A small broker, `sandboxd` (`apps/sandboxd`), is the **only** holder of the Docker API. The
  cell gets 15 static plugin tools (`apps/openclaw-channel/src/{sandbox,browser}-tools.ts`), each a credential-free
  caller of its own Agent Channel route. Every call flows cell → API → `sandboxd` → container, never back: a sandbox has
  no path to the API, the cell or any database (stricter than D-01's "except the Agent Channel endpoints", F-2).
- **The API decides every call** (`agent-channel/sandbox.ts` `decideSandboxCall`, shared by sandbox and browser
  routes): the turn's human from the ledger (`no_trigger` otherwise), the resolver's `sandbox.use` / `browser.use` for
  agent ∩ human, the organization switch, the kill switch, the bot's switch, the tool on the delivered turn, the
  budget under the turn's row lock, the organization cap under an advisory lock (checked before the approval, so a grant
  is never spent on a call the cap refuses), 07.5 `approvalForCall`, then one conditional claim. `sandboxd` is called
  only after the commit. Audit rows carry ids, codes, sizes, durations and hosts; a path appears as its length and
  SHA-256; never an argv, a URL path or query, file content or page text.

### The broker: fixed spec, labels, no default policy

- **Fixed container spec, built only by `sandboxd`** (`spec.ts`): user `10001:10001`, read-only root, `CapDrop: ALL`,
  `no-new-privileges`, `Init`, private IPC, `LogConfig none`, PIDs, memory = swap and CPU clamped into
  `[floor, HARD_MAX]` (0 or −1 never reach Docker as "unlimited"), `/tmp` tmpfs `noexec,nosuid,nodev`, one workspace
  volume and the read-only packages volume, no `Binds`, no ports, no `CapAdd`, env only `HOME`, `PATH`, `NODE_PATH`,
  `PYTHONPATH` and the proxy variables (no token, no `OCW_*`). Container limits: `sbx` 1 CPU / 1 GiB / 256 PIDs; `brw`
  1 CPU / 2 GiB / 512 PIDs / 512 MiB shm. Object names use 12 hex characters of `sha256(agentId)` (a UUIDv7 prefix is
  a timestamp).
- **Labels are the authority.** Every object carries `ocw.sandbox`, `ocw.namespace`, `ocw.org`, `ocw.agent` and its
  kind; any op inspects first and refuses a mismatch (`label_mismatch`). Kill, kill-org and purge act only by label;
  `sandboxd` refuses to start inside a container that carries the label it kills (D-14). At boot it adopts its labelled
  objects and sweeps package-run leftovers (`ocw-prun-*`, `ocw-pnet-*`, #260).
- **No default policy.** An organization's limits, kill state, egress modes and private hosts live in `sandboxd`'s
  memory only after the API pushes them. Without a pushed policy every op that starts or runs a container answers
  **409 `policy_missing`**; reads and deletes keep working through a network-none files helper. The API's client reacts
  to `policy_missing` by loading the organization's current policy, pushing it and **retrying the call once** (a killed
  organization's retry is still refused). On every new `sandboxd` boot id the events consumer **re-pushes every
  organization's policy** (`app.sandbox_organizations`, a narrow SECURITY DEFINER lister of organization ids), and a
  settings save, a kill, a resume and **a change of the 07.4 private hosts** (`PUT /keychain/private-hosts`) push at
  once. A push carries the settings version; a stale push never replaces a newer one, so a late re-push cannot undo a
  kill.
- **Files without the archive API.** Every file op is one exec of the root-owned `ocw-files` helper as 10001, the path
  as one argv item, content on stdin/stdout, every path confined by `realpath` to `/workspace` (symlinks out are
  `invalid_path`), writes atomic (temporary file + rename).
- **The image** (`infra/sandbox/sandboxd/Dockerfile`): the broker **bundled with esbuild** into one file (the plan's
  "tsdown, as the API" does not exist; the API runs `tsx`), no `node_modules` at runtime, on the approved
  `node:24.21.0-bookworm-slim@sha256:d6aa754f…` base. In the compose `sandbox` profile it runs **as root only to open
  the Docker socket**, with a read-only root, `cap_drop: [ALL]`, `no-new-privileges`, `init`, a `/tmp` tmpfs, no
  ports, and the internal `sandbox-control` network whose only members are `api` and `sandboxd`. The token comes from
  `pnpm ocw setup` (`OCW_SANDBOX_TOKEN`, ≥ 32 characters); `OCW_SANDBOX_URL` stays empty until the profile is on.
- **Residual risk, stated plainly.** `sandboxd` holds the Docker socket, which is root-equivalent on the host. What
  bounds it: tiny code, a server-built spec with no caller-supplied field, label-scoped operations, token auth on an
  internal network, no inbound path from a sandbox. **Host hardening we recommend** (docs/self-hosting/sandbox.md):
  rootless Docker or `userns-remap` for the daemon, a body-aware Docker authorization plugin (OPA) behind the socket,
  and later Kata Containers where the host has KVM (Hetzner dedicated, not Hetzner Cloud).

### Isolation (D-01, spike (i), D-14)

- **gVisor (`runsc`, systrap) where the host has it.** `OCW_SANDBOX_RUNTIME=auto` picks `runsc` when the daemon lists
  it, `runsc` fails closed when it is missing (`sandboxd` refuses to start, `ensure` answers 503), `runc` is explicit.
  gVisor `release-20261005.0` comes from the official GitHub release (Google's bucket returned 404), SHA512-verified,
  and the **whole tarball** is installed: `runsc` alone refuses to start without its `gvisor-bin/` sidecars.
- **Hardened runc otherwise**, with the weaker boundary named in Settings ("Hardened container · weaker isolation")
  and here. Docker Desktop on macOS has runc only.
- **Chromium's own sandbox (spike (i)).** Under `runsc` it runs **with its sandbox on** (renderer in its own user and
  PID namespaces, seccomp 2): `chromium+gvisor`. On runc the browser gets a seccomp profile (Docker's default plus
  `clone`, `setns`, `unshare` and `chroot`) and keeps its sandbox (`chromium`). On a host that restricts unprivileged
  user namespaces (Ubuntu ≥ 23.10, `kernel.apparmor_restrict_unprivileged_userns=1`) Chromium reports "No usable
  sandbox" and `brw` falls back to `--no-sandbox` with the hardened container as the only boundary:
  **`browserSandbox: "container-only"`**, shown in Settings. **Never silently under runsc**: there the agent refuses
  to start and `sandboxd` answers 503 (a posture the runtime cannot have is refused).

### Networks: per-bot internal networks and one shared egress hop (D-01, D-11, SBX-03)

- **Docker Engine ≥ 26 is required** (`sandboxd` refuses older): older internal networks forwarded DNS
  (CVE-2024-29018 / GHSA-mq39-4gv4-mvpx).
- Each bot gets **its own `internal: true` networks**: `net` for its shell and `bnet` for its browser. Peers on one
  internal network can reach each other, and the proxy names a policy by the network a connection arrives on, so the
  shell and the browser can have different egress modes, and the member's cookies never share a network with `exec`.
- **The `sandbox-egress` proxy is the single shared hop** of every bot network: the only other member of each one, and
  the only container `sandboxd` attaches to the one non-internal network it creates (`ocw-egress-out-<ns>`,
  inter-container traffic off). It is a CONNECT / absolute-URI proxy on plain Node, uid 10002, whose root-owned policy
  file it can read but not rewrite. It decides with the **same code as the API's 07.4 guard** (`@ocw/egress-policy`,
  extracted so the two cannot drift): name rules before any lookup, one lookup, every answer decided, connect to the
  first decided address only (no DNS-rebinding window), ports 80 and 443 only unless an exact private `host:port` is
  allowed, no TLS interception, no body, path or query logged; decision lines carry `{network, host, port, allowed,
  reason}` only.
- **No bot-to-bot path.** Before any allow-list, an answer is refused as **`proxy_self`** (any of the proxy's own
  addresses, from the policy and every interface), **`bot_network`** (inside any bot network of the namespace) or
  `attached_network` (inside any network the proxy is attached to), **even when the private hosts list it**. A policy
  file without bot networks or own addresses is no policy: every request is refused.
- **Proxy address by `ExtraHosts` (the DNS fix).** `runsc` does not answer Docker's embedded DNS (127.0.0.11) on
  internal networks, so a gVisor sandbox could not resolve `sandbox-egress` and had no way out (it failed closed).
  `sandboxd` therefore writes `sandbox-egress:<ip>` into every `sbx`, `brw`, installer and review container's
  `/etc/hosts` (IPv4 only, one entry), on every runtime, and **reads the proxy's address again on every container
  create or start**; a stopped container whose entry is stale is recreated (volumes kept). A running sandbox keeps its
  entry until its next start or restart, so after a proxy restart it fails closed until then (#279).
- **Egress modes** per organization: `off`, `allowlist`, `public`; defaults Browser `public`, Shell `allowlist`. Package
  review and install runs get a registries-only policy (the configured registries plus the private hosts), whatever the
  shell's mode, on their own per-run network.
- **The proxy's own refusal header is its alone (#254, this gate).** `X-OCW-Egress` is stripped from upstream answers
  and from bots' requests, so a site cannot make its own http page read as a proxy refusal.

### The browser container (D-05, BRW-01)

- **One `brw` container per bot**, separate from its shell. A stdio agent (`infra/sandbox/browser/agent.mjs`) drives
  Chromium **over a pipe** (`--remote-debugging-pipe`; no debugging port, no listening port in the container), with
  ephemeral contexts, service workers blocked, a single tab (pop-ups are closed), `--disable-quic` and the WebRTC
  non-proxied-UDP policy. Ops are serialised per context, each with a 45 s timeout; errors carry a fixed code, never
  page text.
- **Pins.** `playwright-core@1.64.1` (Apache-2.0, `sha512-BC4s8y6S…`) drives the **Chrome for Testing headless shell of
  Chrome stable 156.0.8078.47** (revision 1706539), downloaded from Google's official bucket and **sha256-pinned per
  arch** with `ADD --checksum` (`0d5acc62…` linux64, `955059fa…` linux-arm64). Not Playwright's bundled
  `156.0.8078.4`, which is a 156 **beta** (the kind of pin that left `brw` on the 153 beta with hundreds of fixes
  missing); the stable build is on the same milestone and branch, so the CDP protocol matches, and the browser smoke
  asserts the running version. **Every Chrome stable release needs the same bump** (new CfT build, new checksums, the
  smokes); nothing watches for it yet (#300). The apt list is checked at build time to come only from Debian 12
  origins.
- **First request after a cold start (hardening).** `sandboxd` used to attach to `brw` with a 2-byte `{}` request
  body that could reach the agent's stdin after the Engine hijacked the connection; the agent then read
  `{}{"contextId":…}` as one line, answered "not JSON" with no id, and the API reported `service_unavailable` (1 in 10
  fresh starts). **Root cause fixed:** the attach sends no body. **Defence in depth, not a retry:** every request is
  framed as `\n{json}\n` and the agent skips empty lines, so stray bytes become their own refused line and are never
  glued to a request. Proven 20/20 fresh starts (`run-stack-smoke.sh --only coldstart`).
- **Diagnostics through an allowlist.** The agent writes one JSON object per stderr line; `sandboxd` logs a line only if
  it parses as `AgentDiag` (fixed enums, `^[a-z_]{1,32}$` codes, uuids, bounded integers, unknown keys refused, ≤ 1 KiB),
  so no URL, host, page text, typed input or cookie can reach a log. Chromium's raw launch lines are dropped.

### What the bot reads: the E1 finding and the redaction design (D-07, F-4, BRW-03)

- **E1 (research experiment, confirmed on real Chromium).** Playwright's `ariaSnapshot`, CDP `DOMSnapshot` and
  `DOM.getDocument` print a typed password **in clear text**. No library default can be trusted.
- **The only page view is our redacting serializer** (`redact.mjs`): a value becomes `[redacted]` for `type=password`,
  `autocomplete` current-password / new-password / one-time-code, `-webkit-text-security`, a name, label, id,
  placeholder or aria-label matching `/pass|pwd|otp|code|pin|secret|token/i`, a field a person typed into during a
  takeover (marked in an isolated world the page cannot see or forge), and any text field the agent has no facts for
  (redact on doubt). Links carry no value. Text waits match the redacted snapshot, so they are no oracle.
- **Screenshots are masked on the decoded pixels** in the agent (a page script cannot move an overlay); after human
  input, iframes are painted out too. `ocw_browser_screenshot` is offered only to bots whose model accepts images
  (spike (ii), below).
- **There is no JavaScript, DOM, cookie, HAR or selector tool**; refs are opaque ids, and a schema walk refuses those
  keys anywhere in the contracts.
- **The API checks again.** It reads the snapshot raw and replaces any value a redacted node still carries, recording a
  `browser.redaction_incident` (ids and a count). A person's typed input is never logged, audited, published or stored
  (Semgrep `ocw.live-input-logging` over the API, `sandboxd` and the web live view, plus sentinel sweeps through logs,
  spans, Redis, every column and every model request at full stack).

### Live view and takeover (D-06, D-07, F-5, U-2, BRW-02)

- **Transport:** CDP `Page.startScreencast` JPEG frames, ack-paced at **≤ 8 fps**, 960×600 small and 1280×800 large
  (about 0.5 MB/s worst case, about one frame every 3 s idle), on a **dedicated binary WebSocket**
  (`GET /api/v1/live/browser/:contextId`) authenticated like the realtime gateway (`authenticateUpgrade`) and
  re-decided live (invalidation bus, cell config events, lease channel, a 1 s row poll, session recheck). One upstream
  stream per page; each viewer has a one-frame slot (latest wins, never a backlog); a 10 s heartbeat. Frames are never
  persisted or logged. WebRTC (neko) and Steel were rejected: extra ports or TURN, one session per instance.
- **Who watches** is the resolver's decision on a `browser_context` resource: `browser.watch` for readers of the
  conversation and the bot's owner; `browser.control` only for the member the bot works for (the requester), and only
  while they can watch.
- **Takeover privacy (F-5).** While a person holds the lease, **only the socket that took it** gets frames; everyone
  else, including the same person's other devices, sees "Private sign-in in progress" and receives zero frames.
- **Member-session privacy (U-2).** While a member's sealed session is loaded in a page, only that member receives
  frames; the bot's owner and other readers see "Private browsing for {member}".
- **The lease** lives on the context row (`controller_user_id`, `lease_expires_at`, a conditional `UPDATE`), 10 minutes
  after the latest input (warning at 9), kept every 30 s while input flows, released on hand back, socket close, access
  loss, kill or page end; dead leases are swept one minute past expiry (#271). While a takeover is active the bot's ops
  answer `paused` and cost no budget. Input reaches the page through `Input.dispatch*` only.

### Sealed member sessions (D-08, F-10, BRW-04)

- **Storage.** A separate table `browser_sessions` (not a vault item: the bot never addresses a cookie jar), sealed in
  the secret store as kind `browser_session` with AAD `${org}:${user}:browser:${agent}:${siteKey}`, **one per member ×
  site × bot** (U-3), owner-only in the API and by a **restrictive RLS policy** (admins included). `secrets.kind` had no
  database check; the phase added **`secrets_kind_check`**, so every future secret kind needs a migration.
- **What is kept (P-09).** The agent exports only cookies that domain-match (RFC 6265) the sign-in host and that host's
  origin storage; the API applies the same filter again (`keepForSite`). An identity provider's cookie is dropped.
- **When a hand back seals (#284).** The site's state is fingerprinted (SHA-256, in memory only) when the member takes
  control; **a hand back seals only when the site's state changed since takeover** (a consent cookie set before any
  sign-in, or a look-only hand back, seals nothing and the card waits again). Then the API **locks the open page to its
  site** in place (`contextLock`) before the seal is visible. **A lock failure ends the page as `crashed` and is
  audited with `lockFailed`**; the page is closed in `sandboxd` only after its row ended.
- **Use.** A session loads only into a **new** page, site-locked, only in that member's turns with that bot, and only
  where the 07.4 member-account audience rule holds (a DM with one human, an AI chat nobody else reads). Loading sets
  the turn's member data in the same transaction. It re-seals after every signed-in call and before the bot's close.
- **End.** Expiry is the earlier of the kept cookies' expiry and the organization's maximum (default 30 days, 1 … 90);
  the member revokes from Settings › Keychain (the pages that loaded it end); expired rows are purged after 7 days;
  a member who leaves and a bot that is deleted (soft delete included, #287) take their sessions and secrets with them.
- **Sign-in card.** A platform-owned `browser` card (agents cannot post one), 15 minutes, "Open and sign in" for the
  requester only; Not now is the card's denied decision. Electron cookie export stays rejected (infostealer pattern,
  MITRE T1539).

### D-13: signed-in data never leaves for another host without the member

D-13 is its own decision. Once a member's session has been loaded, the turn has **member data**, and:

- **Site lock in the browser agent.** A page with a session (or opened in a turn with member data) is locked to its
  site: every top-level or pop-up navigation to another host is aborted and reported as `blockedNavigation {host}`.
- **`CONFINED_TOOL_FLAGS` member-data rules.** `cross_site` on `ocw_browser_open` and `ocw_browser_act`, `egress_exec`
  on `ocw_sandbox_exec`. With member data, an open of another host, an act the lock stopped, and an exec while the
  shell's egress mode is not `off` each need **the requester's approval**: `approvalForCall(…, { floor: "always" })`,
  one call, **15-minute expiry** (`browserPendingTtlMs`), the page held while it waits. The egress mode is bound into
  the exec's canonical action, so an `allowlist` grant never serves a `public` call. A blocked act's grant re-runs once
  with `allowCrossSite`.
- **Personal bots included**: the floor applies to personal and team bots alike. On team bots P-11 refuses first (below).
- **Only the member decides (the member-session floor).** Under the floor (a signed-in act, a D-13 navigation, a D-13
  exec) the requesting member is the **only** decider, whatever 07.5 rule applies: admins, unit leads and named
  approvers neither see nor approve the request, and a rule cannot relax the floor. A rule that applies still counts
  (its id is stored and shown). This is **`tool_call_approvals.requester_decides`**, fixed at request time (immutable
  row) and **part of the action hash**, so a grant decided without the floor never serves a call under it. A second
  approver on top of the member is not built (the 07.2 primitive has one decision per request).
- **The re-run keeps member data**, exactly as it keeps taint, so an approved exec never runs on a turn without it.
- **Sticky per (bot, conversation) (#292).** `app.agent_member_data` (organization, bot, conversation, the sites loaded,
  first event) is written with the load; **every later turn of that bot in that conversation starts with member data**,
  because the bot's transcript still holds what it read. Its sites open without approval; with none known every host
  asks; a page opened without a session in such a turn is locked to its host. Closing a signed-in page marks nothing.
  **The mark ends only when the bot or the conversation is deleted** (FK cascade); there is no reset action yet
  (deferred). D-13 approvals rest on "a DM never gains a human": proven by test at the API (#298); a database trigger
  is deferred (#302).

### F-8: data flows only from a broader audience to a narrower one

- **P-11.** On a non-personal bot, once the turn has member data, `ocw_sandbox_{write,delete,exec,import}` answer 403
  `member_data` for the rest of the turn (read, list, process and share still work), so a team bot cannot copy what it
  read with Sam's sign-in into a workspace other members' turns read.
- **Downloads** made under a member session (or on a team bot with member data) go to the conversation as attachments
  of the reply; otherwise to the workspace (`downloads/<name>`); otherwise nowhere, said in the activity.
- **`ocw_sandbox_import`** copies an attachment into the workspace only when the conversation's audience covers the
  workspace's (`audienceCovers`, a pure resolver rule; unsure or over 1,000 people → refused `audience_narrower`).

### Sandbox packages with full dependency-tree pinning (D-03, F-3, extends ADR-0011)

Native OpenClaw plugins run in-process with the gateway, never in a sandbox, under either option (F-3). So "install
every refused plugin" is neither safe nor possible; D-03 becomes:

1. First-party `ocw_sandbox_*` and `ocw_browser_*` tools cover the exec, fs, process, browser and
   puppeteer/playwright classes.
2. **Sandbox packages** (npm, PyPI, Debian, ClawHub skill bundles) that an admin (`plugin.manage`) approves per exact
   version and installs into every allowed bot's sandbox, run through `ocw_sandbox_exec`. A bot can also install its
   own dependencies with exec, under the egress policy.
3. Native gateway plugins with dangerous surfaces stay refused; `code_execution` (hosted, paid) and `canvas` stay
   refused.

**What is recorded at review.** `sandboxd` resolves the **whole tree** in a throwaway `review` container (no bot id,
nothing persistent mounted, its own network, registries-only egress): npm `install --package-lock-only
--ignore-scripts` (the top tarball's sha512 must equal the lockfile's), `pip download` (each file hashed), the
`apt-get --print-uris` closure (each `.deb` sha256-checked, maintainer scripts reported, never run), the ClawHub
artifact. The API stores every entry `{name, version, integrity}`, the **lockfile** (≤ 2 MiB, ≤ 5,000 entries) and
`treeSha256 = sha256(packageTreeCanonical(entries))`, recomputed by the API (a broker that lies is 503), and mints an
HMAC **review token** binding organization, source, name, version, top sha256 and `treeSha256`. sha1-only npm entries
are scored `refuse` (`weak_integrity`). Approval re-runs the review live; any change of the top artifact **or of one
dependency** answers **409 `package_changed_upstream`** with the refreshed review. Approved pins are immutable (a
`BEFORE UPDATE` trigger for every role); a new version or a re-approval replaces the row.

**How installs use only the recorded set.** At a sandbox's next start, one `packageInstall` per package, in an
`installer` container with the bot's packages volume: the plan must name exactly the package, be pinned only by sha512
or sha256, and hash to `treeSha256`. npm runs **`npm ci --ignore-scripts`** from the stored lockfile, recomputes the
tree from what was downloaded, then runs lifecycle scripts with `npm rebuild` still inside the installer. PyPI runs
**`pip download --no-deps --require-hashes`** and then **`pip install --no-deps --require-hashes --no-index
--find-links`** (no resolution, no index at install time, no build isolation fetching outside the set). Debian and
ClawHub check sha256 per file. Everything stages on the run's own labelled scratch volume; only a verified build is
copied in and renamed into place. The shell mounts the packages volume read-only.

**The republished-dependency refusal.** A dependency republished upstream after approval gives `digest_mismatch` or
`tree_changed`: nothing is written to the bot's volume, the install row is `failed`, the package is marked **changed
upstream**, the exec still runs, and **there is no silent retry** until an admin re-reviews and re-approves.

Risk scoring: install script → medium; a license the dependency guard denies, or none → high; one typo from a top
package by another publisher → high (needs "install anyway"); the OpenClaw platform itself → refuse.

### Durable usage-event cursor (SBX-01)

`sandboxd` keeps a 5,000-event ring with a monotonic `seq` and a per-process `bootId`. One API process consumes it
(session advisory lock on a dedicated connection, standbys wait). For each event, one transaction for its organization
locks **`sandbox_event_cursor`**, skips the event unless its `(bootId, seq)` is newer, applies it (state mirror, CPU
into `sandbox_usage_daily`, disk, hourly-deduplicated egress audit, browser handlers) and **advances the cursor in the
same transaction**. A replay after an API restart or a lock hand-over therefore **never double-counts CPU** or repeats
an audit. A new boot id is served from its first event and triggers the policy re-push above.

### Switches, modules and limits (D-09, D-12)

- **Organization switch** "Sandbox & Browser" (a setting, `sandbox_policies.enabled`), off by default; while off,
  nothing runs anywhere. Turning it on shows the isolation sentence the server reports.
- **Modules** `sandbox` and `browser` (07.3 catalog, grains `sandbox.use`, `sandbox.files`, `browser.use`,
  `browser.watch`, `browser.control`; agents hold only `.use`) with **no rows by default**: an admin or lead turns them
  off per unit. No seeded deny rows and no backfill (D-12 supersedes F-6).
- **Per-bot switches** Sandbox and Browser, off by default, set by the bot's configurer.
- **Limits** per organization (versioned settings, `expectedVersion`): concurrent sandboxes (default 10), browsers (3),
  CPU minutes per day (600), disk per bot (2 GB) and total (50 GB), sign-in maximum (30 days); plus the **kill switch**
  (`bot.manage`), which stops every sandbox and browser at once, is pushed to `sandboxd`, and keeps files.
- **Files for people (D-04).** `sandbox.files` on a bot requires `bot.configure` on it (a resolver prerequisite);
  everyone else gets the 404 of an unknown bot. Downloads go through the API as attachments, never a sandbox URL.

### Taint and the per-turn budget (F-7)

| Tool | Untrusted output (taints) | Side-effecting | Member-data rule |
|---|---|---|---|
| `ocw_sandbox_exec`, `_process`, `_read`, `_list` | yes | no | `egress_exec` (exec only) |
| `ocw_sandbox_write`, `_delete`, `_import` | no | no | none (P-11 on team bots) |
| `ocw_sandbox_share` | no | **yes** (leaves the sandbox) | none |
| `ocw_browser_open`, `_snapshot`, `_screenshot`, `_wait` | yes | no | `cross_site` (open) |
| `ocw_browser_act` | yes | **only while a member session is loaded for the page** (then the member-session floor) | `cross_site` |
| `ocw_browser_close`, `_signin` | no | no | none (never approvable) |

Confined tools count against **40 calls per turn** (`MAX_SANDBOX_CALLS_PER_TURN`), never the 8-call cap. A turn's flags
can only make a confined tool stricter. 07.5 rules apply to every confined tool except close and sign-in.

### Refusal statuses: the 403 / 409 split

Sandbox and browser routes map refusals by `SANDBOX_REFUSAL_STATUS` / `BROWSER_REFUSAL_STATUS`: **403 for decisions**,
including **`no_trigger`**, **`cap_reached`**, `budget_exhausted`, `cpu_budget`, `tainted`, `member_data`,
`audience_narrower`, `killed`, `sandbox_off`, `bot_off`, `not_allowed`; 409 for state and approvals (`approval_*`,
`policy_changed`, `busy`, `disk_full`, `paused`, `element_gone`); 404 `not_found` / `no_context`; 413, 422, 503. The
**07.4 connector and keychain routes keep 409** for `cap_reached` and `tainted` (shipped, unchanged). The split is
accepted: the plugin keys on the refusal **code**, never the status.

### Disk: a soft quota (F-9)

Docker named volumes have no size quota. `sandboxd` measures the workspace with `du -sb` (apparent size, so sparse files
count in full) through the files helper, before a write (`assertRoom`, 409 `disk_full` with nothing written) and on
every sweep (60 s); over the quota it stops the sandbox (`disk_full`) until files are deleted. Exec writes can overshoot
for up to one sweep. **There is no quota on the per-bot packages volume** (#261); approved trees are bounded only by
the host. A hard limit is host hardening: **XFS project quotas** (`pquota`) for Docker's volume directory.

### Spike (ii): images from a plugin tool reach the model only with image input

In a real OpenClaw 2026.9.7 cell a tool's image block is dropped ("model does not support images") unless the provider
model is declared `input: ["text", "image"]`; then it reaches Chat Completions models as a **user** message after the
tool message. So `ocw_browser_screenshot` is offered only to image-capable models (`modelAcceptsImages`, a hand-kept
family list), the cell snapshot carries `imageModels` and the reconciler renders `input`. The screenshot's untrusted
output taints the turn. Every `ocw_*` tool must be listed in `openclaw.plugin.json` `contracts.tools`.

## Consequences

- A bot can work in files, run commands and use a real browser while the Control Plane decides, budgets, audits and can
  stop every call; one bot can never reach another's sandbox, browser or files, and no sandbox can reach a platform
  service.
- A person signs in for a bot without the bot, the model, a log or the audit ever seeing the password, and the session
  serves only that person's private turns with that bot, never another host without their yes.
- Operators choose the isolation: gVisor with Chromium's sandbox on, or hardened runc with the weaker boundary stated.
  docs/self-hosting/sandbox.md and `infra/sandbox/README.md` explain the profile, gVisor, rootless Docker, XFS quotas.
- **The OpenClaw upgrade checklist (ADR-0010, ADR-0026) gains:** OpenClaw's sandbox still pinned `off`; every `ocw_*`
  tool in `contracts.tools`; the image-input rendering of spike (ii) (`SMOKE_ONLY=bot_sandbox,bot_browser`).
- **The Chrome checklist:** every Chrome stable release, bump the CfT headless shell and its two checksums, keep the
  playwright-core milestone matching, re-run the browser, stack and journey smokes (#300).

### CVE status at the gate (OSV and GitHub advisories, 2026-10-22, last query 09:49Z)

| Pin | Status |
|---|---|
| `openclaw@2026.9.7` | 0 advisories. Clean |
| `playwright-core@1.64.1` | 0. Clean |
| Chrome for Testing **156.0.8078.47** | Current linux stable (Chrome version history and CfT `last-known-good-versions`, 09:22Z). The 153 beta that 07.8-28 found blocking was replaced in the hardening pass |
| gVisor `release-20261005.0` | 0 (OSV Go `gvisor.dev/gvisor`, repository advisories). Clean |
| `esbuild@0.28.2`, `zod@4.6.5` (sandboxd bundle) | 0. Clean |
| `node:24.21.0-bookworm-slim@sha256:d6aa754f…` base | Debian packages move with bookworm-security at rebuild (apt not snapshot-pinned, #236, #238) |
| Docker Engine (CI dind 29.8.2, Docker Desktop 29.6.2 on dev machines) | Fixes after 29.8.2 (29.9.0–29.9.2: Go HTTP/2 and TLS, containerd pull) are not reachable by a bot: sandboxes never hold the socket, pull or build. Accepted; bump to 29.9.2 (#299) |

### Validation

Unit, integration (real PostgreSQL and Redis; the registry-derived cross-tenant matrix over 37 routes; sentinel sweeps
through columns, logs, spans, Redis and every answer), the five real-Docker smokes and the orphans check, the real
OpenClaw cell (`bot_sandbox`, `bot_browser`), the full-stack proof (`scripts/sandbox-proof.sh`, real cell, API,
`sandboxd`, `brw` and Chromium: E1, takeover and member-session privacy, D-13 with `/collect` hits 0), real-browser e2e
at 1440 and 390 in light and dark (incl. `browser-journey` on the real broker), `pnpm gate:compose` with and without the
sandbox profile; recorded in `07.8-VALIDATION.md`. **Owner check pending:** `docs/DEMO.md` › Sandboxes and live browser.

### Deferred

- From the phase brief: CAPTCHA solving, shared team browser sessions, recording or replaying sessions, desktop
  (non-browser) computer use, session-scoped approvals (signed-in actions ask per action), stdio MCP servers inside
  sandboxes, Kata Containers.
- A product action to reset a conversation's member data (#292, #298), and a database trigger for "a DM never gains a
  human" (#302).
- The open 07.8 ledger entries at the gate, by id: #235, #236, #238, #242, #243, #244, #245, #248, #250, #252, #256,
  #257, #258, #261, #262, #264, #266, #267, #268, #269, #270, #274, #277, #278, #279, #280, #281, #282, #283, #285,
  #288, #289, #290, #293, #298, #299, #300, #301, #302, #303, #304 (`.planning/WINDOWS.md`; #251 and #254 are fixed
  by this gate). #303 (the web keeps the previous session's query cache when a session expires without a sign-out) and
  #304 (other `useTopic` callers may multiply invalidations) predate this phase.
  The ones that change behaviour: version listing for packages (#268), IME composition in the live view (#280, #289),
  a running sandbox keeping a stale proxy entry after a proxy restart (#279), a 15-minute sign-in expiring under a
  member still in control (#285), and the CI image and Woodpecker evidence owed at the first push (#277, #301).
