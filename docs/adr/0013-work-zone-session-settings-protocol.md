# ADR-0013: Work Zone session settings protocol

## Status

Accepted (owner-delegated: the owner approved the Phase 03.2 plan and delegated these design decisions to it).
**Date:** 2026-10-05. Builds on [ADR-0012](0012-full-access-mode-and-shared-devices.md) (Full access and shared
devices) and [ADR-0005](0005-local-runtime-daemon-process-model.md) (daemon process model); supersedes neither.

## Context

Phase 03.2 lets the controllers of a Work Zone session change the model, the reasoning effort, the context window,
fast mode and the permission mode (up to ADR-0012's Full access) while the session runs on a member's device with
Claude Code (Claude Agent SDK) or Codex (`codex app-server`). Principle 1 says the session belongs to the platform:
the requested settings, who changed them and every turn's effective mode must live in the Control Plane, while
only the device can apply them to the runtime. Principle 5 says nothing outside an adapter may depend on runtime
internals. The two runtimes differ: Claude applies settings to a live query (`setModel`, `applyFlagSettings`,
`setPermissionMode`), Codex takes per-turn overrides on `turn/start`; neither offers every option the reference UI
shows, and the options change with each runtime release. Research: `.planning/phases/03.2-work-zone-session-controls/03.2-RESEARCH.md`.

## Decision

1. **One settings contract, two messages.** `SessionSettings` in `packages/contracts` (model, effort, context
   window, fast mode, permission mode). The API sends the device command `session.configure` with only the changed,
   authorized keys; the device answers with the event `session.settings` carrying what the runtime really runs.
   The adapter applies settings **between turns**; a change during a running turn is held and applied before the
   next prompt (the UI says "applies to the next turn"). `work_session.updated` propagates both values live.
2. **Storage (P-04).** `work_sessions.model` and `permission_mode` hold the requested (authorized) values;
   `work_sessions.settings` holds effort, context window and fast mode; `effective_settings` is the last device
   report; `settings_pending` is true from a change until the report; `work_prompts.permission_mode` records the
   authorized mode of every dispatched turn.
3. **Catalog transport (P-05).** The daemon reports each runtime's catalog (models, efforts, context windows, fast
   mode, accepted permission modes) and its Full access opt-in in a `capabilities` frame after connecting and on
   every change; `hello` also carries the opt-in. The API stores them on the device row, never writable from user
   routes. Collecting a catalog never sends a model turn. The UI never hard-codes a model list.
4. **One server-side intersection.** Everything a controller may pick is runtime catalog ∩ org Work Zone policy ∩
   device opt-in ∩ the caller's cap on the device ∩ the `device.full_access` grain ∩ the inventory (decision 7),
   computed by pure functions in `apps/api/src/modules/work-session/controls.ts` and used by the controls route,
   settings changes, session creation, dispatch and reauthorization.
5. **Per-turn mode (P-07).** At dispatch each turn runs at min(session mode, cap of the prompt's author), sent as
   `PromptPayload.permissionMode`; the adapter lowers to it before the turn or refuses the turn. Every dispatched
   turn is audited (`work_prompt.dispatched` with requested and effective mode). A tightened policy, opt-out or
   revoked access downgrades or stops live sessions and interrupts a Full access turn in flight.
6. **Denial reasons (P-08).** Refusals are `AuthzDeniedError` on `work_session.configure` with the reason of the
   highest layer that refused: `org_policy`, then `device_opt_in` / `device_grant`, then `denied_for_you`, then
   `runtime` / `not_in_catalog`, then `not_confirmed`. The UI shows the reason next to the disabled option.
7. **The inventory is code (P-09).** `packages/contracts/src/runtime-controls/` lists every runtime option and
   every reference layout element as exposed, deferred or impossible, with reason and evidence. The web renders a
   control only when its row is exposed and the API refuses non-exposed rows (`not_confirmed`).
   `docs/workzone/runtime-controls-inventory.md` is generated from it and a test fails on drift.
8. **Slash commands (P-10).** One parser (`slashDisposition`) decides for the composer, the API and the adapters:
   `/model`, `/effort`, `/fast`, `/permissions` go through the same policy-checked, audited settings path; a
   per-runtime allowlist (`/compact`, …) runs as a prompt; everything else is refused with a visible notice and
   audited. Adapters refuse raw settings commands as a backstop, so none reaches a runtime unchecked.
9. **Full access in the adapters (P-11).** Claude: only a query launched for an authorized `fullAccess` session
   carries `bypassPermissions` + `allowDangerouslySkipPermissions`; crossing the Full access boundary relaunches
   the query between turns with `resume`, keeping the secret deny rules and the PreToolUse hook. Codex: an
   authorized `fullAccess` turn sends `approvalPolicy: "never"` + `sandboxPolicy: dangerFullAccess` per
   `turn/start`. Any bypass report that was not authorized still aborts the session (fail closed).
10. **The device opt-in stays on the device (P-12).** `runtime.json` `fullAccess.optIn` (default off),
    `OCW_ALLOW_FULL_ACCESS` for headless servers, `ocw-runtime full-access on|off|status`, and the desktop Runtime
    menu behind a native confirmation. The daemon refuses Full access starts, configures and turns while it is off;
    neither the web origin nor the server can turn it on.

## Consequences

- Each runtime release can add, remove or change options. Fixtures are recorded per pinned version (Claude Code
  2.1.289 / SDK 0.3.282, Codex 0.160.0) and the inventory names them; after an upgrade the refresh procedure in
  `docs/workzone/runtime-controls-inventory.md` (regenerate Codex types, re-run probes and recorders, update rows,
  regenerate the table) must run before a row changes status. Codex auto-updated to 0.160.1 on the recording
  machine; re-pinning is a follow-up chore.
- Full access and Codex Auto's reviewer behaviour are exposed without a real-runtime fixture (a bypass turn is
  never recorded by an agent). The owner verifies a real Full access turn by hand, including Claude's
  relaunch-with-resume when a session enters and leaves Full access. An optional isolation boundary for Full
  access sessions (sandbox with the worktree as the only writable root) is a recorded follow-up, not a blocker.
- Switching runtime inside a session (`.planning/research/WORKZONE-PROVIDER-SWITCH.md`) stays compatible: it adds
  a handoff on `session.start`, while `session.configure` keeps changing settings within one runtime and the catalog
  already describes every runtime on the device. Several agents per session
  (`.planning/research/WORKZONE-MULTI-AGENT.md`) give each agent its own runtime and settings with the same
  contract; Ultracode and Codex `ultra` stay deferred until then.
- The API pays one catalog-backed decision per settings change and per dispatched turn; the catalog is cached on
  the device row, so no turn waits on the runtime to answer what it supports.
