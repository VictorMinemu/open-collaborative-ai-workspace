# ADR-0017: AI chats sign each member in with their own ChatGPT plan, in the API

## Status

Proposed (owner decisions D-01, D-02 and D-03 in `.planning/phases/05-direct-ai-chat/05-CONTEXT.md`; plan 05-15
accepts it after the Phase 5 gate and the owner's manual sign-in check).
**Date:** 2026-10-06. Complements [ADR-0006](0006-subscription-sign-in-inside-the-cell.md), which stays in force for
bots; supersedes nothing.

## Context

Phase 5 adds private, streaming AI chats (AICHAT-02). The owner decided that they run on two backends (D-01): the
member's **own ChatGPT plan by default**, bring-your-own and never pooled, and optional organization API keys held as
`SecretReference`s. Members never type personal API keys.

- **OpenAI's route.** On 2026-09-30 OpenAI opened "Sign in with ChatGPT – ChatGPT plan usage" to open-source and
  locally hosted apps (developers.openai.com/siwc). A user signs in with OAuth (authorization code + PKCE) and the app
  calls the public Responses API with that user's token. Usage counts against the user's plan. OpenAI states that
  tokens must not be shared or pooled across users, and that `backend-api` endpoints must not be used.
- **Why not the cell's sign-in (ADR-0006).** The OpenClaw cell holds one ChatGPT sign-in per organization for every
  bot. Using it for AI chats would make one person's seat pay for every member's private chats, which contradicts
  D-01. It also routes to `chatgpt.com/backend-api/codex`, and the cell returns whole reply blocks rather than
  deltas. A relay through the plugin would need a new streaming route and an operator-level endpoint inside the cell.
- **Claude (D-03).** Anthropic's published terms forbid third-party apps from offering Claude.ai login or routing
  requests through Free, Pro or Max credentials, Agent SDK included. AI chats therefore offer Claude only through
  an organization's Anthropic or OpenRouter key, labelled METERED. This ADR covers no Claude-subscription path.
- **The loopback redirect.** SIWC requires `http://127.0.0.1:<port>/auth/callback`: only the port may vary, never
  `localhost`. A self-hosted server cannot receive that redirect, because it reaches the computer running the
  browser and not the server.

## Decision

1. **Per-member OAuth, run by the API.** `apps/api/src/modules/model-gateway/chatgpt-plan/oauth.ts` performs OIDC
   discovery on `OCW_CHATGPT_AUTH_BASE_URL` (default `https://auth.openai.com`; any override is refused in
   production). Each endpoint must be HTTPS or on that base's own origin. The authorization request carries PKCE
   S256, `state`, `nonce`, the scopes `openid profile email offline_access resource.invoke
   chatgpt.tokens.use.direct` and `resource=https://api.openai.com/v1`. The verifier, `state` and `nonce` stay in
   Redis (`ocw:ai:siwc:<flowId>`) for 10 minutes. The flow is bound to the organization and member who started it,
   and it is read once with GETDEL. The browser only ever sees the authorize URL and a flow id.
2. **Dynamic client registration.** A member's first sign-in uses `client_id=dynamic_agent_client` with
   `agent_name_hint=Open Collaborative AI Workspace` and an opaque `ext_agent_host_id`. That id (`urn:uuid:…`) is
   generated once per organization of the deployment and kept in `ai_chat_policies.chatgpt_host_id`. The issued
   `oaiapp_…` client id is stored on the member's credential, used for every later sign-in and refresh, and is the
   ID token's expected audience.
3. **The redirect is relayed by paste on every client.** After approving, the member's browser shows an
   unreachable `127.0.0.1` page. The member pastes its address into a dialog (Settings › AI chat), and the address
   travels in a POST body only; it is never logged, audited or put in a query string. The API accepts only
   `http://127.0.0.1:<the requested port>/auth/callback` or its bare query. A wrong paste does not spend the flow. A
   state mismatch, a cancellation or a code exchange does spend it. Plan 05-07 adds an optional desktop path: the
   Electron main process (never the Local Runtime daemon) opens a transient loopback listener for one request and
   forwards `{code, state}` the same way.
4. **ID token and scope checks.** The ID token is verified against the issuer's JWKS with `jose`. The checks are the
   issuer, the audience (the issued client id), expiry with 30 s of tolerance, and the nonce. Subject, email and the
   `chatgpt_plan_type` claim are kept as identity metadata. Without the `chatgpt.tokens.use.direct` scope the
   credential is stored as `plan_usage_disabled`, and AI chats fall back to organization models.
5. **Custody: sealed per member.** The token bundle (access token, refresh token, expiry, client id) is one row in
   `app.secrets` (kind `user_model_credential`). It is sealed with AES-256-GCM and the AAD
   `<orgId>:<userId>:chatgpt_plan`, so it opens only for that member. `user_model_credentials` holds identity
   metadata and status, never a token. A member's token is used only for that member's own turns; no admin path
   reads or uses it.
6. **Serialized refresh.** A token expiring within 5 minutes is refreshed before use. The refresh runs in its own
   transaction: a Redis lock (`ocw:ai:siwc-refresh:<credentialId>`, `SET NX PX 30000`), then `select … for update`
   on the credential row, then a re-read. Only the lock holder calls the token endpoint, and the rotated bundle and
   new expiry are stored atomically. Terminal OAuth errors (`invalid_grant`, `refresh_token_reused`,
   `invalid_client`, `access_denied`, `unauthorized_client`) move the member to `needs_reconnect`, delete the sealed
   bundle and are audited (`ai_credential.refresh_failed {provider, reason}`). Transient errors keep everything; the
   send answers 503 `usage_unavailable`.
7. **Revoke on disconnect.** Disconnect revokes the refresh token, then the access token, at the OIDC
   `revocation_endpoint` (best effort). It then deletes the secret and the row. The member's AI chats fall back to
   organization models.
8. **Inference** uses the public Responses API through the same AI SDK OpenAI provider as organization keys, with
   `store:false`, `stream:true`, instructions as a developer item, and none of the fields the preview rejects
   (05-02). Members whose accounts are `not_eligible` or plan-usage-disabled fall back to organization models
   with a clear reason. Their requests are never silently switched to another billing path.
9. **Audit** records `ai_credential.signin_started`, `connected`, `refresh_failed` and `disconnected` with the
   provider plus the resulting state or reason only.
10. **ADR-0006 stays** for bots: the cell's organization sign-in serves bots and is never used for AI chats.

## Consequences

- **The API holds member tokens.** ADR-0006 rejected API custody for the cell's sign-in to avoid racing
  OpenClaw's own refresher. Here no OpenClaw refresher exists, so that reason does not apply. The cost is
  refresh-race handling (decision 6) and the guarantees in decision 5. Both are covered by integration tests: a
  scan of every text and jsonb column, log scans, two racing sends that refresh once, and another member's flow
  that 404s.
- **NEEDS VALIDATION, owner's manual check in 05-15:**
  - whether OpenAI accepts the paste relay of the loopback redirect (the docs require a loopback redirect and say
    nothing against relaying it);
  - whether ChatGPT Business and Enterprise seats are eligible (`subscription_sharing_user_not_eligible` is
    mapped and falls back cleanly);
  - whether real discovery returns `/api/accounts/authorize` or another authorize path. The client follows
    discovery.
- **The managed cloud** later counts as a "paid or remotely hosted app" and needs OpenAI's interest form before it
  offers plan usage. Self-hosted deployments match the documented "Self-hosted VMs" case.
- **Per-app limits** are managed by each member at `chatgpt.com/settings/usage`. The UI links there ("Manage
  usage") and never promises limits OpenAI does not state.
- **Tests never reach OpenAI.** `infra/fake-model/fake-siwc.mjs` implements discovery, authorize, token (PKCE,
  rotation, reuse detection), JWKS and revocation, with test-only scenario and stats endpoints. The isolated e2e
  harness points `OCW_CHATGPT_AUTH_BASE_URL` at it.
