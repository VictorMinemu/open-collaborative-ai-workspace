# API Coverage — OAuth 2.x / MCP authorization surface (Phase 07.14)

> Full coverage by default. Opt-outs are explicit, reasoned decisions. The "external API" here is the protocol surface
> OCW speaks to any MCP server's authorization server (RFC 6749 and its extensions, the MCP authorization spec and the
> MCP client-credentials extension), not one vendor. Rows marked "07.4" already exist and are reused unchanged.

| capability | decision | reason |
|---|---|---|
| RFC 9728 protected resource metadata discovery | INTEGRATE | |
| RFC 8414 / OIDC authorization server metadata discovery | INTEGRATE | |
| Lenient RFC 8414 read without `authorization_endpoint` (client-credentials-only servers) | INTEGRATE | |
| Authorization code grant with PKCE S256 (organization principal) | INTEGRATE | |
| Refresh token grant (organization principal, serialized) | INTEGRATE | |
| Client credentials grant (RFC 6749 §4.4) | INTEGRATE | |
| RFC 8707 `resource` indicator on authorize, token, refresh and client credentials | INTEGRATE | |
| RFC 9207 `iss` check on the authorization response | INTEGRATE | |
| RFC 7009 token revocation on Disconnect and dropped grants | INTEGRATE | |
| RFC 7591 dynamic client registration (sign-in modes) | INTEGRATE | |
| Client ID metadata documents (CIMD) | INTEGRATE | |
| Pre-registered clients per issuer | INTEGRATE | |
| Client authentication `client_secret_basic` | INTEGRATE | |
| Client authentication `client_secret_post` | INTEGRATE | |
| Client authentication `none` (public clients, sign-in modes) | INTEGRATE | |
| Client authentication `private_key_jwt` | OPT-OUT | explicitly out of scope (CONTEXT Deferred) |
| Client authentication `tls_client_auth` / mTLS | OPT-OUT | explicitly out of scope (CONTEXT Deferred) |
| `WWW-Authenticate` challenge parsing (`resource_metadata`, `scope`, `insufficient_scope`) | INTEGRATE | |
| Scope selection (admin override, challenge, PRM `scopes_supported`, `offline_access`) | INTEGRATE | |
| ID token account label (display only) | INTEGRATE | |
| MCP client-credentials extension `_meta` capability declaration | OPT-OUT | not needed: not required by the normative spec text and no server-side effect on tool calls (RESEARCH A5); add if a server refuses without it |
| Device authorization grant (RFC 8628) for MCP servers | OPT-OUT | not needed: an admin signs in through the browser; no MCP server requires it |
| Token exchange (RFC 8693) | OPT-OUT | not needed: no on-behalf-of chain between OCW principals and providers in this phase |
| JWT bearer assertion grant (RFC 7523) | OPT-OUT | not needed yet: belongs with `private_key_jwt`, deferred |
| Token introspection (RFC 7662) | OPT-OUT | not needed: OCW is the client, not a resource server; a 401 drives refresh and reconnect |
| Pushed authorization requests (RFC 9126) | OPT-OUT | not needed yet: no MCP server in scope requires PAR; revisit if a provider mandates it |
| DPoP (RFC 9449) | OPT-OUT | not needed yet: the MCP authorization spec uses bearer tokens; revisit with sender-constrained tokens |
| Dynamic client registration management (RFC 7592: update/delete) | OPT-OUT | not needed: registrations are kept per issuer and removed locally when a server leaves the sign-in modes |
