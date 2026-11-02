# PRD — Open Collaborative AI Workspace

**Version:** 1.0  
**Status:** Approved baseline  
**Date:** 2026-09-09  
**Supersedes:** v0.3 (2026-09-03, Spanish, archived at `docs/prd/archive/PRD-v0.3-es.md`)  
**Product type:** Open-source collaborative AI workspace for companies

---

## How to read this document

This is the definitive Product Requirements Document for the Open Collaborative AI Workspace. It consolidates the full content of the v0.3 draft into thirteen parts, ordered from vision to roadmap. Parts I–III describe why the product exists and what the user sees; Parts IV–IX describe each functional area in depth; Part X describes the architecture and technical stack; Parts XI–XII cover business and delivery; Part XIII is the log of engineering decisions taken on 2026-09-09, with pointers to the corresponding Architecture Decision Records under `docs/adr/`. Sections marked **P0** are mandatory for the MVP phase in which they appear. Sections marked **Future** are documented for direction only and are not part of the MVPs. ASCII diagrams and code blocks are normative illustrations of the intended UX and data model.

## Table of contents

- Part I — Vision & Problem
- Part II — Organization & Users
- Part III — Product Surfaces
- Part IV — Work Zone
- Part V — Projects, Git, Files & Artifacts
- Part VI — Shared AI Infrastructure
- Part VII — Organizational AI Configuration
- Part VIII — Persistent Agents & OpenClaw
- Part IX — Administration, Security & Governance
- Part X — Architecture & Technical Stack
- Part XI — Business
- Part XII — Roadmap
- Part XIII — Decisions Log

---

## Part I — Vision & Problem

### 1. Executive summary

The product will be an **open source, self-hostable, federable and multiplayer** platform for collaboration between people and AI agents inside companies.

The platform will combine, in a single experience:

- Slack / Discord / Inline-style communication;
- ChatGPT / Claude-style direct chats;
- collaborative AI chats between several people;
- coding agents such as Codex and Claude Code;
- collaborative local execution sessions through **Work Zone**;
- persistent server-side agents through OpenClaw;
- personal, project, team, department and organization bots;
- shared, versioned and inheritable skills;
- shared MCPs with permissions;
- knowledge and memory with enterprise scopes;
- centralized administration of models, providers and accounts;
- a Model Gateway with routing, pools and balancing across accounts/providers;
- automations, scheduled tasks and proactive agents;
- continuity between Desktop, Web and Mobile;
- remote control of local sessions from mobile and web;
- projects and Git repositories;
- enterprise audit and governance;
- official cloud deployment or fully self-hosted deployment.

The product thesis is to transform enterprise use of AI from a fragmented model:

```text
Each employee
↓
Their ChatGPT
Their Claude
Their Codex
Their skills
Their MCPs
Their prompts
Their configurations
```

towards:

```text
Company
↓
Shared AI Infrastructure
↓
People + Agents + Projects + Knowledge + Models + Devices
```

without removing local execution wherever it is necessary.

---

### 2. Vision

#### 2.1 Product vision

Create:

> **The open-source multiplayer workspace for humans and AI agents.**

It can also be described as:

> **Open-source collaborative AI operating system for companies.**

The platform will be the common layer between:

- employees;
- teams;
- projects;
- conversations;
- persistent agents;
- coding agents;
- models;
- skills;
- MCPs;
- knowledge;
- memory;
- permissions;
- devices;
- automations.

---

### 3. Problem

Companies currently use AI tools in a fragmented way:

- each developer configures Codex or Claude Code individually;
- each employee maintains their own AI chats;
- skills, prompts and MCPs are copied by hand;
- AI conversations are not multiplayer;
- local coding sessions cannot be shared properly;
- Slack/Teams/Discord are separated from the agents;
- persistent agents such as OpenClaw live outside the collaboration space;
- models and credentials are managed user by user;
- company knowledge is not distributed in a governed way;
- there is no common enterprise hierarchy for permissions, agents, skills and projects;
- the manager has no consolidated view of usage, cost, agents, activity and permissions.

The product will solve this problem by creating a common infrastructure.

---

### 4. Objectives

#### 4.1 Main objectives

1. Turn AI conversations into collaborative resources.
2. Turn local Codex/Claude Code sessions into multiplayer sessions.
3. Centralize governance, skills, MCPs, models and permissions.
4. Enable persistent, proactive server-side agents.
5. Allow humans and agents to coexist in the same channels.
6. Keep local execution when the runtime requires it.
7. Allow tasks to be continued/controlled from Desktop, Web or Mobile.
8. Be fully open source and self-hostable.
9. Enable a monetizable managed cloud offering without closing the core.
10. Design the product for companies with a real hierarchical structure.

---

### 5. Product principles

#### 5.1 Open source first

The complete product must be deployable on the company's own infrastructure.

Initial installation target:

```bash
git clone ...
docker compose up
```

No essential feature may mandatorily depend on the official cloud.

---

#### 5.2 Local when necessary, server when useful

##### Local execution

Used whenever direct access is required to:

- filesystem;
- local Git repositories;
- terminal;
- Docker;
- installed applications;
- Codex;
- Claude Code;
- OpenCode;
- desktop tools;
- Word / Excel / PowerPoint in later phases.

##### Server-side execution

Used for:

- OpenClaw;
- persistent bots;
- automations;
- scheduled tasks;
- managed workers;
- shared MCPs;
- 24/7 processes.

---

#### 5.3 The session belongs to the platform

A key architectural rule:

> **The runtime may be local. The session is not.**

A Work Zone is a shared cloud/realtime entity that connects to a local execution runtime.

This makes possible:

- multiplayer;
- mobile;
- web;
- audit;
- queue;
- handoff;
- history;
- notifications;
- remote control.

---

#### 5.4 Agents are first-class users

Agents will be real participants of the workspace.

Example:

```text
#backend

Víctor
Alex
Guillermo
@backend
@qa
@security
```

Agents will be able to:

- receive mentions;
- reply;
- create threads;
- mention users;
- mention other agents;
- publish artifacts;
- create Work Zones;
- execute tools;
- request approvals;
- send proactive messages;
- run automations.

---

### 6. Product thesis

The product will not be:

- another chat with bots;
- another Codex frontend;
- another enterprise Claude Code;
- another Discord with AI.

It will be:

> **A collaborative AI infrastructure for the whole organization.**

The main difference will be turning traditionally individual experiences into shared, governable resources:

```text
AI Chat
→ multiplayer

Coding Session
→ multiplayer

Agent
→ shared

Skills
→ shared

MCP
→ shared

Knowledge
→ shared

Models
→ centrally governed

Projects
→ collaborative

Automation
→ proactive
```

while keeping local execution where it is necessary and server-side execution where it brings availability and autonomy.

---

## Part II — Organization & Users

### 7. Users and roles

#### 7.1 Standard User

Can use:

- chats;
- channels;
- DMs;
- AI Chats;
- authorized agents;
- files;
- authorized projects.

---

#### 7.2 Developer

Can additionally use:

- Work Zone;
- repositories;
- Codex;
- Claude Code;
- terminal;
- diffs;
- branches;
- local MCPs;
- session forks.

---

#### 7.3 Team Lead / Manager

Can additionally:

- manage team members;
- share projects;
- configure team agents;
- review usage and activity;
- approve certain operations;
- administer skills/MCPs according to permissions.

---

#### 7.4 Organization Admin

Can administer:

- users;
- departments;
- teams;
- projects;
- models;
- provider pools;
- agents;
- skills;
- MCP;
- policies;
- devices;
- permissions;
- audit;
- budgets;
- storage;
- automations.

---

### 8. Organizational hierarchy

The platform will support:

```text
Organization
│
├── Department
│   │
│   ├── Team
│   │   ├── Project
│   │   └── Project
│   │
│   └── Team
│
└── Department
```

Example:

```text
Autofy
│
├── IT
│   ├── Backend
│   │   ├── Team Alpha
│   │   └── Team Beta
│   ├── Frontend
│   └── Infrastructure
│
└── Marketing
    ├── Performance
    └── Content
```

Each level may have:

- members;
- channels;
- projects;
- agents;
- skills;
- MCPs;
- policies;
- knowledge;
- allowed models;
- budgets.

---

## Part III — Product Surfaces

### 9. Core UX surfaces

The application will have three major mental modes:

```text
Organization
│
├── Chats
│   ├── Channels
│   ├── Threads
│   ├── DMs
│   └── AI Chats
│
├── Work Zone
│   ├── Local coding sessions
│   ├── Generic local tasks
│   ├── Prompt queues
│   └── Collaborative execution
│
└── Agents
    ├── Personal
    ├── Project
    ├── Team
    ├── Department
    └── Organization
```

In addition, **Projects** will exist as a cross-cutting layer.

Target navigation:

```text
Home
Chats
Work Zone
Agents
Projects
```

---

### 10. Visual direction

#### 10.1 Chats

Conceptual inspiration:

```text
Slack
+
Inline
+
Discord
+
ChatGPT
```

Characteristics:

- organizational sidebar;
- dense interface;
- few borders;
- side threads;
- avatars;
- mentions;
- reactions;
- humans and agents mixed together;
- integrated AI Chats;
- high navigation speed.

---

#### 10.2 Work Zone

Conceptual inspiration:

- modern Codex clients;
- Claude Code GUIs;
- conversation-centered sessions;
- Figma/Google Docs-style multiplayer.

It must not become a full IDE.

The conversation will be the main surface.

---

### 11. Platforms

#### 11.1 Desktop

Target technology:

**Electron + React**

Operating systems:

- macOS;
- Windows;
- Linux.

It will be the full client for users who require local execution.

---

#### 11.2 Web

Target technology:

**Next.js + React**

Oriented to:

- administration;
- chat;
- AI Chats;
- server-side agents;
- monitoring;
- remote Work Zones;
- audit;
- configuration.

---

#### 11.3 Mobile

Target technology:

**React Native / Expo**

Platforms:

- iOS;
- Android.

It will allow:

- chats;
- channels;
- DMs;
- threads;
- AI Chats;
- agents;
- monitoring Work Zones;
- sending prompts;
- managing the queue;
- approving operations;
- downloading artifacts;
- receiving push notifications.

---

### 12. Chats

#### 12.1 Navigation

```text
Chats

All
Mentions
Threads
AI Chats

──── Departments ────

IT
  # general
  # backend
  # infrastructure

Marketing
  # general
  # performance

──── Direct Messages ────

Alex
Guillermo
@victor-assistant
@backend
```

---

#### 12.2 Channel UI

The interface will have:

```text
┌───────────────┬──────────────────────────┬────────────────────┐
│ Navigation    │ Conversation             │ Thread             │
│               │                          │                    │
│ Departments   │ #backend                 │ Selected thread    │
│ Channels      │                          │                    │
│ DMs           │ Messages                 │ Replies            │
│ Agents        │ Agent responses          │ Agent activity     │
└───────────────┴──────────────────────────┴────────────────────┘
```

The thread panel can be opened without leaving the main conversation.

---

### 13. Threads

Threads will be a core concept.

Example:

```text
#backend

Víctor:
We need to redo the permissions system.

↳ 24 replies
```

Agents will be able to:

- reply;
- create threads;
- mention humans;
- mention other agents;
- publish artifacts;
- create Work Zones.

The UI will avoid infinite visual hierarchies.

---

### 14. Direct Messages

DMs will exist between:

- human ↔ human;
- human ↔ agent;
- group of humans;
- group of humans + agents.

Personal agents may appear as persistent DMs.

---

### 15. Direct AI Chats

Users will be able to create ChatGPT-style conversations.

Example:

```text
New Chat

Model:
Claude Opus

Tools:
Web
Company Knowledge
MCP
Skills
```

A conversation will have:

```text
Owner: Victor
Visibility: Private
```

And it can be shared later.

---

### 16. Multiplayer AI Chats — P0

AI Chats can be shared between several people.

Example:

```text
Architecture discussion

Participants
Víctor
Alex
@Claude
```

Conversation:

```text
Víctor:
Propose an architecture.

Claude:
...

Alex:
But we need multi-tenancy.

Claude:
Taking the new requirement into account...
```

Each message will preserve:

- author;
- timestamp;
- device;
- context;
- permissions.

The model must know the distinct identity of each participant.

---

### 17. Shareable AI Conversations

A conversation can evolve:

```text
Private AI Chat
↓
Shared with Alex
↓
Shared with Backend Team
```

Without copy-pasting history.

The following will be preserved:

- context;
- messages;
- attachments;
- artifacts;
- model;
- tools;
- permissions;
- participants.

---

### 18. Chat → Work Zone

A conversation can create an execution.

Example:

```text
#backend

Alex:
We have a race condition.

Víctor:
@codex fix it.
```

The platform will ask:

```text
Project
Autofy Ecommerce

Execute on
● Victor's MacBook
○ Alex's MacBook
○ Managed Worker

[Create Work Zone]
```

Afterwards a card will appear in the channel/thread.

---

### 19. Agent Cards

Complex actions will be represented as cards.

Example:

```text
@backend

Created Work Zone
Authentication refactor

Host
Victor's MacBook

Runtime
Claude Code

Status
● Running

[Open] [Follow]
```

Other types:

- PR created;
- report generated;
- approval requested;
- automation created;
- artifact generated;
- deployment.

---

## Part IV — Work Zone

### 20. Work Zone

#### 20.1 Definition

> **A Work Zone is a collaborative cloud session attached to an execution environment.**

Work Zone will not be exclusively for programming.

Initial runtimes:

- Codex;
- Claude Code;
- OpenCode;
- terminal;
- Git;
- filesystem.

Future:

- browser;
- Word;
- Excel;
- PowerPoint;
- other local applications.

---

### 21. Work Zone Architectural Principle — P0

```text
                  WORK SESSION

           ┌──────────┼──────────┐
           │          │          │
        Desktop      Web       Mobile
           │          │          │
           └──────────┼──────────┘
                      │
                Realtime Backend
                      │
              Work Session State
                      │
                  Prompt Queue
                      │
                 Device Relay
                      │
               Victor's Mac
                      │
                Local Runtime
                      │
            Codex / Claude Code
```

---

### 22. Multiplayer Work Zone — P0

Multiple authorized users will be able to:

- join a session;
- see realtime activity;
- send prompts;
- add prompts to the queue;
- steer;
- interrupt;
- see state;
- view diffs;
- view the terminal;
- see modified files;
- receive artifacts;
- download artifacts;
- request local files;
- approve actions;
- follow the session;
- use Desktop, Web or Mobile.

---

### 23. Multi-controller / Single Executor

Initial model:

> **Multiple controllers, one execution authority.**

```text
Víctor
Alex
Guillermo
Mobile
        │
        ▼
Shared Work Session
        │
        ▼
Prompt Arbiter
        │
        ▼
Victor's MacBook
        │
        ▼
Claude Code
```

Multiple agents will not initially be allowed to modify the same working tree simultaneously.

---

### 24. Execution Host

Each Work Zone will have a host.

```text
Execution host
Victor's MacBook Pro
● Online

Runtime
Claude Code

Project
autofy-ecommerce

Branch
feature/auth
```

---

### 25. Work Zone Presence

Header:

```text
[V] [A] [G] +2
```

States:

- Controlling;
- Viewing diff;
- Typing;
- Following;
- Away.

---

### 26. Multiplayer Prompting

New prompts can be:

#### Steer

Modify the direction of the current turn when the runtime allows it.

#### Queue

Wait for the end of the current execution.

#### Interrupt

Cancel/interrupt the current execution and prioritize an instruction.

---

### 27. Prompt Queue — P0

```text
PROMPT QUEUE

RUNNING
Victor
Refactor authentication
12m 43s

NEXT
1. Alex
   Don't change the public API.

2. Guillermo
   Add integration tests.

3. Victor
   Run lint and fix warnings.
```

Permissions:

- add;
- edit if not yet started;
- remove;
- reorder;
- run next;
- change priority.

---

### 28. Prompt Identity

Each prompt will preserve:

```text
prompt_id
author_user_id
origin_device_id
session_id
created_at
execution_mode
status
```

The audit log will show who requested each action even if it runs on someone else's device.

---

### 29. Work Zone Permissions

Possible permissions:

```text
VIEW
COMMENT
PROMPT
STEER
QUEUE
REORDER_QUEUE
CANCEL
APPROVE
FILES_VIEW
FILES_REQUEST
FILES_DOWNLOAD
FILES_SHARE
DIFF_VIEW
TERMINAL_VIEW
FULL_CONTROL
```

Example:

```text
Victor
Owner
Full Control

Alex
Prompt
Queue
View Files
Download Files

Guillermo
Prompt
View Diff

Nacho
View Only
```

---

### 30. Work Zone UI

Left sidebar:

```text
Work Zone

+ New Session
History
Scheduled

PROJECTS

autofy-ecommerce
  ● Authentication refactor
  ○ Stripe webhook
  ○ Product filters

histolab_erp
  ○ PDF upload
```

Center:

- conversation;
- agent actions;
- prompts;
- approvals;
- results;
- artifacts.

Optional right panel:

```text
Activity
Queue
Changes
Files
Terminal
Context
People
```

---

### 31. Work Zone Header

```text
Payments / Authentication Refactor

● Running on Victor's MacBook
Claude Code · Opus
feature/auth

[V][A][G] +2

[Share] [Queue 2] [···]
```

---

### 32. Follow Session

A user will be able to follow a session without controlling it.

Events:

- waiting for approval;
- task completed;
- task failed;
- mention;
- prompt completed;
- device disconnected.

---

### 33. Local Runtime Daemon

Electron will include an independent local service.

```text
Desktop App
     │
     ▼
Local Runtime Daemon
```

Responsibilities:

- launch Codex;
- launch Claude Code;
- launch OpenCode;
- terminal;
- filesystem;
- Git;
- Docker;
- local MCP;
- skills sync;
- secrets injection;
- remote session control;
- event streaming;
- device connection;
- project registration.

Architecture:

```text
Electron
    │
    ▼
Local Runtime
    │
    ├── Codex Adapter
    ├── Claude Code Adapter
    ├── OpenCode Adapter
    ├── Git Adapter
    ├── Terminal Adapter
    ├── Filesystem Adapter
    ├── MCP Runtime
    ├── Skills Manager
    ├── Project Manager
    └── Remote Session Agent
```

Recommended future target: Rust for the daemon (not decided).

---

### 34. Runtime Adapter API

Conceptual common interface:

```text
AgentRuntime
```

Implementations:

```text
CodexRuntime
ClaudeCodeRuntime
OpenCodeRuntime
OpenClawRuntime
GenericLLMRuntime
```

The rest of the product must not depend on the internal details of each runtime.

---

### 35. Unified Session Event Protocol

Normalized events:

```text
session.started
session.waiting
session.completed
session.failed

assistant.message
assistant.thinking

tool.requested
tool.started
tool.output

command.started
command.completed

file.changed
git.diff

approval.requested
approval.resolved

participant.joined
participant.left
participant.typing

prompt.created
prompt.updated
prompt.queued
prompt.reordered
prompt.cancelled

execution.steered

file.requested
file.shared
file.downloaded

artifact.created
session.followed
permission.denied
```

---

### 36. Remote Task Control

A local session can be controlled from other devices.

Example:

The user starts on a Mac:

```text
Claude Code:
Refactor the authentication service and run the tests.
```

From an iPhone:

```text
Active Sessions

MacBook Pro
└── Authentication refactor
    ● Running
    18m 42s
```

The user will be able to:

- view output;
- send a new prompt;
- queue;
- pause;
- stop;
- approve;
- view diff;
- download artifacts.

---

### 37. Device Relay

Each Local Runtime will maintain a secure outbound connection.

```text
MacBook
Local Runtime
     │
     ▼
Device Relay
     ▲
     │
Mobile / Web
```

No ports need to be opened on the device.

The backend will know:

- online/offline;
- latency;
- active sessions;
- runtime versions;
- project registrations;
- pending approvals.

---

### 38. Device Management

Screen:

```text
My Devices

MacBook Pro
● Online
3 active sessions

Office PC
○ Offline

Home Mac Mini
● Online
0 active sessions
```

Admin will be able to:

- authorize;
- revoke;
- block versions;
- require an update;
- limit projects;
- define policies.

---

### 39. Mobile Application

#### Mobile V1

- organizations;
- channels;
- DMs;
- threads;
- AI Chats;
- agents;
- mentions;
- notifications;
- Work Zone monitoring;
- prompts;
- queue;
- stop/pause/resume;
- approvals;
- artifacts;
- authorized files.

---

### 40. Mobile Approvals

Example:

```text
Claude Code requires approval

Command
pnpm prisma migrate deploy

Project
Payments

Device
MacBook Pro

[Reject] [Approve]
```

Permissions will determine who can approve.

---

### 41. Handover between devices

A session will not belong to a UI.

```text
Desktop
↓
Mobile
↓
Web
↓
Desktop
```

When returning to the computer:

```text
Authentication Refactor
3 messages were sent from iPhone.
Resume
```

---

### 42. Generic Local Tasks — Future

The Local Runtime will extend beyond programming.

```text
Local Task Runtime
├── Development
├── Browser
├── Office
├── Design
└── Operating System
```

Example:

> Analyze these documents and update the Word file with the conclusions.

From mobile:

- view progress;
- reply;
- approve;
- add instructions;
- stop.

---

### 43. Office Automation — Future

Potential integrations:

- Microsoft Word;
- Excel;
- PowerPoint;
- Outlook;
- browser;
- filesystem.

---

### 44. Full Remote Computer Access — Future

Will not be part of the MVP.

Initially, semantic control will be supported:

```text
send prompt
approve
stop
continue
view diff
view terminal output
```

Not initially:

```text
stream desktop
mouse control
keyboard control
```

---

## Part V — Projects, Git, Files & Artifacts

### 45. Projects

A Project represents a unit of work.

It contains:

- repositories;
- documentation;
- channels;
- members;
- agents;
- skills;
- MCPs;
- model policies;
- knowledge;
- Work Zones.

Example:

```text
Project: Ecommerce

Repositories:
autofy/backend
autofy/frontend
autofy/mobile
```

Git will be the primary source for code synchronization between developers.

---

### 46. Git Integration

The platform will show:

- branch;
- base commit;
- current commit;
- uncommitted changes;
- diffs;
- PRs;
- conflicts;
- repository status.

A session will have:

```text
Repository
Branch
Commit at session start
Current commit
Working tree state
```

---

### 47. Session Forking — Future

A user will be able to fork a Work Zone to their own device.

```text
Session #892
Host: Victor's MacBook

[Fork to my device]
```

The platform will reconstruct:

- repository;
- base commit;
- branch;
- diff;
- skills;
- MCPs;
- config.

Result:

```text
Session #892
├── Victor Execution
└── Alex Fork
```

---

### 48. Files and Artifacts

Three types will be distinguished.

#### 48.1 Source Files

Git files of the project.

Identity:

```text
repository
branch
commit
relative_path
working_tree_state
```

They will not be uploaded to the server automatically.

---

#### 48.2 Local Files

Files that exist only on the host.

Example:

```text
results.csv
Local · Victor's MacBook
```

They can be:

- previewed if allowed;
- requested;
- shared explicitly.

---

#### 48.3 Shared Artifacts

Deliberately published files.

```text
migration-report.md
18 KB

[Preview] [Download]
```

---

### 49. Artifact Upload Pipeline

```text
Local File
↓
Workspace containment validation
↓
Policy validation
↓
SHA-256
↓
Security checks
↓
Encrypted upload
↓
Object Storage
↓
SessionArtifact
```

---

### 50. File Request

```text
Alex
↓
Backend
↓
Device Relay
↓
Victor Local Runtime
↓
Permission/path validation
↓
File transfer
↓
Alex
```

Modes:

- relay-only;
- persisted artifact.

---

### 51. Artifact Storage Policies

Configurable per organization:

```text
Cloud Artifact Storage
● Enabled
○ Encrypted only
○ Disabled
```

Retention:

- 7 days;
- 30 days;
- 90 days;
- custom.

Sensitive mode:

```text
Server persistence: Disabled
Relay only
```

---

### 52. Absolute Path Privacy

Absolute host paths will not be exposed.

Allowed:

```text
src/auth/auth.service.ts
```

Not allowed:

```text
/Users/victor/Projects/autofy/backend/src/auth/auth.service.ts
```

The absolute mapping will exist only in the Local Runtime.

---

### 53. Registered Projects on Remote Devices

From Web/Mobile, previously registered projects can be selected.

```text
My MacBook

Payments
Ecommerce
ERP
```

Arbitrary exploration of the whole filesystem will not be allowed.

---

## Part VI — Shared AI Infrastructure

### 54. Model Gateway

Every runtime will be able to use a centralized endpoint.

```text
Codex / Claude Code / AI Chat
           │
           ▼
      Model Gateway
           │
   ┌───────┼────────┐
   │       │        │
OpenAI  Anthropic  Others
```

The client uses platform credentials, not the real provider credentials.

---

### 55. Provider Pools

An organization will be able to create pools.

```text
Pool: Engineering Claude

Anthropic Account 01
Anthropic Account 02
Anthropic Account 03
Anthropic Account 04
```

The router will decide the account according to:

- availability;
- quota;
- consumption;
- rate limit;
- cooldown;
- errors;
- priority;
- latency;
- model;
- organization policy;
- workspace access.

It will not be limited to simple round robin.

---

### 56. Provider Account State

Conceptual entity:

```text
provider_account

status
quota
current_usage
rate_limit_state
last_request
recent_errors
cooldown_until
priority
weight
workspace_access
```

---

### 57. Model Routing

Possible policies:

```text
Simple question → cheap model
Coding → coding model
Research → high-capability model
Private data → local model
```

Fallback:

```text
Claude Opus
↓
GPT
↓
Claude Sonnet
```

---

### 58. Organization Model Governance

Admin will be able to control:

- allowed models;
- blocked models;
- providers;
- provider pools;
- budgets;
- fallbacks;
- models per team;
- models per project;
- models per agent.

---

## Part VII — Organizational AI Configuration

### 59. Skills

Skills will be versioned resources.

Scopes:

- Organization;
- Department;
- Team;
- Project;
- User.

Example:

```text
Organization
└── security-policy

IT
└── development-standards

Backend
└── nestjs-guidelines

Payments Project
└── stripe-integration

Victor
└── personal-workflow
```

---

### 60. Skill Inheritance

Effective Skills:

```text
Organization skills
+
Department skills
+
Team skills
+
Project skills
+
User skills
```

When an administrator updates:

```text
nestjs-guidelines
v17 → v18
```

the affected devices must synchronize automatically.

---

### 61. Skill Versioning

Must support:

- semantic versions;
- changelog;
- rollback;
- pinning;
- mandatory versions;
- staged rollout;
- compatibility metadata.

---

### 62. GitOps for AI Configuration

Optionally, a workspace/project can be exported to Git.

```text
agents/
  backend/
    agent.yaml
    SOUL.md
    skills/
  marketing/
    agent.yaml

skills/
policies/
workspace.yaml
permissions.yaml
```

Objectives:

- portability;
- code review;
- versioning;
- no vendor lock-in.

---

### 63. MCP

MCP Servers will have enterprise scopes.

Example:

```text
GitHub MCP
Scope: Organization

PostHog MCP
Scope: Product Team

Supabase Production
Scope: Backend
Approval required: true
```

---

### 64. MCP Permissions

The following will be distinguished:

- availability;
- capabilities;
- read/write;
- secrets;
- approvals;
- user-level access;
- agent-level access.

---

### 65. Policies

Policies will be independent of skills.

Example:

```text
Production access = prohibited
Shell destructive commands = approval required
Personal agents = enabled
Max personal agents = 3
```

Conceptual model:

```text
Effective permissions =
Organization
∩ Department
∩ Team
∩ Project
∩ User
∩ Agent
∩ Tool
```

Higher-level restrictions prevail.

**Module access.** Admins, and Team Leads for the units they lead, turn whole modules (Work Zone, AI chats, bots) on
or off for the organization, a department, team or project, or one person. Turning a module off is an explicit deny
rule on the module's permissions, decided by the same resolver: it beats every role, including admin, and is inherited
down the hierarchy. The UI hides a denied module and the API refuses it. It is never a feature flag (ADR-0024).

---

## Part VIII — Persistent Agents & OpenClaw

### 66. Persistent Agents

OpenClaw will be used primarily for persistent agents.

Types:

#### Personal Agent

```text
@victor-assistant
```

#### Project Agent

```text
@payments-agent
```

#### Team Agent

```text
@backend
```

#### Department Agent

```text
@it-support
```

#### Organization Agent

```text
@company
```

---

### 67. Personal Agent Policies

Admin will be able to define:

```text
Personal Agents
Enabled: Yes
Max agents/user: 3
Allowed runtimes: OpenClaw
Allowed MCPs: Gmail, Calendar, GitHub
Forbidden: Production DB, Production AWS
```

---

### 68. Agent Builder

Desktop/Web will allow creating agents.

Fields:

#### Identity

- Name;
- Username;
- Avatar;
- Description.

#### Scope

- Personal;
- Project;
- Team;
- Department;
- Organization.

#### Runtime

- OpenClaw;
- future managed runtimes.

#### Model

- default;
- fallback;
- provider pool.

#### Skills

Selection and inheritance.

#### MCP

Selection and permissions.

#### Channels

Where it can participate.

#### Permissions

Allowed actions.

#### Triggering

- mention;
- DM;
- automatic;
- scheduled;
- event-based.

---

### 69. OpenClaw Native Channel — P0

The platform will be exposed as a **native OpenClaw channel**.

A conceptual plugin will be developed:

```text
@ourplatform/openclaw-channel
```

OpenClaw will not talk directly to the internal messaging implementation.

Path:

```text
OpenClaw
   │
   ▼
Our OpenClaw Channel Plugin
   │
   ▼
Agent Channel API
   │
   ▼
Our Backend
   │
   ├── Chat Service
   ├── Permissions
   ├── Audit
   ├── Artifacts
   └── Federation layer
```

---

### 70. OpenClaw Inbound

Must support:

- channel messages;
- DMs;
- threads;
- mentions;
- replies;
- attachments;
- authorized actions.

Flow:

```text
Victor
↓
#backend
↓
Backend realtime event
↓
OpenClaw Channel Plugin
↓
OpenClaw agent
```

---

### 71. OpenClaw Outbound

OpenClaw will be able to send:

- text;
- replies;
- thread messages;
- DMs;
- attachments;
- artifacts;
- approval requests;
- cards/event payloads.

Flow:

```text
OpenClaw agent
↓
message/sendMedia
↓
Channel Plugin
↓
Agent Channel API
↓
Backend
↓
Persist + Broadcast + Push + Audit
```

---

### 72. OpenClaw Proactive Messaging — P0

Agents will be able to initiate messages without a user contacting them first.

Examples:

- weekly report;
- incident alert;
- daily summary;
- task completed;
- reminder;
- sales follow-up;
- scheduled task result.

Example:

```text
@weekly-report
Every Friday 17:00
↓
collect data
↓
generate report
↓
send → #management
```

---

### 73. Standing Orders + Automations

The following will be distinguished:

```text
Standing order = WHAT it must do
Automation = WHEN it must do it
```

The UI will abstract the internal details of the runtime.

Example:

```text
AUTOMATION
Weekly company report

Agent
@company-analyst

When
Every Friday
17:00 Europe/Madrid

Deliver to
#management

Instructions
Generate the weekly company report.
```

As built in Phase 07.6 (ADR-0028):

- **Triggers:** a schedule (cron in an IANA time zone, presets in the UI), a signed webhook (Standard Webhooks; leads
  and admins create them), or new mail in an IMAP folder read with a Keychain app password. Webhook and mail content is
  posted by the platform first and treated as untrusted: the bot's turn on it is read-only unless a person approves a
  specific action.
- **Runs as its creator.** An automation always acts as the person who created it (their access, their bot, their
  budget); admins may pause or delete anyone's automation but never edit, resume or run it as them.
- **Budget:** runs a day per automation, a minimum interval, inbound items per hour, and a pause after three failed runs
  in a row ("Needs attention").
- **The Control Plane is the only scheduler.** Jobs run in PostgreSQL (pg-boss); OpenClaw's own cron and webhooks stay
  off in the cell.

---

### 74. Natural Language Automation Creation

Example:

```text
Victor:
@analyst every Friday at 5pm produce a metrics report and send it to #management.
```

The platform/agent will be able to create:

```text
standing_order
schedule
timezone
delivery_target
```

Afterwards it will show a confirmation card.

As built in Phase 07.6 (ADR-0028): the bot proposes through the `ocw_automation_propose` tool, the platform posts an
approval card, and only the person who asked (who becomes the run-as person) can create it, discard it, or edit it
first ("Created with changes"). Nothing runs until that person confirms; a bot cannot propose from a turn that read
outside content.

---

### 75. Delivery Targets

Entity:

```text
AgentDeliveryTarget

id
organizationId
agentId
type: channel | thread | dm | board
conversationId
threadId?
boardColumnId?   (board: each run adds a card to this column)
permissions
createdBy        (= the run-as person)
```

As built in Phase 07.6 (ADR-0028): the target is part of the automation (`app.automations`) and is decided again at
every run: the bot must be a member that may post there and the run-as person must still read it. A personal bot
delivers only to its owner's DM; a `dm` target is the run-as person's DM with the bot.

Targets will be stored using stable IDs, not names.

Example:

```text
channel:uuid
thread:uuid
user:uuid
```

---

### 76. OpenClaw Bindings

Each agent identity will have an associated account/channel.

Example:

```text
OpenClaw Gateway
│
├── agentId: backend
│   └── channel account: backend-agent
│
├── agentId: marketing
│   └── channel account: marketing-agent
│
└── agentId: victor-assistant
    └── channel account: victor-assistant
```

---

### 77. OpenClaw Approvals

Approval requests must be integrated into the chat.

Example:

```text
@devops requires approval

Production deployment
Command: kubectl apply ...

[Reject] [Approve once]
```

The ability to approve will depend on policies.

---

### 78. OpenClaw Attachments

Agents will be able to generate files.

Flow:

```text
OpenClaw
↓
sendMedia
↓
Channel Plugin
↓
Artifact API
↓
Object Storage
↓
Message attachment
```

---

### 79. Agent-to-Agent Collaboration

Agents will be able to mention other agents.

Example:

```text
Victor:
@backend implement the feature and when you're done hand it over to @qa.

@backend:
Implementation finished.
@qa review commit 2839f2.

@qa:
I found two issues.
```

Full traceability must be preserved.

---

### 80. Agent-to-Agent Permissions

Control:

```text
Human → Agent
Agent → Agent
Agent → Tool
Agent → Channel
Agent → External Agent
```

Example:

```text
@accountant
can_message:
  - @invoice-agent
  - @bank-agent
cannot_message:
  - @production-agent
```

---

### 81. Memory

Separate memories:

```text
Personal Memory
Agent Memory
Project Memory
Team Memory
Channel Memory
Organization Memory
Thread Context
```

Effective context:

```text
Thread context
+
Project context
+
Team knowledge
+
Department knowledge
+
Organization knowledge
+
Agent memory
+
Allowed user memory
```

---

### 82. Memory Isolation

A private conversation must never automatically become shared memory.

Configurable policies:

- no persistence;
- user only;
- project;
- team;
- organization;
- explicit promotion only.

---

### 83. Knowledge

Scopes:

- organization;
- department;
- team;
- project;
- user.

Possible sources:

- files;
- docs;
- repositories;
- Notion/Drive integrations;
- internal APIs;
- structured databases.

---

### 84. Team Home

Each team will have a page.

```text
Backend Team

12 Members
4 Agents
7 Active Projects

ACTIVE WORK
● Authentication refactor — Victor + Codex
● ERP permissions — Alex + Claude
● Payment migration — Guillermo + @backend

CHANNELS
# backend
# code-review
# incidents

AGENTS
@backend
@qa
@security

PROJECTS
Ecommerce
ERP
Payments
```

---

## Part IX — Administration, Security & Governance

### 85. Admin Console

#### Organization

- users;
- roles;
- departments;
- teams.

#### AI

- providers;
- provider accounts;
- pools;
- models;
- budgets.

#### Agents

- bots;
- personal agents;
- templates;
- runtimes;
- automations.

#### Development

- projects;
- repositories;
- skills;
- MCPs.

#### Devices

- authorized devices;
- versions;
- online status;
- sessions.

#### Security

- permissions;
- policies;
- audit;
- secrets.

---

### 86. Security Model

Principle: least privilege.

The following will be distinguished:

```text
User permissions
Agent permissions
Channel permissions
Project permissions
Tool permissions
Device permissions
```

An action can only be performed if all the required layers allow it.

---

### 87. Secrets

Secrets must be stored in a secret store.

Examples:

- API keys;
- GitHub tokens;
- AWS credentials;
- DB credentials;
- MCP secrets;
- provider credentials.

They will never be stored directly inside skills.

Possible target technology:

- OpenBao;
- cloud KMS;
- Vault-compatible abstraction.

See ADR-0003 (`docs/adr/0003-infrastructure-baseline.md`): the OpenBao/KMS abstraction is the decided baseline.

---

### 88. Audit Log

Every sensitive action will generate an event.

Example:

```text
10:42 Victor prompted @backend
10:43 @backend accessed GitHub
10:44 @backend modified branch feature/auth
10:51 Alex approved command
10:53 @backend created PR #183
```

Fields:

- actor;
- agent;
- user;
- device;
- resource;
- action;
- result;
- timestamp;
- organization;
- session.

---

### 89. Notifications

Channels:

- desktop;
- web;
- mobile push;
- optional email.

Events:

- mention;
- agent response;
- task completed;
- task failed;
- approval required;
- queue started;
- device offline;
- artifact ready;
- automation delivered;
- budget warning.

---

## Part X — Architecture & Technical Stack

### 90. Realtime Requirements

Must support:

- messages;
- presence;
- typing;
- streaming output;
- queue;
- execution state;
- approvals;
- file events;
- terminal events;
- diffs;
- notifications;
- agent proactive messages.

Initial target for normal collaborative events:

```text
< 500 ms typical propagation
```

---

### 91. Federation

The product will be federable.

Principle:

```text
company-a.example
       │
       │ federation
       ▼
company-b.example
```

Federation will allow:

- shared rooms;
- external users;
- external agents;
- cross-company collaboration;
- agent-to-agent interactions.

Pure P2P between devices is not considered as the main architecture.

---

### 92. Federation Layer

Matrix or a compatible protocol may be used as the underlying implementation, keeping our product API on top.

OpenClaw must integrate with **our channel API**, not directly with Matrix, so as not to bypass:

- permissions;
- agent identity;
- artifacts;
- audit;
- cards;
- organization hierarchy;
- policies.

---

### 93. High-level architecture

```text
                ┌───────────────────────┐
                │      WEB APP          │
                └──────────┬────────────┘
                           │
┌───────────────┐          │          ┌───────────────┐
│ MOBILE APP    │──────────┼──────────│ DESKTOP APP   │
└───────────────┘          │          └──────┬────────┘
                           │                 │
                           ▼                 ▼
               ┌────────────────────┐   Local Runtime
               │   CONTROL PLANE    │        │
               │                    │        ├─ Codex
               │ Organizations      │        ├─ Claude Code
               │ Teams              │        ├─ OpenCode
               │ Projects           │        ├─ Git
               │ Agents             │        ├─ Terminal
               │ Skills             │        ├─ Filesystem
               │ Permissions        │        └─ MCP
               │ Sessions           │
               └────────┬───────────┘
                        │
       ┌────────────────┼────────────────┐
       │                │                │
       ▼                ▼                ▼
 Model Gateway      Chat Layer      Device Relay
       │
       ├─ OpenAI
       ├─ Anthropic
       ├─ Gemini
       └─ Others

               ┌─────────────────────┐
               │ SERVER AGENT PLANE  │
               │                     │
               │ OpenClaw            │
               │ Workers             │
               │ Automations         │
               └─────────────────────┘
```

---

### 94. Control Plane

The Control Plane will be one of the highest-value pieces of the product.

Responsibilities:

- organizations;
- identity;
- permissions;
- teams;
- projects;
- agents;
- skills;
- MCP;
- policies;
- models;
- providers;
- budgets;
- sessions;
- devices;
- automations;
- auditing.

---

### 95. Agent Execution Plane

OpenClaw will be used as a runtime, not as the main multi-tenant backend.

Model:

```text
Workspace A
└── OpenClaw Cell
    ├── Agent A
    ├── Agent B
    └── Agent C

Workspace B
└── OpenClaw Cell
    ├── Agent D
    └── Agent E
```

Each trust boundary will have adequate isolation.

---

### 96. Initial technical stack

The stack below is the approved baseline as of 2026-09-09. Items marked with an ADR reference are decided; see Part XIII for rationale and for the list of items deferred to the GSD research phase.

#### Repository and tooling (ADR-0001)

```text
Single TypeScript monorepo
pnpm workspaces + Turborepo
Biome (lint + format)
Vitest (tests)
Node 22 LTS (exact version pinned in .nvmrc)
TypeScript strict
```

#### Frontend

```text
Desktop: Electron + React
Web: Next.js + React
Mobile: Expo / React Native
```

UI component library: working assumption Tailwind + shadcn/ui (deferred to research). Electron packaging and Expo setup are deferred to research.

#### Backend (ADR-0002, ADR-0003)

```text
TypeScript
Fastify (see ADR-0002) — modular monolith in apps/api
PostgreSQL (only database in MVP1)
Redis (pub/sub, presence, ephemeral state)
NATS JetStream — deferred (target: MVP2 event fan-out)
```

ORM: recommendation Drizzle (deferred to research). Realtime transport: working assumption WebSocket via Fastify + Redis pub/sub (deferred to research). Self-hosted auth/identity approach: deferred to research. AI provider SDK layer: deferred to research.

#### Workflows (ADR-0003)

```text
Temporal — deferred (target: MVP5 automations)
```

#### Server Agent Runtime

```text
OpenClaw
Docker
```

Later:

```text
Kubernetes
gVisor / Kata
```

#### Secrets (ADR-0003)

```text
OpenBao / KMS abstraction
```

#### Object Storage (ADR-0003)

```text
S3-compatible
```

#### Observability (ADR-0003)

```text
OpenTelemetry (from day one)
Prometheus
Grafana
Loki
```

#### AI coding agent instructions (ADR-0004)

```text
AGENTS.md — single source of truth
CLAUDE.md — imports AGENTS.md (@AGENTS.md) plus Claude-specific notes
.planning/ — GSD planning artifacts
```

---

### 97. Core Entities

```text
Organization
OrgUnit
User
Membership
Role

Device
DeviceSession

Project
Repository

Channel
Thread
Conversation
Message
ConversationParticipant

Agent
AgentTemplate
AgentRuntime
AgentDeliveryTarget
Automation

Skill
SkillVersion
SkillAssignment

MCPServer
MCPAssignment

Provider
ProviderAccount
ProviderPool
Model
ModelPolicy

WorkSession
WorkSessionParticipant
WorkSessionPermission

Execution
ExecutionRuntime
ExecutionDevice

Prompt
PromptQueueItem

RepositoryState
FileReference
Artifact
ArtifactPermission

SessionEvent
ApprovalRequest

SecretReference
Policy
Permission

Memory
KnowledgeSource

AuditEvent
Notification
```

---

### 98. APIs / Services

Logical services:

```text
Identity Service
Organization Service
Chat Service
Realtime Service
Work Session Service
Device Relay Service
Model Gateway
Provider Router
Agent Service
OpenClaw Channel API
Automation Service
Skills Service
MCP Service
Policy Service
Artifact Service
Audit Service
Notification Service
Federation Service
```

They will start as modules of a modular monolith (Fastify, `apps/api`, see ADR-0002) with explicit boundaries, and may be separated later.

---

### 99. Non-Functional Requirements

#### Security

- encryption in transit;
- encryption at rest where appropriate;
- least privilege;
- tenant isolation;
- secret separation;
- signed device identity;
- auditability.

#### Reliability

- reconnectable realtime sessions;
- replayable session events;
- resumable uploads;
- idempotent automation delivery;
- queue persistence.

#### Scalability

Initial design prepared for:

- multiple organizations;
- thousands of users;
- thousands of agents;
- many concurrent Work Sessions;
- large chat history;
- horizontal scaling of gateways and relays.

---

### 100. Final architecture summary

```text
                           ORGANIZATION
                                │
          ┌─────────────────────┼─────────────────────┐
          │                     │                     │
        CHATS                WORK ZONE              AGENTS
          │                     │                     │
 Humans + AI              Local execution       Persistent AI
 Channels                 Codex / Claude        OpenClaw
 Threads                  Git / Files           Automations
 AI Chats                 Multiplayer           Proactive msgs
          │                     │                     │
          └─────────────────────┼─────────────────────┘
                                │
                            PROJECTS
                                │
                  ┌─────────────┼──────────────┐
                  │             │              │
                Skills         MCP         Knowledge
                  │             │              │
                  └─────────────┼──────────────┘
                                │
                         CONTROL PLANE
                                │
          ┌─────────────────────┼─────────────────────┐
          │                     │                     │
    Model Gateway          Device Relay          Audit/Policy
          │                     │
          │                     ▼
          │                Local Runtime
          │                     │
          │            ┌────────┼────────┐
          │            │        │        │
          │          Codex   Claude   OpenCode
          │
          ▼
   Provider Pools
 OpenAI / Anthropic / Others

                     SERVER AGENT PLANE
                             │
                          OpenClaw
                             │
                 Native Platform Channel
                             │
              Proactive + Reactive Messaging
```

---

## Part XI — Business

### 101. North Star Metric

Primary:

> **AI-assisted tasks successfully completed per active organization.**

Secondary:

- active organizations;
- active users;
- Work Sessions started;
- Work Sessions completed;
- AI Chats;
- shared AI Chats;
- agents used;
- agents created;
- remote prompts;
- mobile approvals;
- skills distributed;
- artifacts generated;
- agent proactive messages;
- automations completed;
- model cost per completed task.

---

### 102. Open Source License Strategy

Initial proposal:

```text
Server / Control Plane: AGPLv3
Desktop: AGPLv3
Web: AGPLv3
Mobile: AGPLv3
Protocol / SDK: Apache 2.0
Agent SDK: Apache 2.0
Plugins: Apache 2.0
```

The trademark will be protected independently of the code.

---

### 103. Monetization

The code will remain open source.

Monetization will come mainly from operations and services.

#### Community Self-hosted

Free.

#### Managed Cloud

Managed hosting.

#### Agent Runtime / Compute

Charged by:

- active agents;
- execution hours;
- worker compute;
- storage.

#### Model Usage

- pass-through;
- metering;
- optional markup depending on strategy.

#### Enterprise

- dedicated deployments;
- private VPC;
- SLA;
- support;
- compliance;
- backups;
- disaster recovery;
- managed upgrades;
- SSO;
- SCIM;
- private networking.

#### Marketplace

Commission on:

- agents;
- skills;
- templates;
- integrations.

---

### 104. Pricing Direction

Do not base it exclusively on seats.

Possible formula:

```text
Base workspace
+
Users
+
Agent runtime
+
Compute
+
Model usage
```

Because:

```text
Company A
5 humans
50 agents

Company B
100 humans
2 agents
```

require different economics.

---

### 105. Marketplace — Future

Possible catalog:

```text
GitHub Maintainer
SEO Specialist
Recruiting Agent
Customer Support Agent
DevOps Agent
PostHog Analyst
Salesforce Agent
```

A package may include:

- prompt/personality;
- skills;
- MCPs;
- permissions;
- workflows;
- recommended models;
- memory schema.

---

## Part XII — Roadmap

### 106. MVP Roadmap

#### MVP 1 — Collaborative Workspace

P0:

- organizations;
- users;
- departments;
- teams;
- channels;
- threads;
- DMs;
- realtime;
- presence;
- direct AI Chats;
- multiplayer AI Chats;
- agents in conversations.

---

#### MVP 2 — Multiplayer Work Zone

P0:

- Electron;
- Local Runtime;
- Codex;
- Claude Code;
- WorkSession server entity;
- participants;
- realtime execution events;
- prompt identity;
- prompt queue;
- steering where supported;
- permissions;
- execution host;
- Git state;
- changed files;
- basic artifacts.

---

#### MVP 3 — Shared AI Infrastructure

- Model Gateway;
- provider pools;
- intelligent routing;
- account health;
- quotas;
- budgets;
- policies.

---

#### MVP 4 — Organizational AI Configuration

- skills;
- inheritance;
- versioning;
- MCP;
- policies;
- device sync;
- project context.

---

#### MVP 5 — Persistent Agents + OpenClaw Channel

P0:

- OpenClaw runtime;
- native platform channel plugin;
- inbound messages;
- outbound messages;
- proactive messages;
- personal agents;
- team agents;
- department agents;
- organization agents;
- agent-to-agent;
- scheduled automations;
- delivery targets;
- approvals.

---

#### MVP 6 — Remote Work Zone

- Device Relay;
- Web Work Zone;
- remote prompts;
- queue control;
- remote approvals;
- file requests;
- artifacts;
- follow session.

---

#### MVP 7 — Mobile

- iOS;
- Android;
- Chats;
- channels;
- DMs;
- threads;
- AI Chats;
- agent conversations;
- Work Zone monitoring;
- prompts;
- queue;
- approvals;
- artifacts;
- push.

---

### 107. Future Roadmap

- production-ready federation;
- external organizations;
- marketplace;
- agent packages;
- full remote computer control;
- Office automation;
- browser automation;
- managed cloud coding agents;
- visual workflows;
- advanced compliance;
- SSO/SCIM;
- dedicated deployments;
- edge runtimes;
- local models;
- cross-device session forks;
- collaborative prompt drafting;
- external agent federation.

---

### 108. MVP Non-Goals

Not to be built initially:

- full IDE;
- realtime collaborative filesystem;
- multiple agents writing simultaneously to the same working tree;
- full desktop streaming;
- mouse/keyboard remote desktop;
- full marketplace;
- complex office automation;
- infinite thread nesting;
- arbitrary filesystem browsing from mobile.

---

### 109. Main risks

#### 109.1 Runtime fragmentation

Codex, Claude Code and other runtimes may produce different events.

Mitigation:

- Runtime Adapter API;
- Unified Session Event Protocol.

#### 109.2 Local device connectivity

The host may sleep or disconnect.

Mitigation:

- heartbeat;
- reconnect;
- persisted queue;
- clear offline state;
- optional future managed workers.

#### 109.3 Permission complexity

Enterprise inheritance may become hard to understand.

Mitigation:

- effective permission viewer;
- policy simulator;
- explicit deny precedence;
- templates.

#### 109.4 Agent autonomy

Proactive agents may generate noise or execute unwanted actions.

Mitigation:

- delivery permissions;
- budget limits;
- automation visibility;
- approval policies;
- rate limits.

#### 109.5 File privacy

A local Work Zone may expose sensitive information.

Mitigation:

- relative paths;
- registered workspaces;
- containment checks;
- explicit sharing;
- relay-only mode;
- retention controls.

---

### 110. Acceptance Criteria — Core

The product will have validated the initial thesis when the following can be performed end to end:

#### Scenario A — Multiplayer Coding

1. Víctor opens a project on Desktop.
2. Starts Claude Code in a Work Zone.
3. Alex joins from another computer.
4. Both see realtime output.
5. Alex adds a prompt to the queue.
6. Víctor leaves the computer.
7. From mobile, he approves an operation.
8. Claude finishes.
9. Both download the artifact.
10. The result is published in #backend.

#### Scenario B — Multiplayer AI Chat

1. Víctor creates a private AI Chat.
2. He shares it with Alex.
3. Both write in real time.
4. The model distinguishes both users.
5. From the chat they create a Work Zone.

#### Scenario C — Proactive OpenClaw Agent

1. Admin creates @weekly-report.
2. Assigns it skills and MCPs.
3. Configures a weekly automation.
4. Delivery target = #management.
5. OpenClaw wakes the agent without a human prompt.
6. It generates the report.
7. It publishes text + PDF in #management.
8. The delivery is audited.

#### Scenario D — Enterprise Governance

1. Admin updates a Backend skill.
2. All the team's devices receive the new version.
3. An unauthorized user tries to access a production MCP.
4. The platform blocks the action.
5. The attempt appears in the audit log.

---

## Part XIII — Decisions Log

All decisions below were taken on 2026-09-09 and are recorded as Architecture Decision Records under `docs/adr/`. The ADR is the authoritative text; this log is a summary.

### 111. Decided

#### ADR-0001 — Single TypeScript monorepo

- **Decision:** a single TypeScript monorepo; pnpm workspaces + Turborepo; Biome for lint + format; Vitest for tests; Node 22 LTS (exact version pinned in `.nvmrc`); TypeScript strict.
- **Rationale:** one language and one toolchain across Desktop, Web, Mobile, API and Local Runtime minimizes friction for a small team and lets shared packages (protocol, SDK, UI) be consumed without publishing.
- **ADR:** `docs/adr/0001-typescript-monorepo.md`

#### ADR-0002 — Fastify modular monolith

- **Decision:** the backend is Fastify (not NestJS) as a modular monolith in `apps/api`; the services listed in Section 98 are modules with explicit boundaries, extractable later.
- **Rationale:** Fastify keeps the runtime lightweight and explicit while the modular-monolith layout preserves the option to split services once scale or team structure requires it.
- **ADR:** `docs/adr/0002-fastify-modular-monolith.md`

#### ADR-0003 — Infrastructure baseline

- **Decision:** PostgreSQL is the only database in MVP1; Redis for pub/sub, presence and ephemeral state; NATS JetStream and Temporal are deferred until a roadmap phase needs them (target: MVP2 event fan-out / MVP5 automations); S3-compatible object storage; OpenBao/KMS abstraction for secrets; OpenTelemetry from day one.
- **Rationale:** start with the smallest infrastructure that satisfies MVP1 and add message streaming and durable workflows only when the roadmap phase that needs them arrives, while keeping secrets, storage and observability decisions fixed early because they are hard to retrofit.
- **ADR:** `docs/adr/0003-infrastructure-baseline.md`

#### ADR-0004 — AGENTS.md as single source of truth

- **Decision:** `AGENTS.md` is the single source of truth for AI coding agent instructions; `CLAUDE.md` only imports it (`@AGENTS.md`) plus Claude-specific notes; GSD planning artifacts live in `.planning/`.
- **Rationale:** a single instruction file avoids drift between agent-specific files and keeps tool-neutral guidance in one place, with tool-specific additions layered on top.
- **ADR:** `docs/adr/0004-agents-md-single-source.md`

### 112. Deferred to GSD research phase (not decided)

- ORM (recommendation: Drizzle).
- Self-hosted auth/identity approach.
- Realtime transport details (working assumption: WebSocket via Fastify + Redis pub/sub).
- AI provider SDK layer.
- UI component library (working assumption: Tailwind + shadcn/ui).
- Electron packaging.
- Expo setup.

Also not decided: Rust as the future implementation language for the Local Runtime Daemon (Section 33) remains a recommendation only.

### 113. Amendments of 2026-09-10 (after project research)

Project research (`.planning/research/`) resolved the deferred items and proposed changes that were
accepted the same day:

- **ADR-0001 amended:** Node 24 LTS (was 22), TypeScript 7 with a `typescript6` alias for tooling, pnpm 12.
- **ADR-0003 amended:** `SecretStore` abstraction with `env`/`file` provider by default and OpenBao as an
  optional compose profile; Grafana Tempo added to the observability profile; minimal compose profile is
  api + web + migrate + PostgreSQL + Redis + MinIO.
- **ADR-0005 `docs/adr/0005-local-runtime-daemon-process-model.md`:** the Local Runtime daemon is a
  standalone process supervised by the desktop app, talking over a Unix socket / named pipe.
- **Resolved from Section 112:** ORM = Drizzle with RLS policies in schema; identity = better-auth embedded
  in the API with our own OrgUnit hierarchy; realtime = `@fastify/websocket` + Redis with per-stream `seq`
  persisted in PostgreSQL; AI layer = Vercel AI SDK 7; UI = Next.js 16, Tailwind, shadcn/ui on Base UI.
  Runtime adapters use the Claude Agent SDK and `codex app-server`, never CLI stdout. Electron renderer is
  a bundled Vite build. Each becomes an ADR in the phase that implements it.
- **Shared AI chat context rule (Section 15/16):** tools invoked in a shared conversation run with the
  intersection of the agent's permissions and the triggering human's permissions; retrieved content must
  be authorised for every participant or is withheld with an explanation; user-private memory never
  enters a conversation with more than one human.
- **First-release gaps accepted as MVP 1 / MVP 2 scope:** auth with invitations and first-run bootstrap,
  minimal admin console, message search, edit/delete, reactions, read state, notification preferences,
  attachments, pins/permalinks, organization-level model provider configuration, AI chat basics
  (streaming, stop, regenerate, titles, list, custom instructions, usage records), multiplayer
  response-trigger and single-generation policy, hosted agent persona entity; and for MVP 2 permission
  modes, approval semantics, worktree per session, resume/reattach with explicit host-offline state,
  runtime detection, device pairing/revocation, adapter capability flags, view modes, open-in-editor,
  desktop notifications, usage indicator, session lifecycle, host consent. Full list and rationale in
  `.planning/research/FEATURES.md` §4; requirement IDs in `.planning/REQUIREMENTS.md`.

---

**End of PRD v1.0.**
