---
schema_version: 1
open_count: 53
waived_count: 0
fixed_count: 16
total_count: 69
last_updated: 2026-10-07T05:51:33.668Z
---

# Broken Windows Ledger

> Cross-phase defect register. With `workflow.windows_enforce` enabled, `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 03.1 | unrun-verify | infra/openclaw/test/run-container-smoke.sh |  | 03.1-01: SMOKE_ONLY=mention,dm real-cell smoke not run to PASS: Docker VM out of memory (~1 GB available, swap full); the smoke cell is OOM-killed while booting | fixed |  | 2026-10-05T01:30:27.229Z | 2026-10-05T04:30:11.095Z |
| 2 | 03.1 | stub | apps/api/src/modules/bot-capabilities/turn-policy.ts | 187 | 03.1-03: turn.memory is always [] (planned extension point; 03.1-07 loads the human's DM memories) | fixed |  | 2026-10-05T01:53:53.261Z | 2026-10-05T03:34:12.241Z |
| 3 | 03.1 | stub | apps/api/src/modules/bot-capabilities/turn-policy.ts | 182 | 03.1-03: turnPolicy does not meter turns yet (planned extension point; 03.1-05 adds the atomic daily counter and deliver:false at the limit) | fixed |  | 2026-10-05T01:53:53.338Z | 2026-10-05T02:53:21.482Z |
| 4 | 03.1 | unrun-verify | infra/openclaw/test/run-container-smoke.sh |  | 03.1-04: SMOKE_ONLY=mention,dm,capabilities real-cell smoke not run to PASS locally: smoke cell OOM-killed during boot under the mandated --memory 1g cap (Docker VM ~0.9 GB available, swap full). Proven instead by the new CI cell-smoke job (offline, GitHub runner) | fixed |  | 2026-10-05T02:39:58.104Z | 2026-10-05T04:30:11.165Z |
| 5 | 03.1 | unrun-verify | infra/openclaw/test/run-container-smoke.sh |  | 03.1-04: SMOKE_ONLY=dm-isolation,capabilities real-cell smoke not run locally (same VM OOM under the 1 GB cap); transcript purge implemented defensively (reconciler + port, unit-tested) but OpenClaw's own behaviour on roster removal is unobserved until the CI cell-smoke job runs | fixed |  | 2026-10-05T02:45:08.390Z | 2026-10-05T04:30:11.235Z |
| 6 | 03.1 | unrun-verify | infra/openclaw/test/run-container-smoke.sh |  | 03.1-07: SMOKE_ONLY=memory,capabilities real-cell smoke not run locally (Docker VM cannot boot a smoke cell next to the demo; orchestrator rule). Scenario memory runs in the CI cell-smoke job; locally proven by plugin unit/contract tests and the fixture mapped through the built plugin | fixed |  | 2026-10-05T03:34:12.311Z | 2026-10-05T04:30:11.306Z |
| 7 | 03.1 | stub | apps/api/src/modules/agent-channel/index.ts |  | 03.1-11: /cell plugins is [] until 03.1-12 wires the approved list | fixed |  | 2026-10-05T04:53:52.880Z | 2026-10-05T06:50:12.949Z |
| 8 | 03.1 | unrun-verify | infra/openclaw/test/run-container-smoke.sh |  | 03.1-10: SMOKE_ONLY=mcp real-cell smoke not run locally (no OpenClaw container on the dev VM); proven by plugin/registry-model/integration tests; CI cell-smoke must show the mcp scenario lines listed in 03.1-10-SUMMARY | fixed |  | 2026-10-05T05:29:32.197Z | 2026-10-05T05:49:08.348Z |
| 9 | 03.1 | unrun-verify | infra/openclaw/test/run-container-smoke.sh |  | 03.1-12: SMOKE_ONLY=marketplace real-cell smoke not run locally (no OpenClaw container on the dev VM); proven by host CLI end-to-end, plugin/contract/integration tests; CI cell-smoke must show the marketplace lines listed in 03.1-12-SUMMARY | fixed |  | 2026-10-05T06:50:13.022Z | 2026-10-05T13:57:42.773Z |
| 10 | 03.1 | unrun-verify | infra/openclaw/test/run-container-smoke.sh |  | 03.1-14: SMOKE_ONLY=sandbox real-cell smoke not run locally (no OpenClaw container and <1 GB free on the dev VM); bridge proven by 21 node tests and a real hardened container with server-everything; CI cell-smoke must show the sandbox lines listed in 03.1-14-SUMMARY | fixed |  | 2026-10-05T13:58:55.002Z | 2026-10-05T14:54:04.675Z |
| 11 | 03.2 | stub | apps/api/src/modules/work-session/routes.ts |  | controlsContext uses DEFAULT_WORK_ZONE_POLICY and owner-only grain until Plan 04/05 | fixed |  | 2026-10-05T20:36:46.216Z | 2026-10-05T21:23:03.814Z |
| 12 | 03.2 | stub | apps/local-runtime/src/daemon.ts |  | hello/capabilities fullAccessOptIn hard-coded false until Plan 06 | fixed |  | 2026-10-05T20:36:46.287Z | 2026-10-05T21:50:29.369Z |
| 13 | 03.2 | stub | apps/api/src/modules/work-session/service.ts |  | dispatched turn mode = session mode; per-author cap (P-07) lands in Plan 04 | fixed |  | 2026-10-05T20:36:46.358Z | 2026-10-05T21:23:16.071Z |
| 14 | 03.2 | stub | packages/contracts/src/device.ts |  | Device.viewerMaxMode/grants and UpdateDeviceRequest.shareMaxMode not wired until Plan 05 | fixed |  | 2026-10-05T20:36:46.430Z | 2026-10-05T21:49:49.987Z |
| 15 | 03.2 | deviation | apps/local-runtime/src/codex/codex-runtime.ts |  | /compact completes via turn/completed (compaction is a non-steerable turn at 0.160.0); not fixtured | open |  | 2026-10-05T21:04:47.656Z |  |
| 16 | 03.2 | unrun-verify | packages/contracts/src/runtime-controls/codex.ts |  | Codex Auto (approvalsReviewer auto_review) exposed but its review behaviour is not fixtured | open |  | 2026-10-05T21:04:47.745Z |  |
| 17 | 03.2 | deviation | packages/realtime-client/src/client.ts |  | Fixed pre-existing resync cursor bug (org topics past REPLAY_LIMIT dropped live events); found by the 03.2-11 full e2e | open |  | 2026-10-06T00:14:50.556Z |  |
| 18 | 03.2 | unrun-verify | .planning/phases/03.2-work-zone-session-controls/03.2-VALIDATION.md |  | Manual-only: real Full access turn (Claude relaunch with resume, Codex never+dangerFullAccess), resolved-model mapping, Codex Auto reviewer | open |  | 2026-10-06T00:14:50.629Z |  |
| 19 | 03.2 | unrun-verify | apps/local-runtime/src/claude/title.ts |  | Claude title latency with thinking disabled not recorded (fixture recorded with thinking: 31 s); owner manual check | open |  | 2026-10-06T02:17:25.305Z |  |
| 20 | 04 | deviation | apps/api/src/modules/chat/index.ts |  | POST /conversations/:id/messages answers 400 attachments_unavailable for attachment-only posts until 04-04 wires uploads | fixed |  | 2026-10-06T04:56:06.542Z | 2026-10-06T10:22:12.272Z |
| 21 | 04 | deviation | apps/api/src/modules/chat/access.ts |  | ConversationAccess boolean check is isReadable (plan said canRead; static guard bans that identifier); 04-09 must call isReadable | open |  | 2026-10-06T04:56:06.615Z |  |
| 22 | 04 | deviation | apps/api/src/modules/chat/access.ts |  | Hidden conversations now 404 with the route's not-found message (identical to missing); was generic 'Not found' | open |  | 2026-10-06T05:27:09.545Z |  |
| 23 | 04 | deviation | packages/contracts/src/chat.ts |  | Added PageQueryFields + pageCursorCount; messages route enforces one cursor after readable (400 invalid_page_query) | open |  | 2026-10-06T05:27:09.619Z |  |
| 24 | 04 | deviation | apps/web/components/chat/use-permalink-window.ts |  | Detached window logic extracted into shared hooks (not in plan file list); 04-07 group DMs must reuse it | open |  | 2026-10-06T05:27:09.695Z |  |
| 25 | 04 | deviation | apps/api/src/app.ts |  | buildApp gained an optional secretStore test hook so testcontainer S3 secrets resolve via SecretReference | open |  | 2026-10-06T05:31:09.460Z |  |
| 26 | 04 | deviation | packages/db/sql/post-migrate.sql |  | app.due_attachment_sweeps takes p_now (default now()) in addition to p_limit, for the sweeper's injectable clock | open |  | 2026-10-06T05:31:09.529Z |  |
| 27 | 04 | deviation | apps/api/src/config/env.ts |  | OCW_SEARCH_RATE_LIMIT_PER_MINUTE (default 30) added; e2e-isolated.sh raises it to 600 for specs | open |  | 2026-10-06T06:11:49.247Z |  |
| 28 | 04 | deviation | apps/api/src/modules/search/index.ts |  | Search routes call markDecided after access.readableIds (request-less filterFor) and share one app.rateLimit handler | open |  | 2026-10-06T06:11:49.318Z |  |
| 29 | 04 | deviation | apps/web/public/emojibase/README.md |  | Emoji picker data self-hosted (emojibase-data 17.0.0 en, vendored JSON) instead of frimousse's jsDelivr default | open |  | 2026-10-06T06:20:53.647Z |  |
| 30 | 04 | deviation | apps/web/components/chat/message-actions.tsx |  | Hover toolbar hidden on hover:none devices; touch uses the long-press sheet only | open |  | 2026-10-06T06:20:53.716Z |  |
| 31 | 04 | deviation | apps/api/src/modules/chat/saves.ts |  | GET /saved marks the request decided after access.readableIds (request-less filterFor) for the strict authz hook | open |  | 2026-10-06T06:20:53.784Z |  |
| 32 | 04 | deviation | packages/contracts/src/chat.ts |  | CreateDmRequestFields (route body, max 32) so POST /dms answers too_many_participants after dedupe instead of validation_error | open |  | 2026-10-06T07:09:19.504Z |  |
| 33 | 04 | deviation | apps/api/src/modules/chat/index.ts |  | GET /messages/:id/thread now serves DM and group roots to participants (was channel-only); outsiders still 404 | open |  | 2026-10-06T07:09:19.575Z |  |
| 34 | 04 | deviation | apps/api/src/modules/chat/dm-privacy.int.test.ts |  | Privacy suite links attachments to messages via SQL until 04-12 wires attachments on send; Plan 09 adds the inbox route | fixed |  | 2026-10-06T07:09:19.644Z | 2026-10-06T10:22:12.346Z |
| 35 | 04 | deviation | apps/web/components/members/member-profile-sheet.tsx |  | Message action added to the member profile sheet (not in plan file list) | open |  | 2026-10-06T07:09:19.714Z |  |
| 36 | 04 | deviation | apps/web/components/chat/chat-sidebar.tsx |  | Unit sections also list unjoined public channels of the member's own units (muted) so new department channels reach members live | open |  | 2026-10-06T08:08:43.342Z |  |
| 37 | 04 | deviation | packages/contracts/src/chat.ts |  | Add-only ChannelUnit.pathNames, ChannelList.memberUnitIds, ThreadSummary.lastReplies | open |  | 2026-10-06T08:08:43.410Z |  |
| 38 | 04 | deviation | apps/api/src/modules/agent-channel/index.ts |  | Agent channel resource carries the channel's unit path so unit-scoped rules reach bots | open |  | 2026-10-06T08:08:43.479Z |  |
| 39 | 04 | deviation | apps/api/src/modules/chat/index.ts |  | conversation.updated with unitId re-decides live conv: subscriptions; #general cannot move; archived PATCH 410 | open |  | 2026-10-06T08:08:43.546Z |  |
| 40 | 04 | deviation | apps/api/src/modules/notification/snippet.ts |  | Inbox snippets drop Markdown markup (plain one-line text, computed at read time); file not in plan list | open |  | 2026-10-06T08:49:18.908Z |  |
| 41 | 04 | deviation | apps/api/src/modules/chat/index.ts |  | @channel/@here limit exempts client retries of an already-posted message; channel.mention_all added to viewerCan | open |  | 2026-10-06T08:49:18.977Z |  |
| 42 | 04 | deviation | e2e/tests/chat-sidebar.spec.ts |  | View list assertion updated for Mentions (inserted second by plan) | open |  | 2026-10-06T08:49:19.050Z |  |
| 43 | 04 | deviation | apps/api/src/modules/chat/dm-privacy.int.test.ts |  | Inbox privacy covered via list checks and a dedicated describe, not routesFor (GET /notifications is a 200 list) | open |  | 2026-10-06T08:49:19.123Z |  |
| 44 | 04 | deviation | apps/api/src/modules/chat/index.ts |  | moveReadCursor locks the user: stream before counting so conversation.read never overtakes a notification; not_a_member on mark-unread for unjoined channels | open |  | 2026-10-06T09:33:56.215Z |  |
| 45 | 04 | deviation | packages/contracts/src/notifications.ts |  | Add-only ConversationReadEvent.latestMessageSeq: clients refetch the snapshot when a conv: frame overtook the counts | open |  | 2026-10-06T09:33:56.287Z |  |
| 46 | 04 | deviation | apps/api/src/modules/chat/threads.ts |  | Folded 04-08/04-09 items: ThreadList.unreadThreads over all pages; thread reads clear that thread's notifications | open |  | 2026-10-06T09:33:56.356Z |  |
| 47 | 04 | deviation | apps/api/src/modules/chat/dm-privacy.int.test.ts |  | Fixture re-marks Alex's DM notification unread (reading the DM now reads it); privacy assertions unchanged | open |  | 2026-10-06T09:33:56.425Z |  |
| 48 | 04 | deviation | apps/web/components/chat/use-read-cursor.ts |  | Shared read-cursor hook (not in plan list): detached windows read only what they show, per-tab hold in sessionStorage, New messages divider on open | open |  | 2026-10-06T09:33:56.493Z |  |
| 49 | 04 | deviation | apps/api/src/modules/artifact/attachments.ts |  | 04-12: attachment preview/large redirects send CORP cross-origin (Chromium treats IP:port as separate sites; helmet same-site blocked previews) | open |  | 2026-10-06T10:22:12.419Z |  |
| 50 | 04 | deviation | apps/web/components/chat/dm-view.tsx |  | 04-12: DMs with a bot offer no attachments until bots can read files | open |  | 2026-10-06T10:22:12.492Z |  |
| 51 | 04 | deviation | packages/contracts/src/notifications.ts |  | decideNotify optional actorKind: a bot's reply in a bot DM pops only on a mention or level all (04-09 open item) | open |  | 2026-10-06T10:38:03.132Z |  |
| 52 | 04 | deviation | apps/web/components/chat/chat-sidebar.tsx |  | All view count and collapsed sections skip muted rows unless mentioned (same rule as the badge) | open |  | 2026-10-06T10:38:03.199Z |  |
| 53 | 04 | deviation | apps/web/components/settings/account-nav.ts |  | Settings › Notifications linked as an Account section instead of settings-nav.ts | open |  | 2026-10-06T10:38:03.268Z |  |
| 54 | 04 | deviation | apps/web/components/notifications/os-notifier.tsx |  | OsNotifier shares the sidebar's user: cursor (GET /channels userSeq), applies notification_prefs.updated app-wide, skips pop-ups older than 10 minutes | open |  | 2026-10-06T10:38:03.340Z |  |
| 55 | 04 | deviation | apps/desktop/e2e/smoke.e2e.ts |  | Smoke bridge key list gains setBadgeCount plus a badge round trip (not in plan list) | open |  | 2026-10-06T10:38:03.410Z |  |
| 56 | 04 | deviation | apps/web/components/chat/attachments/lightbox.tsx |  | 04-13: lightbox backdrop forceRender (Base UI skips nested dialog backdrops; phone thread is a sheet) | open |  | 2026-10-06T12:07:47.641Z |  |
| 57 | 04 | deviation | e2e/tests/work-zone-title.spec.ts |  | 04-13: tab-title assertions accept the 04-11 unread-count prefix | open |  | 2026-10-06T12:07:47.711Z |  |
| 58 | 04 | deviation | e2e/tests/search.spec.ts |  | 04-13: palette bot found by 'sammy'; 'sam' overflows the 5-person overview on a shared stack | open |  | 2026-10-06T12:07:47.779Z |  |
| 59 | 04 | todo | apps/web/components/chat/views/threads-view.tsx |  | 04-13 review: Threads view cards render @mentions as plain text (no MentionContext) | open |  | 2026-10-06T12:07:47.849Z |  |
| 60 | 04 | todo | apps/web/components/chat/message-list.tsx |  | 04-13 review: (edited) marker on its own line instead of inline | open |  | 2026-10-06T12:07:47.918Z |  |
| 61 | 04 | todo | e2e/tests/attachments.spec.ts |  | 04-13 review: capture upload progress mid-flight with a throttled route | open |  | 2026-10-06T12:07:47.987Z |  |
| 62 | 04 | unrun-verify | apps/desktop/src/main/index.ts |  | Signed-build notification click-to-focus and dock badge remain manual checks (Pitfall 11) | open |  | 2026-10-06T12:07:48.055Z |  |
| 63 | 05 | deviation | e2e/tests/ai-chat-signin.spec.ts |  | Disconnect e2e asserts plan rows via GET /ai-chat/models, and signin.int 'org rows stay available' is vacuous until 05-04's picker and org keys merge; tighten both after the 05-04 merge | open |  | 2026-10-06T18:13:56.172Z |  |
| 64 | 05 | unrun-verify | apps/desktop/src/main/chatgpt-loopback.ts |  | Real desktop build: Continue with ChatGPT through the system browser and the 127.0.0.1 listener against auth.openai.com (human-check, 05-15 owner check) | open |  | 2026-10-06T18:58:18.983Z |  |
| 65 | 05 | deviation | apps/api/src/modules/ai-chat/service.ts |  | 05-12: abandoned AI chat drafts remain as hidden empty chats (no sweeper); their unsent uploads are swept after 24 h | open |  | 2026-10-07T01:48:18.761Z |  |
| 66 | 05 | deviation | apps/api/src/modules/ai-chat/shares.ts |  | 05-13: every share view writes an ai_chat.share_viewed audit row (no dedupe window) | open |  | 2026-10-07T02:35:52.102Z |  |
| 67 | 05 | unrun-verify | docs/adr/0017-sign-in-with-chatgpt-per-member.md |  | Owner manual check on the demo: real Sign in with ChatGPT by paste and from the desktop app, one plan turn with Stop, Business/Enterprise eligibility, visual review of 05-UI-REVIEW.md (05-VALIDATION manual rows) | open |  | 2026-10-07T05:51:33.527Z |  |
| 68 | 05 | deviation | apps/api/src/modules/identity/authenticate.ts |  | Phase 1-4 routes run requireUser as preHandler: an anonymous malformed body gets 400 before 401 (AI routes fixed in 05-15; see 05 deferred-items.md) | open |  | 2026-10-07T05:51:33.597Z |  |
| 69 | 05 | deviation | apps/api/src/app.ts |  | API request logs include query strings (search terms from GET /search?q=); add a serializer that redacts them (05 deferred-items.md) | open |  | 2026-10-07T05:51:33.668Z |  |

````json
[
  {
    "id": 1,
    "kind": "unrun-verify",
    "phase": "03.1",
    "file": "infra/openclaw/test/run-container-smoke.sh",
    "line": null,
    "description": "03.1-01: SMOKE_ONLY=mention,dm real-cell smoke not run to PASS: Docker VM out of memory (~1 GB available, swap full); the smoke cell is OOM-killed while booting",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-05T01:30:27.229Z",
    "resolved_at": "2026-10-05T04:30:11.095Z"
  },
  {
    "id": 2,
    "kind": "stub",
    "phase": "03.1",
    "file": "apps/api/src/modules/bot-capabilities/turn-policy.ts",
    "line": 187,
    "description": "03.1-03: turn.memory is always [] (planned extension point; 03.1-07 loads the human's DM memories)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-05T01:53:53.261Z",
    "resolved_at": "2026-10-05T03:34:12.241Z"
  },
  {
    "id": 3,
    "kind": "stub",
    "phase": "03.1",
    "file": "apps/api/src/modules/bot-capabilities/turn-policy.ts",
    "line": 182,
    "description": "03.1-03: turnPolicy does not meter turns yet (planned extension point; 03.1-05 adds the atomic daily counter and deliver:false at the limit)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-05T01:53:53.338Z",
    "resolved_at": "2026-10-05T02:53:21.482Z"
  },
  {
    "id": 4,
    "kind": "unrun-verify",
    "phase": "03.1",
    "file": "infra/openclaw/test/run-container-smoke.sh",
    "line": null,
    "description": "03.1-04: SMOKE_ONLY=mention,dm,capabilities real-cell smoke not run to PASS locally: smoke cell OOM-killed during boot under the mandated --memory 1g cap (Docker VM ~0.9 GB available, swap full). Proven instead by the new CI cell-smoke job (offline, GitHub runner)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-05T02:39:58.104Z",
    "resolved_at": "2026-10-05T04:30:11.165Z"
  },
  {
    "id": 5,
    "kind": "unrun-verify",
    "phase": "03.1",
    "file": "infra/openclaw/test/run-container-smoke.sh",
    "line": null,
    "description": "03.1-04: SMOKE_ONLY=dm-isolation,capabilities real-cell smoke not run locally (same VM OOM under the 1 GB cap); transcript purge implemented defensively (reconciler + port, unit-tested) but OpenClaw's own behaviour on roster removal is unobserved until the CI cell-smoke job runs",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-05T02:45:08.390Z",
    "resolved_at": "2026-10-05T04:30:11.235Z"
  },
  {
    "id": 6,
    "kind": "unrun-verify",
    "phase": "03.1",
    "file": "infra/openclaw/test/run-container-smoke.sh",
    "line": null,
    "description": "03.1-07: SMOKE_ONLY=memory,capabilities real-cell smoke not run locally (Docker VM cannot boot a smoke cell next to the demo; orchestrator rule). Scenario memory runs in the CI cell-smoke job; locally proven by plugin unit/contract tests and the fixture mapped through the built plugin",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-05T03:34:12.311Z",
    "resolved_at": "2026-10-05T04:30:11.306Z"
  },
  {
    "id": 7,
    "kind": "stub",
    "phase": "03.1",
    "file": "apps/api/src/modules/agent-channel/index.ts",
    "line": null,
    "description": "03.1-11: /cell plugins is [] until 03.1-12 wires the approved list",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-05T04:53:52.880Z",
    "resolved_at": "2026-10-05T06:50:12.949Z"
  },
  {
    "id": 8,
    "kind": "unrun-verify",
    "phase": "03.1",
    "file": "infra/openclaw/test/run-container-smoke.sh",
    "line": null,
    "description": "03.1-10: SMOKE_ONLY=mcp real-cell smoke not run locally (no OpenClaw container on the dev VM); proven by plugin/registry-model/integration tests; CI cell-smoke must show the mcp scenario lines listed in 03.1-10-SUMMARY",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-05T05:29:32.197Z",
    "resolved_at": "2026-10-05T05:49:08.348Z"
  },
  {
    "id": 9,
    "kind": "unrun-verify",
    "phase": "03.1",
    "file": "infra/openclaw/test/run-container-smoke.sh",
    "line": null,
    "description": "03.1-12: SMOKE_ONLY=marketplace real-cell smoke not run locally (no OpenClaw container on the dev VM); proven by host CLI end-to-end, plugin/contract/integration tests; CI cell-smoke must show the marketplace lines listed in 03.1-12-SUMMARY",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-05T06:50:13.022Z",
    "resolved_at": "2026-10-05T13:57:42.773Z"
  },
  {
    "id": 10,
    "kind": "unrun-verify",
    "phase": "03.1",
    "file": "infra/openclaw/test/run-container-smoke.sh",
    "line": null,
    "description": "03.1-14: SMOKE_ONLY=sandbox real-cell smoke not run locally (no OpenClaw container and <1 GB free on the dev VM); bridge proven by 21 node tests and a real hardened container with server-everything; CI cell-smoke must show the sandbox lines listed in 03.1-14-SUMMARY",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-05T13:58:55.002Z",
    "resolved_at": "2026-10-05T14:54:04.675Z"
  },
  {
    "id": 11,
    "kind": "stub",
    "phase": "03.2",
    "file": "apps/api/src/modules/work-session/routes.ts",
    "line": null,
    "description": "controlsContext uses DEFAULT_WORK_ZONE_POLICY and owner-only grain until Plan 04/05",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-05T20:36:46.216Z",
    "resolved_at": "2026-10-05T21:23:03.814Z"
  },
  {
    "id": 12,
    "kind": "stub",
    "phase": "03.2",
    "file": "apps/local-runtime/src/daemon.ts",
    "line": null,
    "description": "hello/capabilities fullAccessOptIn hard-coded false until Plan 06",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-05T20:36:46.287Z",
    "resolved_at": "2026-10-05T21:50:29.369Z"
  },
  {
    "id": 13,
    "kind": "stub",
    "phase": "03.2",
    "file": "apps/api/src/modules/work-session/service.ts",
    "line": null,
    "description": "dispatched turn mode = session mode; per-author cap (P-07) lands in Plan 04",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-05T20:36:46.358Z",
    "resolved_at": "2026-10-05T21:23:16.071Z"
  },
  {
    "id": 14,
    "kind": "stub",
    "phase": "03.2",
    "file": "packages/contracts/src/device.ts",
    "line": null,
    "description": "Device.viewerMaxMode/grants and UpdateDeviceRequest.shareMaxMode not wired until Plan 05",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-05T20:36:46.430Z",
    "resolved_at": "2026-10-05T21:49:49.987Z"
  },
  {
    "id": 15,
    "kind": "deviation",
    "phase": "03.2",
    "file": "apps/local-runtime/src/codex/codex-runtime.ts",
    "line": null,
    "description": "/compact completes via turn/completed (compaction is a non-steerable turn at 0.160.0); not fixtured",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-05T21:04:47.656Z",
    "resolved_at": null
  },
  {
    "id": 16,
    "kind": "unrun-verify",
    "phase": "03.2",
    "file": "packages/contracts/src/runtime-controls/codex.ts",
    "line": null,
    "description": "Codex Auto (approvalsReviewer auto_review) exposed but its review behaviour is not fixtured",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-05T21:04:47.745Z",
    "resolved_at": null
  },
  {
    "id": 17,
    "kind": "deviation",
    "phase": "03.2",
    "file": "packages/realtime-client/src/client.ts",
    "line": null,
    "description": "Fixed pre-existing resync cursor bug (org topics past REPLAY_LIMIT dropped live events); found by the 03.2-11 full e2e",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T00:14:50.556Z",
    "resolved_at": null
  },
  {
    "id": 18,
    "kind": "unrun-verify",
    "phase": "03.2",
    "file": ".planning/phases/03.2-work-zone-session-controls/03.2-VALIDATION.md",
    "line": null,
    "description": "Manual-only: real Full access turn (Claude relaunch with resume, Codex never+dangerFullAccess), resolved-model mapping, Codex Auto reviewer",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T00:14:50.629Z",
    "resolved_at": null
  },
  {
    "id": 19,
    "kind": "unrun-verify",
    "phase": "03.2",
    "file": "apps/local-runtime/src/claude/title.ts",
    "line": null,
    "description": "Claude title latency with thinking disabled not recorded (fixture recorded with thinking: 31 s); owner manual check",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T02:17:25.305Z",
    "resolved_at": null
  },
  {
    "id": 20,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/api/src/modules/chat/index.ts",
    "line": null,
    "description": "POST /conversations/:id/messages answers 400 attachments_unavailable for attachment-only posts until 04-04 wires uploads",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-06T04:56:06.542Z",
    "resolved_at": "2026-10-06T10:22:12.272Z"
  },
  {
    "id": 21,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/api/src/modules/chat/access.ts",
    "line": null,
    "description": "ConversationAccess boolean check is isReadable (plan said canRead; static guard bans that identifier); 04-09 must call isReadable",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T04:56:06.615Z",
    "resolved_at": null
  },
  {
    "id": 22,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/api/src/modules/chat/access.ts",
    "line": null,
    "description": "Hidden conversations now 404 with the route's not-found message (identical to missing); was generic 'Not found'",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T05:27:09.545Z",
    "resolved_at": null
  },
  {
    "id": 23,
    "kind": "deviation",
    "phase": "04",
    "file": "packages/contracts/src/chat.ts",
    "line": null,
    "description": "Added PageQueryFields + pageCursorCount; messages route enforces one cursor after readable (400 invalid_page_query)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T05:27:09.619Z",
    "resolved_at": null
  },
  {
    "id": 24,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/web/components/chat/use-permalink-window.ts",
    "line": null,
    "description": "Detached window logic extracted into shared hooks (not in plan file list); 04-07 group DMs must reuse it",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T05:27:09.695Z",
    "resolved_at": null
  },
  {
    "id": 25,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/api/src/app.ts",
    "line": null,
    "description": "buildApp gained an optional secretStore test hook so testcontainer S3 secrets resolve via SecretReference",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T05:31:09.460Z",
    "resolved_at": null
  },
  {
    "id": 26,
    "kind": "deviation",
    "phase": "04",
    "file": "packages/db/sql/post-migrate.sql",
    "line": null,
    "description": "app.due_attachment_sweeps takes p_now (default now()) in addition to p_limit, for the sweeper's injectable clock",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T05:31:09.529Z",
    "resolved_at": null
  },
  {
    "id": 27,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/api/src/config/env.ts",
    "line": null,
    "description": "OCW_SEARCH_RATE_LIMIT_PER_MINUTE (default 30) added; e2e-isolated.sh raises it to 600 for specs",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T06:11:49.247Z",
    "resolved_at": null
  },
  {
    "id": 28,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/api/src/modules/search/index.ts",
    "line": null,
    "description": "Search routes call markDecided after access.readableIds (request-less filterFor) and share one app.rateLimit handler",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T06:11:49.318Z",
    "resolved_at": null
  },
  {
    "id": 29,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/web/public/emojibase/README.md",
    "line": null,
    "description": "Emoji picker data self-hosted (emojibase-data 17.0.0 en, vendored JSON) instead of frimousse's jsDelivr default",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T06:20:53.647Z",
    "resolved_at": null
  },
  {
    "id": 30,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/web/components/chat/message-actions.tsx",
    "line": null,
    "description": "Hover toolbar hidden on hover:none devices; touch uses the long-press sheet only",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T06:20:53.716Z",
    "resolved_at": null
  },
  {
    "id": 31,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/api/src/modules/chat/saves.ts",
    "line": null,
    "description": "GET /saved marks the request decided after access.readableIds (request-less filterFor) for the strict authz hook",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T06:20:53.784Z",
    "resolved_at": null
  },
  {
    "id": 32,
    "kind": "deviation",
    "phase": "04",
    "file": "packages/contracts/src/chat.ts",
    "line": null,
    "description": "CreateDmRequestFields (route body, max 32) so POST /dms answers too_many_participants after dedupe instead of validation_error",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T07:09:19.504Z",
    "resolved_at": null
  },
  {
    "id": 33,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/api/src/modules/chat/index.ts",
    "line": null,
    "description": "GET /messages/:id/thread now serves DM and group roots to participants (was channel-only); outsiders still 404",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T07:09:19.575Z",
    "resolved_at": null
  },
  {
    "id": 34,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/api/src/modules/chat/dm-privacy.int.test.ts",
    "line": null,
    "description": "Privacy suite links attachments to messages via SQL until 04-12 wires attachments on send; Plan 09 adds the inbox route",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-06T07:09:19.644Z",
    "resolved_at": "2026-10-06T10:22:12.346Z"
  },
  {
    "id": 35,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/web/components/members/member-profile-sheet.tsx",
    "line": null,
    "description": "Message action added to the member profile sheet (not in plan file list)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T07:09:19.714Z",
    "resolved_at": null
  },
  {
    "id": 36,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/web/components/chat/chat-sidebar.tsx",
    "line": null,
    "description": "Unit sections also list unjoined public channels of the member's own units (muted) so new department channels reach members live",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T08:08:43.342Z",
    "resolved_at": null
  },
  {
    "id": 37,
    "kind": "deviation",
    "phase": "04",
    "file": "packages/contracts/src/chat.ts",
    "line": null,
    "description": "Add-only ChannelUnit.pathNames, ChannelList.memberUnitIds, ThreadSummary.lastReplies",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T08:08:43.410Z",
    "resolved_at": null
  },
  {
    "id": 38,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/api/src/modules/agent-channel/index.ts",
    "line": null,
    "description": "Agent channel resource carries the channel's unit path so unit-scoped rules reach bots",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T08:08:43.479Z",
    "resolved_at": null
  },
  {
    "id": 39,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/api/src/modules/chat/index.ts",
    "line": null,
    "description": "conversation.updated with unitId re-decides live conv: subscriptions; #general cannot move; archived PATCH 410",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T08:08:43.546Z",
    "resolved_at": null
  },
  {
    "id": 40,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/api/src/modules/notification/snippet.ts",
    "line": null,
    "description": "Inbox snippets drop Markdown markup (plain one-line text, computed at read time); file not in plan list",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T08:49:18.908Z",
    "resolved_at": null
  },
  {
    "id": 41,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/api/src/modules/chat/index.ts",
    "line": null,
    "description": "@channel/@here limit exempts client retries of an already-posted message; channel.mention_all added to viewerCan",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T08:49:18.977Z",
    "resolved_at": null
  },
  {
    "id": 42,
    "kind": "deviation",
    "phase": "04",
    "file": "e2e/tests/chat-sidebar.spec.ts",
    "line": null,
    "description": "View list assertion updated for Mentions (inserted second by plan)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T08:49:19.050Z",
    "resolved_at": null
  },
  {
    "id": 43,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/api/src/modules/chat/dm-privacy.int.test.ts",
    "line": null,
    "description": "Inbox privacy covered via list checks and a dedicated describe, not routesFor (GET /notifications is a 200 list)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T08:49:19.123Z",
    "resolved_at": null
  },
  {
    "id": 44,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/api/src/modules/chat/index.ts",
    "line": null,
    "description": "moveReadCursor locks the user: stream before counting so conversation.read never overtakes a notification; not_a_member on mark-unread for unjoined channels",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T09:33:56.215Z",
    "resolved_at": null
  },
  {
    "id": 45,
    "kind": "deviation",
    "phase": "04",
    "file": "packages/contracts/src/notifications.ts",
    "line": null,
    "description": "Add-only ConversationReadEvent.latestMessageSeq: clients refetch the snapshot when a conv: frame overtook the counts",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T09:33:56.287Z",
    "resolved_at": null
  },
  {
    "id": 46,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/api/src/modules/chat/threads.ts",
    "line": null,
    "description": "Folded 04-08/04-09 items: ThreadList.unreadThreads over all pages; thread reads clear that thread's notifications",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T09:33:56.356Z",
    "resolved_at": null
  },
  {
    "id": 47,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/api/src/modules/chat/dm-privacy.int.test.ts",
    "line": null,
    "description": "Fixture re-marks Alex's DM notification unread (reading the DM now reads it); privacy assertions unchanged",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T09:33:56.425Z",
    "resolved_at": null
  },
  {
    "id": 48,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/web/components/chat/use-read-cursor.ts",
    "line": null,
    "description": "Shared read-cursor hook (not in plan list): detached windows read only what they show, per-tab hold in sessionStorage, New messages divider on open",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T09:33:56.493Z",
    "resolved_at": null
  },
  {
    "id": 49,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/api/src/modules/artifact/attachments.ts",
    "line": null,
    "description": "04-12: attachment preview/large redirects send CORP cross-origin (Chromium treats IP:port as separate sites; helmet same-site blocked previews)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T10:22:12.419Z",
    "resolved_at": null
  },
  {
    "id": 50,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/web/components/chat/dm-view.tsx",
    "line": null,
    "description": "04-12: DMs with a bot offer no attachments until bots can read files",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T10:22:12.492Z",
    "resolved_at": null
  },
  {
    "id": 51,
    "kind": "deviation",
    "phase": "04",
    "file": "packages/contracts/src/notifications.ts",
    "line": null,
    "description": "decideNotify optional actorKind: a bot's reply in a bot DM pops only on a mention or level all (04-09 open item)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T10:38:03.132Z",
    "resolved_at": null
  },
  {
    "id": 52,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/web/components/chat/chat-sidebar.tsx",
    "line": null,
    "description": "All view count and collapsed sections skip muted rows unless mentioned (same rule as the badge)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T10:38:03.199Z",
    "resolved_at": null
  },
  {
    "id": 53,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/web/components/settings/account-nav.ts",
    "line": null,
    "description": "Settings › Notifications linked as an Account section instead of settings-nav.ts",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T10:38:03.268Z",
    "resolved_at": null
  },
  {
    "id": 54,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/web/components/notifications/os-notifier.tsx",
    "line": null,
    "description": "OsNotifier shares the sidebar's user: cursor (GET /channels userSeq), applies notification_prefs.updated app-wide, skips pop-ups older than 10 minutes",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T10:38:03.340Z",
    "resolved_at": null
  },
  {
    "id": 55,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/desktop/e2e/smoke.e2e.ts",
    "line": null,
    "description": "Smoke bridge key list gains setBadgeCount plus a badge round trip (not in plan list)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T10:38:03.410Z",
    "resolved_at": null
  },
  {
    "id": 56,
    "kind": "deviation",
    "phase": "04",
    "file": "apps/web/components/chat/attachments/lightbox.tsx",
    "line": null,
    "description": "04-13: lightbox backdrop forceRender (Base UI skips nested dialog backdrops; phone thread is a sheet)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T12:07:47.641Z",
    "resolved_at": null
  },
  {
    "id": 57,
    "kind": "deviation",
    "phase": "04",
    "file": "e2e/tests/work-zone-title.spec.ts",
    "line": null,
    "description": "04-13: tab-title assertions accept the 04-11 unread-count prefix",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T12:07:47.711Z",
    "resolved_at": null
  },
  {
    "id": 58,
    "kind": "deviation",
    "phase": "04",
    "file": "e2e/tests/search.spec.ts",
    "line": null,
    "description": "04-13: palette bot found by 'sammy'; 'sam' overflows the 5-person overview on a shared stack",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T12:07:47.779Z",
    "resolved_at": null
  },
  {
    "id": 59,
    "kind": "todo",
    "phase": "04",
    "file": "apps/web/components/chat/views/threads-view.tsx",
    "line": null,
    "description": "04-13 review: Threads view cards render @mentions as plain text (no MentionContext)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T12:07:47.849Z",
    "resolved_at": null
  },
  {
    "id": 60,
    "kind": "todo",
    "phase": "04",
    "file": "apps/web/components/chat/message-list.tsx",
    "line": null,
    "description": "04-13 review: (edited) marker on its own line instead of inline",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T12:07:47.918Z",
    "resolved_at": null
  },
  {
    "id": 61,
    "kind": "todo",
    "phase": "04",
    "file": "e2e/tests/attachments.spec.ts",
    "line": null,
    "description": "04-13 review: capture upload progress mid-flight with a throttled route",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T12:07:47.987Z",
    "resolved_at": null
  },
  {
    "id": 62,
    "kind": "unrun-verify",
    "phase": "04",
    "file": "apps/desktop/src/main/index.ts",
    "line": null,
    "description": "Signed-build notification click-to-focus and dock badge remain manual checks (Pitfall 11)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T12:07:48.055Z",
    "resolved_at": null
  },
  {
    "id": 63,
    "kind": "deviation",
    "phase": "05",
    "file": "e2e/tests/ai-chat-signin.spec.ts",
    "line": null,
    "description": "Disconnect e2e asserts plan rows via GET /ai-chat/models, and signin.int 'org rows stay available' is vacuous until 05-04's picker and org keys merge; tighten both after the 05-04 merge",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T18:13:56.172Z",
    "resolved_at": null
  },
  {
    "id": 64,
    "kind": "unrun-verify",
    "phase": "05",
    "file": "apps/desktop/src/main/chatgpt-loopback.ts",
    "line": null,
    "description": "Real desktop build: Continue with ChatGPT through the system browser and the 127.0.0.1 listener against auth.openai.com (human-check, 05-15 owner check)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-06T18:58:18.983Z",
    "resolved_at": null
  },
  {
    "id": 65,
    "kind": "deviation",
    "phase": "05",
    "file": "apps/api/src/modules/ai-chat/service.ts",
    "line": null,
    "description": "05-12: abandoned AI chat drafts remain as hidden empty chats (no sweeper); their unsent uploads are swept after 24 h",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-07T01:48:18.761Z",
    "resolved_at": null
  },
  {
    "id": 66,
    "kind": "deviation",
    "phase": "05",
    "file": "apps/api/src/modules/ai-chat/shares.ts",
    "line": null,
    "description": "05-13: every share view writes an ai_chat.share_viewed audit row (no dedupe window)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-07T02:35:52.102Z",
    "resolved_at": null
  },
  {
    "id": 67,
    "kind": "unrun-verify",
    "phase": "05",
    "file": "docs/adr/0017-sign-in-with-chatgpt-per-member.md",
    "line": null,
    "description": "Owner manual check on the demo: real Sign in with ChatGPT by paste and from the desktop app, one plan turn with Stop, Business/Enterprise eligibility, visual review of 05-UI-REVIEW.md (05-VALIDATION manual rows)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-07T05:51:33.527Z",
    "resolved_at": null
  },
  {
    "id": 68,
    "kind": "deviation",
    "phase": "05",
    "file": "apps/api/src/modules/identity/authenticate.ts",
    "line": null,
    "description": "Phase 1-4 routes run requireUser as preHandler: an anonymous malformed body gets 400 before 401 (AI routes fixed in 05-15; see 05 deferred-items.md)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-07T05:51:33.597Z",
    "resolved_at": null
  },
  {
    "id": 69,
    "kind": "deviation",
    "phase": "05",
    "file": "apps/api/src/app.ts",
    "line": null,
    "description": "API request logs include query strings (search terms from GET /search?q=); add a serializer that redacts them (05 deferred-items.md)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-07T05:51:33.668Z",
    "resolved_at": null
  }
]
````
