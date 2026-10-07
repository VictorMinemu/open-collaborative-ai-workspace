# Phase 6: Multiplayer AI Chat, Shared-Context Safety and Agents - Context

**Gathered:** 2026-10-07 (owner-delegated; defaults follow from Phase 5 D-01/D-02)
**Status:** Ready for planning

<decisions>
## Implementation Decisions

- **D-01 (who pays in a shared AI chat):** the human who triggers the turn pays with their own ChatGPT plan or picks an
  org model (METERED) — consistent with Phase 5 D-01 (BYO, never pooled). The chat owner's plan is never used for
  other people's turns. Coalesced queued follow-ups are billed to the first waiting author. OpenAI's stance on group use
  of personal plans via Sign in with ChatGPT is NEEDS VALIDATION (recorded in the ADR; owner manual check).
- **D-02 (metered spoofing eval):** build the three-participant addressing/spoofing evaluation as an **opt-in local
  script** (owner runs it with an OpenRouter key, ~$0.15–0.40 per run) plus a label/weekly workflow ready for when
  GitHub Actions billing is restored. Never runs on every PR, never in executors' gates, never spends without the owner.
- **D-03 (sharing in place):** a grant table (person, org unit, organization; can_chat / can_view) evaluated in the single
  resolver path; revocation closes open streams; Phase 5 snapshot links stay as "frozen copy".
- **D-04 (prompt):** roster in instructions + server-generated attributed blocks per human message + a final "you are
  answering X" block; never mid-conversation system messages (ChatGPT-plan route rejects them); single-human chats
  unchanged (no regression).
- **D-05 (addressing/queue):** the model answers when @mentioned or when the author toggles "Ask AI"; messages arriving
  during a generation are queued and answered in one coalesced turn visible to all; one generation per conversation.
- **D-06 (context safety):** personal instructions/memory are excluded whenever the chat is shared (not only when a second
  human has posted); tools = agent ∩ triggering human; sources not authorised for every participant are withheld and the
  model explains why.
- **D-07 (agents):** agents in AI chats answer through OpenClaw (as in channels); the chat's model stays in the AI SDK
  loop; typed Agent Cards in their own table with server-decided actions (Open / Follow / Approve), updated in place;
  agent personas with tools, scope (org/department/team/project/personal) and owner, extending one-click bots.
- **D-08 (visual):** consistent with Phase 4/5 UI language; share-in-place dialog states exactly what becomes visible;
  1440/390 light/dark.

### Claude's Discretion
Plan split (research suggests 13 plans / 5 waves, tracer: share with one person end to end), data model details.
</decisions>

<canonical_refs>
- `.planning/phases/06-multiplayer-ai-chat/06-RESEARCH.md`; ROADMAP Phase 6; REQUIREMENTS MULTI-01..08, AGENT-01/02/04
- Phase 5 summaries + 05-VERIFICATION; ADR-0017/0018; AGENTS.md (structural participant identity, one generation)
</canonical_refs>

<deferred>
- Running the metered eval in CI (blocked by GitHub billing) — workflow prepared, owner triggers.
</deferred>
