# ADR-0012: Full access mode and shared devices

- **Status:** Accepted (owner decision, 2026-10-05). Supersedes the "never enable a runtime's
  bypass-permissions mode" rule in AGENTS.md and the "rejecting bypass-permissions modes" behaviour shipped
  in Phase 1, for Work Zone sessions that go through the path below.
- **Date:** 2026-10-05

## Context

The Work Zone runs Claude Code (Claude Agent SDK) and Codex (`codex app-server`) on a member's device with
that member's own subscription. Until now the daemon rejected both runtimes' bypass modes
(`permissionMode: "bypassPermissions"`, Codex `danger-full-access` sandbox with `approvalPolicy: "never"`),
and a session on another member's device needed that member to accept it.

The owner wants two things (Phase 03.2 research, `03.2-RESEARCH.md`):

1. **Full access**: the real bypass mode of both runtimes, so long tasks run without prompts.
2. **Shared devices**: a device (typically a server or VM that hosts the harnesses) that its owner shares
   with chosen people, who then start and control sessions on it without the owner accepting each session
   or each action.

## Decision

1. **Full access is a real runtime mode**, mapped onto the common `permissionMode` enum as `full_access`
   (Claude `bypassPermissions`; Codex `approvalPolicy: "never"` + `sandbox: "danger-full-access"`). It is
   offered only when **all** of these hold, checked server-side on every turn:
   - the organization policy allows `full_access` (default: **denied**);
   - the device owner enabled full access on that device (default: **off**);
   - the person asking holds the permission to use full access on that device (resolver grain).
   The client never decides; a turn that asks for a mode above the effective cap runs at the cap and the
   change is reported back.
2. **Shared devices.** A device owner marks a device as *shared* and lists the members or units allowed to
   use it, each with a maximum permission mode (up to `full_access` if the device allows it). Listed people
   start and control sessions on that device without per-session acceptance by the owner. The owner can
   change the list or revoke access at any time; revocation stops their running sessions. Unlisted members
   keep the existing acceptance flow.
3. **Every switch is visible and audited.** Entering full access, the mode of every turn, who started a
   session on a shared device and every tool action keep emitting audit events with actor, device, session
   and organization. The session header shows a persistent *Full access* badge to every controller.
4. **Kept guarantees.** Only repo-relative paths leave the device; secrets stay in the secret store and are
   never put in prompts; the single execution authority per working tree is unchanged; org policy can
   always lower the cap and its restriction wins (Org ∩ … ∩ Device). Slash commands typed in a prompt
   (`/model`, `/permissions`, …) are intercepted by the adapter and go through the same policy check.
5. **Recommended deployment.** Full access is meant for a dedicated machine (a server, VM or container
   whose filesystem and credentials are scoped to the work). The device settings say so in plain words
   before the owner enables it.

## Consequences

- The agent can run any command and edit any file the device's OS user can reach, without asking. On a
  personal laptop that includes everything the user can read; this is why it is off by default at two
  levels and recommended only on dedicated hosts.
- People using a shared device consume the device owner's runtime subscription unless the device is
  logged in with an organization/service account; the device settings show whose subscription is used.
  The vendors' terms for shared use of a personal subscription are the owner's responsibility and are
  recorded as a risk for Phase 9.
- AGENTS.md changes its rule from "never enable bypass modes" to "only through ADR-0012's path". Coding
  agents working on this repository still never enable full access outside that path (tests use recorded
  fixtures or ephemeral devices).
- Phase 03.2 implements the mode and the device settings; Phase 8 device grains and Phase 10 host
  acceptance build on the shared-device list instead of replacing it.
