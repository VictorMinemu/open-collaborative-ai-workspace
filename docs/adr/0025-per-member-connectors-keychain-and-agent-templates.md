# ADR-0025: Per-member connectors, the agent keychain and agent templates

## Status

Accepted (owner-delegated decisions C-01 … C-05 and D-01 … D-07 in
`.planning/phases/07.4-per-member-connectors-agent-keychain-and-templates/07.4-CONTEXT.md`, owner decision #191 in the
phase ledger; Phase 07.4, recorded at its gate, plan 07.4-14).
**Date:** 2026-10-13. **Supersedes** the "Deferred: per-human MCP OAuth" item of
[ADR-0011](0011-openclaw-marketplace-trust-model-and-mcp.md), and only that item. **Extends**
[ADR-0010](0010-personal-bots-capability-model-and-tool-gate.md) (tool gate, taint, upgrade checklist),
[ADR-0017](0017-sign-in-with-chatgpt-per-member.md) (sealing and serialized refresh of a member's tokens),
[ADR-0019](0019-multiplayer-ai-chats.md) (audience rule) and [ADR-0020](0020-agent-personas-and-agent-cards.md)
(platform cards through the Agent Channel API). None of them is edited.

## Context

A shared bot must act with the credentials of the person who asked, never with a pooled account or another member's
(OPS F1-F3, CONN-01 … CONN-06). Three needs came together:

1. **Per-member accounts on MCP servers.** ADR-0011 registered MCP servers with one organization credential and
   deferred per-human OAuth because it needs a public callback. OpenClaw offers a `per-requester` OAuth of its own, but
   it would keep members' tokens in the cell and outside our resolver, audit and audience rule (C-01).
2. **Secrets by reference.** Bots need to call plain HTTP APIs with a member's or a unit's key without the model ever
   seeing the key (principle 8).
3. **Agents from templates.** Leads want to publish a vetted agent that members start as their own personal agent,
   within the personal-agent caps.

Every one of these makes the API call URLs chosen by an admin, a provider or a model, which is a server-side request
forgery surface the API did not have before.

## Decision

1. **Auth modes on the existing MCP registry (D-01).** `mcp_servers.auth_mode` is `org_secret` (ADR-0011, the default
   for every existing server), `per_member_oauth` or `per_member_secret`. Member modes need a remote transport (never
   the stdio sandbox) and never reach the OpenClaw cell. Members connect in Settings › Connections.
2. **The API is the proxy, and the OAuth callback lands on the API (D-02).** `POST /agent-channel/v1/connectors/call`
   runs the call with the turn's human's credential (agent ∩ human), audited per call; OpenClaw's per-requester OAuth
   is rejected. The OAuth client follows the MCP authorization spec: RFC 9728 → RFC 8414 discovery with the issuer equal
   to its discovery URL; PKCE `S256` required (a server that does not advertise it is refused); RFC 8707 `resource` on
   every authorization, token and refresh request; RFC 9207 `iss` checked when sent; sign-in and token endpoints HTTPS
   or same-origin; client choice per issuer, pre-registered → CIMD → DCR, and a client is never reused across issuers.
   Member sign-in is offered only with HTTPS or `localhost` (D-07 item 4), pointing admins to `pnpm ocw enable proxy`;
   the client metadata URL can be turned off per connector for providers that cannot reach the instance (#179).
3. **Custody in ADR-0017's shape.** A member's token bundle or key is sealed in `app.secrets` with the AAD
   `${org}:${user}:connector:${serverId}`; refresh is serialized (Redis lock + row lock + re-read); a terminal failure
   is `needs_reconnect` with a reason (expired, revoked, provider changed); an issuer change is a reconnect and no
   credential is ever sent to the new issuer. `connector_connections` is owner-only in PostgreSQL (restrictive policy);
   the admin count and the clearing on a mode switch or a delete go through two `SECURITY DEFINER` functions that
   return numbers or secret ids only. A mode switch or a delete destroys member tokens locally, after a confirmation
   with the count, without revoking them at the provider.
4. **Revocation of a dropped grant (#193).** A member's disconnect revokes at the provider. On `issuer_changed` or any
   other terminal failure the API also revokes, best effort and after the transaction that dropped the credential
   committed, at the issuer that granted it (its stored revocation endpoint), and only when the client is still known:
   the refresh token when the grant may still be live (issuer change, a refreshed token refused by the resource
   server), the access token when the provider just refused the refresh. A confidential client whose secret is gone
   cannot authenticate the request, so nothing is sent. The outcome is logged as a flag and `connector.needs_reconnect`
   records `revokeAtIssuer`.
5. **Three static plugin tools and logical names.** The cell runs only `ocw_connector_list`, `ocw_connector_call` and
   `ocw_http_request`; each posts the turn's event and agent ids only. A per-member tool travels as a logical name
   `<safe>__<tool>` in the turn and never in OpenClaw's `alsoAllow`. `ocw_connector_call` takes the logical tool's
   flags, `ocw_http_request` treats GET and HEAD as reads, and `ocw_connector_list` taints the turn once it lists
   per-member connectors (their descriptions are third-party output).
6. **The audience rule for member accounts (D-03).** A tool that acts with a member's own account (a per-member
   connector or a personal key) is offered only where that member alone reads the result, or where they shared it.
   Elsewhere it is withheld with reason `member_account` and a resource the persona turns into an "Allow … in …" link.
   A share is an explicit, audited choice made after the reader count is shown; it is re-decided at call time, so a
   revoke bites mid-turn.
   - **"Shared" differs from ADR-0019 for AI chats (07.4-11).** For member-account tools an AI chat is unshared when
     nobody but the asker reads it and no agent other than the turn's own persona is a member. ADR-0019's `isShared`
     counts every agent member, which would make every persona chat shared; it is unchanged for everything else.
   - **Unit keys follow the unit audience (#191, owner decision).** A unit key is usable only where every reader of the
     conversation is inside that unit's audience (members of the unit or below, leads on its path, admins); a public
     channel or a group-granted AI chat never qualifies. Organization keys serve every member.
7. **The keychain (D-04, D-07).** `vault_items` hold personal or unit keys of kind `api_key`, `basic` or `oauth`
   (client credentials) with a host allowlist and an optional path prefix. The model sees a handle (`k_` + 10 base32);
   the API injects the value server-side, only to allowed hosts, drops headers the model sent that could carry
   credentials, redacts the value from the answer and audits `secret.used` with ids, host and method only. Storage is
   `db` only in this phase. Personal keys and their grants to bots are owner-only in PostgreSQL (#182; the cell reads
   which bots hold some key through a `SECURITY DEFINER` function that returns agent ids only). Private hosts are
   reachable only by unit keys whose exact `host:port` is on the admin's list; personal keys never reach one.
   - **Client-credentials tokens are cached per process.** An `oauth` key's token lives in the API process's memory
     until `expires_in − 30 s`, keyed by the item and its value version; concurrent callers share one request. Each API
     instance fetches its own token; nothing is persisted.
8. **The egress guard (D-07).** `apps/api/src/lib/egress.ts` is the only outbound path of these modules: it resolves
   once and connects to the validated address (undici `connect.lookup`), refuses loopback, link-local, metadata,
   private, CGNAT, ULA, multicast, reserved and IPv4-embedding forms (unless the exact `host:port` is allowed for that
   call) and the platform's own hosts always, never follows redirects, and caps size and time. The Semgrep rule
   `ocw.raw-egress` refuses raw `fetch`, sockets and HTTP clients in those modules; every MCP SDK call passes the
   guard as its `fetchFn`.
9. **Agent call rules.** Every agent call needs a live turn of that agent whose human still reads the conversation;
   otherwise it answers **403 `no_trigger`** (not 404 `unknown_turn`), as every Agent Channel agent route does, and the
   plugin reads both as the same sentence. Refusals the member can fix (`not_connected`, `needs_reconnect`) are decided
   **before the claim**: they neither spend the turn's tool budget nor taint it; a refresh that fails after the claim
   finishes the call as blocked. A member who has not connected (or must reconnect) gets one platform-owned "Connect
   your … account" card per turn and connector, which leads to Settings and back to the chat.
10. **Templates fork (D-05).** `agent_templates` are unit-scoped, versioned and immutable once published (a trigger
    refuses any update). Starting one creates the member's own personal agent through `createPersonalBot` with
    `template_id` and version, its own memory and connections, filtered by the personal-agent caps (what was left out is
    shown). A newer version is an "update available" notice only the owner can apply.
11. **Module access stays a catalog (ADR-0024).** Bots now also covers `connector.connect` and `vault.use`; units and
    organizations that turned Bots off before 07.4 are completed by the forward-only backfill `20261014042429` (#177).
    Withdrawal never needs the module: with connecting denied, Settings › Connections lists the member's own
    connections and allowed conversations so they can disconnect and revoke (#196).

## Consequences

- A shared bot acts with each asker's own account, and results stay where only that person reads them unless they
  chose otherwise. No member credential reaches the cell, a prompt, a log, an audit event or a response (07.4-12 leak
  sweep).
- **The OpenClaw upgrade checklist (ADR-0010) gains:**
  - static tool discovery: the three `ocw_*` tools are declared in the manifest's `contracts.tools` and reach the model
    (research A1);
  - the slow-call case: a **30 s** connector call (the API proxy's upstream limit; the plugin's budget is 35 s)
    completes inside a real cell turn (`run-container-smoke.sh`, scenario `connectors`);
  - the fixed refusal sentences (not connected, needs reconnect, member account, unit audience) reach the model, never
    the API's error body.
- **Taint blocks read-then-write in one turn.** Listing per-member connectors or calling an untrusted tool taints the
  turn, so a later side-effecting call in the same turn is refused. Approvals for that case come with 07.5.
- Each connector call opens and closes its own MCP session (about three round trips, research A6); an idle session
  cache is backlog. Each refresh re-discovers the authorization server (two extra requests).
- Two members racing the first DCR registration at one issuer can leave the loser's client orphaned at the provider.
- `connector_credential` secrets are readable as ciphertext by any session of the organization; they open only with
  the member's AAD.

### Upgrade cost of the 07.4 migrations

Four forward-only migrations run in the one-shot `migrate` service of an upgrade (backup-restore.md; no rewrite of
existing rows, no downtime beyond the migration step itself):

| Migration | What it does to existing data | Cost |
| --- | --- | --- |
| `20261013221007_connectors_keychain_templates` | Creates seven empty tables; adds nullable or constant-default columns to `agents`, `bot_policies`, `mcp_server_tools`, `mcp_servers`; adds CHECKs on those tables; re-adds the `agent_tool_calls.source_kind` CHECK | Columns are catalog-only (PostgreSQL 11+). Each CHECK scans its table once under an `ACCESS EXCLUSIVE` lock; only `agent_tool_calls` (one row per bot tool call) can be large: measured on PostgreSQL 18 (Docker, 07.4-14) at 52 ms for 1 000 000 rows (148 MB) with a warm cache, so a cold one costs about one sequential read of the table; a constant-default `NOT NULL` column took 0.5 ms |
| `20261013233856_agent_template_versions_immutable` | A trigger on an empty table | Instant |
| `20261014020321_connector_oauth_use_cimd` | `mcp_servers.oauth_use_cimd boolean default true` | Catalog-only |
| `20261014042429_bots_off_connector_vault_backfill` | Adds 2 deny rows per complete old Bots-off rule set | One scan of `permission_rules` (hundreds of rows) |

`post-migrate.sql` adds the owner-only policies and the definer functions; it is idempotent and instant.

### Validation

Every behaviour above runs against the fake OAuth MCP server and fake keychain targets
(`infra/fake-model/fake-mcp-oauth.mjs`) in unit, integration and real-browser tests, and in the real OpenClaw image's
smoke. **Real-provider interoperability (research A3) is pending the owner:** on an HTTPS instance, register a real
MCP server per member (pre-registered client, or CIMD where the provider supports it), connect two members, check each
answer comes from its own account, let a token expire and confirm the silent refresh, and disconnect to confirm the
revocation at the provider. Record the outcome here in a superseding ADR if anything differs.

### Deferred

- Browser-session logins for services without OAuth or keys (OPS-BL-03).
- Vault items written to OpenBao at runtime (the OpenBao store is load-once and read-only today).
- An MCP session cache, revocation of orphaned DCR clients, and a reason for a unit key withheld by the audience rule.
