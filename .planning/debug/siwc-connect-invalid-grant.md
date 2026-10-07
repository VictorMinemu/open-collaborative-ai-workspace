---
status: diagnosed
trigger: "Per-member Sign in with ChatGPT (SIWC, ADR-0017) for AI chats does not work on the local demo; Connect looks disabled with the pasted 127.0.0.1:1455 callback in the textarea"
created: 2026-10-07T13:25:00Z
updated: 2026-10-07T13:47:00Z
goal: find_root_cause_only
---

## Current Focus

hypothesis: Real OpenAI token endpoint rejects the authorization_code exchange with invalid_grant because exchangeCode() omits `resource=https://api.openai.com/v1` (sent at authorize). The fake never checks resource, so tests pass. Disabled Connect is a downstream UI state (signin_failed restart:true clears flow; re-paste clears the error).
test: unit check of exchangeCode body + parseRedirect on the real URL shape (synthetic code) in the throwaway worktree
expecting: body has no `resource`; parseRedirect accepts the shape (so client-side/parse is not the cause)
next_action: pnpm install in ../ocw-siwc-debug, run a scratch vitest that captures exchangeCode's form body
bug_class: Bohrbug (deterministic: every real first sign-in exchange omits resource)
known_pattern_candidate: "03.1-tool-gate — fake passes, real fails (fake did not model the real contract)"

## Symptoms

expected: paste the 127.0.0.1:1455/auth/callback address, click Connect, card shows Connected
actual: screenshot (08:23 local) shows step 1 back to "Continue with ChatGPT", textarea holds the URL, Connect disabled, no error text
errors: none visible in screenshot
reproduction: Settings > AI chat > Continue with ChatGPT > approve at OpenAI > paste > Connect
started: first real-OpenAI attempt (owner manual check of ADR-0017), 2026-10-07 13:21 UTC

## Eliminated

- hypothesis: client-side parsing/validation keeps Connect disabled for this URL shape
  evidence: Connect enable is only `flow && address.trim() && !pending` (no URL parsing client-side); API log shows POST /complete at 13:21:50Z, so Connect was clicked and enabled
  timestamp: 2026-10-07T13:35:00Z
- hypothesis: wrong token endpoint (Codex /oauth/token vs /api/accounts/oauth/token)
  evidence: live public discovery returns token_endpoint https://auth.openai.com/api/accounts/oauth/token; code follows discovery
  timestamp: 2026-10-07T13:36:00Z
- hypothesis: expired or reused code
  evidence: start 13:21:28Z, complete 13:21:50Z (22 s); exactly one complete call in the log; nothing listening on 1455 now
  timestamp: 2026-10-07T13:36:00Z

## Evidence

- timestamp: 2026-10-07T13:30:00Z
  checked: demo processes (lsof) and worktree reflog
  found: API pid 33028 (tsx, cwd t3code-81d72154/apps/api) and web pid 33029 started 00:52:01 local, when the worktree was at b9115b2 (Phase 5; differs from origin/main 3bbcbd9 only in 05-VERIFICATION.md). Logs at ~/.ocw-demo/logs/api.log and web.log
  implication: demo runs origin/main code
- timestamp: 2026-10-07T13:31:00Z
  checked: ~/.ocw-demo/logs/api.log
  found: 13:21:27Z POST /chatgpt/start 200; 13:21:50Z POST /chatgpt/complete -> WARN {provider:chatgpt_plan, code:invalid_grant, status:400} "chatgpt sign-in code exchange failed" -> 400 (640 ms)
  implication: paste parsed and state matched; OpenAI's real token endpoint refused the code exchange
- timestamp: 2026-10-07T13:33:00Z
  checked: demo DB (read-only SELECT)
  found: one audit row ai_credential.signin_started {state: not_connected}; no user_model_credentials row; policy enabled with host id
  implication: first-time registration flow (client_id=dynamic_agent_client); no failure audit is written
- timestamp: 2026-10-07T13:34:00Z
  checked: chatgpt-connect-dialog.tsx and the screenshot
  found: signin_failed has restart:true -> failWith clears flow and address; onChange clears error on re-paste; Connect disabled while !flow; step 1 shows Continue only when flow===null
  implication: screenshot state = after a failed Connect + re-paste; UI hides the reason
- timestamp: 2026-10-07T13:37:00Z
  checked: developers.openai.com/siwc sign-in doc + OpenClaw, t3code, TanStack AI, pi implementations
  found: doc step 3 "exchange ... with the issued client_id, code, code_verifier, the same redirect_uri, and the same resource"; all four implementations send resource on the code exchange; oauth.ts exchangeCode sends only grant_type, code, code_verifier, redirect_uri, client_id; fake-siwc token() never checks resource
  implication: strongest discrepancy between our client and the real server

- timestamp: 2026-10-07T13:45:00Z
  checked: revert test in this worktree. fake-siwc made to enforce the documented rule (code bound to the authorize resource; refresh requires resource), oauth.ts unchanged
  found: signin.int.test.ts 13 failed / 9 passed, every sign-in answering 400 signin_failed "ChatGPT did not accept this sign-in" (the demo's exact response). With `resource: CHATGPT_RESOURCE` added to exchangeCode: signin + plan-errors int tests 34/34 pass
  implication: the omission alone reproduces the owner's failure against a fake that follows the documented contract. Expected collateral: oauth.test.ts:290 (exact body without resource) and 5 fake-siwc.test.mjs token tests need `resource` added
- timestamp: 2026-10-07T13:46:00Z
  checked: oauth.test.ts:290-311
  found: the unit test asserts the exchange body with toEqual and no resource. The refresh test (259) does include resource
  implication: why it was not caught. The test and the fake both encoded the omission

## Resolution

root_cause: apps/api/src/modules/model-gateway/chatgpt-plan/oauth.ts exchangeCode (248-264) POSTs the authorization_code grant without `resource=https://api.openai.com/v1`, although authorize sends it and OpenAI's SIWC doc (sign-in step 3) requires "the same resource". OpenAI's token endpoint answers 400 invalid_grant; routes.ts:218-226 maps that to 400 signin_failed. The dialog (restart:true) then clears flow+address, and re-pasting clears the error, so Connect sits disabled with no message. The fake (fake-siwc.mjs token()) never checks resource, so unit, integration and e2e tests passed.
fix: (diagnose only) add `resource: CHATGPT_RESOURCE` to exchangeCode; make fake-siwc enforce resource on both grants; update oauth.test.ts and fake-siwc.test.mjs. Hardening: reject a first-registration callback without an `oaiapp_` client_id (doc: registration incomplete). The dialog should keep the restart error visible until Continue is pressed again
verification: prototype in ../ocw-siwc-debug (uncommitted). Strict fake without the fix fails like the demo; with the fix, 34/34 int tests pass. Real-server confirmation still pending (owner retries once after deploy)
files_changed: []
specialist_hint: typescript
