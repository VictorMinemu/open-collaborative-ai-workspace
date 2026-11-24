# ADR-0044: An organization's subscription accounts form a pool for the Work Zone and bots

## Status

Status: Accepted. **Date:** 2026-11-24. **Deciders:** Víctor Ruiz (Autofy Labs). Recorded in the first wave of the
phase (plan 07.18-03), before any behaviour lands. The owner, quoted from the phase context:

> "to finish the MVP, the Work Zone (local Claude Code or Codex) and the bots connect to an internal pool of accounts,
> so that when one runs out the next one is used, or round-robin; the distribution options are configurable"

The decisions are D-01 … D-14 in
`.planning/phases/07.18-subscription-account-pool-work-zone-local-claude-code-and-co/07.18-CONTEXT.md` (taken by the
agent under the owner's full-autonomy grant), the planner decisions PD-01 … PD-26, the edge cases E1 … E17, the
prohibitions P1 … P7 and the flagged assumptions A-01 … A-08 in `07.18-01-PLAN.md` (the phase hub), and the research in
`07.18-RESEARCH-NOTES.md`. The owner's full-autonomy grant makes CONTEXT's decisions the acceptance.

**Extends, without editing it:** [ADR-0006](0006-subscription-sign-in-inside-the-cell.md). The cell keeps OpenClaw's
own sign-in and refresh, and ChatGPT tokens still never leave the cell. This record allows several sign-ins in the
cell, one profile per pool account, and sends Claude setup-tokens to the cell over `GET /cell`.

**Does not change:** [ADR-0017](0017-sign-in-with-chatgpt-per-member.md). AI chats stay per member, on the member's own
ChatGPT plan, and are never pooled (P5).

**Builds on:**

- [ADR-0003](0003-infrastructure-baseline.md): secrets by `SecretReference`, sealed in the secret store.
- [ADR-0012](0012-full-access-mode-and-shared-devices.md): bypass modes and shared devices. Untouched: an account
  changes who pays for a turn, never what the turn may do.
- [ADR-0032](0032-runtime-cli-updates.md) and [ADR-0040](0040-runtime-self-update.md): CLI and daemon updates.
  Untouched.

### Replaced statements

| Statement (verbatim) | Where | What replaces it | What stays |
| --- | --- | --- | --- |
| "each customer runs the Work Zone with their OWN Claude Code / Codex subscription logins on their OWN device (BYO subscription; we never provide, pool or proxy subscriptions)" | `.planning/STATE.md`, Work Zone note of 2026-10-02 (not an ADR) | For an organization that adds pool accounts, its Work Zone sessions run on the organization's own pooled accounts (§§ 1–6). | A device's own login keeps working exactly as before, and is the fallback (§ 5). We still never provide an account and never proxy one. |
| "Each customer connects their own subscription to their own self-hosted instance; we never pool or proxy subscriptions." | ADR-0006, Context | An organization may pool the subscription accounts it owns, for its own bots and Work Zone (§§ 1, 2, 9). | Each customer brings its own accounts to its own instance. Nothing is pooled across organizations. We never proxy. |

## Context

### What the PRD asks for

PRD § 55 "Provider Pools": "An organization will be able to create pools." The router decides the account according to
availability, quota, consumption, rate limit, cooldown, errors, priority, latency, model, organization policy and
workspace access, and "It will not be limited to simple round robin." This phase covers availability, rate limit,
cooldown, errors, priority (and weight) and organization policy. Latency, model and consumption-based routing are not
built.

### How each runtime authenticates (research)

**Claude Code and the Agent SDK.**

- Auth precedence: cloud provider > `ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY` > `apiKeyHelper` >
  `CLAUDE_CODE_OAUTH_TOKEN` > profiles > the `/login` credential. A pool token passed as `CLAUDE_CODE_OAUTH_TOKEN` only
  wins once the first three are stripped.
- `claude setup-token` is Anthropic's own sign-in flow. It prints a one-year OAuth token, saves it nowhere, serves model
  requests only and needs a Pro, Max, Ultra, Team or Enterprise plan. No refresh is documented. Usage reads need a
  "profile" scope this token probably lacks.
- `CLAUDE_CONFIG_DIR`: each directory has its own login, settings and history. The SDK's `Options.env` replaces the
  subprocess env for each `query()`.
- Limit signals: `rate_limit_event` (`status: 'allowed' | 'allowed_warning' | 'rejected'`, `resetsAt`,
  `rateLimitType` `five_hour | seven_day | seven_day_opus …`, `utilization`); assistant `error: 'rate_limit' |
  'billing_error'`; the text "You've hit your session limit · resets 3:45pm" (the SDK exports
  `USAGE_LIMIT_ERROR_PREFIXES`, marked @alpha).
- Transcripts live under `$CLAUDE_CONFIG_DIR/projects/`. Resuming under another token with the same config dir is
  plausible but unverified (A-01). Prompt caches are per organization, so a switch is a full cache miss.

**Codex.**

- Auth is per process: `CODEX_HOME/auth.json`, refreshed by Codex itself. Refresh tokens rotate
  (`refresh_token_reused`), and OpenAI's CI guide says: "Do not share the same file across concurrent jobs or multiple
  machines." A copy held by our API would go stale.
- The app-server v2 account methods: `account/login/start` takes `chatgpt`, `chatgptDeviceCode`, `apiKey` or
  `chatgptAuthTokens`; the last one is marked "OPENAI INTERNAL USE ONLY". Also `account/read`, `account/logout`,
  `account/updated`, `account/rateLimits/read` and `account/rateLimits/updated` (`primary` / `secondary`: `usedPercent`,
  `windowDurationMins`, `resetsAt`), whose comment says clients "must not infer recovery from percentages".
- Limit signals: HTTP 429 `usage_limit_reached` with `resets_at`; in v2, `codexErrorInfo: "usageLimitExceeded"`.
- OpenAI's documented way to change account is to restart app-server with the new credential, then `thread/resume`.
  Rollouts live under each `CODEX_HOME`, so slots must share them. Whether encrypted reasoning is bound to an account
  is unverified (A-02).

**OpenClaw 2026.9.7 (the pinned image).**

- Several profiles per provider (`openclaw models auth login --provider openai --profile-id <id>`).
- Order: `models auth order set` / the gateway's `models.authOrderSet` > `auth.order.<provider>` > stored. With no order,
  OpenClaw goes round-robin by least recently used and puts cooling accounts last. It has no weighted mode.
- A session keeps its profile and changes it on cooldown, `/new` or `/reset`. On a rate limit OpenClaw tries the
  provider's other profiles first, then the fallback models, with a 30 s → 1 min → 5 min cooldown that follows
  `Retry-After`.
- SecretRef covers API keys and static tokens only, not ChatGPT OAuth, which OpenClaw refreshes itself.
- Our code today signs in one profile per provider into the shared `main` agent store, reports the first usable
  profile, removes every profile on sign-out, keeps one `model_providers` row per organization and provider, and sets
  no `auth.order`.

**Existing multi-account tools.** CLIProxyAPI is a proxy that imitates the official client. better-ccflare is a proxy
with session-sticky routing; it removed round-robin and weighted routing because they "can trigger Claude's anti-abuse
systems" (github.com/tombii/better-ccflare, `docs/load-balancing.md`). codex2api (`round_robin | remaining_quota |
fill_first`), codex-lb (sticky threads) and CLIProxyAPI (`round-robin | weighted-round-robin | fill-first`,
session-affinity, cooldown) show the same vocabulary. We build none of them and sit between no CLI and its provider.

### The providers' terms (verbatim)

- Anthropic, code.claude.com/docs/en/legal-and-compliance:
  - "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to
    route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users."
  - "Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the
    Agent SDK."
- Anthropic consumer terms: "You may not share your Account login information … or Account credentials with anyone
  else."
- OpenAI Terms of Use: "You may not share your account credentials or make your account available to anyone else" and
  "circumvent any rate limits or restrictions".
- OpenAI Services Agreement: "Customer will not share Account access credentials or individual login credentials
  between multiple users" and "(i) violate or circumvent Usage Limits".

**The owner read these terms and decided to build the pool.** The accounts belong to the organization that adds them,
and so does the risk under each provider's terms. The platform does not provide accounts, does not pool across
organizations, does not imitate the official clients (each account is used only through Claude Code, the Agent SDK,
Codex or OpenClaw's own sign-in) and does not rotate per request (§ 4). This record states the terms so the decision
is on record; it does not claim the use is permitted. The admin documentation (plan 17) states them too.

## Decision

### 1. One pool per organization and provider (D-01, D-03, PD-11, PD-19, PD-20, PD-25)

- Two providers: `claude` (Claude Pro, Max and Team accounts) and `chatgpt` (ChatGPT Plus, Pro and Business accounts).
  Each account has a label typed by the admin (an e-mail, a name), an `enabled` flag, a `priority` (its place in the
  order) and a `weight` (1–100). At most 20 accounts per provider.
- `app.account_pool_accounts` keeps one row per account: organization, provider, label, kind (`token`, `device_slot`
  or `cell_profile`), its credential handle (a secret reference, a device and slot, or a cell profile id), enabled,
  priority, weight, `cooldown_until`, `limit_reason`, `last_used_at`, `wrr_current` and the last usage snapshot.
  `app.account_pool_policies` keeps the strategy, the scope and `fallback_to_device_login` per organization and
  provider. Both are organization-scoped with a restrictive RLS policy (D-03).
- **Only admins write the pool** (`provider.manage`, PD-19). Every change is audited in the same transaction:
  `account_pool.account_added`, `.account_updated`, `.account_removed`, `.reordered`, `.policy_changed`,
  `.sign_in_started`, `.signed_in`, `.sign_in_failed`, `.slot_reported`, `.limited`, `.switched` (PD-20). Metadata
  carries ids, provider, kind, label, reason and times, never a token, a user code or a verification URL.
- Rows an admin creates start enabled. A Codex slot a device reports that no admin started (`origin: "cli"`) arrives
  disabled and audited `account_pool.slot_reported`; an admin enables it (PD-11).
- **Removal is soft** (PD-25): `removed_at` is set, a token's secret is deleted, a slot is signed out on its device and
  a cell profile in the cell. Sessions that used it switch at their next dispatch (§ 4).

### 2. Each credential lives where its runtime can use it safely (D-02, PD-02, PD-03, PD-04, PD-10, PD-12, PD-21, PD-22)

**Claude for the Work Zone: a setup-token, sealed, given to one session in memory.**

- The admin runs `claude setup-token` and pastes the result. It must look like a setup-token (`sk-ant-`, 20–512
  url-safe characters); an `sk-ant-api…` value is refused (`api_key_not_allowed`, "This is an API key. Add it in
  Settings › Models."), because organization API keys already live there as METERED models (PD-22).
- It is sealed in `app.secrets` with kind `pool_token` and AAD `<orgId>:account_pool:<accountId>`. Only
  `account-pool/tokens.ts` seals and opens it (PD-21). It is never shown again.
- **Never stored with a command** (PD-02). `device_commands.payload` keeps `account: { kind: "token", accountId,
  label }` only. When the hub flushes the command, the API opens the token and adds `oauthToken` to the frame actually
  sent, never written back (the 06.1 image pattern). A token that cannot be opened at send time fails the command with
  `account_unavailable`.
- The daemon passes it to that session only, as `CLAUDE_CODE_OAUTH_TOKEN` in the SDK's `Options.env`, with
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `apiKeyHelper` stripped, because they win over it. It is never written
  to disk on the device, never logged and never sent back.
- Sessions keep the daemon's one `CLAUDE_CONFIG_DIR`, so the transcript stays on the device and a session can resume
  under another account (A-01).

**ChatGPT for the Work Zone (Codex): signed in on the device, one `CODEX_HOME` per slot.**

- Because refresh tokens rotate and `chatgptAuthTokens` is internal to OpenAI, the API never holds a ChatGPT token for
  Codex. An admin starts Codex's own device-code login on a chosen service device, from Settings or
  `ocw-runtime account add codex`, and the sign-in runs there.
- Each slot is `<ocw home>/accounts/codex/<slotId>/` (mode 0700), with metadata in `slots.json` beside it. Its
  `sessions/` is a link to the daemon's default Codex home's `sessions/`, so device-login and slot sessions resume each
  other's threads, and `config.toml` links the default one when present (POSIX; on win32 a directory junction for
  `sessions` and no config link). Only Codex writes `auth.json`. Removing a slot unlinks both links first, then removes
  the directory (PD-10).
- The daemon reports each slot (id, label, origin, signed in, plan type, usage snapshot) in `accounts.sync`. The server
  lists it as an account usable on that device only. **A slot never sends a token, and no device frame carries an
  account e-mail** (P2).

**Bots (OpenClaw): one profile per pool account, inside the cell.**

- Each ChatGPT account for bots is signed in **inside the cell** with its own profile id `openai:pool-<accountId>`
  (ADR-0006 stays: OpenClaw refreshes it and it never leaves the cell). When the pinned login flow takes no profile id
  (A-03), the id it returns is stored. Sign-out removes only that profile.
- **Adoption** (PD-12): every connected profile the cell reports that the pool lacks becomes a pool row (`origin:
  "adopted"`). The pre-07.18 `model_providers` sign-in thereby becomes the pool's first ChatGPT account with no SQL data
  migration, and keeps working.
- Claude accounts reach the cell as the same setup-tokens, over the authenticated `GET /cell` like provider API keys,
  as an `anthropic:pool-<accountId>` token profile per account, read from an `OCW_POOL_TOKEN_<n>` env SecretRef. If
  token profiles do not take precedence over the Anthropic API key (A-05), `CELL_CLAUDE_TOKENS` is false: the cell gets
  no Claude tokens and Settings says "Bots use the Anthropic API key", stated, never silent.

**Pool support is a device capability** (PD-04). The daemon sends `hello.accountPool = 1`; the API stores it as
`devices.account_pool_version` and never selects a pool account for a device without it. Such a session runs on the
device's own login and says so. Every `session.start` and `prompt` to a capable device carries `account` (an object,
or null for the device's own login); on a prompt, absent means "keep the current one" (PD-03).

### 3. Strategies (D-04, PD-07)

Per organization and provider:

- `failover` (the default): always the first usable account by priority; the next one only while it cools down.
- `fill_first` is the same as `failover`. It is accepted as a choice and stored as `failover`; the UI calls it "Use one
  until its limit, then the next".
- `round_robin`: the usable account used least recently.
- `weighted`: usable accounts in proportion to their weight, drawn by deterministic smooth weighted round-robin
  (`wrr_current` per account), so tests are exact (E2: weights 5/1/1 give the exact smooth sequence).

**Deterministic and serialized** (PD-07). `pickAccount` is a pure function. `selectAccount` inserts the default policy
row if it is missing, locks it `FOR UPDATE`, reads the candidates, picks, and writes `last_used_at` (all strategies)
and `wrr_current` (weighted) in the same transaction. Ties break by priority, then creation time, then id. Two
concurrent starts under round-robin take two different accounts (E1).

### 4. Sticky per session, never per request (D-05, PD-06, P3)

- The strategy chooses an account **when a session starts or when its account must change**, never per request.
- A Work Zone session keeps its account for every turn. Before every dispatch, `ensureAccount` keeps it while it is
  usable. An account that was removed, disabled, needs sign-in, is cooling down or is a slot of another device is
  replaced at once (the switch reason is `limit` with its time when cooling, else `unavailable`; E7).
- A session on the device's own login stays there until that login hits a limit; then it moves to a ready pool account
  (E17).
- A bot conversation keeps OpenClaw's own session stickiness; the API sets only the order (§ 9).

**Why.** Prompt caches are per account, so every switch is a full cache miss: per-request rotation would pay it on
every turn. And per-request rotation is the pattern multi-account tools report as triggering the providers' anti-abuse
checks; better-ccflare removed round-robin and weighted routing for that reason. A strategy here therefore spreads
**sessions**, not requests.

### 5. Usable accounts and the fallback (D-06, PD-16, PD-17, PD-18)

- **Usable** = enabled ∩ not removed ∩ not cooling (`cooldown_until` in the past) ∩ signed in ∩, for a device slot, its
  device is the session's device.
- **Scope** (PD-18) applies to Claude token accounts: `all`, `work_zone` (kept out of the cell) or `bots` (kept out of
  the Work Zone). ChatGPT `device_slot` rows serve only the Work Zone of their device; `cell_profile` rows only bots.
- **Fallback** (PD-16). With no usable account, the session falls back to the device's own login (today's behaviour)
  when the organization allows it (`fallbackToDeviceLogin`, default on) and the runtime reports a login (E5).
  Otherwise the start is refused with `no_account`: "No account in the pool is ready. The earliest resets at <ISO>."
  (or "… Add one in Settings › Account pool." when no reset is known; E6).
- A start no longer needs a device login when the pool serves it: `createWorkSession` refuses an unsigned runtime only
  when no pool account was selected (PD-17).

### 6. Limits, cooldown and the switch (D-07, D-08, PD-05, PD-08, PD-14, PD-15, PD-23, PD-24)

- **Claude signals** (PD-24): `rate_limit_event` with `status: "rejected"` → limited, with `resetsAt` (`five_hour`;
  `seven_day*` → `seven_day`; `seven_day_opus|sonnet` → `weekly_model`; `overage` → `usage_limit`). Assistant `error`
  `rate_limit` → `rate_limit`, `billing_error` → `billing`. `authentication_failed` and `oauth_org_not_allowed` →
  `auth_failed`: the account becomes `needs_sign_in`, with no cooldown. A result or assistant text that starts with one
  of the SDK's `USAGE_LIMIT_ERROR_PREFIXES` → `usage_limit` with the last `resetsAt` seen. Once per turn.
- **Codex signals** (PD-23): `turn/completed` with `codexErrorInfo === "usageLimitExceeded"`, or an `error`
  notification with it and `willRetry` false → `usage_limit`; `unauthorized` → `auth_failed`. `resetsAt` is the latest
  `resetsAt` among the last reported windows at 100 % used or more, else null.
- The daemon sends `session.account_limited` (session id, prompt id, account id or null for the device's own login,
  reason, reset time), **never a credential**, and sends it before the turn's `prompt.completed` (PD-05).
- **Cooldown** (PD-08): the reset time, else 5 minutes, at most 7 days. A reset in the past or absent gives now + 5
  minutes; one beyond 7 days gives now + 7 days (E3). A second limit on a cooling account keeps the later of the two.
- **The switch** (D-08, PD-05). On the frame the API sets the cooldown, re-queues the in-flight prompt at its place
  (`queued`, `account_switches + 1`), and the arbiter re-dispatches the **same prompt, same id, as the same turn on the
  same session** with the next usable account: Claude resumes the same session id under the new env; Codex restarts
  its app-server under the new slot's `CODEX_HOME` and calls `thread/resume`.
- **Shown and audited** (PD-14). Each switch is audited `account_pool.switched` and the API itself appends the
  server-only session event `account.switched` to `ws:<id>`, rendered as "Switched to account B: A reached its limit
  until 15:40". A copy a device sends is dropped (E12). A successful switch clears `lastError`.
- **At most 3 switches per turn** (PD-15). The fourth limit is not switched: the prompt fails as the device reports it,
  with "Every pool account reached its limit for this turn. The earliest resets at <ISO>." (E4).

### 7. Usage only as the runtime reports it, never polled (D-09, PD-09, P4)

Claude's `rate_limit_event` utilization (a fraction) and Codex's `account/rateLimits/updated`, plus one
`account/rateLimits/read` after a slot's app-server starts, become `account.usage` frames, stored per account
(`usage`, `usage_at`) and shown in Settings. A frame names exactly one target (an account or a slot). No other endpoint
is called and no undocumented usage endpoint is polled.

### 8. Surfaces (D-10, D-11, PD-19)

- **Settings › Account pool** (admins): a Claude section and a ChatGPT section, each with its strategy and accounts
  (label, where it lives, status ready / cooling until hh:mm / needs sign-in / disabled, last used, usage bars when
  known), with add, remove, enable, reorder and weight. Adding a Claude account pastes a setup-token, with the
  `claude setup-token` instruction shown. Adding a ChatGPT account chooses "for bots" (sign-in in the cell, device code
  shown) or "on a device" (a service device; device code shown, the sign-in runs there).
- A Work Zone session shows its pool account's **label** in its header. The new-session dialog shows "Account: pool
  (failover)" (or the active strategy), "This device's login", or "No pool account is ready".
- Members see labels only (`WorkSession.poolAccount`, `GET /account-pool/preview` for a device they may use), never a
  token, a secret id or an e-mail field.

### 9. Bots keep their model (D-12, PD-12, PD-13, PD-18)

- A bot keeps its current model choice. When the pool for that model's provider has accounts, the cell uses them.
- **Order** (PD-13): `failover` → the explicit order of the enabled profiles by priority. `round_robin` and `weighted`
  → no explicit order while every bot profile of the provider is enabled (OpenClaw's own least-recently-used
  rotation), else the explicit order of the enabled ones. OpenClaw has no weighted mode, so Settings says "Bots don't
  support weighted. They use round-robin." Disabled profiles are never in an explicit order (A-04). The API sets the
  order through `models.authOrderSet`.

### 10. Security (D-13, PD-11, PD-19, PD-20, PD-21, PD-22, A-06)

- Tokens are sealed at rest, held in memory only on the device, scrubbed by `redact()` (the setup-token shape
  `sk-ant-oat01-…` is covered by the redaction patterns) and never in audit, events, logs, errors, a DTO or a route
  response (P1, E8). Only `SessionAccount` (server → device) and the cell's `accountPool.claude.tokens` over `GET /cell`
  carry one.
- Device slots never send tokens; device frames never carry an account e-mail (P2). A frame naming another device's
  slot or another organization's account changes nothing (E11). Tenant B cannot list, update, select or limit tenant
  A's accounts (E10).
- Only admins write the pool; device-reported slots arrive disabled (P6). The selection runs server-side only.
- **A project cannot redirect the token** (A-06). Flag settings `env.ANTHROPIC_BASE_URL` (the highest precedence)
  is expected to beat a project's `.claude/settings.json` env. If the probe shows otherwise, a project whose settings
  set `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `apiKeyHelper` gets no pool token: the start
  fails with "This project's Claude settings choose their own credentials; pool accounts are not used here" (E16).
- No proxy sits between a CLI and its provider (P4). Contracts and schema are additive; older daemons, plugins and webs
  keep working (P7, E9).

### 11. This record (D-14)

This ADR records the pool, the per-runtime credential placement and the sticky-session rule. It does not change
ADR-0017 and it extends ADR-0006. AGENTS.md carries one technology row, "Subscription account pool", citing it.

## Relation to other ADRs

- **ADR-0017, unchanged.** AI chats stay per member, on the member's own ChatGPT plan, never pooled. Claude in AI chats
  stays organization keys only (METERED). No pool account ever serves an AI chat (P5, PD-26).
- **ADR-0006, extended.** Several sign-ins in the cell, one profile per pool account (`openai:pool-<id>`), each signed
  in and refreshed by OpenClaw; ChatGPT tokens never leave the cell. Claude setup-tokens reach the cell like provider
  keys, over `GET /cell`. Per-profile sign-out replaces "sign-out removes every profile" for pool profiles (E15).
- **ADR-0003.** Setup-tokens are secrets by `SecretReference`, sealed (`pool_token`).
- **ADR-0012, untouched.** Bypass modes are decided exactly as before; an account never widens a session's mode.
- **ADR-0032 and ADR-0040, untouched.** The daemon still updates the CLIs and itself as those records say; account slots
  live beside, not inside, the versioned install.

## Consequences

### Positive

- Work continues across usage limits: a limited account cools down and the same turn re-runs on the next one.
- No proxy and no imitation of an official client: every account is used only through Claude Code, the Agent SDK, Codex
  or OpenClaw's own sign-in.
- Accounts signed in on a device never leave that device; ChatGPT accounts for bots never leave the cell; setup-tokens
  leave the secret store only to the session's device, in memory, or to the cell.
- The pre-07.18 bot sign-in becomes the first pool account with no data migration; a device's own login keeps working
  as the fallback.

### Negative and limits

- A switch is a full prompt-cache miss: the next turn on the new account costs more and runs slower.
- A device with no Claude login of its own has no model catalog, so its pool sessions start on the default model.
- Resuming across accounts is unverified until the owner's UAT (A-01, A-02). The stated fallback: the session reports
  "This conversation could not continue on the next account. Start a new session." and the prompt fails; there is no
  silent fresh start.
- OpenClaw has no weighted mode; bots fall back to round-robin and Settings says so (PD-13).
- The terms risk is the organization's. The providers' terms quoted in Context may be read to forbid this use; the
  owner decided to proceed, and the organization that adds the accounts owns them and that risk.
- A setup-token has no documented refresh; when it expires or is revoked, the account turns `needs_sign_in` and an
  admin pastes a new one.

### Not in this phase

- API keys in the pool (metered overflow after subscriptions run out).
- A custom base URL per runtime (LiteLLM or an own proxy).
- Polling usage endpoints for a live quota view.
- AI chats (ADR-0017), HTTP proxies and a hosted CLIProxyAPI (PD-26).

## Flagged assumptions

Each has a test or a probe and a stated fallback (from the phase hub).

- **A-01** Resuming a Claude session under another token with the same `CLAUDE_CONFIG_DIR` keeps the transcript.
  Probe: owner UAT with two real setup-tokens. Fallback: a failed resume reports `session.error` "This conversation
  could not continue on the next account. Start a new session." and the prompt fails (no silent fresh start).
- **A-02** Codex `thread/resume` under another `CODEX_HOME` with the shared `sessions/` works (encrypted reasoning may
  be account-bound). Probe: owner UAT with two ChatGPT accounts. Fallback: as A-01.
- **A-03** OpenClaw 2026.9.7's `runModelsAuthLoginFlow` takes a profile id. Probe: plan 07 reads the pinned image's
  dist. Fallback: PD-12 (store the returned id).
- **A-04** The gateway method `models.authOrderSet`, and whether an explicit order excludes unlisted profiles. Probe:
  plan 07 reads the dist. Fallback: PD-13 as written.
- **A-05** Anthropic token profiles with an env SecretRef take precedence over `models.providers.anthropic.apiKey`.
  Probe: plan 07. Fallback: `CELL_CLAUDE_TOKENS = false`: Claude pool accounts stay Work Zone only, the cell snapshot
  sends no Claude tokens, and Settings says "Bots use the Anthropic API key", stated, never silent.
- **A-06** Flag settings `env.ANTHROPIC_BASE_URL` (highest precedence) beat a project's `.claude/settings.json` env.
  Probe: plan 06 with the installed CLI and a local HTTP listener (a dummy token, no network). Fallback: a project whose
  settings set `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `apiKeyHelper` gets no pool token
  (the start fails with "This project's Claude settings choose their own credentials; pool accounts are not used
  here").
- **A-07** `rate_limit_event.resetsAt` and Codex `RateLimitWindow.resetsAt` are epoch seconds; `utilization` is a
  fraction. Pinned by tests; a value above 1e12 is read as milliseconds.
- **A-08** The device's Codex supports `account/login/start` with `chatgptDeviceCode` (present in codex-cli 0.172.0).
  Fallback: the sign-in ends `unsupported` with "Update Codex on this device and try again".
