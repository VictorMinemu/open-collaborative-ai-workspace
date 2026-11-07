# ADR-0036: Organization connector auth

## Status

Status: Accepted. **Date:** 2026-11-07. **Deciders:** Víctor Ruiz (Autofy Labs). Recorded at the phase gate (plan
07.14-14) from the owner's request and decisions D-01 … D-18 in
`.planning/phases/07.14-organization-connector-auth/07.14-CONTEXT.md`, the planner decisions PD-01 … PD-18 in
`07.14-01-PLAN.md`, the research in `07.14-RESEARCH.md` and the 07.14 SUMMARYs.

**Extends, without editing it:** [ADR-0025](0025-per-member-connectors-keychain-and-agent-templates.md) (per-member
connectors, the connector proxy, sealed custody, the audience rule). **Builds on:**
[ADR-0011](0011-openclaw-marketplace-trust-model-and-mcp.md) (the MCP registry and the stdio sandbox) and
[ADR-0017](0017-sign-in-with-chatgpt-per-member.md) (sealed tokens, the `trusted()` endpoint rule). Supersedes nothing.
The admin guide is [docs/self-hosting/connectors.md](../self-hosting/connectors.md).

## Context

On the first real install (`https://ocw.autofy.ing`, behind Cloudflare) the owner could not use MCP servers that need
OAuth and asked (2026-11-06) to "allow configuring MCPs with any kind of auth".

ADR-0025 gave an MCP server three auth modes: `org_secret` (fixed headers for the whole organization, rendered in the
OpenClaw cell), `per_member_oauth` and `per_member_secret` (each member's own account, called by the API proxy). Fixed
headers already cover Bearer tokens, API keys and Basic auth. Three things were missing:

- **One shared OAuth account** for the organization's bots. Many providers only offer OAuth, and a team bot should not
  need every member to sign in.
- **The OAuth client-credentials grant** (RFC 6749 §4.4), for services that issue a client ID and secret and no browser
  sign-in.
- **A way to know why OAuth fails.** A failed sign-in said "Sign-in error" and nothing else, so the owner could not tell
  a missing public URL from a provider without client registration.

The code also had about 30 places that asked `authMode !== "org_secret"` and read the answer as "a member's account".
With two more modes, each of those places would have silently treated an organization account as a member's, or tried
to render it in the cell.

## Decision

### Five modes, one set of predicates (D-01, D-16, PD-03)

- `mcp_servers.auth_mode` gains `org_oauth` (**Organization sign-in**) and `org_client_credentials` (**Client
  credentials**). The UI names the five modes **Organization headers** (`org_secret`), **Organization sign-in**,
  **Client credentials**, **Member sign-in** (`per_member_oauth`) and **Member key** (`per_member_secret`), grouped
  "For the whole organization" and "Each member's own account". Both new modes need a remote transport, never the
  stdio sandbox. The migration is additive; existing rows keep their mode.
- Every mode question goes through five predicates in `packages/contracts/src/connectors.ts`, with frozen mode lists
  for SQL `inArray`:

  | Predicate | True for | Decides |
  | --- | --- | --- |
  | `rendersInCell` | `org_secret` | cell snapshot, header reveal, cell probe |
  | `usesConnectorProxy` | every other mode | proxy lookups, logical tool names, `ocw_connector_call` |
  | `isPerMemberMode` | the two member modes | member lists, shares, templates, the audience rule, approvals kind |
  | `isOrgCredentialMode` | `org_oauth`, `org_client_credentials` | the organization's credential |
  | `usesOAuthSignIn` | `per_member_oauth`, `org_oauth` | OAuth client fields, CIMD, the sign-in flow |

- **Rule (D-16):** that file is the only place a raw comparison against the organization-headers mode is allowed. The
  Semgrep rule `ocw.raw-auth-mode` refuses `===`, `!==`, `eq()` and `ne()` against `"org_secret"` under `apps/`
  (tests excluded). Comparisons against the other four literals stay allowed, because they are precise.

### Custody: one module over a principal (D-06, D-07, PD-04, PD-05)

- A credential's identity is `(server, principal)`, with `principal = member | organization`. The credential module
  has one implementation: a private store per principal holds what differs (table, row lock, AAD, refresh lock key,
  audit names). Refresh, re-read and the `needs_reconnect` write are shared, not copied.
- **The organization's credential** is one sealed bundle per server in `app.secrets` (kind `connector_credential`),
  with AAD `${org}:org:connector:${serverId}`. A member's AAD has a user UUID as its second segment, never the literal
  `org`, so neither can ever open as the other (tested both ways). The bundle kinds allowed for the organization are
  `oauth` and `client_credentials`; anything else fails closed.
- **State and display metadata** (method, status, issuer, client ID and Token URL for client credentials, scopes,
  account label, expiry, connected by, connected at, last error, last used) live in `app.connector_org_connections`:
  one row per (organization, server), a composite FK to the organization's own server (on delete cascade), tenant RLS
  forced, and no owner-only policy and no `SECURITY DEFINER` function. Only the connectors module writes it, except
  the registry's destroy on a mode switch or delete. Members never read it: the DTO is served only on `mcp.manage`
  routes, and the proxy reads it inside the tenant as the turn's human.
- **Refresh** is serialized exactly like member connections: Redis `SET NX PX` on `ocw:conn:refresh:org:<serverId>`,
  the row lock, then a re-read. The issuer is re-discovered first. If it changed, the result is `needs_reconnect` and
  nothing is sent, so a credential never goes to a new issuer.
- **Terminal failures** set `needs_reconnect` with the 07.4 reasons and audit `connector.org_needs_reconnect`. The bot's
  call then fails with "The organization's connection to {server} needs to be reconnected by an admin." Admins see
  Reconnect on the server row.
- **Disconnect** revokes at the provider (RFC 7009) when OCW knows the client and the revocation endpoint, outside any
  transaction, and then deletes the row and the sealed secret. A second Disconnect answers 404 `not_connected` and
  sends nothing.
- **Destroy on switch or delete (D-08, PD-11).** Leaving an organization mode (to any other mode, including
  `org_oauth` ↔ `org_client_credentials`) or deleting the server while the connection exists answers 409
  `org_connection_exists { method }`. The same `clearConnections: true` that confirms the 07.4 member case confirms
  it. Then the row and its sealed bundle are destroyed in the request's transaction, with no provider revoke (as for
  member tokens), audited `connector.org_disconnected` with `reason: "mode_changed" | "server_deleted"`. The registry
  holds the server row (`for update`), so a switch racing a callback sees the committed connection.
- **D-14:** switching between `per_member_oauth` and `org_oauth` keeps the issuer's OAuth client registrations
  (`connector_oauth_clients`). Only tokens are destroyed. Registrations are removed only when the server leaves both
  sign-in modes.

### Organization sign-in (D-02, D-09, PD-06)

- `org_oauth` reuses the 07.4 OAuth client unchanged: discovery (RFC 9728 → RFC 8414), issuer equality, PKCE `S256`
  required, the RFC 8707 `resource` parameter, the RFC 9207 `iss` check, the per-issuer client choice (pre-registered →
  CIMD → DCR) and the admin scope override. Only the principal changes.
- The start of a sign-in moved into `connectors/flow.ts` (`startOAuthFlow`), and both connect routes call it. The flow
  record in Redis carries `principal`, which defaults to `member`, so a record written by a pre-07.14 instance stays
  valid for its 10 minutes.
- Routes, all `mcp.manage` (Organization Admins), decided by the resolver: `POST /api/v1/connectors/:id/org-connection/connect`,
  `DELETE /api/v1/connectors/:id/org-connection`, `POST /api/v1/connectors/:id/probe` (by mode). An org-B caller gets 404.
- **Binding.** The callback stays `GET /api/v1/connectors/oauth/callback`, in the same order: GETDEL of the state, the
  session's user and organization equal the flow's, `iss`, then `error` or `code`. For an organization flow it then
  **re-decides `mcp.manage`** for that user (an admin demoted mid-flow gets `session_mismatch`), re-loads the server and
  requires `org_oauth` (else `flow_expired`, so a callback after a switch or delete stores nothing), exchanges the code,
  stores and audits in one transaction that holds the server row, always probes the tools with the new token, clears
  `auth_failure` and redirects to `/settings/mcp-servers?connected=<id>` (or `?error=<code>&connector=<id>`). Only the
  admin who started the flow can complete it. Connecting twice keeps one row and the same secret id.
- `error=invalid_scope` maps to `scope_rejected` for organization flows only. Member flows keep their 07.4 codes.

### Client credentials (D-03, D-17, PD-07)

- This is the MCP extension `io.modelcontextprotocol/oauth-client-credentials`. OCW sends client secrets
  (`client_secret_basic`, or `client_secret_post` when the metadata lists only post). It does not send the extension's
  per-request `_meta` capability declaration: the normative spec does not require it, and it has no effect on tool
  calls.
- **Discovery is its own step**, because the 07.4 `discover()` requires PKCE and an authorization endpoint. It reads RFC
  9728 → RFC 8414 / OIDC metadata. When the SDK's schema refuses a document without `authorization_endpoint`, the same
  well-known URLs are read again through the egress guard with a lenient schema. Issuer equality and `trusted()` apply
  as in `discover()`. With no metadata at all, the admin-entered Token URL is required.
- **The grant** uses the SDK's `fetchToken` with `ClientCredentialsProvider`, `fetchFn = egress.bound(oauthPolicy)`,
  `trusted()` checked before any request, `resource` always sent, scopes only when set. Missing `expires_in` means
  300 s. There is no refresh token: "refresh" is a new grant, through the same serialized path (one grant across API
  instances), 60 s before expiry. `invalid_client`, `unauthorized_client` and `invalid_scope` are terminal.
- **Issuer pin.** A bundle saved with metadata stores its issuer. Each re-grant re-discovers first; a changed or
  vanished issuer is `needs_reconnect` (`issuer_changed`) and the secret is never sent. A bundle saved without
  metadata (`issuer` null) uses its stored Token URL.
- **The save** (`PUT /api/v1/connectors/:id/org-connection/client-credentials`, `mcp.manage`) runs discovery and a real
  grant, seals the bundle (`client_credentials` kind: client ID, client secret, Token URL, issuer, resource,
  revocation endpoint, auth method, scopes, and the current token), writes the row and probes the tools. A refused
  save answers 409 with the D-10 code, records `auth_failure`, keeps the existing connection, and is audited
  `connector.connect_failed` (`principal: "organization"`, `method: "client_credentials"`).
- **A stored secret only goes to the target it was saved for (security fix, 07.14-09).** The client secret is
  write-only, so a form that leaves it empty keeps the saved one. That secret, and the saved server's OAuth clients,
  are used only when the URL, the client ID and the Token URL equal the saved ones, and when the issuer and token
  endpoint discovered now equal the saved ones. Otherwise the save answers 400 `secret_required` and sends nothing, and
  Test sign-in uses only the values typed in the form. Before this fix an admin could point the save or the test at
  their own server and receive the organization's stored secret in the token request. Admin-entered Token URLs also
  meet the registry's URL policy (`checkMcpUrl`) before any request, then `trusted()` and the egress guard.

### Where calls run and who may use them (D-04, D-05, PD-09)

- Both new modes run only through the API connector proxy (`POST /agent-channel/v1/connectors/call`,
  `agent-channel/connectors.ts`). **The token, refresh token and client secret never reach the OpenClaw cell:** the
  cell snapshot lists neither the server nor its tokens, and the cell sees only logical tool names with
  `ocw_connector_list` / `ocw_connector_call`. The tool list comes from the API with the organization's credential.
- The proxy picks the credential from the server's stored mode (`credentialKeyOf`): an organization-mode server is
  called with the organization's token, a member-mode server with the asker's. There is no fallback either way.
- **Offer rules.** The organization's account is an organization resource, offered exactly where Organization headers
  servers are offered: every member's bots, chains and automations, in DMs and channels, gated by `orgEnabled`,
  `personalAllowed` and `status === "ready"`. The member audience rule of ADR-0025 §6 does not apply, because the
  account is not a member's. The organization-resource checks do: in a shared AI chat the tool is withheld
  `not_every_participant` when a reader is denied, and `shared_with_group` applies. Per-tool approvals (ADR-0026) and
  taint are unchanged and run before any token is read; approvals show these tools as `kind: "mcp"`, `account: "org"`
  ("· MCP server", never "· your account").
- Templates and member-account shares never take an organization-mode server. Watched records (ADR-0028) read and
  write them with the organization's token, as workspace access.
- A server whose organization account is not connected keeps its tools offered; the call fails with "The organization
  hasn't connected {server} yet. An admin can connect it in Settings › MCP servers." There is never a connect card for
  an organization mode.

### Audit (D-09, D-13, PD-10)

- `connector.org_connected { serverId, method, issuer }`, `connector.org_disconnected { serverId, method, revoked,
  reason: "admin" | "mode_changed" | "server_deleted" }` and `connector.org_needs_reconnect { serverId, code,
  revokeAtIssuer }`. `connector.connect_failed` gains `principal: "organization"` for organization flows.
- **D-13:** there is no `connector.called` action. Proxied calls keep today's `bot.tool_call` and
  `bot.tool_call.completed`, now with `credential: "organization"` or `"member"`, set from the server's mode once the
  server is resolved. No arguments or results are recorded.
- No audit row, log line, redirect or response carries a token, code, PKCE verifier, `state`, client secret or
  provider text. The leak sweep (`security.int.test.ts`) checks every database column, audit row, response, WebSocket
  frame, Redis key and value, log line and the cell snapshot for the organization's canaries.

### Diagnosis (D-10, D-15, D-18, PD-08)

- **Closed failure codes,** in step order, each with one fix line (`AUTH_FAILURE_FIX` in the contracts):
  `https_required`, `discovery_failed`, `issuer_mismatch`, `token_endpoint_untrusted`, `pkce_unsupported`,
  `client_registration_unavailable`, `scope_rejected`, `token_exchange_failed`.
- **Steps:** `public_url` (sign-in modes) → `discovery` → `issuer` → `endpoints` → `pkce` (sign-in modes) →
  `client_registration` (sign-in modes) → `token` (client credentials only). The first failure stops the run, and the
  later steps read "Not checked".
- **The public-URL check.** `https_required` also fires when the redirect URI's host is loopback while the admin opened
  the page on another host. This is the usual case behind a TLS-terminating proxy or tunnel where
  `OCW_PUBLIC_API_URL` was left at `http://localhost:4000`: the provider would send the admin's browser to localhost.
  The dialog names both hosts.
- **Test sign-in** (`POST /api/v1/connectors/oauth-test`, `mcp.manage`, 10 per minute per admin) runs the steps for
  unsaved or saved values. **It never registers a client** (the client step is a dry run of the pre-registered → CIMD →
  DCR choice; `registerClient()` is never called) **and never stores anything**: no row, client, secret,
  `auth_failure` or `oauth_status`. For client credentials it runs a real grant and discards the token.
- **D-15:** the last failure of a server is `mcp_servers.auth_failure`, nullable and checked against the closed set
  (never provider text). Only organization flows write it (a failed connect start, a failed callback, a refused
  client-credentials save). Their success and a mode change clear it. Test sign-in and member flows never write it.
- Provider error bodies, `error_description` and SDK messages are never read into a response, a row or the UI.
- **Cloudflare and CIMD.** With the client metadata URL (CIMD), the provider's server fetches
  `/api/v1/connectors/oauth/client-metadata.json`. Cloudflare bot protection, a managed challenge or Access in front of
  the whole host answers that fetch with a challenge, and the provider then refuses OCW at authorize. OCW never sees a
  callback, so this cannot be diagnosed afterwards. The dialog shows a fixed hint beside the CIMD URL, and the guides
  say to allow that path or turn off the client metadata URL for that server.

## Consequences

- **Admins** pick one of five modes per MCP server, run Test sign-in before saving, and connect the organization's
  account once from the server row (Connect, Reconnect, Disconnect) or save a client ID and secret. They need
  `mcp.manage`. Sign-in modes need HTTPS and a correct `OCW_PUBLIC_API_URL` (`pnpm ocw enable proxy`).
- **Bots** of every member use the organization's account wherever organization tools are allowed, with no
  per-member sign-in and no connect card. What the account can read, every reader of the conversation can read
  through the bot's answers. Admins control that with tool grants, per-tool approvals and the organization-resource
  checks, exactly as for Organization headers.
- **Members** never see the organization's credential or its status outside the bot's answers; Settings › Connections
  lists member modes only.
- **One-way changes:** the widened check constraint, `mcp_servers.auth_failure` and `app.connector_org_connections`
  with its RLS policy. `ocw upgrade` applies them; the N-1 → N upgrade test covers them.
- **Not supported** (deferred): shared accounts per unit (team) instead of the whole organization;
  `private_key_jwt` and mTLS client authentication for client credentials; platform MCP servers inside Work Zone
  sessions (they would reuse this custody). A provider without DCR or CIMD (for example GitHub's remote MCP server)
  needs a pre-registered OAuth app.

### Validation

Unit tests (the predicates against the D-16 table, the per-mode request rules, the failure codes and fix lines, the
OAuth steps, `diagnose()`), integration tests on real PostgreSQL and Redis against the fake OAuth MCP server (the
schema and tenant isolation as `ocw_app`, the N-1 → N upgrade, organization sign-in and its binding, custody with
racing refreshes and AAD swaps, client credentials with the issuer pin and the stored-secret target rule, Test sign-in
storing nothing and registering nothing, the proxy and turn policy, approvals, templates, shares, watched records, the
leak sweep), the Semgrep rule's fixtures, the web unit tests, the isolated e2e on both Playwright projects
(`mcp-servers.spec`, `connectors-org.spec`) and `pnpm gate:compose`; recorded in `07.14-VALIDATION.md`. **Owner check
pending:** `docs/DEMO.md` › Organization connector auth (Phase 07.14): a real OAuth-only MCP server on the real instance
behind Cloudflare.
