# Feature Research

**Domain:** Open-source, self-hostable, multiplayer collaborative AI workspace (Slack-style chat + shareable multiplayer AI chats + cloud-owned coding-agent "Work Zones" executing locally via Codex / Claude Code)
**Researched:** 2026-09-10
**Confidence:** MEDIUM overall. Per the `classify-confidence` seam every web-sourced claim is LOW; the categorisation below is a synthesis across 30+ independent sources and official product docs (Claude Code docs, Codex CLI docs, Conductor docs, Devin docs, Cursor docs, Claude/ChatGPT help centres, Zulip, Open WebUI, Happier, Paseo, Dust). Claims about fast-moving products (Codex app, Claude Code desktop) should be re-verified at phase-planning time.

**Scope of this file:** the three product surfaces in the current milestone (PRD MVP 1 + MVP 2): **Chats** (channels/threads/DMs), **AI Chats** (direct + multiplayer + shareable), **Work Zone** (multiplayer coding-agent sessions). Each feature is mapped to the PRD and flagged when the PRD is silent.

---

## 1. Competitive landscape (what exists today)

### 1.1 Team chat (Slack, Discord, Mattermost, Rocket.Chat, Zulip, Inline)

| Product | Conversation model | Notable for this project |
|---------|--------------------|--------------------------|
| Slack | Channels + optional side-panel threads, DMs, group DMs | The UX baseline users will measure us against: reactions, search, pins, saved items, unread badges, quick switcher, Huddles, Canvas, Lists |
| Discord | Servers → categories → channels, threads, voice | Category grouping in sidebar maps well to Department → Channel sections in PRD §12.1 |
| Mattermost | Slack clone, self-hosted; collapsed reply threads, playbooks, boards, calls | Simplest self-host (2 containers). Shows what a self-hosted "Slack alternative" must have to be credible |
| Rocket.Chat | Rooms, opt-in E2E per room, omnichannel/livechat, 200+ app marketplace | Feature sprawl example; omnichannel and E2E are anti-features for us |
| Zulip | Channels → mandatory named **topics** (every message lives in a topic) | Strongest async model; "mark topic resolved", "move messages between topics", permalinks. Good ideas for threads without infinite nesting |
| Inline | Thread-based "interface for multiplayer work" for teammates and agents; macOS/iOS beta; OpenClaw + Hermes Agent integrations, CLI, MCP | Explicit PRD inspiration; validates the "agents as first-class participants" thesis but is closed and early |
| Open WebUI **Channels** | "Persistent, shared spaces where humans and AI models participate in the same conversation", `@model` tagging, threads and reactions | The closest open-source implementation of "agents in channels" today; also has RBAC, groups, SCIM, per-model access |

Sources: [Mattermost/Rocket.Chat/Zulip comparison (wz-it)](https://wz-it.com/en/blog/slack-alternatives-mattermost-rocketchat-zulip/), [selfhosting.sh ranking](https://selfhosting.sh/best/communication/), [Zulip features](https://zulip.com/features/), [Zulip vs Slack (aquaray)](https://www.aquaray.com/en/blog/posts/zulip-vs-slack-comparison), [Inline](https://inline.chat/), [Open WebUI features](https://docs.openwebui.com/features/). Confidence: LOW (web), corroborated across sources.

### 1.2 Shared AI chat (ChatGPT, Claude, LibreChat, Open WebUI, Dust, Glean)

| Product | Sharing model | What it does NOT do (our opening) |
|---------|---------------|-----------------------------------|
| ChatGPT **group chats** | Up to 20 people in one live chat via invite link; invitees must accept; anyone can leave/remove; personal memory never shared and no new memories created; adding someone to an existing chat **creates a copy** in the group section | Chat is copied, not upgraded in place; consumer-grade, no org hierarchy, no audit, no attribution to devices/permissions |
| ChatGPT **shared Projects** (Business/Enterprise/Edu, rolling to consumer) | Project = files + instructions + project-scoped memory shared with teammates; roles **Can Chat** / **Can Edit**; inherits workspace feature toggles, retention, data residency | Shares *context*, not live conversations |
| Claude **Projects** (Team/Enterprise) | Project visibility **Public** (org-wide) / **Private** (invited); member roles **Can view** / **Can edit**; "chats within a project are not shared by default"; chat sharing = **snapshot link** updatable on demand | Snapshot, not live; no multi-author messages |
| LibreChat | Multi-provider ChatGPT-style UI, presets, model comparison, RBAC, shared links, agents | Single-user conversations |
| Open WebUI | Admin panel + RBAC + groups, shared conversations, folders/tags/pins, model presets, knowledge bases, notes, Channels, SCIM 2.0, analytics | Channels are new and chat-first; no local coding-agent execution |
| Dust | "Multiplayer AI for human-agent collaboration": conversations where several agents are @mentioned, conversations shared across teams, Spaces with dual-layer permissions (what agents can access vs who can use them), SCIM groups, 70+ connectors, Slack workflows (`@dust +agent`) | Cloud-only SaaS; no local execution; no coding-agent sessions |
| Glean | Enterprise search + assistant + agents over connected knowledge | Knowledge-first; not a chat workspace |

Sources: [OpenAI group chats (via Fidji Simo)](https://fidjisimo.substack.com/p/a-new-way-to-collaborate-in-chatgpt), [VentureBeat](https://venturebeat.com/ai/chatgpt-group-chats-are-here-but-not-for-everyone-yet), [OpenAI "more ways to work with your team"](https://openai.com/index/more-ways-to-work-with-your-team/), [ChatGPT Projects help](https://help.openai.com/en/articles/10169521-using-projects-in-chatgpt), [Claude project sharing help](https://support.claude.com/en/articles/9519189-manage-project-visibility-and-sharing), [Open WebUI vs LibreChat](https://docs.openwebui.com/alternatives/librechat/), [Dust](https://dust.tt/), [Dust Slack docs](https://docs.dust.tt/docs/slack). Confidence: LOW (web); Claude/ChatGPT help-centre facts verified against official pages.

### 1.3 Coding-agent GUIs and session managers

| Product | Model | Features that matter for Work Zone |
|---------|-------|-----------------------------------|
| **Codex app** (OpenAI desktop) | Local threads organised by project; **worktrees** per thread; review agent changes in-thread, **comment on the diff**, open in editor; **Automations** on a schedule with results in a **review queue**; Codex CLI documents "**Steer the active turn**", `/permissions` sandbox and writable roots, `codex resume`, subagents, dedicated `review` | Steering is native; worktrees are default; review queue pattern |
| **Claude Code desktop** | Rebuilt around **parallel sessions**, each in its own **worktree**; sidebar filter by status/project/environment; **diff view with line-level comments** Claude acts on; PR monitoring with **Auto-fix / Auto-merge**; integrated terminal (local only); file editor pane; browser pane; **permission modes** Manual / Accept edits / Plan / Auto / Bypass; view modes Normal / Verbose / Summary; `@file` mentions; attach files; side chat `/btw`; **cross-session messaging**; local / cloud / SSH / WSL environments; OS + push notifications; `/desktop` to lift a CLI session into the app; auto-archive on PR merge; usage ring | Single-user only; the richest reference for "what a session UI needs" |
| **Claude Code CLI** (queue semantics, official docs) | Enter while working **queues** (listed above the input); queued message delivered "as soon as those tool calls finish, within the same turn", otherwise oldest becomes next turn; **Esc interrupts and keeps queued messages, sending them next**; Up-arrow **takes back** queued messages for editing; Esc Esc = rewind/checkpoints | No true mid-turn steering (GitHub issues #30492, #64624, #50246 confirm the gap). Defines the `ClaudeCodeRuntime` capability set |
| **Conductor** (Mac) | Workspace per task = worktree + branch; setup/run scripts; diff viewer; terminal; PR flow; Checks tab (git status, CI, deployments, todos); create workspace from GitHub/Linear issue, PR, branch; `.context` directory; runs Claude Code, Codex, Cursor | No multi-person collaboration at all |
| **Vibe Kanban** (open source, **commercial product sunsetting**) | Kanban of tasks → agent runs in worktree; dev-server one-click; diff with comments; PR creation; supports 10+ agents; MCP config centralisation; team issue tracking with automatic status updates | Signal: a *task board* over agents did not sustain a business; the session/conversation is the durable surface |
| **Paseo** (open source) | Daemon + desktop/mobile/web/CLI; runs Claude Code, Codex, OpenCode, Pi, Cursor (+34); worktree per agent; **E2E encrypted relay** or Tailscale/Cloudflare; "run locally, from another machine, or with a team"; voice; agent chaining/loops/schedules; GitHub/Slack/Discord triggers | Remote-control focused, single-operator; no server-side session entity or permissions per participant |
| **Happier** (open source companion) | 13 agents; "Follow a session live, send messages, and approve permissions from your phone"; **queue messages while the agent works — reorder, edit, or send them now**; steer when backend supports, else queue; **session sharing with view-only / edit / public read-only link**, concurrent control with activity tracking; E2E encrypted by default; one-command self-host; voice; "Needs attention" group | **Closest existing product to Work Zone**. Not in PRD prior-art list. Lacks org hierarchy, granular permission matrix, prompt identity/audit, chat integration |
| **OpenCode** | TUI/desktop; `/share` creates a **public** link to a session (manual/auto/disabled); sharing not yet in V2 | Public-link sharing is read-only and public; the enterprise version of this is our shareable session |
| **Cursor Background/Cloud Agents in Slack** | `@Cursor` in a thread; reads whole thread for context; runs in isolated VM; follow-ups via `@Cursor [prompt]` gated by **Team follow-ups** setting; new agent via `@Cursor agent`; defaults per person/channel/workspace; routing rules; status via emoji reactions (⏳ ✅ ❌); "Open in Cursor" button; PR links | Best reference for Chat → Work Zone and agent cards; but cloud-only VM, no local execution |
| **Devin** | `@Devin` in channel/thread; **bidirectional thread sync** (web app ↔ Slack); any team member can reply in the synced thread; `!new` code channels where every message goes to the session; status chips working/blocked/done; PR chips; parallel sessions; Devin scheduling Devins | Multiplayer-by-thread is real and used; sandbox VM per session |

Sources: [Codex app intro](https://openai.com/index/introducing-the-codex-app/), [Codex CLI docs](https://learn.chatgpt.com/docs/codex/cli), [Claude Code desktop docs](https://code.claude.com/docs/en/desktop), [Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode), [claude-code #36326](https://github.com/anthropics/claude-code/issues/36326), [#30492](https://github.com/anthropics/claude-code/issues/30492), [Conductor docs](https://www.conductor.build/docs/guides/parallel-agents/run-multiple-claude-code-sessions), [Vibe Kanban](https://vibekanban.com/), [Paseo](https://paseo.sh/), [Happier](https://happier.dev/), [Happier queue guide](https://guides.happier.dev/how-to-queue-messages-from-your-phone-while-an-agent-is-busy), [OpenCode share](https://opencode.ai/docs/share/), [Cursor Slack docs](https://cursor.com/docs/integrations/slack), [Devin Slack docs](https://docs.devin.ai/integrations/slack). Confidence: LOW (web); Claude Code, Codex CLI, Conductor, Cursor and Devin facts read from official docs.

---

## 2. Feature Landscape

Legend for the **PRD** column: `MVP1` / `MVP2` = explicitly in PRD §106; `implied` = mentioned elsewhere in the PRD but not in the MVP list; **`GAP`** = not in the PRD at all; `MVP3+` = explicitly deferred.

### 2.1 Surface: Chats (channels, threads, DMs)

#### Table Stakes (Users Expect These)

| Feature | Why Expected | Complexity | PRD | Notes |
|---------|--------------|------------|-----|-------|
| Public + private channels, create/archive/join/leave, topic/description, member list | Every team chat since IRC | LOW | MVP1 (channels) | Private channels need RLS-backed membership checks from day one |
| Org hierarchy sections in sidebar (Department → channels) | PRD §12.1; Discord categories prove the pattern | MEDIUM | MVP1 | Differentiating *presentation* of a table-stakes feature |
| DMs and group DMs (human↔human, human↔agent, mixed) | Slack, Mattermost, Zulip all have | LOW | MVP1 | Agent DMs require the minimal agent entity (see §4 gaps) |
| Side-panel threads, no nesting; thread reply count + participants in parent | Slack's model; PRD §13 | MEDIUM | MVP1 | Consider Zulip-style "mark resolved" later, not now |
| Realtime delivery, presence, typing indicators | Table stakes; PRD < 500 ms | MEDIUM | MVP1 | WebSocket + Redis pub/sub; reconnect with replay |
| Markdown formatting, code blocks with syntax highlighting, inline code | Zulip "expressive formatting"; developers will paste code constantly | LOW | **GAP** | Use one message body format (Markdown subset) shared with AI chats and agent output |
| Edit and delete own messages (with "edited" marker) | Universal | LOW | **GAP** | Audit log must keep prior versions |
| Emoji reactions | Universal; PRD §10.1 lists "reactions" as visual direction only | LOW | implied | Cursor and Devin use reactions as *agent status* — reuse for agent cards |
| @mentions of users and agents, @channel/@here, mention autocomplete | Universal; drives notifications and agent triggering | MEDIUM | MVP1 (mentions for agents) | Human mentions not explicitly listed; both needed |
| Unread tracking: per-channel unread badges, mention badges, mark as read/unread, "All / Mentions / Threads" views | PRD §12.1 nav shows these views; Slack/Zulip/Mattermost all have | MEDIUM | implied | Requires per-user read markers table; non-trivial at realtime scale |
| Notifications: desktop/web, per-channel mute, DND, mention-only setting | Users leave products that spam them | MEDIUM | implied (§89) | §89 lists events but no preferences/mute model; needs to be MVP1 |
| Message search (messages, people, channels; filters by channel/author/date) | Slack's defining feature; Zulip "message history search" | MEDIUM | **GAP** | Postgres full-text search is enough for MVP1 (no Elasticsearch) |
| File and image attachments in messages with preview, drag-and-drop, paste | Universal | MEDIUM | implied (§7.1 "files") | Reuse the artifact upload pipeline (containment → policy → SHA-256 → scan → encrypted → S3) so there is one file path |
| Link previews (unfurl) | Universal; Zulip "previews for links, images and videos" | LOW | **GAP** | Server-side fetch with SSRF protection; can defer to v1.x if needed |
| Pin / save (bookmark) messages | Slack pins + saved; Zulip permalinks | LOW | **GAP** | Permalinks to messages and threads are required anyway for agent cards |
| User profiles, avatars, display names, status/away | Universal | LOW | implied | Presence states already in PRD |
| Auth: email/password sign-up, invites, password reset, session management; org creation on first run | Cannot ship a workspace without it | MEDIUM | **GAP** (auth approach "deferred to research") | SSO/SCIM is Future; but invite-by-email and org bootstrap are MVP1 |
| Quick switcher / keyboard navigation (Cmd+K) | Slack, Zulip; PRD "high navigation speed" | LOW | implied (§10.1) | Cheap and makes dense UI usable |
| Basic admin: manage users, departments, teams, roles | PRD Part IX admin console is not in MVP list but roles are | MEDIUM | implied (§85) | Minimal admin pages are MVP1 (invite, deactivate, assign role/team) |
| Message history persistence, infinite scroll, jump to date/permalink | Universal | MEDIUM | implied | Cursor-based pagination |

#### Differentiators (Competitive Advantage)

| Feature | Value Proposition | Complexity | PRD | Notes |
|---------|-------------------|------------|-----|-------|
| Agents as first-class channel/DM members (mentions, replies, threads, cards) | Open WebUI Channels and Dust do `@model`/`@agent`, Slack does it via bots; none combine with org hierarchy + local execution | HIGH | MVP1 | The model must see the *thread* it was mentioned in (Cursor/Devin both read full thread) |
| Agent Cards (Work Zone created, PR created, approval requested, artifact) as structured messages with actions | Cursor/Devin use emoji + text; a typed card with `[Open] [Follow] [Approve]` is better and audit-able | MEDIUM | MVP2 (Chat → Work Zone card) | Define a card schema now; other card types later |
| Chat → Work Zone creation flow (pick project + execution host) | Cursor's `@Cursor` launches a cloud VM; ours launches on a colleague's Mac or a managed worker | HIGH | MVP2 | Depends on device registry + registered projects |
| Hierarchy-scoped everything (channels, agents, permissions per org/dept/team/project) | Slack is flat; Dust has Spaces; nobody has the full hierarchy | HIGH | MVP1 | Explicit-deny precedence and an effective-permission viewer are the PRD mitigations |
| Human + agent mixed group DMs | Rare outside Open WebUI Channels | LOW (once agents exist) | MVP1 | |

#### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Voice/video calls, Huddles, screen share | Slack/Mattermost/Rocket.Chat have it | Enormous infra (SFU, TURN), zero relation to core value | Link out to Meet/Zoom; revisit post-PMF |
| Per-room end-to-end encryption (Rocket.Chat style) | Privacy optics | Breaks search, agent participation, audit, server-side models; self-hosting already answers the trust question | Encryption at rest + TLS + self-host; relay-only mode for sensitive Work Zones |
| Infinite thread nesting / replies-to-replies | Discord forum style | PRD non-goal; destroys readability | Single-level side-panel threads; Zulip-style "move to new thread" later |
| Docs/Canvas, Lists, Boards, Playbooks | Slack/Mattermost bundle them | Product sprawl; Vibe Kanban's sunset shows boards over agents did not stick | Artifacts (markdown/PDF) are the document surface; link external tools |
| Omnichannel / livechat / customer support widgets | Rocket.Chat revenue driver | Different customer | Never |
| Slack Connect-style federation now | PRD is "federable" | Explicitly Future; identity and permission model must stabilise first | Design IDs as globally unique (ULIDs) to keep the door open |
| Custom themes/branding per user | Rocket.Chat | Low value, high UI-surface cost | Dark/light only |
| Message-level E2E for DMs | "Private DMs" | Same as above; admins in enterprises expect DM audit | Clear retention/audit policy instead |

### 2.2 Surface: AI Chats (direct, multiplayer, shareable)

#### Table Stakes (Users Expect These)

| Feature | Why Expected | Complexity | PRD | Notes |
|---------|--------------|------------|-----|-------|
| Streaming responses, stop generation, regenerate last answer | ChatGPT/Claude baseline | MEDIUM | **GAP** (implied by "realtime") | Stream via same WebSocket as chat; persist partial output on stop |
| Model picker per chat (and per message switch) | PRD §15 | LOW | MVP1 | Requires org-level provider keys (see gaps) |
| Chat list with auto-generated titles, rename, delete/archive, search across chats | ChatGPT, Claude, LibreChat, Open WebUI all have | LOW | **GAP** | "AI Chats" nav entry exists in §12.1 but no list semantics |
| Markdown rendering, code blocks with copy button, tables, LaTeX optional | Universal | LOW | **GAP** | Shared renderer with Chats |
| File/image attachments in prompts | ChatGPT/Claude baseline; PRD §17 preserves "attachments" | MEDIUM | implied | Vision-capable models only; enforce upload pipeline |
| Edit a sent prompt and re-run (branching) | ChatGPT/Claude have; users expect | MEDIUM | **GAP** | In multiplayer chats editing *other people's* prompts must be impossible; edit = new branch by author only. Can defer to v1.x |
| Custom/system instructions per chat (and per user defaults) | Universal | LOW | **GAP** | Precursor of Skills (MVP4); keep it a plain text field |
| Tool toggles: web search, company knowledge, MCP, skills | PRD §15 lists them | HIGH (knowledge/MCP) / LOW (toggle UI) | MVP1 lists tools; knowledge/MCP are MVP4 | MVP1 should ship the toggle model with web search only; the rest greyed out |
| Private by default, owner, visibility badge | PRD §15 | LOW | MVP1 | |
| Share snapshot link (read-only) | Claude/ChatGPT/OpenCode all do it | LOW | implied (§17) | Cheap subset of "share with person" |
| Token/context usage indicator | Claude Code usage ring, Open WebUI analytics | LOW | **GAP** | Precursor to budgets (MVP3); at least show tokens per message in metadata |
| Folders / projects for chats | ChatGPT & Claude Projects; Open WebUI folders | MEDIUM | implied (§45 Projects) | Attach an AI chat to a Project entity rather than inventing folders |

#### Differentiators (Competitive Advantage)

| Feature | Value Proposition | Complexity | PRD | Notes |
|---------|-------------------|------------|-----|-------|
| **Live multiplayer AI chat**: several humans + model in one conversation, realtime, every message attributed (author, timestamp, device, context, permissions) | ChatGPT group chats exist but are consumer, copy-on-share, no audit; Claude/ChatGPT projects keep chats private; Dust shares conversations but not live co-prompting with attribution | HIGH | MVP1 (P0) | **Core value**. See gap on response-trigger policy |
| **Model sees distinct participants** (name, role, maybe team) per message | ChatGPT group chats do not document this; Open WebUI has `{{USER_NAME}}` only for single user | MEDIUM | MVP1 | Prompt-construction: prefix each user message with speaker identity; never leak personal memory across users (ChatGPT's rule) |
| **In-place progressive sharing** private → person → team, preserving context, messages, attachments, artifacts, model, tools, permissions, participants | ChatGPT *copies* into a new group chat; Claude shares snapshots | MEDIUM | MVP1 | Visibility is a property of the conversation, not a copy; access re-evaluated on every read via RLS |
| Persistent agents joining an AI chat as participants | Dust does agent mentions in conversations; we add org hierarchy | MEDIUM | MVP1 (agents in conversations) | MVP1 agent = model + instructions + tools persona, not OpenClaw (MVP5) |
| **AI Chat → Work Zone** (Scenario B step 5) | Nobody bridges a shared brainstorm to a local coding session with the same participants | HIGH | MVP2 | Carry conversation summary + participants + permissions into the WorkSession |
| Permissions-aware context (model only sees what the *lowest* participant may see? or the *owner*?) | Enterprise necessity nobody else solves | HIGH | implied (§16 "permissions") | Decide the rule in requirements; it affects tool calls in shared chats |
| Full audit trail of AI conversations (who asked, which model, which tools, cost) | Managers have "no consolidated view" (PRD §3) | MEDIUM | implied (§88) | Emit audit events from day one even without a UI |

#### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Personal memory shared into multiplayer chats | "Claude knows me" | Leaks private context between colleagues; ChatGPT explicitly forbids it | Memory is per user and off in shared chats until Memory Isolation (§82) exists |
| Collaborative co-editing of a single prompt draft (Google-Docs style cursors) | "Figma-style" inspiration | CRDT complexity for marginal value; PRD lists "collaborative prompt drafting" as Future | Each participant sends their own attributed messages; show "typing" |
| Per-user BYOK API keys as the primary model access path | LibreChat/Open WebUI allow it; quick to ship | Defeats governance, cost visibility and audit, the whole product thesis | Org/team-level provider configuration (thin precursor of Model Gateway MVP3) |
| RAG / knowledge bases / connectors in MVP1 | Open WebUI, Dust, Glean lead with it | Big surface; MVP4 scope; distracts from multiplayer proof | Ship attachments only; knowledge later |
| Voice mode, image generation, "canvas" artifacts editor | ChatGPT parity | Not the core value; expensive | Text + files; markdown artifacts rendered read-only |
| Model-comparison side-by-side (LibreChat) | Power users | Niche; complicates multiplayer semantics | Model switch per message is enough |
| Auto-responding model on every human message in group chats | Simplest implementation | Model spams a multi-human discussion; two humans typing at once produce interleaved generations | Explicit trigger policy: respond when @mentioned or when addressed by the last message while idle; serialise generations per conversation (see §4) |

### 2.3 Surface: Work Zone (multiplayer coding-agent sessions)

#### Table Stakes (Users Expect These)

Baseline is what Claude Code desktop, Codex app, Conductor, Paseo and Happier all offer to a *single* user. If we are worse than the free official GUI for the solo case, developers will not open sessions here, and there is nothing to make multiplayer.

| Feature | Why Expected | Complexity | PRD | Notes |
|---------|--------------|------------|-----|-------|
| Session list sidebar grouped by project with status (running / waiting / needs approval / done / failed), rename, archive, search | Claude Code desktop, Codex app, Conductor | MEDIUM | MVP2 (§30) | "Needs attention" grouping (Happier) is cheap and valuable |
| New session: pick project, runtime (Codex / Claude Code), model, permission mode, host | All GUIs | MEDIUM | MVP2 | Host selection is our extra |
| Conversation stream with collapsed tool calls and view modes (Normal / Verbose / Summary) | Claude Code desktop has exactly this; raw tool spam is unreadable | MEDIUM | MVP2 (event protocol) | Render from the Unified Session Event Protocol, never from raw runtime output |
| Streaming assistant output + thinking indicator | All | MEDIUM | MVP2 | `assistant.message` / `assistant.thinking` events |
| **Permission / approval prompts** (approve once, allow for session, deny with comment) surfaced in UI | Claude Code and Codex both block on these; the session is dead without them | HIGH | MVP2 (`approval.requested/resolved`) | Multiplayer twist: who may approve is a permission (`APPROVE`) |
| **Permission modes** per session (Manual / Accept edits / Plan / Auto / Bypass for Claude Code; approval + sandbox for Codex) | Both runtimes expose them; users set them before starting | MEDIUM | **GAP** | Adapter must map runtime-specific modes to a common enum; org policy may cap the mode |
| Interrupt / stop current turn | Universal (Esc / Ctrl+C) | LOW | MVP2 (`CANCEL`) | Claude Code keeps queued messages after Esc; mirror that |
| Message queue while agent works (add, edit, reorder, remove, send now) | Claude Code native queue; Happier: "reorder, edit, or send them now" | MEDIUM | MVP2 (P0 Prompt Queue) | Our queue is server-side and multi-author; must not conflict with the runtime's internal queue |
| Steering mid-turn where the runtime supports it | Codex CLI: "Steer the active turn"; Claude Code: queue only, interrupt with Esc | MEDIUM | MVP2 | Capability flag per adapter: `supportsSteer` (Codex true, Claude Code false → fallback to queue, as Happier does) |
| Changed files list + unified/side-by-side diff viewer | Every GUI | MEDIUM | MVP2 | Diff computed on the host; only relative paths leave the device |
| Git state header: repo, branch, base commit, current commit, dirty/clean | Codex/Claude/Conductor show branch; PRD §46 | LOW | MVP2 | |
| **Worktree / branch per session** option at creation | Codex app, Claude Code desktop, Conductor, Vibe Kanban, Paseo all default to it | MEDIUM | **GAP** | PRD says "one working tree" per session, which is compatible: each *session* gets its own worktree. Without it two sessions on the same repo collide |
| Terminal output view (read-only for non-owners) | Conductor/Claude desktop have terminals; PRD `TERMINAL_VIEW` | MEDIUM | MVP2 | Read-only stream is enough; interactive terminal is an anti-feature for remote controllers |
| Resume / reattach a session after app restart, daemon restart or host sleep | Claude Code `/resume`, Codex `codex resume`; PRD risk §109.2 | HIGH | implied (§97 "reconnectable, replayable") | Requires persisted runtime session id + event log replay + heartbeat |
| Runtime detection and health: installed? logged in? version? | Users will hit "claude not found" first minute | LOW | **GAP** | Daemon reports runtime versions to backend (§37 lists "runtime versions") |
| Attach images / files to a prompt; `@file` mention with autocomplete from the registered project | Claude Code desktop, Conductor | MEDIUM | implied | File list must come from the host via daemon, relative paths only |
| Desktop notifications: finished, failed, needs approval, mentioned | Claude Code desktop, Happier, Paseo | LOW | implied (§89) | Also drives `Follow Session` (§32) |
| Open in editor (VS Code / Cursor deep link) | Codex app, Claude Code desktop | LOW | **GAP** | One-liner on the host side; huge for adoption; only for the executing host |
| Context/usage indicator (tokens, context window %) | Claude Code usage ring | LOW | **GAP** | Runtimes expose it in events |
| Session transcript history searchable | Claude Code desktop | LOW | implied (§30 History) | Event log is the transcript |
| Device registration / pairing of the daemon to a user + org | Paseo/Happier both have pairing; PRD §38 is MVP6 but MVP2 needs the minimum | MEDIUM | implied (§33 "device connection") | Device token + org binding + revoke is MVP2; policies/versions later |

#### Differentiators (Competitive Advantage)

| Feature | Value Proposition | Complexity | PRD | Notes |
|---------|-------------------|------------|-----|-------|
| **Session owned by the platform, executed locally** (WorkSession entity + daemon on any member's machine) | Codex/Claude: local-only or vendor cloud; Cursor/Devin: vendor VM; Paseo/Happier: personal remote control. None make the session an org resource | HIGH | MVP2 (P0 §21) | Core value #2 |
| **Multiple controllers, single executor** with server-side arbitration | Happier allows concurrent control but without arbitration or granular roles | HIGH | MVP2 | Prompt Arbiter serialises writes to the runtime |
| **Prompt identity + audit** (who asked, from which device, mode, status) even when it runs on someone else's laptop | No competitor records this | MEDIUM | MVP2 | Non-negotiable for the enterprise buyer |
| **Granular Work Zone permissions** (VIEW … FULL_CONTROL, 15 grains) enforced server-side | Happier: view/edit; Cursor: "Team follow-ups" toggle; Devin: anyone in thread | HIGH | MVP2 | Ship with 3–4 templates (Owner / Collaborator / Reviewer / Viewer) mapped to grains to keep UX sane |
| **Shared multi-author Prompt Queue** with priority and run-next | Happier's queue is personal; Claude Code's is local | MEDIUM | MVP2 (P0) | |
| Presence in session header (Controlling / Viewing diff / Typing / Following / Away) | Figma-style; none of the agent GUIs have it | MEDIUM | MVP2 (§25) | |
| Execute on a colleague's registered machine or (later) managed worker | Only Paseo hints at "with a team" | HIGH | MVP2 (host picker) | Host consent + registered projects only |
| Shared artifacts with governed upload pipeline and retention | Happier/Paseo transfer files but without policy | MEDIUM | MVP2 (basic) | |
| Agent card posted back to the originating channel/thread with live status | Cursor emoji + Devin chips are the bar; a live card with `[Open] [Follow]` beats both | MEDIUM | MVP2 | |
| Runtime-agnostic adapter + unified event protocol | Paseo/Happier/Vibe Kanban are agent-agnostic already: this is **table stakes among session managers**, a differentiator only versus Codex/Claude native apps | HIGH | MVP2 | Do not market it as the differentiator; market multiplayer + governance |
| Follow Session (notifications without control) | Happier "Needs attention" is personal | LOW | MVP2 (§32) | |

#### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Full IDE / editable file pane / browser preview pane / dev-server runner | Claude Code desktop and Vibe Kanban have them | PRD non-goal; competes with the developer's real editor; remote editing of a colleague's disk is a security nightmare | Read-only file view with relative paths + "Open in editor" on the host |
| Interactive remote terminal for non-host users | "Let me just run it" | Arbitrary command execution on someone else's machine; bypasses prompt identity and audit | Read-only terminal stream; prompts go through the agent with audit |
| Multiple agents writing the same working tree concurrently | "Parallel agents" hype | PRD non-goal; merge chaos | One executor per session; parallelism = multiple sessions in separate worktrees |
| Kanban/task board as the primary Work Zone surface | Vibe Kanban | The commercial product is sunsetting; PRD says "conversation is the main surface" | Session list with status + optional later integration with issue trackers |
| Automations / scheduled agent runs / "agent schedules agents" | Codex Automations, Devin scheduling, Paseo loops | MVP5 scope (OpenClaw); needs Temporal-class durability | Manual sessions only in MVP2 |
| Vendor cloud sandboxes / managed workers in MVP2 | Cursor, Devin, Codex cloud, Claude cloud sessions | Whole new execution plane; Future in PRD | Host picker shows "Managed Worker" greyed out |
| Desktop streaming / remote mouse-keyboard / computer use | Claude Code desktop "computer use" | PRD non-goal; privacy; scope | Semantic control only (prompt, approve, stop, diff, terminal view) |
| Arbitrary filesystem browsing from remote clients | "Let me pick a folder" | PRD non-goal; leaks absolute paths | Registered projects only; relative paths only |
| Voice control | Paseo, Happier | Nice demo, low enterprise value now | Defer |
| Diff line comments that the agent acts on | Codex app, Claude Code desktop, Vibe Kanban | Valuable, but it is a prompt with a code anchor; adds UI complexity to MVP2 | v1.x: comment = queued prompt with `file:line` context |
| Cross-session agent messaging | Claude Code desktop | Depends on multiple sessions and agent-to-agent permissions (§80, MVP5) | Defer |
| Public read-only share links for sessions (OpenCode, Happier) | Easy virality | Enterprise data exposure; audit gap | Org-scoped share with `VIEW` permission; public links never |

---

## 3. Feature Dependencies

```
Auth + Org bootstrap + Invites
    └──requires──> Org hierarchy (org / dept / team / project) + roles
                       └──requires──> Channels, DMs, membership (RLS)
                                          └──requires──> Realtime transport (WS + pub/sub + replay)
                                                             ├──> Presence / typing / unread badges
                                                             ├──> Threads (side panel)
                                                             ├──> Notifications + preferences
                                                             └──> Streaming AI responses

Org-level model provider config (keys)  ──requires──> Secrets store abstraction
    └──requires──> Direct AI Chat (model picker, streaming, stop, titles, list)
                       └──requires──> Multiplayer AI Chat (participants, attribution, trigger policy, serialised generation)
                                          └──requires──> Progressive sharing (visibility upgrade in place)
                                                             └──enhances──> AI Chat → Work Zone

Minimal Agent entity (persona: model + instructions + tools + scope)
    └──requires──> Agents in channels / DMs (mention → thread-aware reply)
                       └──requires──> Agent Cards (typed message + actions)
                                          └──requires──> Chat → Work Zone card

Upload pipeline (containment → policy → SHA-256 → scan → encrypt → S3)
    ├──> Chat attachments
    ├──> AI Chat attachments
    └──> Work Zone shared artifacts

Electron app + Local Runtime daemon + device pairing
    └──requires──> Registered projects on device
                       └──requires──> AgentRuntime adapters (Codex, Claude Code) + capability flags
                                          └──requires──> Unified Session Event Protocol + persisted event log
                                                             ├──> WorkSession entity + participants + permissions
                                                             │       ├──> Prompt identity + Prompt Queue (multi-author)
                                                             │       ├──> Steer / Queue / Interrupt (per capability flag)
                                                             │       ├──> Approvals (who may approve)
                                                             │       ├──> Presence in session
                                                             │       └──> Follow Session + notifications
                                                             ├──> Git state + changed files + diff (host-computed, relative paths)
                                                             ├──> Worktree/branch per session
                                                             └──> Resume / reattach (heartbeat + replay)

Work Zone permissions ──conflicts──> Interactive remote terminal (anti-feature)
Per-user BYOK ──conflicts──> Org provider config / audit / budgets
Auto-respond-on-every-message ──conflicts──> Multiplayer AI Chat usability
```

### Dependency Notes

- **Multiplayer AI Chat requires a trigger policy and serialised generation:** with two humans typing, the server must decide when the model speaks and must run one generation at a time per conversation; otherwise responses interleave. This is a requirement, not an implementation detail.
- **Agents in channels (MVP1) require a minimal Agent entity even though OpenClaw is MVP5:** an MVP1 agent is a hosted persona (model + instructions + tool toggles + scope) that the API invokes on mention. Design its table so OpenClaw-backed agents (MVP5) are another `runtime` value.
- **Direct AI Chat requires provider configuration before the Model Gateway exists:** MVP1 needs an org-admin screen for provider API keys and allowed models (a thin slice of MVP3). Without it there is no model to pick.
- **Work Zone approvals require permission modes:** approval events only make sense once the session's permission mode is known; the adapter maps runtime modes to a common enum and the org policy may cap it.
- **Steer depends on adapter capability flags:** Codex supports steering the active turn; Claude Code only queues (interrupt via Esc keeps the queue). The UI must show "Steer" only when `supportsSteer` is true, otherwise fall back to Queue with a clear label (Happier's behaviour).
- **Worktree per session enhances multi-controller/single-executor:** the PRD's "one runtime, one working tree" is per session; two sessions on the same repo need separate worktrees or they corrupt each other's diffs.
- **Chat → Work Zone requires device pairing + registered projects:** the host picker can only list machines that have a paired daemon with the project registered.
- **Attachments everywhere depend on the upload pipeline:** build it once in MVP1 for chat files; MVP2 artifacts reuse it.

---

## 4. PRD gaps: what a first release must have that the PRD does not list

Ordered by how badly users would notice.

### MVP1 gaps

| # | Missing item | Why users expect it | Suggested requirement |
|---|--------------|---------------------|-----------------------|
| 1 | Auth and onboarding: sign-up, email invite, password reset, org bootstrap on first `docker compose up` | You cannot log in otherwise; SSO is Future but invites are not | Self-hosted auth with email+password + invite links; admin user created on first run |
| 2 | Message search (messages, people, channels) | Slack's core; Zulip lists it first | Postgres FTS with filters `in:#channel from:@user before:` |
| 3 | Edit/delete messages, "edited" marker, version kept for audit | Universal | Author-only edit within policy window; admins can delete |
| 4 | Reactions | Listed only in "visual direction" | Emoji reactions on messages, thread replies and AI messages |
| 5 | Read state: unread badges, mention counts, mark unread, All/Mentions/Threads views | PRD nav shows the views but not the state model | Per-user read markers; server computes badge counts |
| 6 | Notification preferences: per-channel mute, DND, mention-only, desktop toggle | §89 lists events only | Preferences entity + delivery rules |
| 7 | Attachments and link previews in chat | Universal | Reuse upload pipeline; unfurl with SSRF guard (unfurl may slip to v1.x) |
| 8 | Message formatting spec (Markdown subset, code blocks) shared across chats, AI chats and agent output | Developers paste code constantly | One renderer, one storage format |
| 9 | Org-level model provider configuration (API keys, allowed models) | Model picker is empty without it | Thin admin page; keys in secret store; per-org allowlist. Full Gateway stays MVP3 |
| 10 | AI chat basics: streaming, stop, regenerate, auto-title, chat list/rename/archive/search, custom instructions, token counts | ChatGPT/Claude/LibreChat/Open WebUI baseline | Explicit requirements, not "implied by realtime" |
| 11 | **Multiplayer response-trigger and concurrency policy** | Two humans + one model needs rules; multi-user chat research (MUCA "what/when/who", HUMA facilitator) agrees the assistant must not answer every message and each message needs an explicit speaker label | Model responds when @mentioned or when addressed while idle; one generation at a time per conversation; every human message rendered as an attributed user turn (name/role), consecutive human messages merged into one turn, participant roster in the system prompt; queued human messages visible to all |
| 12 | Definition of an MVP1 "agent in conversation" | OpenClaw is MVP5 | Hosted persona entity: name, avatar, model, instructions, tools, scope (org/dept/team/project/personal), owner |
| 13 | Minimal admin console: users, roles, departments, teams, projects | Roles exist but no way to assign them | CRUD pages for hierarchy + membership |
| 14 | Pins/saved messages and permalinks | Cheap, expected; permalinks needed by agent cards | Permalink to message/thread; pin per channel; save per user |
| 15 | Context-visibility rule in shared AI chats (whose permissions bound the model's tools/knowledge?) | Enterprise correctness | Decide: tools run with the *requesting author's* permissions; retrieved content visible to all participants must be authorised for all (or block with explanation) |

### MVP2 gaps

| # | Missing item | Why users expect it | Suggested requirement |
|---|--------------|---------------------|-----------------------|
| 1 | Permission modes per session (Manual / Accept edits / Plan / Auto / Bypass) mapped across runtimes, capped by org policy | Both runtimes expose them; first thing a Claude Code user sets | `permissionMode` on WorkSession + adapter mapping + `permission.denied` when policy caps |
| 2 | Approval prompt semantics: approve once / allow for session / deny with comment; who may approve | Runtime blocks until answered | `APPROVE` grain + approval UI + timeout behaviour when nobody answers |
| 3 | Worktree/branch-per-session option at creation | Default in every GUI | Daemon Git adapter creates `.<app>/worktrees/<session>`; branch prefix setting |
| 4 | Resume/reattach after daemon or host restart; explicit offline state | PRD risk 109.2 | Persisted runtime session id; replay from event log; "Host offline since 12:03" banner; queued prompts wait |
| 5 | Runtime detection, login state and version compatibility reported by daemon | First-run failure mode | Daemon capability report on connect; UI blocks session creation with actionable error |
| 6 | Device pairing/revocation for the daemon (minimum of §38) | Security baseline | Pairing code flow, device token, revoke from web |
| 7 | Adapter capability flags (`supportsSteer`, `supportsResume`, `supportsPermissionModes`, `supportsImages`) | Steer only where supported | Part of `AgentRuntime` interface; UI adapts |
| 8 | View modes (Normal / Verbose / Summary) for the event stream | Raw tool events are unreadable | Client-side filter over event types |
| 9 | Open in editor deep link on the host | One-liner, high value | `code://` / `cursor://` from host only |
| 10 | Desktop notifications for finish / fail / approval / mention | All GUIs | Electron notifications wired to Follow Session events |
| 11 | Context/usage indicator and per-session cost | Runtimes emit it | `session.usage` event or field on `assistant.message` |
| 12 | Session archive/rename; auto-archive on completion | Sidebar hygiene | Status lifecycle: draft → running → waiting → completed/failed → archived |
| 13 | Host consent UX when someone else creates a session on your machine | Chat → Work Zone lets Alex pick Victor's MacBook | Host must accept (or pre-authorise per project/team) before runtime launches |
| 14 | What non-host controllers see in "Files" | Relative paths only, registered project only | File list from host; preview gated by `FILES_VIEW`; request via `FILES_REQUEST` (MVP6 relay may be deferred, but the permission grains exist in MVP2) |

---

## 5. MVP Definition

### Launch With (v1 = this milestone, MVP1 + MVP2)

Chats
- [ ] Auth + invites + org bootstrap — cannot log in otherwise
- [ ] Org hierarchy + four roles + minimal admin CRUD — permissions need somewhere to hang
- [ ] Public/private channels, DMs, group DMs, side-panel threads — table stakes
- [ ] Realtime, presence, typing, unread badges, mention counts — table stakes
- [ ] Markdown + code blocks, edit/delete, reactions, attachments, pins/permalinks — table stakes
- [ ] Search (Postgres FTS) — Slack's defining feature
- [ ] Notification preferences (mute, DND, mention-only) — retention
- [ ] Agents as members with thread-aware mention replies — differentiator, prerequisite for cards

AI Chats
- [ ] Org provider config + model picker + streaming/stop/regenerate/titles/list — table stakes
- [ ] Multiplayer AI chat with attribution, participant-aware prompting, trigger policy, serialised generation — **core value**
- [ ] In-place progressive sharing (private → person → team) — differentiator
- [ ] Snapshot share link (read-only) — cheap subset

Work Zone
- [ ] Electron + daemon + device pairing + registered projects — foundation
- [ ] Codex and Claude Code adapters with capability flags; unified event protocol; persisted event log — foundation
- [ ] WorkSession with participants, permission templates, permission modes, approvals — **core value**
- [ ] Prompt identity + multi-author queue (add/edit/remove/reorder/run-next/priority) + steer/queue/interrupt — P0
- [ ] Session sidebar, conversation stream with view modes, diff/changed files, git state, read-only terminal stream — table stakes
- [ ] Worktree-per-session option — collision avoidance
- [ ] Resume/reattach + offline state — PRD risk
- [ ] Basic shared artifacts via upload pipeline — P0
- [ ] Chat → Work Zone flow with host consent + agent card — differentiator, Scenario A/B

### Add After Validation (v1.x)

- [ ] Link unfurls — once attachments/permalinks are stable
- [ ] Edit-and-branch prompts in AI chats — when single-author editing rules are settled
- [ ] Diff line comments as queued prompts — when queue semantics are proven
- [ ] Zulip-style "resolve thread" / move messages — when thread volume justifies it
- [ ] Quick switcher (Cmd+K) — trivial, add as soon as nav stabilises
- [ ] Effective-permission viewer — when permission complaints appear (PRD risk 109.3)
- [ ] Session transcript export — first compliance ask

### Future Consideration (v2+, per PRD)

- [ ] Model Gateway, pools, routing, budgets (MVP3)
- [ ] Skills, MCP scopes, policies, device sync (MVP4)
- [ ] OpenClaw runtime, proactive agents, automations, scheduled runs (MVP5)
- [ ] Device Relay, web/mobile remote control, file requests, follow from mobile (MVP6–7)
- [ ] Managed workers / cloud sandboxes; session forking; federation; marketplace; voice; computer use (Future)

---

## 6. Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Multiplayer AI chat with attribution + trigger policy | HIGH | HIGH | P1 |
| WorkSession entity + permissions + approvals | HIGH | HIGH | P1 |
| Unified event protocol + Codex/Claude Code adapters | HIGH | HIGH | P1 |
| Prompt identity + shared queue + steer/queue/interrupt | HIGH | MEDIUM | P1 |
| Channels/threads/DMs/realtime/presence | HIGH | MEDIUM | P1 |
| Auth + invites + org bootstrap + minimal admin | HIGH | MEDIUM | P1 |
| Search, edit/delete, reactions, unread state, notification prefs | HIGH | MEDIUM | P1 |
| Org provider config + AI chat basics (stream/stop/titles) | HIGH | LOW | P1 |
| Progressive in-place sharing | HIGH | MEDIUM | P1 |
| Agents in channels (persona entity + mention reply) | HIGH | MEDIUM | P1 |
| Diff/changed files + git state + read-only terminal | HIGH | MEDIUM | P1 |
| Worktree per session | MEDIUM | LOW | P1 |
| Resume/reattach + offline banner | HIGH | HIGH | P1 |
| Chat → Work Zone + agent card + host consent | HIGH | HIGH | P1 |
| Basic shared artifacts | MEDIUM | MEDIUM | P1 |
| Permission modes mapping | HIGH | LOW | P1 |
| Desktop notifications + Follow Session | MEDIUM | LOW | P1 |
| Open in editor | MEDIUM | LOW | P1 |
| Usage/context indicator | MEDIUM | LOW | P2 |
| Attachments in chat / AI chat | HIGH | MEDIUM | P1 (pipeline) |
| Link unfurls | MEDIUM | LOW | P2 |
| Pins/saved/permalinks | MEDIUM | LOW | P1 (permalinks) / P2 (pins) |
| Edit-and-branch prompts | MEDIUM | MEDIUM | P2 |
| Diff line comments → queued prompt | MEDIUM | MEDIUM | P2 |
| Quick switcher | MEDIUM | LOW | P2 |
| Effective-permission viewer | MEDIUM | MEDIUM | P2 |
| Voice, computer use, IDE panes, boards, calls | LOW | HIGH | P3 / never |

**Priority key:** P1 must have for this milestone; P2 add when possible; P3 future.

---

## 7. Competitor Feature Analysis (selected)

| Feature | ChatGPT group chats | Claude / ChatGPT Projects | Happier | Claude Code desktop / Codex app | Cursor / Devin in Slack | Our approach |
|---------|--------------------|---------------------------|---------|----------------------------------|-------------------------|--------------|
| Multiple humans in one AI conversation | Yes, up to 20, invite link, copy-on-share | No (chats private inside shared project) | Yes for coding sessions (view/edit) | No | Yes via Slack thread (Devin sync, Cursor follow-ups) | Yes, in place, attributed, hierarchy-scoped, audited |
| Model knows who is speaking | Undocumented | n/a | n/a | n/a | Thread author names visible to bot | Explicit speaker identity per message in prompt construction |
| Personal memory in shared chat | Never shared | Project-scoped memory | n/a | n/a | n/a | Never shared; memory isolation later |
| Sharing upgrade | Copy to group | Snapshot link / project roles | Share link or invite | None | Channel membership | Visibility property on the conversation |
| Session executes on | OpenAI cloud | n/a | User's own machine | Local, vendor cloud, SSH | Vendor VM | Any paired member device (later managed worker) |
| Queue while agent works | n/a | n/a | Reorder / edit / send now | Claude Code: queue + take-back; Codex: steer | Follow-up messages | Server-side multi-author queue with priority and run-next |
| Steer mid-turn | n/a | n/a | If backend supports | Codex yes; Claude Code no | No | Capability flag per adapter |
| Approvals from remote | n/a | n/a | Phone push | Desktop; push via Dispatch | Slack "Apply" (Devin) | `APPROVE` grain; desktop now, mobile MVP7 |
| Permissions | Leave/remove | Can view / Can edit / Owner | View / Edit / public link | Owner only | Team follow-ups toggle | 15 grains with templates, server-enforced |
| Diff review | n/a | n/a | Yes | Yes with line comments | PR link | Diff viewer MVP2; comments v1.x |
| Worktrees | n/a | n/a | Via agent | Default per session/thread | VM | Option per session |
| Audit of who prompted | No | No | Activity tracking | No | Slack history | Prompt identity + audit log |
| Self-host | No | No | Yes | No | No | Yes, `docker compose up` |

---

## 8. Sources

Official documentation (verified by direct fetch on 2026-09-10):
- Claude Code desktop: https://code.claude.com/docs/en/desktop
- Claude Code interactive mode (queue / interrupt semantics): https://code.claude.com/docs/en/interactive-mode
- Codex CLI features ("Steer the active turn", `/permissions`, `codex resume`): https://learn.chatgpt.com/docs/codex/cli
- Conductor docs: https://www.conductor.build/docs/guides/parallel-agents/run-multiple-claude-code-sessions
- Devin Slack integration: https://docs.devin.ai/integrations/slack
- Cursor Slack integration: https://cursor.com/docs/integrations/slack
- Claude project visibility and sharing: https://support.claude.com/en/articles/9519189-manage-project-visibility-and-sharing
- Open WebUI features: https://docs.openwebui.com/features/
- Zulip features: https://zulip.com/features/
- Happier: https://happier.dev/ and https://guides.happier.dev/how-to-queue-messages-from-your-phone-while-an-agent-is-busy
- Paseo: https://paseo.sh/
- Vibe Kanban (sunset notice): https://vibekanban.com/
- Dust: https://dust.tt/ and https://docs.dust.tt/docs/slack
- Inline: https://inline.chat/
- OpenCode share: https://opencode.ai/docs/share/

Announcements and secondary sources (LOW confidence, cross-checked):
- OpenAI group chats: https://fidjisimo.substack.com/p/a-new-way-to-collaborate-in-chatgpt , https://venturebeat.com/ai/chatgpt-group-chats-are-here-but-not-for-everyone-yet , https://openai.com/index/group-chats-in-chatgpt/ (403 at fetch time)
- ChatGPT shared projects: https://openai.com/index/more-ways-to-work-with-your-team/ , https://help.openai.com/en/articles/10169521-using-projects-in-chatgpt
- Codex app: https://openai.com/index/introducing-the-codex-app/ , https://intuitionlabs.ai/articles/openai-codex-app-ai-coding-agents
- Claude Code desktop redesign: https://www.macrumors.com/2026/04/15/anthropic-rebuilds-claude-code-desktop-app/
- Claude Code steering gap issues: https://github.com/anthropics/claude-code/issues/36326 , https://github.com/anthropics/claude-code/issues/30492 , https://github.com/anthropics/claude-code/issues/64624 , https://github.com/anthropics/claude-code/issues/50246
- Self-hosted chat comparisons: https://wz-it.com/en/blog/slack-alternatives-mattermost-rocketchat-zulip/ , https://selfhosting.sh/best/communication/ , https://www.aquaray.com/en/blog/posts/zulip-vs-slack-comparison
- LibreChat vs Open WebUI: https://docs.openwebui.com/alternatives/librechat/ , https://portkey.ai/blog/librechat-vs-openwebui/
- Vibe Kanban review: https://elite-ai-assisted-coding.dev/p/vibe-kanban-tool-review

Not reachable at research time (should be re-checked during phase research): OpenAI group chats page and help-centre article (HTTP 403), Codex app worktrees/features pages (redirect chain to learn.chatgpt.com returned a generic ChatGPT features page), Mattermost end-user docs (404 on the collaborate index).

---
*Feature research for: Open Collaborative AI Workspace (Chats, AI Chats, Work Zone surfaces; PRD MVP1 + MVP2)*
*Researched: 2026-09-10*
