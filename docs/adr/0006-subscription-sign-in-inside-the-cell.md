# ADR-0006: Subscription model providers sign in inside the OpenClaw cell

- **Status:** Accepted
- **Date:** 2026-10-04
- **Deciders:** Víctor Ruiz (Autofy Labs)

## Context

Bots (OpenClaw agents, one cell per organization) must be able to use a customer's own **ChatGPT
subscription through Codex** instead of an API key. Each customer connects their own subscription to
their own self-hosted instance; we never pool or proxy subscriptions. API-key providers keep working.

Two places could own the OAuth tokens:

1. **The cell (OpenClaw).** OpenClaw 2026.9.7 ships ChatGPT/Codex sign-in in its bundled `openai`
   provider plugin: browser OAuth (PKCE, localhost callback) and **device code**
   (`auth.openai.com/api/accounts/deviceauth/usercode` → poll `…/deviceauth/token` → `oauth/token`,
   15-minute codes). The result is an OAuth auth profile `openai:<email>` in OpenClaw's own SQLite auth
   store (`$OPENCLAW_STATE_DIR/state/openclaw.sqlite`, shared by every agent through read-through), which
   OpenClaw refreshes itself (`refreshOAuth` hook) and routes to `chatgpt.com/backend-api/codex`
   (`openai-chatgpt-responses`). The legacy `openai-codex/*` provider id was folded into `openai/*` in
   2026.9 (`openclaw doctor --fix` migrates old refs).
2. **Our API.** Run the device grant in `apps/api`, store tokens encrypted in `app.secrets` and ship them
   to the cell over the Agent Channel API like API keys; we would then own refresh and rotation races
   with OpenClaw's own refresher.

The CLI (`openclaw models auth login --method device-code`) refuses to run without a TTY, and the
in-process Gateway method `models.authLogin` needs `operator.admin`, which external plugins never get.
OpenClaw does export the flow its own channel `/login` command and Control UI use,
`runModelsAuthLoginFlow`, from `openclaw/plugin-sdk/provider-auth-login-flow-runtime` (a JS-only,
"production-private" export of `package.json#exports`). A spike from our channel plugin in the real
2026.9.7 image obtained a device code from auth.openai.com through it.

## Decision

- **OpenClaw-native sign-in, inside the cell.** The `ocw` channel plugin drives
  `runModelsAuthLoginFlow({provider: "openai", method: "device-code", agent: "main", credentialOnly:
  true, isRemote: true})` with a prompter that forwards the verification URL and one-time code to the
  Agent Channel API. Tokens stay in OpenClaw's auth store, on the cell's state volume; OpenClaw refreshes
  them. They never reach our database, logs or API responses.
- **The API orchestrates only.** Admin-only `POST/GET/DELETE /api/v1/model-providers/openai-codex/auth`;
  durable cell commands `provider.auth.start|cancel|revoke` on `cell:<org>` (additive to Agent Channel
  API v1; older plugins ignore them); the cell reports `pending` (URL + code), `connected` (email + plan),
  `error` (classified) or `disconnected` (credentials lost) on `POST /agent-channel/v1/provider-auth`.
  The short-lived flow state, code included, lives in Redis with a TTL and is readable by admins only;
  browsers get a `provider.auth.updated` hint without the code. Connect, cancel, failure, credential loss
  and disconnect are audited in the same transaction as their state change.
- **Model routing.** Bots keep an OCW model ref `openai-codex/<model>`; the plugin maps it to OpenClaw's
  `openai/<model>` and pins `agentRuntime.id: "openclaw"` per agent model, so the embedded runtime (no
  tools, our dispatch path) runs the turn, never the native Codex harness. When an OpenAI **API key** is
  also configured, the plugin moves it to the custom provider id `ocw-openai`, because OpenClaw keeps
  ChatGPT sign-ins and OpenAI API keys under one provider id.
- **The cell loads OpenClaw's `openai` plugin at boot** (`plugins.allow: ["ocw", "openai"]`, personality
  layer off). Enabling it later would swap plugin instances and abort a sign-in in progress.
- **Fallback (not taken):** device grant in the API with tokens in `app.secrets`. It stays the option if
  a future OpenClaw removes the login-flow export; it would be a new ADR.

## Consequences

- Positive: no token custody in the control plane; refresh, rotation and revocation are OpenClaw's
  (the same code its own UI uses); one sign-in serves every bot of the cell.
- Positive: BYO by construction: the credential lives in the customer's own cell volume.
- Negative: we depend on a JS-only OpenClaw export (`runModelsAuthLoginFlow`) and its prompter shape.
  It is pinned with the image (2026.9.7) and declared narrowly in `openclaw-sdk.d.ts`; every OpenClaw
  bump must re-run the container smoke test, which exercises the real module.
- Negative: wiping the cell's state volume loses the sign-in. The plugin reports it (`disconnected`) and
  the UI asks to reconnect; bots on ChatGPT models report `error` until then.
- Negative: the `openai` plugin adds memory to the cell (idle about 0.6–0.8 GB). On a tight Docker host
  two gateways cannot run side by side.
- The device code is shown to admins only and expires in 15 minutes; it is never logged by the plugin
  or the API (tests scan logs, streams and audit metadata for it).
