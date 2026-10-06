---
phase: 05-direct-ai-chat
plan: 05
subsystem: auth
tags: [oauth, pkce, oidc, jose, siwc, chatgpt-plan, secrets, redis, playwright, settings]

requires:
  - phase: 05-direct-ai-chat
    plan: 02
    provides: user_model_credentials + sealed bundle (AAD org:user:chatgpt_plan), gateway resolve/listModels, accessTokenFor stub, fake Responses API, testing-ai harness
  - phase: 05-direct-ai-chat
    plan: 03
    provides: AI chat pages, model chip, plan usage line, e2e support (openNewAiChat, sendAi)
provides:
  - "chatgpt-plan/oauth.ts: discovery (1 h cache, https-or-same-origin endpoints), startSignIn (PKCE S256, state, nonce, dynamic registration hints), parseRedirect, exchangeCode, validateIdToken (jose JWKS), refreshTokens, revokeTokens, OAuthError, CHATGPT_SCOPES, PLAN_SCOPE, CHATGPT_RESOURCE"
  - "POST /me/model-credentials/chatgpt/start, POST …/complete, DELETE /me/model-credentials/chatgpt"
  - "credentials.ts: serialized refresh inside accessTokenFor (own transaction, Redis NX + row lock), disconnectCredential, authBaseOf; PlanTokenUnavailableError → 503 usage_unavailable"
  - "ai_chat_policies.chatgpt_host_id generated once per org (urn:uuid)"
  - "Audits ai_credential.signin_started / connected / refresh_failed / disconnected"
  - "infra/fake-model/fake-siwc.mjs under /siwc (+ node tests), mounted by server.mjs, shipped in the fake image"
  - "Web: /settings/ai-chat, 'AI chat' in the account nav, ChatgptPlanCard, ChatgptConnectDialog, lib/chatgpt-plan-queries.ts"
  - "ADR-0017 (Proposed)"
affects: [05-04, 05-06, 05-07, 05-08, 05-11, 05-15]

actuals:
  tokens: 34976   # chars/4 over added lines of the realized diff, screenshots excluded
  tasks: 3
  commits: 14

tech-stack:
  added: []
  patterns:
    - "Token refresh runs in its OWN tenant transaction so a needs_reconnect transition commits even though the caller's send then fails"
    - "Redis lock holder refreshes; a caller without the lock re-reads under the row lock and polls (never refreshes)"
    - "Sign-in flow state: GET + binding check + shape check first (a wrong paste keeps the flow), then GETDEL (single use)"
    - "Fake OAuth server exposes counters and sha256 hashes of issued tokens only, never token values"
    - "E2E: Playwright does not route an HTTP redirect's target, so the fake authorize 302 is replayed as location.replace"

key-files:
  created:
    - apps/api/src/modules/model-gateway/chatgpt-plan/oauth.ts
    - apps/api/src/modules/model-gateway/chatgpt-plan/oauth.test.ts
    - apps/api/src/modules/model-gateway/chatgpt-plan/signin.int.test.ts
    - infra/fake-model/fake-siwc.mjs
    - infra/fake-model/fake-siwc.test.mjs
    - apps/web/app/(app)/settings/ai-chat/page.tsx
    - apps/web/components/ai-chat/settings/chatgpt-plan-card.tsx
    - apps/web/components/ai-chat/chatgpt-connect-dialog.tsx
    - apps/web/lib/chatgpt-plan-queries.ts
    - e2e/tests/ai-chat-signin.spec.ts
    - docs/adr/0017-sign-in-with-chatgpt-per-member.md
  modified:
    - apps/api/src/modules/model-gateway/chatgpt-plan/credentials.ts
    - apps/api/src/modules/model-gateway/chatgpt-plan/routes.ts
    - apps/api/src/modules/model-gateway/chatgpt-plan/catalog.ts
    - apps/api/src/modules/model-gateway/errors.ts
    - apps/api/src/modules/model-gateway/index.ts
    - apps/api/src/modules/ai-chat/service.ts
    - apps/api/src/modules/ai-chat/run-loop.ts
    - apps/api/src/testing-ai.ts
    - apps/web/components/settings/account-nav.ts
    - infra/fake-model/server.mjs
    - infra/fake-model/Dockerfile

key-decisions:
  - "Refresh is serialized in a separate transaction (Redis NX lock ocw:ai:siwc-refresh:<credentialId>, then select … for update, re-read); only terminal OAuth codes clear tokens"
  - "A pasted address with the wrong shape (invalid_redirect) does not spend the flow; state mismatch, cancel and any code exchange do"
  - "Another member's flow id reads exactly like a missing one (404) and is left intact"
  - "Terminal code-exchange errors answer 400 signin_failed (not in the planned code list); every grant obtained but not stored is revoked"
  - "Discovery endpoints must be HTTPS or on the configured base's own origin (SSRF guard, T-05-05-07)"
  - "No OpenAI logo is drawn: 'Continue with ChatGPT' is a black/white pill next to the existing GPT mark"

requirements-completed: [AICHAT-02]

coverage:
  - id: D1
    description: "A member connects their own ChatGPT plan through the paste-redirect flow and the next AI chat turn uses their issued token"
    requirement: AICHAT-02
    verification:
      - kind: integration
        ref: "apps/api/src/modules/model-gateway/chatgpt-plan/signin.int.test.ts"
        status: pass
      - kind: e2e
        ref: "e2e/tests/ai-chat-signin.spec.ts (desktop + mobile)"
        status: pass
    human_judgment: false
  - id: D2
    description: "PKCE S256, state, nonce, JWKS ID-token validation (issuer, audience, expiry, nonce, key), scope check"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/model-gateway/chatgpt-plan/oauth.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Refresh exactly once under racing sends; transient errors keep tokens (503); terminal errors → needs_reconnect, secret deleted, audited"
    verification:
      - kind: integration
        ref: "signin.int.test.ts › refresh is serialized and rotation-safe"
        status: pass
    human_judgment: false
  - id: D4
    description: "Disconnect revokes refresh + access tokens, deletes secret and row, idempotent, never touches another member"
    verification:
      - kind: integration
        ref: "signin.int.test.ts › disconnect revokes at the auth server"
        status: pass
      - kind: e2e
        ref: "ai-chat-signin.spec.ts › Sam disconnects"
        status: pass
    human_judgment: false
  - id: D5
    description: "No token, code, verifier or pasted address in any app/auth text or jsonb column, log line or audit row"
    verification:
      - kind: integration
        ref: "signin.int.test.ts › no plaintext … / audit and logs carry no secret"
        status: pass
    human_judgment: false
  - id: D6
    description: "Real sign-in against auth.openai.com (paste relay acceptance, Business/Enterprise eligibility)"
    verification:
      - kind: manual
        ref: "05-15 owner check"
        status: pending
    human_judgment: true

duration: 75min
completed: 2026-10-06
status: complete
---

# Phase 5 Plan 05: Per-member Sign in with ChatGPT Summary

**Each member now connects their own ChatGPT plan from Settings › AI chat. "Continue with ChatGPT" opens the authorize page in a new tab. The member pastes the 127.0.0.1 address it lands on, and the API runs the whole OAuth exchange: PKCE S256, single-use state bound to the member, JWKS-verified ID token and the plan-scope check. The tokens are sealed for that member alone, and the next AI chat answers on their issued token. Expiring tokens refresh exactly once even when sends race. Dead grants ask the member to reconnect, outages keep the tokens, and Disconnect revokes everything at the auth server. Everything is proven against a new fake SIWC server, and ADR-0017 is Proposed.**

## Performance

- **Duration:** ~75 min (2026-10-06, 12:30 to 13:45 local)
- **Tasks:** 3/3
- **Files:** 22 changed (11 created, 11 modified) plus 16 screenshots

## Accomplishments

- **Fake SIWC (`infra/fake-model/fake-siwc.mjs`):** discovery under the request's own base and JWKS from an RSA key generated at start. Authorize approves at once and 302s to the loopback address with `code`, `state` and an `oaiapp_fake_…` client id. The token endpoint checks single-use codes, PKCE and redirect/client binding, rotates refresh tokens and answers `refresh_token_reused`. It also offers revocation, `__scenario` (`deny`, `no_plan_scope`, `expires_in`, `token_unavailable`) and `__stats` (counters plus sha256 of issued access tokens only).
- **OAuth client (`oauth.ts`):** discovery is cached for 1 h and its endpoints must be HTTPS or same-origin. `startSignIn` sends the registration hints only for `dynamic_agent_client`. `parseRedirect` checks shape first, then `error=`, then state. Token requests are form-encoded with strict Zod parsing, and `OAuthError.terminal` is true for the five listed codes (401 included), false for 5xx and network errors. ID tokens go through `jose` `createRemoteJWKSet` + `jwtVerify` (issuer, audience, nonce, 30 s clock tolerance), and plan type comes from `https://api.openai.com/auth`.
- **Routes:**
  - `start` decides `ai_chat.use` and refuses with 409 `disabled_by_org`. It creates the org's `urn:uuid` host id with an insert-or-keep upsert and reuses the member's issued client id. The flow goes to `ocw:ai:siwc:<flowId>` (600 s), then the start is audited.
  - `complete` answers 404 for a missing or foreign flow without spending it. A wrong paste is 400 and keeps the flow; otherwise the flow is consumed with GETDEL. The code exchange then runs: 400 `signin_failed` for a terminal error, 502 `chatgpt_unavailable` for an outage. The ID token is validated and the scope checked before the sealed bundle is stored, and a grant that ends up unstored is revoked. The connection is audited.
  - `DELETE` revokes the refresh token, then the access token, removes the secret and the row, and is audited and idempotent.
- **Refresh (`credentials.ts`):**
  - A token within 5 minutes of expiry is refreshed in its own transaction, under the Redis NX lock and `select … for update`, with a re-read. The rotated bundle and expiry are stored atomically.
  - Terminal errors set `needs_reconnect`, delete the secret, record `last_error` and audit `refresh_failed {provider, reason}`.
  - Transient errors throw `PlanTokenUnavailableError`. The send answers 503 `usage_unavailable`, the run loop fails the generation with that code, and the model list shows the cached catalog.
- **Web:**
  - "AI chat" (Sparkles) in the account settings nav, and `/settings/ai-chat` with the ChatGPT plan section.
  - The card covers not connected (the exact explainer + "Continue with ChatGPT"), connected (email · Plus, "Manage usage" in a new tab, Disconnect with a confirmation), and needs reconnect, plan usage disabled, not eligible and turned off by the admin.
  - The two-step connect dialog becomes a bottom sheet at 390. The tab opens inside the click and is navigated once the API answers, so popup blockers do not interfere. Errors are inline in plain words.

## Task Commits

1. **Task 1 (tracer):** `6931eef` test + `2366fe1` feat (fake SIWC) · `67f846b` test + `4e89e17` feat (OAuth client) · `5b0621a` test (integration RED) + `7772366` feat (routes) · `2ca85de` test (e2e) + `a355462` feat (web)
2. **Task 2:** `be2e9fc` test (refresh/disconnect RED) · `7b71cab` feat (serialized refresh, revoke) · `6b75684` feat (Disconnect UI)
3. **Task 3:** `02005e3` docs (ADR-0017)
4. **Follow-ups:** `b82aebf` fix (e2e redirect routing, card title) · `a001d41` docs (screenshots)

## Verification

- **Unit:** `oauth.test.ts` passes 14/14; the model-gateway unit files pass 27/27.
- **Node:** `node --test infra/fake-model/fake-siwc.test.mjs infra/fake-model/fake-responses.test.mjs` passes. `fake-siwc` is 24/24, and all `infra/fake-model/*.test.mjs` pass 57/57.
- **Integration (ephemeral PostgreSQL + Redis):** `signin.int.test.ts` passes 22/22. The 05-02 `ai-chat.int.test.ts` regression passes 20/20.
- **Isolated e2e:** `--rebuild-web ai-chat-signin ai-chat.spec account` gives **21/21 passed** on desktop and mobile, with no skips or flakes. That covers ai-chat-signin 3×2, ai-chat.spec 3×2 unchanged and account 4×2 unchanged.
- **`pnpm typecheck --force`:** 8/8. **`pnpm verify`:** exit 0. Lint shows 4 warnings, all pre-existing in `apps/local-runtime`. Tests: **149 files, 2062 tests** (05-03 baseline: 147/2026).
- **Acceptance greps:** `ocw:ai:siwc:` is in routes.ts. `createRemoteJWKSet` is in oauth.ts. `/settings/ai-chat` is in account-nav.ts. `ocw:ai:siwc-refresh:` and `export async function disconnectCredential` are in credentials.ts. ADR-0017 has 4 `## ` sections and contains `Proposed`, `0006` and `chatgpt.tokens.use.direct`. ADR-0006 is unchanged since ea27442.
- **Screenshots reviewed with Read:** `settings-ai-chat-not-connected-1440`, `-390-dark`; `chatgpt-connect-dialog-390`, `-1440-dark`; `settings-ai-chat-connected-390`, `-1440`, `-1440-dark`; `settings-ai-chat-disconnect-390`, `-1440-dark`. The two steps read clearly on mobile and the paste field is three monospace lines. The review led to one fix: the card title repeated the section heading. Regression screenshots regenerated by ai-chat.spec and account were reverted and not committed.
- No real OpenAI endpoint was called, no migration was added, and no default `.env` was used for tests. `.env` was symlinked only for the isolated e2e and removed afterwards. The demo was not touched.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Files outside `files_modified`**
- `testing-ai.ts` points `OCW_CHATGPT_AUTH_BASE_URL` at the fake's `/siwc`.
- `errors.ts` adds `PlanTokenUnavailableError`. `index.ts` exports it and falls back to the cached catalog in `listModels`, using `catalog.ts` `cachedPlanCatalog`.
- `ai-chat/service.ts` maps the error to 503 `usage_unavailable`, and `ai-chat/run-loop.ts` fails the generation with `usage_unavailable`.
- `infra/fake-model/Dockerfile` ships `fake-siwc.mjs`.
- Commits: 5b0621a, 7b71cab, 2366fe1.

**2. [Rule 1 - Correctness] Refresh in its own transaction**
- The plan says "select … for update" around the refresh. If the refresh ran inside the caller's send transaction, the send's 409 would roll back the `needs_reconnect` transition.
- The refresh therefore opens its own tenant transaction. The Redis lock holder refreshes; others re-read under the row lock and poll every 150 ms, up to 35 s, then fail transiently. This also avoids a deadlock between the Redis lock and the row lock.
- Commit 7b71cab.

**3. [Rule 2 - Security/UX] Flow handling in `complete`**
- A foreign flow id is not consumed, so Alex cannot burn Sam's sign-in. The plan's "GETDEL" alone would have consumed it.
- A paste with the wrong shape keeps the flow.
- The code adds 400 `signin_failed` for terminal exchange errors and 400 `id_token_invalid` for a token response without an ID token or refresh token.
- Commit 7772366.

**4. [Rule 2 - Security] Discovery SSRF guard and revoke-on-failure**
- Discovery endpoints must be HTTPS or on the configured base's origin.
- Tokens obtained but never stored are revoked: bad ID token, policy turned off between start and complete, or a DB error.
- Commits 4e89e17, 7772366.

**5. [Test] Task 1's e2e ran together with Task 2**
- The spec's `beforeAll` disconnects Sam (`DELETE`, a Task 2 route) because ai-chat.spec seeds him in the other project.
- The first full run failed because Playwright does not intercept the target of an HTTP redirect. The spec now turns the fake authorize 302 into `location.replace`, and the popup still lands on and is routed at `127.0.0.1:1455`.
- Commit b82aebf.

**6. [Scope] Disconnect e2e "picker's plan rows are disabled"**
- The picker ships in 05-04, which runs in parallel. This spec asserts the API model list instead: plan rows are unavailable with `not_connected`, and New chat shows no "Using ChatGPT plan" line.
- The integration "organization rows stay available" assertion is vacuous on this branch, because there are no org-key rows until 05-04.

**7. [UX] No OpenAI logo**
- "Continue with ChatGPT" is a black pill in light mode and a white pill in dark mode, next to the existing `GPT` mark. No trademark artwork was invented.

**Plan mode note:** CLAUDE.md asks for plan mode on authentication and secret custody changes. The plan delegates approval, so the work went from the plan's specification to tests to code.

## Known Stubs

None. The model picker that shows plan rows with reasons belongs to 05-04/05-07, and the desktop loopback listener belongs to 05-07. Both are planned and outside this plan's goal.

## Windows Ledger

`gsd windows append --kind deviation --phase 05 --file e2e/tests/ai-chat-signin.spec.ts --description "Disconnect e2e asserts plan rows via GET /ai-chat/models, and signin.int 'org rows stay available' is vacuous until 05-04's picker and org keys merge; tighten both after the 05-04 merge"`

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: cookie-to-loopback | apps/web/components/ai-chat/chatgpt-connect-dialog.tsx | When OCAW itself is served from `127.0.0.1` (dev or e2e), the browser sends the OCAW session cookie to `http://127.0.0.1:1455/auth/callback`, because cookies are not port-scoped (seen in the e2e trace). Any local process listening on 1455 could read it. Production on a real domain is not affected. Consider documenting this for loopback-hosted setups. |

T-05-05-01 … 07 are each mitigated and covered by tests: foreign/replayed/forged flows (01), ID-token failure cases (02), column, log and audit scans (03), Alex isolation (04), racing refresh (05), the four audits (06), and the test-only auth base plus the discovery origin guard (07).

## Issues Encountered

- The first e2e run failed on the redirect-routing limitation described in deviation 5. It was fixed in the spec, and the code was unaffected.
- The `pg` deprecation warnings during `pnpm verify` come from other suites, as noted in 05-02.

## Next Phase Readiness

- **05-04 merge:** expect small conflicts in `model-gateway/index.ts` (`listModels` try block, error exports) and possibly `errors.ts`.
- **05-07:** can reuse `ChatgptConnectDialog` / `ContinueWithChatgptButton` and `chatgptPlanKeys` for reconnect from the error card and picker. The desktop listener posts to the same `complete` route.
- **05-15:** must run the manual real sign-in (paste relay acceptance, Business seat eligibility, discovery's authorize path) and then accept ADR-0017.

## Self-Check: PASSED

- Files exist: every path in `key-files`.
- Commits found: 6931eef, 2366fe1, 67f846b, 4e89e17, 5b0621a, 7772366, 2ca85de, a355462, be2e9fc, 7b71cab, 6b75684, 02005e3, b82aebf, a001d41.
