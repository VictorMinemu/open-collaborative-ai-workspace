---
phase: 05-direct-ai-chat
plan: 07
subsystem: web, api, desktop
tags: [chatgpt-plan, siwc, errors, usage-limit, model-picker, welcome, electron, loopback, ipc, playwright]

requires:
  - phase: 05-direct-ai-chat
    plan: 04
    provides: ModelPicker / ModelPickerList, setAiChatModel, org_key models (METERED), listModels defaultRef order
  - phase: 05-direct-ai-chat
    plan: 05
    provides: SIWC start/complete flow, ChatgptConnectDialog, ChatgptPlanCard, chatgptPlanKeys, fake SIWC, ADR-0017 (Proposed)
provides:
  - "GenerationError per AiErrorCode (plain language, actions) + usage-limit dialog that opens once per live failure"
  - "Model picker plan states: Continue with ChatGPT / Reconnect ChatGPT rows, not-eligible and admin-off explanations"
  - "ChatgptWelcomeModal (one time after connecting) + POST /me/model-credentials/chatgpt/welcome-seen"
  - "reportFailure audits ai_credential.state_changed {provider, state, reason} on a real transition"
  - "apps/desktop/src/main/chatgpt-loopback.ts: one-shot 127.0.0.1 callback listener; channels ocw:chatgpt-loopback-prepare|await|cancel; optional window.ocwDesktop.chatgptLoopback*"
  - "ChatgptConnectDialog desktop path (no paste) with paste fallback"
affects: [05-06, 05-08, 05-11, 05-15]

actuals:
  tokens: 24760   # chars/4 over added lines of the realized diff (99,039 chars), screenshots excluded
  tasks: 3
  commits: 14

tech-stack:
  added: []
  patterns:
    - "A failure is 'live' when this page saw the message streaming (module-level set fed by AiMessage); only live usage limits open the dialog, once"
    - "'Use an organization model' = setAiChatModel(chatKey, recommended org model); never a resend"
    - "Desktop loopback hands over a rebuilt URL with code/state/client_id/error only; headers and cookies are never read (only Host, for DNS rebinding)"
    - "e2e simulates the desktop preload with addInitScript + exposeFunction (Node plays the main process)"

key-files:
  created:
    - apps/api/src/modules/model-gateway/chatgpt-plan/plan-errors.int.test.ts
    - apps/web/components/ai-chat/chatgpt-welcome-modal.tsx
    - apps/desktop/src/main/chatgpt-loopback.ts
    - apps/desktop/src/main/chatgpt-loopback.test.ts
    - e2e/tests/ai-chat-plan-errors.spec.ts
  modified:
    - apps/api/src/modules/model-gateway/chatgpt-plan/routes.ts
    - apps/api/src/modules/model-gateway/chatgpt-plan/signin.int.test.ts
    - apps/api/src/modules/model-gateway/index.ts
    - apps/web/components/ai-chat/generation-error.tsx
    - apps/web/components/ai-chat/ai-message.tsx
    - apps/web/components/ai-chat/model-picker.tsx
    - apps/web/components/ai-chat/model-picker.test.tsx
    - apps/web/components/ai-chat/chatgpt-connect-dialog.tsx
    - apps/web/components/ai-chat/settings/chatgpt-plan-card.tsx
    - apps/web/lib/chatgpt-plan-queries.ts
    - apps/web/lib/desktop.ts
    - apps/desktop/src/main/index.ts
    - apps/desktop/src/preload/main.ts
    - apps/desktop/src/shared/channels.ts
    - apps/desktop/src/shared/ipc.ts
    - apps/desktop/src/shared/ipc.test.ts
    - apps/desktop/src/shared/desktop-api.d.ts
    - e2e/tests/ai-chat-signin.spec.ts
    - e2e/tests/ai-chat.spec.ts
    - docs/adr/0017-sign-in-with-chatgpt-per-member.md

key-decisions:
  - "No silent billing switch: the usage-limit dialog leads with Manage usage; the org model is the member's explicit choice and only changes the composer selection"
  - "Credential transitions (not_eligible, needs_reconnect) are audited from reportFailure, only when the status really changes"
  - "welcome-seen is idempotent (first timestamp kept) and survives a reconnect; a disconnect deletes the row, so a later new connection shows it again"
  - "The desktop listener is a scoped exception to 'no listening TCP port': desktop main process only, 127.0.0.1, one request, Host-checked, 5 min, cancelled on window close/quit; the daemon stays socket-only"

requirements-completed: [AICHAT-02, AICHAT-03]

coverage:
  - id: D1
    description: "Usage limit mid-answer: partial text kept, one plan request, no retry, no Anthropic call, credential stays connected; dialog leads with Manage usage; explicit org switch, nothing resent"
    requirement: AICHAT-02
    verification:
      - kind: integration
        ref: "apps/api/src/modules/model-gateway/chatgpt-plan/plan-errors.int.test.ts"
        status: pass
      - kind: e2e
        ref: "e2e/tests/ai-chat-plan-errors.spec.ts (desktop + mobile)"
        status: pass
    human_judgment: false
  - id: D2
    description: "not_eligible / invalid_user / unavailable / unsupported states, defaultRef falls back to the org model, reconnect, welcome-seen, audits without bodies"
    requirement: AICHAT-02
    verification:
      - kind: integration
        ref: "plan-errors.int.test.ts"
        status: pass
      - kind: unit
        ref: "apps/web/components/ai-chat/model-picker.test.tsx"
        status: pass
      - kind: e2e
        ref: "ai-chat-plan-errors.spec.ts (picker entry, welcome once, not eligible, reconnect)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Desktop sign-in without paste: one-shot 127.0.0.1 listener, IPC validation, web desktop path with paste fallback"
    requirement: AICHAT-02
    verification:
      - kind: unit
        ref: "apps/desktop/src/main/chatgpt-loopback.test.ts, apps/desktop/src/shared/ipc.test.ts"
        status: pass
      - kind: e2e
        ref: "ai-chat-plan-errors.spec.ts (simulated preload: no paste; cancel → paste)"
        status: pass
      - kind: manual
        ref: "05-15 owner check on a real desktop build against auth.openai.com"
        status: pending
    human_judgment: true

duration: ~95min
completed: 2026-10-06
status: complete
---

# Phase 5 Plan 07: ChatGPT-plan errors and UX, desktop loopback sign-in Summary

**When a member's ChatGPT plan hits its usage limit mid-answer, the answer keeps its text. A dialog leads with "Manage usage" and offers "Use an organization model" (METERED) only as the member's explicit choice; nothing is resent or re-routed. Every other plan state now has plain words and the right action: not eligible falls back to organization models, Reconnect is offered where it helps, "Continue with ChatGPT" is in the picker, and a one-time welcome follows each new connection. In the desktop app the sign-in needs no paste: a one-shot listener on 127.0.0.1 in the Electron main process catches the callback.**

## Accomplishments

- **API:**
  - `plan-errors.int` proves the 05-02/05-05 backend end to end for every SIWC code. A usage limit keeps the partial body, makes exactly one plan request and no Anthropic call, and leaves the credential `connected`. `not_eligible` and `invalid_user` move the credential and make the org model the default. `unavailable` and `unsupported:input_file` (with `errorParam`) keep it connected.
  - `POST /me/model-credentials/chatgpt/welcome-seen` writes the caller's own row only, is idempotent, and survives a reconnect.
  - `reportFailure` now audits `ai_credential.state_changed {provider, state, reason}`, only when the status really changes.
- **Web:**
  - `GenerationError` gives each code one sentence and its actions: Manage usage, Use an organization model, or Reconnect ChatGPT. Unsupported capabilities are named in words ("files", "images", "web search").
  - The usage-limit dialog (sheet at 390, initial focus on Manage usage) opens once, and only for failures that arrive live. After a reload only the card shows.
  - A live credential failure refreshes the model list and plan status.
  - Picker: the plan group's "Not connected" row is now "Continue with ChatGPT". Reconnect and plan-usage-off show "Reconnect ChatGPT". A not-eligible account gets a wrapped explanation; when the admin turned plans off, the row says "Turned off by your admin".
  - `ChatgptWelcomeModal` opens after a connect from the picker, the error card or Settings. It reads "…counts toward your plan's limits, not your organization's bill", and any way of closing it records it as seen.
- **Desktop:**
  - `chatgpt-loopback.ts` binds 127.0.0.1 only: port 1455, else an ephemeral port that the API puts into `redirect_uri`.
  - It serves one GET `/auth/callback` with a matching `Host`. The page it returns is static, has no script, and is sent with no-store and CSP headers. The listener then closes.
  - Other limits: a 5-minute timeout, one flow at a time, https-only authorize URLs (http://127.0.0.1 only in unpackaged builds), and no logging.
  - Three Zod-validated channels go through the existing trusted-sender wrapper. The preload exposes optional functions, and the listener is cancelled when the window closes or the app quits.
  - `ChatgptConnectDialog` runs prepare → start(redirectPort) → await → complete and shows "Waiting for ChatGPT in your browser…". If that fails, times out or the member chooses "Paste the address instead", the same sign-in continues by paste.

## Task Commits

1. **Task 1 (tracer):** `a2637bf` test (int + e2e RED) · `45cbaa6` feat (usage-limit dialog/card)
2. **Task 2:** `edd0a5d` test (int RED) · `7e74df3` feat (API) · `d3a821a` test (picker RED) · `98e52a8` feat (web) · `91daaf3` docs (screenshots) · `85058b6` test fix
3. **Task 3:** `89bde0f` test (desktop RED) · `214aa0a` feat (listener + IPC) · `35b39ac` test (e2e RED) · `dad3998` feat (web desktop path) · `5f28487` docs (ADR-0017 note) · `bf839b1` fix (wait-state copy + screenshots)

## Verification

- **Integration:** `plan-errors.int` 12/12 on an ephemeral PostgreSQL + Redis. Tasks 2 and 3 were RED first: the route returned 404 and no audits were written. `signin.int` 22/22, and its "organization rows stay available" check is now a real assertion (next section).
- **Web unit:** `model-picker.test` 10/10 (4 RED first).
- **Desktop:** `env -u ELECTRON_RUN_AS_NODE pnpm --filter @ocw/desktop test` 11 files, **88/88**: `chatgpt-loopback.test.ts` 16/16, and `ipc.test.ts` gained 5 tests.
- **Isolated e2e** (`scripts/e2e-isolated.sh`):
  - Task 1 run (`--rebuild-web ai-chat-plan-errors ai-chat.spec`): 11/11.
  - Task 2 run (+ ai-chat-signin, ai-chat-models): 31/31.
  - Final run (`--rebuild-web ai-chat-plan-errors ai-chat-signin ai-chat-models ai-chat.spec`): **35/35** on desktop and mobile, with no skips, flakes or retries. Two `ai-chat-plan-errors`-only runs after the copy fix gave 15/15 each.
- **`pnpm typecheck --force`:** 8/8. **`pnpm verify`:** exit 0, **155 files, 2142 tests** (05-04 baseline 151/2068). The 4 lint warnings were already in `apps/local-runtime`.
- **Acceptance greps:** `usage_limit_exceeded` and `setAiChatModel` are in generation-error.tsx; `welcome-seen` is in routes.ts; `export function ChatgptWelcomeModal` exists; "Continue with ChatGPT" appears ≥1 time in model-picker.tsx; `"127.0.0.1"` is in chatgpt-loopback.ts; channels.ts has 3 `chatgpt-loopback` lines.
- **Daemon untouched:** `git log ea27442..HEAD -- apps/local-runtime/src` is empty, and `git diff --quiet HEAD -- apps/local-runtime/src` exits 0.
- **Screenshots reviewed with Read:**
  - `ai-plan-usage-limit-1440` and `-390-dark`. This review led to two changes: focus now starts on Manage usage, and the dialog copy is shorter.
  - `ai-picker-continue-chatgpt-390` and `-1440-dark`
  - `chatgpt-welcome-1440-dark` and `-390`
  - `ai-plan-not-eligible-1440`
  - `chatgpt-desktop-waiting-390` and `-1440-dark`. Two Cancel buttons were confusing, so the inline one became "Paste the address instead".
  - None of them says the organization pays for plan usage. Screenshots from regression specs were reverted.
- **Safety:** no real provider was called. No migration was added, and the default `.env` was never used for tests (symlinked for the isolated e2e only, now removed). The demo, other worktrees, the owner's desktop app and `~/.ocw` were not touched, and no Electron binary was launched.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Audit] `model-gateway/index.ts` is not in `files_modified`**
- The plan expects audits for the not-eligible and reconnect transitions, but `reportFailure` wrote none.
- It now audits `ai_credential.state_changed` (`provider`, `state`, `reason`) with a `ne(status)` guard, so a transition is recorded once. Commit 7e74df3.

**2. [Spec precision] "three ai.delta frames" and "usage record (estimated)"**
- The run loop coalesces deltas into 50 ms frames (P-06), so the test checks that the offsets chain and that the deltas join to "Echo: hello" (the fake's three pieces).
- The fake's `response.failed` reports usage, so the usage record carries reported counts (`estimated: false`) with `cost null`, which is what the run loop should do.

**3. [Rule 3 - Blocking] Edits outside `files_modified`**
- `ai-message.tsx` gained two lines: `markStreamed`, and the new GenerationError props. Expect a small merge conflict with 05-06, which also edits this file.
- `e2e/tests/ai-chat.spec.ts`: the failed card's text is now "ChatGPT is temporarily unavailable. Try again in a moment."
- `e2e/tests/ai-chat-signin.spec.ts`: the new connection's welcome is dismissed.
- `signin.int.test.ts`: Anthropic is configured and the org rows are asserted, as the orchestrator asked.
- `docs/adr/0017` (Proposed, so editable) records the scoped exception.

**4. [Test harness] Seeded plans cannot reconnect at the fake SIWC**
- The seed route uses client id `oaiapp_fake`, which the fake never issued.
- `plan-errors.int` connects both members through the real 05-05 flow instead.

**5. [Rule 2 - Security] Additions to the listener interface**
- The listener checks `Host` (DNS rebinding) and rebuilds the URL from an allow-list.
- `prepare` accepts `allowLoopbackAuthorize`, set to `!app.isPackaged` in main.
- Also added: `cancelAllChatgptLoopbacks()` (window close / quit) and `activeChatgptLoopbackAddress()` (the test asserts the bound address).

**6. [UX] Desktop wait copy**
- The behavior asked for "Waiting… with Cancel". The footer Cancel closes the dialog and frees the listener.
- The inline action reads "Paste the address instead", which cancels the wait and shows the paste step.

**7. [Test] Extra e2e coverage for the web desktop path**
- A simulated `window.ocwDesktop` (init script, with Node playing the main process) proves two things: the redirect port reaches `redirect_uri` and nothing is pasted, and cancelling falls back to paste on the same flow.
- The real Electron round trip remains the 05-15 human check.

**Plan mode note:** CLAUDE.md asks for plan mode on permission/audit changes. The plan specified the route, the audit and the threat mitigations, so it was implemented test-first as written.

## Known Stubs

None.

## Windows Ledger

`gsd windows append --kind unrun-verify --phase 05 --file apps/desktop/src/main/chatgpt-loopback.ts --description "Real desktop build: Continue with ChatGPT through the system browser and the 127.0.0.1 listener against auth.openai.com (human-check, 05-15 owner check)"`

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: loopback-listener | apps/desktop/src/main/chatgpt-loopback.ts | A new, temporary TCP listener in the desktop main process. It is a scoped exception to the daemon's "no TCP port" rule and is recorded in ADR-0017: 127.0.0.1 only, one request, Host-checked, 5 min, never reads cookies or headers, no logging. |

T-05-07-01 … 05 are mitigated and tested:
- **01:** no Anthropic call or retry after any plan failure (int), and no resend after the org switch (e2e).
- **02:** the API validates state and PKCE; the listener answers one request with a Host check.
- **03:** the bound address is asserted as 127.0.0.1, the port is freed on timeout, cancel and resolve, and the log scan finds no `code=`.
- **04:** Zod args, trusted sender, and https-only authorize URLs.
- **05:** the UI renders per-code copy only, and the audits carry no body or token.

## Issues / Open

- **05-06 merge:** expect a conflict in `ai-message.tsx`. Keep both 05-06's Stop/Regenerate changes and this plan's `markStreamed` + GenerationError props.
- **Plain-browser paste on a loopback-hosted workspace:** the 05-05 cookie caveat still applies there (documented in ADR-0017). The desktop path is not affected.

## Self-Check: PASSED

- Files exist: every path in `key-files`.
- Commits found: a2637bf, 45cbaa6, edd0a5d, 7e74df3, d3a821a, 98e52a8, 91daaf3, 85058b6, 89bde0f, 214aa0a, 35b39ac, dad3998, 5f28487, bf839b1.
