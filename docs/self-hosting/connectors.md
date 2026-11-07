# Connectors, member accounts and the keychain

Bots can call outside services in five ways. An admin picks the way per MCP server in **Settings › MCP servers ›
Authentication**; members connect their own accounts in **Settings › Connections** and keep their keys in **Settings ›
Keychain**. The decisions behind this page are in
[ADR-0025](../adr/0025-per-member-connectors-keychain-and-agent-templates.md) (member accounts) and
[ADR-0036](../adr/0036-organization-connector-auth.md) (the organization's own accounts).

| Mode (Settings › MCP servers › Authentication) | Who the service sees | Pick it when |
| --- | --- | --- |
| **For the whole organization** | | |
| **Organization headers** (`org_secret`) | The workspace's own account, through fixed headers (a Bearer token, an API key, Basic auth) | The service takes a static key and every member may see the same data |
| **Organization sign-in** (`org_oauth`) | The account an admin signed in with once (OAuth 2.1) | The service only offers OAuth sign-in and the team's bots should share one account |
| **Client credentials** (`org_client_credentials`) | An OAuth client of the organization (client ID and secret, RFC 6749 §4.4) | The service issues a client ID and secret for machine access, with no browser sign-in |
| **Each member's own account** | | |
| **Member sign-in** (`per_member_oauth`) | The member who asked, through their own sign-in (OAuth 2.1) | The service has per-person data or permissions and supports OAuth sign-in for MCP (RFC 9728 metadata and PKCE) |
| **Member key** (`per_member_secret`) | The member who asked, through a key they paste once | The service has per-person API keys but no OAuth sign-in for MCP |

Only **Organization headers** are sent to the OpenClaw cell. Every other mode is called by the API itself, through
its connector proxy, so a sign-in token, a refresh token or a client secret never reaches the cell or the model.

- **A member-account connector** is called only on a turn that member started, and only where that member alone reads
  the result (their DM with the bot, or an AI chat nobody else reads) unless they allowed it for one conversation.
- **An organization account** (Organization sign-in, Client credentials) is an organization resource, like
  Organization headers. Every member's bots use it wherever organization tools are allowed: DMs, channels, chains and
  automations. Whatever that account can read, every reader of the conversation can read through the bot's answer.
  Decide that with the bot's tool grants and with per-tool approvals. In a shared AI chat the tool is withheld when one
  of the readers may not use it.

Every proxied call is audited as `bot.tool_call` with `credential: "organization"` or `"member"`, without its
arguments or results.

## HTTPS and the public URL are required for sign-in

**Organization sign-in** and **Member sign-in** need HTTPS (or `localhost`), and `OCW_PUBLIC_API_URL` must be the
address people open. Turn both on with one command (see [reverse-proxy.md](reverse-proxy.md)):

```bash
pnpm ocw enable proxy --site-address ocw.example.com
```

Without HTTPS, both sign-in cards read **Needs HTTPS** in the dialog, the dialog says "Sign-in needs HTTPS. Run pnpm ocw
enable proxy on the server, then reload this page.", and members see "Sign-in needs HTTPS on this workspace." Key,
header and client-credential modes still work. Nothing has to be edited after enabling the proxy: the status is
derived from `OCW_PUBLIC_API_URL` at read time.

**The public-URL check.** If the instance sits behind a proxy or a tunnel that terminates TLS (Cloudflare Tunnel, a
load balancer) and `OCW_PUBLIC_API_URL` was left at its default `http://localhost:4000`, the provider would send the
admin's browser back to localhost after sign-in. Test sign-in catches this: when the redirect URI points at a loopback
host but you opened the page at another host, it stops at **This workspace's address** and the dialog says "This
workspace tells providers to return to {redirect host}, but you opened it at {page host}." Set `OCW_PUBLIC_API_URL`
to the workspace's public HTTPS address and reload.

## What to give the service's admin

The dialog shows both values with a copy button, for both sign-in modes:

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
   The provider's server fetches that URL from the internet. Turn it off for a provider that cannot reach your
   instance: an internal name, an internal CA, or Cloudflare bot protection, a managed challenge or Cloudflare Access
   in front of the workspace (see [reverse-proxy.md](reverse-proxy.md#cloudflare-in-front-of-the-workspace)).
3. **Dynamic client registration (DCR).** Used when the provider allows it.

If none applies, the server card says **Needs an OAuth client** and nobody can sign in until you add one. Switching a
server between **Member sign-in** and **Organization sign-in** keeps its OAuth client registrations; only the tokens
are deleted.

Every sign-in uses PKCE `S256`, the RFC 8707 `resource` parameter and, when the provider sends one, the RFC 9207 `iss`
check. Sign-in and token endpoints must be HTTPS or on the MCP server's own origin.

## Organization sign-in

One admin signs in once with the organization's account, and every member's bots use it.

1. **Add the server.** Settings › MCP servers › **Add**: a remote MCP URL, **Authentication › Organization sign-in**.
   Fill the pre-registered client if the provider needs one, run **Test sign-in** (below), then **Save**. The card
   reads *Waiting for an admin to connect*.
2. **Connect.** On the server's row, **Connect** goes to the provider's sign-in and back to Settings › MCP servers:
   *Connected {server} for the organization.* The row shows *Connected as {account} · by {admin} · {time}*, OCW loads
   the server's tools with the new token, and the server turns **Ready**.
3. **Grant its tools** to the bots that should use them (Bots › the bot › Capabilities), as for any organization tool.

- **Who can.** Organization Admins (`mcp.manage`). Only the admin who started a sign-in can finish it, and OCW checks
  `mcp.manage` again when the provider sends them back: a sign-in started by an admin who was demoted in the meantime
  stores nothing.
- **Where bots use it.** Wherever organization tools are allowed (above). A member never needs to sign in and never
  gets a "Connect your account" card for it. Settings › Connections lists member-account servers only.
- **Reconnect.** OCW refreshes the token before it expires, one refresh at a time across API instances. When the
  provider refuses the refresh, revokes access or changes its sign-in server, the row shows **Needs reconnect** with
  the reason (*The sign-in expired.*, *Access was revoked at the provider.*, *The provider's sign-in server changed.*)
  and **Reconnect**. Until then a bot's call fails with "The organization's connection to {server} needs to be
  reconnected by an admin."
- **Not connected.** A bot that calls the server before anyone connected it says "The organization hasn't connected
  {server} yet. An admin can connect it in Settings › MCP servers."
- **Disconnect** asks first ("Bots stop using the organization's account on {server}. OCW also signs it out at the
  provider when it can."), then revokes the token at the provider when OCW knows how (RFC 7009) and deletes it.

## Client credentials

For services that give you a client ID and a client secret for machine access. No browser sign-in is involved.

Fields in the dialog, under **Authentication › Client credentials**:

| Field | Notes |
| --- | --- |
| **Client ID** | As the provider shows it |
| **Client secret** | Write-only. It is sealed and never shown again; an edit shows *Secret set* with **Replace** |
| **Token URL** (optional) | Leave it empty to use the server's published sign-in information (RFC 9728 → RFC 8414). Required only when the server publishes none. It must be HTTPS or on the MCP server's own address |
| **Scopes** (optional) | Space-separated. Empty sends no `scope`, so the provider's default applies |

- **Save** runs the grant right away: OCW finds the token endpoint, asks for a token with the RFC 8707 `resource` of
  the MCP server, loads the server's tools with it, and the row shows *Client {clientId} · by {admin} · {time}*. If the
  provider refuses, the dialog stays open with "Client credentials failed at: {step}." and the fix line, and the row
  keeps any earlier working credentials.
- **Client authentication** is `client_secret_basic`, or `client_secret_post` when the server's metadata lists only
  post. `private_key_jwt` and mTLS are not supported.
- **Refresh means a new grant.** There is no refresh token: OCW asks for a new token a minute before the old one
  expires, one request at a time across API instances. A token without `expires_in` is treated as valid for 5 minutes.
- **The issuer is pinned.** When the credentials were saved with published metadata, OCW checks before every grant
  that the server still names the same sign-in server. If it changed, the row shows **Needs reconnect** and the secret
  is not sent.
- **The saved secret stays with its target.** Editing the URL, the Client ID or the Token URL, or a server that now
  names another issuer or token endpoint, needs the secret typed again (the API answers `secret_required` and sends
  nothing). OCW never sends a saved secret anywhere else, in a save or in Test sign-in.
- **Update credentials** on the row opens the dialog; **Disconnect** revokes the current token at the provider's
  revocation endpoint when it publishes one, then deletes the credentials.

## Test sign-in and what each failure means

**Test sign-in** in the dialog checks a sign-in mode or client credentials before you save, with the values in the form
(or the saved ones). It never registers OCW at the provider and never stores anything. For client credentials it asks
for a real token and throws it away. It runs these steps in order and stops at the first failure: *This workspace's
address*, *Sign-in information*, *Sign-in server identity*, *Secure endpoints*, *PKCE (S256)*, *Client registration*,
*Token*. Steps that do not apply to the mode, and steps after a failure, read *Not checked*. It is limited to 10 runs per
minute per admin.

The last failure of an organization connect or a client-credentials save is also shown on the server's row ("Last
sign-in failed: {step}.") until a sign-in succeeds or the mode changes. OCW never shows or stores the provider's own
error text.

| Code | Step | What it means and the fix |
| --- | --- | --- |
| `https_required` | This workspace's address | Sign-in needs this workspace's public HTTPS address in `OCW_PUBLIC_API_URL`. Run `pnpm ocw enable proxy` on the server (or set the URL), then reload the page. Also shown when the public URL is loopback but you opened the page elsewhere |
| `discovery_failed` | Sign-in information | The server publishes no OAuth sign-in information OCW can read (RFC 9728 / RFC 8414). Check the URL, or use **Organization headers** with an API key |
| `issuer_mismatch` | Sign-in server identity | The sign-in server names a different issuer than its address. The provider has to fix its metadata; until then, use **Organization headers** |
| `token_endpoint_untrusted` | Secure endpoints | The sign-in endpoints must use HTTPS (or the MCP server's own address). Check the Token URL, or ask the provider for an HTTPS endpoint |
| `pkce_unsupported` | PKCE (S256) | The server's sign-in doesn't offer PKCE `S256`, which OCW requires. Use **Client credentials** or **Organization headers** |
| `client_registration_unavailable` | Client registration | The server doesn't let OCW register itself (no CIMD, no DCR). Create an OAuth app at the provider with the redirect URI, then enter its client ID and secret under **Pre-registered client** |
| `scope_rejected` | Token | The provider refused the requested scopes. Clear **Scopes** to use the server's own, or enter scopes it accepts |
| `token_exchange_failed` | Token | The provider didn't finish the sign-in. Check the client ID and secret, then try again |

Provider notes:

- **GitHub's remote MCP server** offers no dynamic registration or CIMD. Create an OAuth app (or GitHub App) in GitHub
  with the redirect URI above, then enter its client ID and secret under **Pre-registered client**.
- **A provider that cannot fetch the client metadata URL** (Cloudflare or a firewall in front of the workspace) fails
  at the provider's page, after Test sign-in passed: OCW never hears back. Allow the path, or turn off **Use the client
  metadata URL** for that server.

## Private network hosts

Outbound calls of connectors and keys go through one guard. It resolves each host once, connects only to the address
it checked, never follows a redirect, and refuses loopback, link-local, cloud metadata, private (RFC 1918, CGNAT, ULA)
and reserved addresses, and OCW's own services (database, Redis, storage, the cell, the API itself), whatever the
name. Sign-in, token and revocation endpoints go through the same guard.

To let **unit keys** reach a service on your own network (an on-premises ERP, say), list its exact `host:port` in
**Settings › MCP servers › Private network hosts** (admins with `bot.manage`). Personal keys never reach a private
host, listed or not, and OCW's own services stay refused even if listed.

## What members see

- **Settings › Connections:** every member-account connector with its state (Not connected, Connected as …, Needs
  reconnect, Access revoked), Connect / Reconnect / Disconnect, and the conversations they allowed their account in,
  each with Revoke. When Bots are turned off for a member, the page still lists their own connections and allowed
  conversations so they can disconnect and revoke; connecting needs Bots on. Organization accounts are not listed.
- **In chat:** a bot that needs their account posts a "Connect your {connector} account" card with a Connect button
  that comes back to the chat. In a shared conversation the bot explains why it cannot use the account there and links
  to "Allow {connector} in #channel", which shows how many people will read the results before anything is allowed.
  An organization account never posts a card; the bot says an admin must connect or reconnect it.
- **Settings › Keychain:** their personal keys (and the unit keys of the units they lead), each with a handle such as
  `k_abc2def3gh`, the hosts it may be sent to, the bots that may use it and when it was last used. Bots only ever see
  the handle.

## What is never stored or shown

- Sign-in tokens, refresh tokens, member keys, keychain values and client secrets are sealed in the database (AES-256-GCM
  with the instance's `OCW_ENCRYPTION_KEY`), each bound to its member, connector or key, so a value moved to another
  row does not open. A member's sign-in and keys are readable by that member's session only, in the API and in
  PostgreSQL. The organization's sign-in or client credentials are sealed for the organization and that server, and
  never open as a member's (or the other way round).
- No response, page, log line, audit event, cell configuration or model prompt carries one. Audit events name ids,
  hosts and methods only (`secret.used`, `connector.connected`, `connector.org_connected`,
  `connector.org_disconnected`, `connector.org_needs_reconnect`, `bot.tool_call`).
- OAuth codes, PKCE verifiers and `state` live only in Redis for the 10 minutes of a sign-in.
- Client-credentials tokens of keychain OAuth keys stay in the API process's memory until they expire; each API
  instance fetches its own. Client-credentials tokens of an MCP server are sealed with its credentials and shared by
  every API instance.

## Changing a connector's mode or deleting it

- **Leaving a member mode** (for example to **Organization headers**), or deleting the connector, deletes every
  member's sign-in or key for it. The dialog first says how many members are connected and asks to confirm
  ("Disconnect {n} members?"); the change is audited as `connector.connections_cleared`.
- **Leaving an organization mode** (to any other mode, including between **Organization sign-in** and **Client
  credentials**), or deleting the server, deletes the organization's sign-in or client credentials. The dialog asks
  first ("Disconnect the organization's account?" / "Switching {server} to {mode} deletes the organization's saved
  sign-in. Bots stop using it."; on delete, "The organization's sign-in to {server} is deleted too." and **Delete and
  disconnect**). The change is audited as `connector.org_disconnected` with the reason.

These tokens are destroyed in OCW only: they stay valid at the provider until they expire. A member who disconnects
themselves, an admin who presses **Disconnect** on an organization account, or a sign-in that stops working is also
revoked at the provider when OCW still knows the client.

## The test-only override

`OCW_EGRESS_TEST_HOSTS` maps a name to a loopback address so the isolated end-to-end tests can reach the fake OAuth
server. The API refuses to start with it when `NODE_ENV=production`; never set it on a real instance.
