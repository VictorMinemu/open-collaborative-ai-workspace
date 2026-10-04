# ADR-0008: Short-lived JWTs for the API, the browser WebSocket and the Device Link

- **Status:** Accepted
- **Date:** 2026-10-04
- **Deciders:** Víctor Ruiz (Autofy Labs)

## Context

Phase 2 success criterion 4 (AUTH-06): API and WebSocket connections authenticate with short-lived JWTs
verified against a JWKS endpoint, and the Phase 1 cookie-authenticated WebSocket moves to them without
breaking reconnect and replay. In MVP 0 the browser WebSocket was opened with the session cookie, REST
used the same cookie, and the Local Runtime daemon connected to `/runtime/ws` with its long-lived raw
device token on every connect. Desktop apps already installed (the demo Mac) send that raw token and
cannot be updated in step with the server.

## Decision

**Issuer.** better-auth's `jwt` plugin signs access tokens with EdDSA (Ed25519) keys stored in
`auth.jwks`, whose private keys are encrypted with `BETTER_AUTH_SECRET`. `GET /api/auth/token` issues a
token for the signed-in session and `GET /api/auth/jwks` publishes the public keys. Claims are minimal:
`sub`, `sid` (session), `org` (organization) and `ck` (client kind), with no e-mail, name or image.
Tokens live 10 minutes; issuer and audience are the public API URL. The automatic `set-auth-jwt` header is
disabled.

**Verifier.** The API verifies with `jose` against an in-process cached JWKS, re-fetched once on an
unknown key id with a cooldown. It never uses better-auth's per-call `verifyJWT`, which reads every key
from the database. After the signature, issuer, audience and expiry, the claims are Zod-parsed, the
session is checked against the Redis revocation deny-list, and the member must exist and not be
deactivated.

**REST (D-01).** Every user route accepts `Authorization: Bearer <jwt>` or the session cookie. A
presented Bearer JWT is authoritative: when it fails, the cookie is not tried. The web keeps the HttpOnly
cookie for REST (instant revocation, no token handling in JS); the daemon and the future mobile app use
Bearer.

**Browser WebSocket.** The client offers `["ocw.v1", "ocw.auth.<jwt>"]` in `Sec-WebSocket-Protocol`. The
gateway checks the Origin, verifies the token before the upgrade (401 otherwise), echoes `ocw.v1` and
never the token, and the header is redacted from logs. A cookie alone no longer opens `/ws`. The socket
outlives its token by design: it is tied to the session, which a periodic recheck confirms. Revocation is
immediate: signing out, revoking a session or deactivating a member writes `ocw:auth:revoked-sid:<sid>`
(TTL longer than a token) and publishes on `ocw:auth:revoked`, and every API instance closes the matching
sockets with 4401. The realtime client fetches a fresh token before each connect and retries once on
4401. The frame protocol, reconnect and `seq` replay are unchanged.

**Device Link (D-03).** The daemon exchanges its long-lived device token for a 10-minute device JWT
(`POST /api/v1/devices/token`, `aud = ocw:device-link`) before every connect. User and device tokens use
different audiences, so neither verifies as the other. `/runtime/ws` verifies the device JWT, re-reads the
device row (a revoked device is refused even with a valid token) and records a `device.link` resolver
decision. The raw device token is still accepted on `/runtime/ws` while `OCW_ACCEPT_LEGACY_DEVICE_TOKEN`
is true (the default until Phase 8), with a warning and a `device.legacy_token_used` audit row at most once
per device per hour, so desktop apps built before Phase 2 keep working.

**Not adopted.** `@better-auth/oauth-provider` (a full OAuth authorization server) is deferred: nothing in
Phase 2 needs third-party clients. The Agent Channel cell token stays as it is (hashed, rotatable,
server-to-server, Agent Channel scope only); AUTH-06 names the API, the WebSocket and the daemon.

## Consequences

- Rotating `BETTER_AUTH_SECRET` breaks token signing ("Failed to decrypt private key") until the
  `auth.jwks` rows are deleted. New keys are then minted, every outstanding JWT becomes invalid and clients
  fetch new ones. The rotation also signs everyone out, because the secret signs the session cookies.
  `docs/DEMO.md` documents the procedure.
- Phase 8 (DEV-02: Ed25519 device identity, RFC 8628 device grant) replaces the long-lived device
  credential behind the same `POST /api/v1/devices/token` exchange and removes
  `OCW_ACCEPT_LEGACY_DEVICE_TOKEN`. Operators can set it to `false` earlier, once every desktop app is
  rebuilt.
- A stolen access token is useful for at most 10 minutes and dies at once when its session is revoked.
  Open sockets close within a second of revocation.
- Every new client (mobile, CLI) authenticates the same way: obtain a token, send it as Bearer or as the
  WebSocket subprotocol entry.
