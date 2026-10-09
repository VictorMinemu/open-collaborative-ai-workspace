# ADR-0024: Module access per unit is a catalog of explicit deny rules decided by the resolver

## Status

Accepted (owner decisions D-01 to D-05 in `.planning/phases/07.3-module-access-per-unit/07.3-CONTEXT.md`, planner
decisions P-01 to P-12 in `07.3-01-PLAN.md`; Phase 07.3 plan 07.3-01).
**Date:** 2026-10-09. Builds on [ADR-0007](0007-roles-hierarchy-and-permission-resolver.md) (roles, units, explicit
rules, the resolver), [ADR-0009](0009-realtime-presence-and-live-reauthorization.md) (live re-authorization) and
[ADR-0020](0020-agent-personas-and-agent-cards.md) (unit personas, lead rights). Supersedes ADR-0007 only where it
says rules are admin-only with a read-only UI, and only for module rules.

## Context

Organizations want to turn whole modules (Work Zone, AI chats, bots) on or off for a department, team, project or
person from Settings (F15 in `.planning/research/OPS-FEATURES.md`). A feature-flag system would duplicate the resolver:
a second authority with its own inheritance, precedence and audit. The resolver can already express it: an explicit
deny rule removes a permission whatever granted it (the admin role included), scoped to the organization or a unit
subtree, for everyone, a role, a user or an agent, on an exact grain or a `prefix.*`.

The research (`07.3-RESEARCH.md`) found three gaps a module toggle would expose:

1. AI chats were read through `channel.read` alone, so a member denied `ai_chat.*` still opened her own chats by URL,
   read chats shared with her, found them in search and got their notifications.
2. Channel bot dispatch checked `bot.read` only for unit personas, so a member denied `bot.read` could still @mention an
   organization team bot in a channel, and reply-mode `all` bots still answered her.
3. Rules were admin-only (`rule.manage`), so leads had no way to manage modules for the units they lead.

## Decision

1. **A module is a catalog in contracts, compiled to ordinary deny rows; no feature flags.**
   `packages/contracts/src/module-access.ts` maps each module to exact grains: Work Zone → `work_session.*`,
   `device.pair`, `device.use`, `device.full_access`; AI chats → `ai_chat.*`; Bots → `bot.read`, `bot.create_personal`,
   `bot.configure`, `bot.internet`, `bot.tool.use`. Each module also names its entry grain (`work_session.read`,
   `ai_chat.read`, `bot.read`), which the web checks to show it. Turning a module off for a scope and subject writes
   one `effect: "deny"` row per pattern in `app.permission_rules`. There is no module table, column or route check.
   `MODULE_EXCLUDED` lists grains that are never module grains: device hygiene (`device.read`, `device.update`,
   `device.revoke`), `device.link`, governance (`bot.manage`, `bot.manage_unit`) and `agent_card.approve`. A contract
   test refuses any catalog pattern that matches an admin- or runtime-surface grain or an excluded one, and refuses
   any Work Zone, Bots or `ai_chat.` grain that no module and no exclusion classifies.
2. **`ai_chat.read` gates AI chat reads at the readable set.** A new grain (chat surface, held by every role) is
   decided in `chat/access.ts` on top of the chat's own access: `readableRow` (404 identical to a missing chat),
   `readableIds` (AI chats leave the candidate kinds) and `isReadable`. One change covers the ai-chat routes, search,
   the inbox, notifications and the `conv:` topic. A plain `ai_chat.use` deny keeps today's semantics (shared chats
   stay readable); `ai_chat.*` covers both.
3. **Channel bots answer only who holds `bot.read`.** Channel @mentions and reply-mode `all` call the same
   `authorReads` check for every bot that DMs and group DMs already used, so module rules reach organization team
   bots too.
4. **Who manages modules.** `unit.modules.manage` (team surface) is held by admins everywhere and, through
   `LEAD_PERMISSIONS`, by leads on the subtree they lead (like `bot.manage_unit`). The module-access API (07.3-02)
   writes and deletes only catalog deny rows at the exact requested scope, so ancestor and organization rows always
   win through the resolver. A lead never targets an admin: a `policy.ts` precondition on `unit.modules.manage` reads
   the target person's role (`ResourceFacts.targetRole`) and refuses with `role_ceiling` when it outranks the actor's
   role (a lead's role rank, as for invitations). A lead may re-enable at their own scope what an admin turned off
   there; an admin who wants a lock sets it one level up.
5. **Audit and live application are reused.** Each row keeps the `permission_rule.created` / `.deleted` audit, and one
   `permission_rules.updated` event per request re-decides live subscriptions (ADR-0009) and refreshes
   `/me/permissions` in the web.
6. **The web hides; the API is the authority.** Entries of a denied module are hidden cosmetically from the entry
   grain; every direct call is still refused by the resolver.

## Consequences

- **A unit-wide off reaches everyone in the unit, admins included.** A rule scoped to a unit with subject everyone,
  whether set by an admin or by the unit's lead, also reaches organization admins who are members of that unit,
  because deny beats every role. The person-level ceiling protects admins only from per-person rows (tested in
  07.3-02).
- **Bots off in a unit stops that unit's own personas for everyone.** Unit personas carry their unit's path, so a
  unit-scoped Bots row makes them unreadable, unconfigurable and tool-less for every member and admin; governance
  (`bot.manage`) stays. Accepted and pinned by a resolver test; the panel warns when the unit owns personas.
- **Bot DMs are hidden while Bots is off** (07.3-03), since the bot no longer answers.
- **Device hygiene stays.** A member whose Work Zone is off still lists, unshares and revokes the devices she owns
  (`GET /devices` answers 200).
- **Nothing is cleaned up or interrupted.** AI chat grants to a denied member stay and reappear when the module is
  turned back on; a running Work Zone turn is not interrupted; a queued AI chat prompt is not re-decided when it starts
  (research A5). While AI chats is off for her, a member cannot open her own chats, but she can always revoke her own
  share links: the revoke checks that she created the link and owns the chat, not the module (07.3-02). A grant
  change keeps the roster row of a grantee whose AI chats is off: participation follows the grant, not the module.
- **Proactive agent messages** to a denied human (automations, agent-initiated DMs) are decided per action in phases
  07.6 and 07.7.
- **Phase 8 naming constraint.** Work Zone session grains must keep the `work_session.` prefix, so `work_session.*`
  absorbs them; the contract test fails on any unclassified Work Zone grain until someone classifies it.
- **Sibling phases add catalog entries the same way** (one module id, exact grains, the contract test).
