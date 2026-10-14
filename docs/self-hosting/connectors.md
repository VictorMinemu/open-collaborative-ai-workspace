# Connectors, member accounts and the keychain

Bots can call outside services in three ways. An admin picks the way per connector in **Settings › MCP servers**;
members connect their own accounts in **Settings › Connections** and keep their keys in **Settings › Keychain**. The
decisions behind this page are in [ADR-0025](../adr/0025-per-member-connectors-keychain-and-agent-templates.md).

| Mode (Settings › MCP servers › Authentication) | Who the service sees | Pick it when |
| --- | --- | --- |
| **Organization secret** (`org_secret`) | The workspace's own account, for every member | The service is a shared resource (company docs, a status page) and every member may see the same data |
| **Each member signs in** (`per_member_oauth`) | The member who asked, through their own sign-in (OAuth 2.1) | The service has per-person data or permissions and supports OAuth sign-in for MCP (RFC 9728 metadata and PKCE) |
| **Each member's own key** (`per_member_secret`) | The member who asked, through a key they paste once | The service has per-person API keys but no OAuth sign-in for MCP |

A member-account connector never reaches the OpenClaw cell: the API calls it for the member, only on a turn that member
started, and only where that member alone reads the result (their DM with the bot, or an AI chat nobody else reads)
unless they allowed it for one conversation. Every call is audited without its arguments or results.

## HTTPS is required for member sign-in

Members can sign in to a connector only when the instance has HTTPS (or runs on `localhost`). Turn it on with one
command (see [reverse-proxy.md](reverse-proxy.md)):

```bash
pnpm ocw enable proxy --site-address ocw.example.com
```

Without it, **Each member signs in** reads **Needs HTTPS** in the dialog and members see "Sign-in needs HTTPS on this
workspace." Key connectors still work. Nothing has to be edited after enabling the proxy: the status is derived from
`OCW_PUBLIC_API_URL` at read time.

## What to give the service's admin

The dialog shows both values with a copy button:

| Value | Where it comes from |
| --- | --- |
| Redirect URI | `<OCW_PUBLIC_API_URL>/api/v1/connectors/oauth/callback` |
| Client metadata URL | `<OCW_PUBLIC_API_URL>/api/v1/connectors/oauth/client-metadata.json` (HTTPS instances only) |

OCW picks the OAuth client in this order, per authorization server (issuer), and never reuses a client of one issuer
at another:

1. **A pre-registered client.** Register OCW at the provider with the redirect URI above, then open **Pre-registered
   client (optional)** in the dialog: Issuer URL, Client ID, Client secret (only for a confidential client; it is
   sealed and never shown again) and Scopes (optional; otherwise the scopes the server asks for).
2. **The client metadata URL (CIMD).** Used when the provider supports it and **Use the client metadata URL** is on.
   Turn it off for a provider that cannot reach your instance (an internal name or an internal CA).
3. **Dynamic client registration (DCR).** Used when the provider allows it.

If none applies, the connector card says **Needs an OAuth client** and members cannot sign in until you add one. A
server that publishes no protected resource metadata (RFC 9728) or no PKCE `S256` shows **Sign-in error**: use **Each
member's own key** for it instead.

Every sign-in uses PKCE `S256`, the RFC 8707 `resource` parameter and, when the provider sends one, the RFC 9207 `iss`
check. Sign-in and token endpoints must be HTTPS or on the MCP server's own origin.

## Private network hosts

Outbound calls of connectors and keys go through one guard. It resolves each host once, connects only to the address
it checked, never follows a redirect, and refuses loopback, link-local, cloud metadata, private (RFC 1918, CGNAT, ULA)
and reserved addresses, and OCW's own services (database, Redis, storage, the cell, the API itself), whatever the
name.

To let **unit keys** reach a service on your own network (an on-premises ERP, say), list its exact `host:port` in
**Settings › MCP servers › Private network hosts** (admins with `bot.manage`). Personal keys never reach a private
host, listed or not, and OCW's own services stay refused even if listed.

## What members see

- **Settings › Connections:** every member-account connector with its state (Not connected, Connected as …, Needs
  reconnect, Access revoked), Connect / Reconnect / Disconnect, and the conversations they allowed their account in,
  each with Revoke. When Bots are turned off for a member, the page still lists their own connections and allowed
  conversations so they can disconnect and revoke; connecting needs Bots on.
- **In chat:** a bot that needs their account posts a "Connect your {connector} account" card with a Connect button
  that comes back to the chat. In a shared conversation the bot explains why it cannot use the account there and links
  to "Allow {connector} in #channel", which shows how many people will read the results before anything is allowed.
- **Settings › Keychain:** their personal keys (and the unit keys of the units they lead), each with a handle such as
  `k_abc2def3gh`, the hosts it may be sent to, the bots that may use it and when it was last used. Bots only ever see
  the handle.

## What is never stored or shown

- Sign-in tokens, refresh tokens, member keys, keychain values and client secrets are sealed in the database (AES-256-GCM
  with the instance's `OCW_ENCRYPTION_KEY`), each bound to its member, connector or key, so a value moved to another
  row does not open. A member's sign-in and keys are readable by that member's session only, in the API and in
  PostgreSQL.
- No response, page, log line, audit event, cell configuration or model prompt carries one. Audit events name ids,
  hosts and methods only (`secret.used`, `connector.connected`, `bot.tool_call`).
- OAuth codes, PKCE verifiers and `state` live only in Redis for the 10 minutes of a sign-in.
- Client-credentials tokens of keychain OAuth keys stay in the API process's memory until they expire; each API
  instance fetches its own.

## Changing a connector's mode or deleting it

Leaving a member mode (for example back to **Organization secret**), or deleting the connector, deletes every
member's sign-in or key for it. The dialog first says how many members are connected and asks to confirm
("Disconnect {n} members?"); the change is audited as `connector.connections_cleared`. These tokens are destroyed in
OCW only: they stay valid at the provider until they expire. A member who disconnects themselves, or whose sign-in
stops working, is also revoked at the provider when OCW still knows the client.

## The test-only override

`OCW_EGRESS_TEST_HOSTS` maps a name to a loopback address so the isolated end-to-end tests can reach the fake OAuth
server. The API refuses to start with it when `NODE_ENV=production`; never set it on a real instance.
