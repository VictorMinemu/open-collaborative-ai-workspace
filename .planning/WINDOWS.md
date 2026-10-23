---
schema_version: 1
open_count: 169
waived_count: 5
fixed_count: 134
total_count: 308
last_updated: 2026-10-23T03:52:58.614Z
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
| 70 | 06 | unrun-verify | apps/openclaw-channel/src/mention-mapper.ts |  | 06-10 ai_chat persona delivery (flat, per-mention session, withheld block, gate refusal) not yet proven in a real OpenClaw cell (CI cell-smoke unavailable) | open |  | 2026-10-07T10:45:46.645Z |  |
| 71 | 06 | deviation | apps/api/src/modules/notification/service.ts |  | 06-13 card_updated notifies a follower only on a card's first status change (one notification row per user+message; later changes do not re-notify) | open |  | 2026-10-07T11:15:43.269Z |  |
| 72 | 06 | unrun-verify | infra/openclaw/test/run-container-smoke.sh |  | 06-14 cell-smoke scenario card (ocw_agent_card create/update, agent.card_action.v1 turn) not yet run in a real OpenClaw cell; e2e specs updated for ocw_agent_card not run | open |  | 2026-10-07T11:45:56.476Z |  |
| 73 | 06 | unrun-verify | .planning/phases/06-multiplayer-ai-chat/06-16-PLAN.md |  | 06-16 Task 3: metered spoofing eval and OpenAI ChatGPT-plan terms check not run (eval deferred, human_needed) | open |  | 2026-10-07T15:33:04.842Z |  |
| 74 | 06 | deviation | apps/api/src/modules/chat/index.ts |  | Phase 4 chat routes authenticate in preHandler: anonymous malformed bodies get 400 before 401 (card routes fixed in 06-16) | open |  | 2026-10-07T15:33:04.922Z |  |
| 75 | 06 | deviation | apps/web/components/bots/add-to-channel-dialog.tsx |  | Add to channel lists channels where the caller gets 403; bots.spec now picks #general | open |  | 2026-10-07T15:33:04.995Z |  |
| 76 | 06.1 | deviation | apps/api/src/modules/work-session/images.int.test.ts |  | attachment_not_linkable acceptance grep is 3 (<6); rejection matrix is table-driven | open |  | 2026-10-07T17:14:33.250Z |  |
| 77 | 06.1 | deviation | packages/contracts/src/work-session.ts |  | WorkPrompt.attachments is in upload order, not request order; 06.1-02 must dispatch in request order | fixed |  | 2026-10-07T17:14:33.320Z | 2026-10-07T18:10:28.424Z |
| 78 | 06.1 | deviation | apps/local-runtime/src/codex/codex-runtime.ts |  | Codex turn/start error surfaces as session.error + failed prompt.completed, not a prompt() rejection (plan said reject) | open |  | 2026-10-07T17:48:58.224Z |  |
| 79 | 06.1 | deviation | apps/local-runtime/src/codex |  | Synthetic Codex image fixture reuses recorded initialize/thread/start lines | open |  | 2026-10-07T17:48:58.298Z |  |
| 80 | 06.1 | deviation | packages/db |  | 06.1-02 added migration work_prompt_image_order outside its files_modified (needed for request order) | open |  | 2026-10-07T18:10:28.511Z |  |
| 81 | 06.1 | unmet-truth | apps/api/src/modules/work-session/turn-mode.int.test.ts |  | One standalone turn-mode.int run failed in beforeAll with no captured cause; 9 reruns passed (unconfirmed flake) | open |  | 2026-10-07T18:10:28.587Z |  |
| 82 | 06.1 | deviation | e2e/tests/work-zone-images.spec.ts |  | Task 2 e2e written before implementation but not run red on its own | open |  | 2026-10-07T19:02:07.423Z |  |
| 83 | 06.1 | unrun-verify | apps/web/components/work-zone/composer.tsx |  | Real Ctrl+V on a non-macOS host not run (paste event is key-agnostic) | open |  | 2026-10-07T19:02:07.493Z |  |
| 84 | 06.1 | deviation | apps/web/components/chat/attachment-grid.tsx |  | attachment-grid.tsx changed outside files_modified (optional className) | open |  | 2026-10-07T19:02:07.565Z |  |
| 85 | 06.1 | unrun-verify | .planning/phases/06.1-work-zone-image-attachments/06.1-05-PLAN.md |  | 06.1-05 Task 3 real-runtime image check (Claude Code, Codex) deferred, human_needed | open |  | 2026-10-07T21:32:00.387Z |  |
| 86 | 06.1 | deviation | apps/api/src/lib/redis.ts |  | Gate fixed a Phase 1 realtime subscribe/unsubscribe race outside files_modified (redis.int.test.ts) | open |  | 2026-10-07T21:32:00.457Z |  |
| 87 | 06.1 | deviation | apps/web/components/search/search-palette.tsx |  | Gate fixed a Phase 4 search palette focus defect outside files_modified | open |  | 2026-10-07T21:32:00.531Z |  |
| 88 | 07 | unmet-truth | apps/api/src/realtime-presence.int.test.ts |  | Rate-limit presence test (line ~430) flaky under load; failed once while a parallel dump ran, 9/9 alone | open |  | 2026-10-08T00:51:08.081Z |  |
| 89 | 07 | deviation | apps/api/src/app.ts |  | trustProxy wired through fastifyTrustProxy() (Fastify fails closed on numeric trustProxy); plan grep differs | open |  | 2026-10-08T01:09:05.045Z |  |
| 90 | 07 | deviation | scripts/guard |  | claude-agent-sdk license exception and server-everything license clarification pending owner/legal confirmation (D-14, ADR-0021) | open |  | 2026-10-08T01:18:30.440Z |  |
| 91 | 07 | deviation | compose.yaml |  | Garage has no healthcheck: compose --wait does not wait for it (backup gate retries 60s after recreate) | open |  | 2026-10-08T02:11:23.801Z |  |
| 92 | 07 | deviation | compose.yaml |  | docker compose start also reruns the one-shot migrate service (idempotent) | open |  | 2026-10-08T02:11:23.891Z |  |
| 93 | 07 | deviation | compose.yaml |  | With OCW_TRUST_PROXY=1 a process on the host or the compose network can still forge X-Forwarded-For; closing it needs a fixed Caddy IP/subnet | open |  | 2026-10-08T02:29:43.449Z |  |
| 94 | 07 | deviation | compose.yaml |  | API has no depends_on openbao in vault mode: a cold start may exit once and retry | open |  | 2026-10-08T02:33:44.398Z |  |
| 95 | 07 | unmet-truth | scripts/ocw/backup.mjs |  | ocw backup omits the openbao-data volume and secrets/ when the vault profile is on; a restore would not boot (fix in 07-10/07-11) | fixed |  | 2026-10-08T02:33:44.475Z | 2026-10-08T04:16:52.638Z |
| 96 | 07 | unrun-verify | scripts/gate/compose-gate.mjs |  | gate:compose default (short) variant and --steps playwright alone not run separately; covered by the full run | open |  | 2026-10-08T04:16:52.709Z |  |
| 97 | 07 | deviation | scripts/ocw/backup.mjs |  | Backup omits caddy-data: a restore on fresh volumes gives Caddy a new local CA | open |  | 2026-10-08T04:16:52.781Z |  |
| 98 | 07 | unmet-truth | docs/INSTALL.md |  | Owner clean-machine install on real hardware deferred (human_needed), incl. Linux check of OpenBao capabilities | open |  | 2026-10-08T05:06:11.267Z |  |
| 99 | 07 | deviation | scripts/ocw/backup.mjs |  | A vault-enabled backup contains the OpenBao seal key; as sensitive as .env (documented) | open |  | 2026-10-08T05:06:11.340Z |  |
| 100 | 07.3 | deviation | apps/web/components/settings/account-nav |  | AI chat account entry hidden only when the permission is decided off (P-08), not via can() | open |  | 2026-10-10T01:03:30.376Z |  |
| 101 | 07.3 | deviation | apps/web/components/organization/unit-modules-card.tsx |  | Read-only reason reads the member's role for copy only; edit rights still come from canEdit | open |  | 2026-10-10T01:03:30.449Z |  |
| 102 | 07.3 | unmet-truth | apps/api/src/modules/agent-channel |  | Proactive agent messages and queued AI chat prompts are not re-decided against module rules (07.6/07.7 scope) | open |  | 2026-10-10T01:03:30.526Z |  |
| 103 | 07.1 | deviation | apps/api/src/modules/chat/board |  | Possible deadlock: DELETE /messages on a card root racing a card text edit can abort one (500); delete should take the stream lock first | fixed |  | 2026-10-12T13:51:08.419Z | 2026-10-12T21:23:03.467Z |
| 104 | 07.1 | deviation | apps/api/src/modules/chat/board/access.ts |  | A card create with @channel and an invalid columnId spends the channel's per-minute mention slot before the 400 (claim happens before column validation) | fixed |  | 2026-10-12T13:53:16.172Z | 2026-10-12T21:23:03.542Z |
| 105 | 07.1 | unrun-verify | apps/api/src/modules/chat/board/routes.ts |  | Card PATCH does not pass the new body to writableBoard: confirm in 07.1-14 that edits never broadcast @channel (as generic message edits) or gate them with channel.mention_all | fixed |  | 2026-10-12T13:53:16.261Z | 2026-10-12T21:23:03.617Z |
| 106 | 07.1 | deviation | apps/web/app/globals.css |  | Dark mode: white text on the primary colour is 3.44:1 (< 4.5:1 AA) on every enabled primary button; fix the dark primary token in 07.1-14 with before/after screenshots | fixed |  | 2026-10-12T15:31:56.286Z | 2026-10-12T21:23:03.688Z |
| 107 | 07.1 | deviation | packages/realtime-client |  | A dead socket the browser does not report is still not detected (no pong timeout) | open |  | 2026-10-12T15:37:41.294Z |  |
| 108 | 07.1 | deviation | apps/openclaw-channel/src/turn-scoped-tools.ts |  | ocw_board_card alsoAllow lives in the plugin reconciler (a bot's own alsoAllow overrides the global one in OpenClaw 2026.9.7) | waived | By design, recorded in ADR-0022 | 2026-10-12T17:15:54.121Z | 2026-10-12T21:23:03.760Z |
| 109 | 07.1 | deviation | apps/openclaw-channel/src/board-tool.ts |  | Agents can move/set waiting only on the thread's card or cards they created in this conversation (board read returns only the thread card version) | waived | By design, recorded in ADR-0022 | 2026-10-12T17:15:54.192Z | 2026-10-12T21:23:03.829Z |
| 110 | 07.1 | deviation | apps/web/app/globals.css |  | Dark destructive buttons (white on --destructive oklch(0.66 0.2 22)) measure ~3.3:1 (< 4.5:1 AA); same fill/text split as primary fixes it | fixed |  | 2026-10-12T21:23:03.898Z | 2026-10-12T22:27:16.906Z |
| 111 | 07.1 | deviation | apps/web/components/chat/board/card-strip.tsx |  | A card with a typed title and empty description shows an empty root message body in its thread (author and time only) | fixed |  | 2026-10-12T21:23:03.967Z | 2026-10-12T22:27:16.978Z |
| 112 | 07.1 | deviation | e2e/tests/search.spec.ts |  | Composer-focus regression e2e was not RED on the pre-fix build; fix rests on run-1 evidence, a focus probe and a unit test | open |  | 2026-10-12T21:23:04.036Z |  |
| 113 | 07.1 | deviation | apps/web/components/chat/channel-view.tsx |  | Board Messages view: a card root beyond the first 100 cards of its column is not cached, so Edit message falls back to the inline editor (400 board_card_use_board) | fixed |  | 2026-10-12T21:23:04.109Z | 2026-10-12T22:27:17.051Z |
| 114 | 07.2 | deviation | packages/contracts/src/memory.ts |  | Folder rule pathPrefix is accepted by the contract but dropped by the API until 07.2-03; an allow memory.write on hr/ would apply to the whole scope meanwhile; must close before the phase merges | fixed |  | 2026-10-13T03:20:41.553Z | 2026-10-13T04:39:31.651Z |
| 115 | 07.2 | deviation | apps/web/components/shell/module-gate.tsx |  | Settings > Modules shows a Memory toggle with no memory UI until 07.2-10; screenshot the 4-row panel in 10/13 | fixed |  | 2026-10-13T03:20:41.625Z | 2026-10-13T07:35:47.237Z |
| 116 | 07.2 | deviation | packages/db/src/schema/memory.ts |  | approval_requests has no personal-owner column: an admin with direct SQL can see that an approval for a personal proposal exists (metadata, not content); decide in 07.2-06 | waived | API owner-only visibility proven by test; no RLS by design (ADR-0023 decision 16) | 2026-10-13T03:45:07.675Z | 2026-10-13T04:50:57.537Z |
| 117 | 07.2 | deviation | packages/db/src/schema/memory.ts |  | Personal bot notebook owner assumes a personal bot never changes owner or kind; recompute the owner if that ever changes | open |  | 2026-10-13T03:45:07.777Z |  |
| 118 | 07.2 | deviation | packages/db/src/schema/memory.ts |  | A file moved across scopes keeps old revisions with the previous owner (conservative); 07.2-08 must account for it | fixed |  | 2026-10-13T03:45:07.876Z | 2026-10-13T05:47:46.872Z |
| 119 | 07.2 | deviation | apps/api/src/modules/policy/module-access-enforcement.int.test.ts |  | testcontainers Redis port wait can time out under Docker load and fail verify once | open |  | 2026-10-13T03:45:07.976Z |  |
| 120 | 07.2 | deviation | compose.yaml |  | The internal pii network is created by every compose project even with the profile off (uses Docker address pools); adding it recreates the api once on the next up | waived | One internal network per stack is the accepted cost (D-08); the dev host had 30 networks from dead per-branch projects, cleaned to 16 | 2026-10-13T04:19:12.931Z | 2026-10-13T15:20:56.912Z |
| 121 | 07.2 | unrun-verify | infra/presidio/recognizers.yaml |  | Spanish Presidio accuracy only checked on fixed samples (missed a Spanish name in a probe); owner manual check on real documents | open |  | 2026-10-13T04:19:13.026Z |  |
| 122 | 07.2 | deviation | scripts/ocw.mjs |  | No pnpm ocw enable pii: turning on the pii profile means editing .env by hand, unlike other profiles | open |  | 2026-10-13T04:19:13.134Z |  |
| 123 | 07.2 | deviation | apps/openclaw-channel/src/memory-files-tool.ts |  | /memory/* Agent Channel routes exist only in the fake API until 07.2-11; the real API would 404 (no turn offers the tools yet) | fixed |  | 2026-10-13T04:30:05.478Z | 2026-10-13T07:15:00.114Z |
| 124 | 07.2 | deviation | infra/openclaw |  | No memory scenario in the real-cell smoke yet; add it in 07.2-15 | fixed |  | 2026-10-13T04:30:05.563Z | 2026-10-13T15:20:09.715Z |
| 125 | 07.2 | deviation | apps/openclaw-channel/src/agent-channel-protocol.ts |  | memoryFiles mirror uses the exact scopeKind enum: a new API scopeKind silently drops all files and falls back to legacy notes until the mirror is updated | open |  | 2026-10-13T04:30:05.650Z |  |
| 126 | 07.2 | deviation | packages/contracts/src/sensitive-data.ts |  | detectSensitive returns unbounded spans while MemoryProposalView caps 200 spans / 50 findings; 07.2-09 must cap before building the view | fixed |  | 2026-10-13T04:39:23.084Z | 2026-10-13T06:30:45.615Z |
| 127 | 07.2 | deviation | packages/contracts/src/sensitive-data.ts |  | False positives (warn): any bare 9-digit number starting 6-9 is a phone; git@github.com:org/repo is an email; Luhn accepts 0000 0000 0000 0000 | open |  | 2026-10-13T04:39:23.163Z |  |
| 128 | 07.2 | deviation | packages/contracts/src/sensitive-data.ts |  | Keyed secrets (DB_PASSWORD=, Bearer, URL credentials): span and masked sample start at the key, so the UI highlight is wider than the value (no leak) | open |  | 2026-10-13T04:39:23.242Z |  |
| 129 | 07.2 | deviation | apps/api/src/modules/policy |  | unit_has_memory counts only live files; soft-deleted files and pending proposals cascade with the unit; decide in 07.2-08/09 | fixed |  | 2026-10-13T04:39:31.734Z | 2026-10-13T05:47:47.036Z |
| 130 | 07.2 | deviation | apps/api/src/modules/policy |  | A standard owner of a team bot can write its notebook but not promote (memory.promote is lead/admin); needs an explicit product exception if wanted | open |  | 2026-10-13T04:39:31.819Z |  |
| 131 | 07.2 | deviation | apps/api/src/modules/policy |  | An agent decision with no human evaluates only the agent; 07.2-08 and 07.2-11 must always pass the human the agent acts for | fixed |  | 2026-10-13T04:39:31.902Z | 2026-10-13T05:47:46.953Z |
| 132 | 07.2 | deviation | apps/api/src/modules/approval |  | Decisions mirrored onto a card do not send the usual card-updated notification to its followers | open |  | 2026-10-13T04:50:57.608Z |  |
| 133 | 07.2 | deviation | apps/api/src/modules/approval |  | Inbox list checks each row's decider rule one by one (up to 500 per page), so a page can come back short with a cursor | fixed |  | 2026-10-13T04:50:57.677Z | 2026-10-13T09:48:45.635Z |
| 134 | 07.2 | deviation | apps/api/src/modules/approval |  | An apply that throws (instead of returning an error code) rolls back the whole decision and leaves the request pending | open |  | 2026-10-13T04:50:57.748Z |  |
| 135 | 07.2 | deviation | apps/api/src/modules/approval |  | An approved grant's card shows succeeded before the grant is used; decide in 07.5 | fixed |  | 2026-10-13T04:50:57.827Z | 2026-10-14T15:04:59.179Z |
| 136 | 07.2 | deviation | packages/db/src/schema |  | The DB still allows changing a memory file's scope_id; moving across scopes is prevented only in the API | fixed |  | 2026-10-13T05:47:47.110Z | 2026-10-13T10:56:27.250Z |
| 137 | 07.2 | deviation | apps/api/src/modules/memory |  | Pending proposals cascade with unit/bot/forgotten scope but their approval_requests rows stay; 07.2-09 must read a missing proposal as scope_gone, not 500 | fixed |  | 2026-10-13T05:47:47.183Z | 2026-10-13T06:30:45.684Z |
| 138 | 07.2 | deviation | apps/api/src/modules/memory |  | A deleted memory file cannot be restored over REST (restore works only on live files) | open |  | 2026-10-13T05:47:47.259Z |  |
| 139 | 07.2 | deviation | apps/api/src/modules/memory |  | GET /memory/scopes writes: it lazily creates the org scope and missing unit scopes | open |  | 2026-10-13T05:47:47.334Z |  |
| 140 | 07.2 | deviation | apps/api/src/modules/memory |  | A 256 KiB body of escaped control chars exceeds Fastify's 1 MiB limit and returns Fastify's 413, not memory_file_too_large | fixed |  | 2026-10-13T05:47:47.411Z | 2026-10-13T10:56:27.416Z |
| 141 | 07.2 | deviation | apps/api/src/modules/memory/search.ts |  | Memory search loads every readable file's content (listReadableFiles) per scope just to get ids, calls listScopes (which writes) and one permission pass per scope; heavy at scale — select ids only | fixed |  | 2026-10-13T06:29:37.690Z | 2026-10-13T10:56:27.012Z |
| 142 | 07.2 | deviation | apps/api/src/modules/memory/search.ts |  | Snippet highlighting scans full content: up to 50 files x 3 configs x 256 KiB per search | fixed |  | 2026-10-13T06:29:37.759Z | 2026-10-13T10:56:27.087Z |
| 143 | 07.2 | deviation | apps/api/src/modules/memory/search.ts |  | Path-only matches return an unmarked snippet; snippet helpers are duplicated from the chat search module | fixed |  | 2026-10-13T06:29:37.838Z | 2026-10-13T07:35:47.307Z |
| 144 | 07.2 | deviation | apps/api/src/modules/approval |  | A proposal that disappears in a cascade leaves its approval request and card pending (fail-closed) until 14-day expiry; needs a 'gone' hook in the primitive to close it as failed/scope_gone | fixed |  | 2026-10-13T06:30:45.754Z | 2026-10-13T10:56:26.855Z |
| 145 | 07.2 | deviation | apps/api/src/modules/memory/proposals.ts |  | Presidio runs inside the proposal transaction: up to 2 s holding the connection and advisory lock | fixed |  | 2026-10-13T06:30:45.823Z | 2026-10-13T10:56:26.934Z |
| 146 | 07.2 | deviation | apps/api/src/modules/memory/proposals.ts |  | canDecide and audience are expensive per row (audience calls usersAllowed over all members); related to #133 | open |  | 2026-10-13T06:30:45.892Z |  |
| 147 | 07.2 | deviation | apps/api/src/modules/memory/proposals.ts |  | Proposal view spans are layer 1 only (Presidio spans not stored; findings shown per line); requestedBy.agent is required, 07.6 will need it nullable | open |  | 2026-10-13T06:30:45.960Z |  |
| 148 | 07.2 | deviation | apps/api/src/modules/agent-channel/memory-files.ts |  | Agent memory list/read count against the turn limit only in the /tool-calls gate; the route does not check it | fixed |  | 2026-10-13T07:15:00.193Z | 2026-10-13T10:56:27.168Z |
| 149 | 07.2 | deviation | apps/api/src/modules/agent-channel/memory-files.ts |  | Agent memory list costs one decision per file; each memory turn queries the bot notebook and decides twice in a DM (related to #139) | open |  | 2026-10-13T07:15:00.266Z |  |
| 150 | 07.2 | unrun-verify | e2e/tests/bot-memory.spec.ts |  | bot-capabilities.spec and bot-memory.spec not run after 07.2-11; the fake API never answers no_trigger, the 07.2-15 smoke should cover an expired-turn call | fixed |  | 2026-10-13T07:15:00.344Z | 2026-10-13T15:20:09.783Z |
| 151 | 07.2 | deviation | packages/db/src/schema |  | app.agent_memories is now dead data (notes live in the private MEMORY.md); dropping it needs a later migration once the backfill has been in production | open |  | 2026-10-13T07:15:00.428Z |  |
| 152 | 07.2 | deviation | apps/api/src/modules/bot-capabilities/memory.ts |  | Legacy notes share one createdAt (file mtime); a note refused for a secret reaches the model as 'not accepted' with no reason | open |  | 2026-10-13T07:15:00.503Z |  |
| 153 | 07.2 | deviation | apps/web/components/memory |  | The Proposals row links to /memory/proposals (built by 07.2-13, not-found until then) and on mobile shows for everyone, while the UI-SPEC limits it to deciders and proposers | fixed |  | 2026-10-13T07:35:47.377Z | 2026-10-13T09:48:45.555Z |
| 154 | 07.2 | deviation | apps/web/components/markdown |  | axe heading-order (moderate) in the memory viewer: Markdown # renders as h3 under the breadcrumb h1; fix in the shared renderer | fixed |  | 2026-10-13T07:35:47.448Z | 2026-10-13T11:20:21.727Z |
| 155 | 07.2 | deviation | apps/web/components/organization |  | Settings > Modules copy still says 'Work Zone, AI chats and bots' and does not name Memory; memory dates show '3 hours ago' instead of the spec's '3h ago' | fixed |  | 2026-10-13T07:35:47.519Z | 2026-10-13T11:20:21.869Z |
| 156 | 07.2 | deviation | apps/web/components/memory |  | Revisions do not carry who approved them, so history shows 'Approved proposal' instead of 'Approved by {person}' | fixed |  | 2026-10-13T08:49:37.424Z | 2026-10-13T09:48:45.713Z |
| 157 | 07.2 | deviation | apps/web/lib/memory-queries.ts |  | Team memory files do not update live: memory.changed reaches only the owner of private memory | fixed |  | 2026-10-13T08:49:37.498Z | 2026-10-13T10:56:27.500Z |
| 158 | 07.2 | deviation | apps/web/components/memory |  | History paginates on the client (API returns all revisions); a file saved without a trailing newline shows an extra empty line in the diff | open |  | 2026-10-13T08:49:37.571Z |  |
| 159 | 07.2 | deviation | apps/web/package.json |  | lang-markdown pulls HTML/CSS/JS modes into the editor bundle; Cmd/Ctrl+S label uses deprecated navigator.platform | open |  | 2026-10-13T08:49:37.641Z |  |
| 160 | 07.2 | deviation | apps/api/src/modules/approval |  | The live card event is emitted before the card is linked to its approval (client works around it); the server should emit message.updated after linking. Expiry does not arrive live (card stays Pending until reload) | fixed |  | 2026-10-13T08:49:54.347Z | 2026-10-13T09:48:45.787Z |
| 161 | 07.2 | deviation | apps/web/components/ui/dialog.tsx |  | The shared Dialog close X is 32 px below 1024 (UI-SPEC asks 44) | fixed |  | 2026-10-13T08:49:54.419Z | 2026-10-13T11:20:21.799Z |
| 162 | 07.2 | deviation | e2e/tests/memory-files.spec.ts |  | memory-files.spec depends on run order: it expects exact scopes for Sam and breaks once other specs leave private scopes of Sam in the shared DB | fixed |  | 2026-10-13T09:44:33.028Z | 2026-10-13T11:20:21.651Z |
| 163 | 07.2 | deviation | apps/api/src/modules/memory |  | Private scopes of deleted bots still appear in /memory/scopes; the bot page waits for the full GET /agents list (no useAgent(id)) | fixed |  | 2026-10-13T09:44:33.110Z | 2026-10-13T10:56:27.334Z |
| 164 | 07.2 | deviation | apps/api/src/modules/memory/approval-kind.ts |  | Bot delete is soft, so its pending memory proposals stay live and a lead can approve them; the server would write on behalf of a deleted bot | fixed |  | 2026-10-13T09:48:45.861Z | 2026-10-13T10:56:26.772Z |
| 165 | 07.2 | deviation | apps/web/components/memory |  | 'No sensitive data found' next to 'Extended scan unavailable' can read as reassuring; review-memory-scopes-390 screenshot from 07.2-10 is stale (shows the now-hidden Proposals row) | fixed |  | 2026-10-13T09:48:45.937Z | 2026-10-13T11:20:21.939Z |
| 166 | 07.2 | deviation | apps/api/src/modules/approval |  | Requests orphaned before the gone path stay pending until expiry (no sweep); if removing a member ever cascades their personal scopes, that path does not call closeGone | open |  | 2026-10-13T10:56:27.581Z |  |
| 167 | 07.2 | deviation | apps/api/src/modules/memory |  | memory.changed: a rename only notifies readers of the new path; unit-scope writes emit one event per reader (a unit: topic would scale better); no e2e for live team-file updates | open |  | 2026-10-13T10:56:27.664Z |  |
| 168 | 07.2 | deviation | apps/api/src/modules/agent-channel |  | Stored cell stream events keep private memory content (turn payloads) and forgetting a scope does not purge them | open |  | 2026-10-13T15:20:09.851Z |  |
| 169 | 07.4 | deviation | packages/db/src/schema/app.ts |  | Cross-org ids: 07.4 FKs check ids only (RLS bypassed), so a row can reference another org's server/key/agent/template; the API must resolve every id inside withTenant (same pattern as bot_tool_grants) | fixed |  | 2026-10-13T22:54:38.207Z | 2026-10-14T08:44:37.392Z |
| 170 | 07.4 | deviation | packages/db/src/schema/app.ts |  | No owner-only restrictive DB policy on personal keys or member connector connections (only tenant isolation); enforce owner-only in the API (07.4-07/10) and add a restrictive policy before the gate, as 07.2 did for personal memory | fixed |  | 2026-10-13T22:54:38.296Z | 2026-10-14T02:33:13.571Z |
| 171 | 07.4 | deviation | packages/db/src/schema/app.ts |  | Template versions are immutable only in the API (no trigger); share resource_id has no FK so deleting a connector or key leaves an inert share row | fixed |  | 2026-10-13T22:54:38.389Z | 2026-10-14T00:55:32.808Z |
| 172 | 07.4 | deviation | packages/db/src/schema/app.ts |  | vault_items.secret_ref accepts env/file/openbao providers in the DB; D-07 db-only must be enforced by the API; SecretsService.putSealed must accept connector_credential and vault_item (07.4-07/10) | fixed |  | 2026-10-13T22:54:38.476Z | 2026-10-14T00:13:09.654Z |
| 173 | 07.4 | deviation | infra/fake-model/fake-mcp-oauth.mjs |  | The fake shares DCR/CIMD clients across issuers (main and alt); 07.4-10 must prove in the API that client credentials are never reused across issuers; default cimdFetch never runs in tests | fixed |  | 2026-10-13T22:56:12.635Z | 2026-10-14T00:13:21.114Z |
| 174 | 07.4 | deviation | .planning/phases/07.4-per-member-connectors-agent-keychain-and-templates/07.4-VALIDATION.md |  | Plans and VALIDATION use 'node --test infra/fake-model/' which Node 24 treats as a file; use the glob form | fixed |  | 2026-10-13T22:56:12.721Z | 2026-10-14T04:20:55.677Z |
| 175 | 07.4 | deviation | apps/api/src/lib/egress.ts |  | MCP SDK OAuth helpers and transports fall back to global fetch without fetchFn and no rule catches the missing argument; every 07.4 SDK call must pass egress.bound(policy) (check in 07.4-10/11 and the gate) | fixed |  | 2026-10-13T22:56:48.885Z | 2026-10-14T02:33:13.785Z |
| 176 | 07.4 | deviation | apps/api/src/lib/egress.ts |  | One undici Agent per request (no keep-alive reuse); privateAllow tested only up to the connect attempt | open |  | 2026-10-13T22:56:48.969Z |  |
| 177 | 07.4 | deviation | packages/contracts/src/module-access.ts |  | HIGH: units/orgs with Bots already off hold the old 5 deny rules; the catalog now has 7, so the API reads them as custom and does not deny connector.connect / vault.use until Bots is toggled again; needs a backfill migration | fixed |  | 2026-10-13T23:06:14.969Z | 2026-10-14T08:44:36.959Z |
| 178 | 07.4 | deviation | packages/contracts/src/mcp.ts |  | memberHeaderName is not checked against forbidden headers in the schema (import cycle); 07.4-06 and 07.4-10 must apply isAllowedInjectionHeader() on the server | fixed |  | 2026-10-13T23:06:15.041Z | 2026-10-14T00:54:30.968Z |
| 179 | 07.4 | deviation | apps/api/src/modules/mcp |  | CIMD is chosen even when the AS cannot read the document (e.g. internal CA); 07.4-10 must allow preferring DCR or pre-registration; servers without RFC 9728 metadata cannot be connected per member | fixed |  | 2026-10-14T00:00:48.322Z | 2026-10-14T02:33:13.713Z |
| 180 | 07.4 | deviation | apps/api/src/modules/mcp |  | No positive SSE round-trip test (fake speaks only streamable HTTP); MCP session not closed with DELETE after a timeout; revokeToken Basic-encodes client id/secret (SDK does not) | open |  | 2026-10-14T00:00:48.417Z |  |
| 181 | 07.4 | deviation | apps/api/src/modules/keychain |  | OAuth keychain token URLs must be https but the e2e fake on :4291 is http; 07.4-13/14 need an https fake or a test-host exemption | open |  | 2026-10-14T00:13:09.756Z |  |
| 182 | 07.4 | deviation | packages/db/sql/post-migrate.sql |  | agent_vault_grants has no owner-only policy: grants on personal keys (ids only) are visible to any session in the org | fixed |  | 2026-10-14T00:13:09.855Z | 2026-10-14T08:44:37.030Z |
| 183 | 07.4 | deviation | apps/api/src/modules/keychain |  | 07.4-11 must run keychain use with the turn's human as the RLS user (never no user or another member); CODEOWNERS does not cover modules/keychain; client-credentials token cache is per process (not in an ADR) | fixed |  | 2026-10-14T00:13:09.951Z | 2026-10-14T02:01:27.888Z |
| 184 | 07.4 | deviation | apps/openclaw-channel/src/connector-tools.ts |  | 07.4-11 must put the three static tool names (never logical m…__tool names) in the /cell snapshot alsoAllow; only a 20 s connector call was proven in the real cell (add a 30 s case to the ADR-0025 checklist); tool descriptions from ocw_connector_list do not taint the turn | fixed |  | 2026-10-14T00:27:30.749Z | 2026-10-14T02:01:27.974Z |
| 185 | 07.4 | deviation | infra/openclaw/test/run-container-smoke.sh |  | Without SMOKE_BUILD the marketplace scenario fails on macOS Docker Desktop (docker cp leaves install-policy.mjs as uid 501); CI unaffected | open |  | 2026-10-14T00:27:30.826Z |  |
| 186 | 07.4 | deviation | packages/db/sql/post-migrate.sql |  | If #170 adds an owner-only policy on connector_connections, the admin member count and clear-on-switch/delete will only see the admin's rows and leave other members' credentials behind silently; that policy needs an mcp.manage path (07.4-10) | fixed |  | 2026-10-14T00:54:31.051Z | 2026-10-14T02:33:13.642Z |
| 187 | 07.4 | deviation | apps/web/components/ui/badge.tsx |  | Shared Badge warning variant fails contrast in light mode (1.91:1); 'Probing' still uses it; PanelDialog close is 32 px at 390 | fixed |  | 2026-10-14T00:54:31.132Z | 2026-10-14T04:12:43.848Z |
| 188 | 07.4 | deviation | e2e/support/a11y.ts |  | The a11y helper waits for infinite animations (pulse, spinner, skeleton) and hangs to timeout; specs cancel them before axe; fix in the helper | fixed |  | 2026-10-14T00:55:32.882Z | 2026-10-14T04:12:43.932Z |
| 189 | 07.4 | deviation | apps/web/components/bots |  | Template 'Connect' links point to /settings/connections (built by 07.4-13); the empty state copy above Templates predates templates; skip notices are generic (no effective value in the contract) | fixed |  | 2026-10-14T00:55:32.956Z | 2026-10-14T04:12:43.768Z |
| 190 | 07.4 | deviation | .github/CODEOWNERS |  | CODEOWNERS does not cover apps/api/src/modules/keychain (and the new connectors module); client-credentials token cache is per process, record in ADR-0025; prove a 30 s connector call in the real cell in 07.4-14 | fixed |  | 2026-10-14T02:01:28.061Z | 2026-10-14T08:44:37.104Z |
| 191 | 07.4 | deviation | apps/api/src/modules/keychain |  | DECISION NEEDED in 07.4-12/14: unit keys are offered in public channels and shared AI chats, so results fetched with a unit's key can reach people outside the unit; apply the audience rule (every reader inside the unit) as memory does | fixed |  | 2026-10-14T02:01:28.146Z | 2026-10-14T04:20:45.906Z |
| 192 | 07.4 | deviation | apps/openclaw-channel/src/tool-guard.ts |  | Plugin local gate uses fixed list flags: after a list it lets a local write through and the API refuses it as tainted (safe, less precise message); /tool-calls still opens its tx with no user | open |  | 2026-10-14T02:01:28.231Z |  |
| 193 | 07.4 | deviation | apps/api/src/modules/connectors |  | On issuer_changed or any terminal failure the credential is dropped without revoking at the old issuer (live until expiry); concurrent DCR registrations for one issuer leave the loser orphaned at the provider; each refresh rediscovers the provider (2 extra requests) | fixed |  | 2026-10-14T02:33:13.855Z | 2026-10-14T08:44:37.462Z |
| 194 | 07.4 | deviation | apps/api/src/modules/connectors |  | conversationName is null for DMs and groups, so the UI would show 'a conversation you can no longer open'; a single member's probe failure puts the whole server in error | fixed |  | 2026-10-14T02:33:13.926Z | 2026-10-14T04:20:45.978Z |
| 195 | 07.4 | deviation | packages/db/sql/post-migrate.sql |  | connector_credential secrets are readable as ciphertext by any session in the org (AAD binds them to the member); CIMD proven only up to the client_id in the authorization URL | open |  | 2026-10-14T02:33:13.999Z |  |
| 196 | 07.4 | deviation | apps/web/components/settings |  | With Bots off the Connections page does not allow disconnect although the API does; ReadersPreview lacks the unit name (unbounded line always says 'Everyone in the organization'); Re-probe toast on needs_reconnect says 'Connect … first' | fixed |  | 2026-10-14T04:12:44.017Z | 2026-10-14T08:44:37.177Z |
| 197 | 07.4 | deviation | apps/web/components/devices-settings.tsx |  | devices-settings.tsx:325 and work-zone/meta.tsx:166 use text-warning by hand and probably fail AA; agent-templates.spec still cancels animations by hand | fixed |  | 2026-10-14T04:12:44.094Z | 2026-10-14T08:44:37.252Z |
| 198 | 07.4 | deviation | apps/openclaw-channel/src/connector-tools.ts |  | For needs_reconnect the plugin says 'You haven't connected…' (should say reconnect); a unit key held back by the audience rule gives the bot no explanation; each connector call opens a new MCP session | fixed |  | 2026-10-14T04:20:46.057Z | 2026-10-14T08:44:37.322Z |
| 199 | 07.4 | deviation | apps/web/components/markdown |  | In-app links in chat Markdown open a new tab (all chat links do); ReadersPreview still lacks the unit name; the cell smoke needs the plugin built first in a fresh worktree | open |  | 2026-10-14T08:44:37.532Z |  |
| 200 | 07.5 | deviation | packages/db/drizzle |  | The column list in SET NULL (col) is not in the drizzle snapshot; a future migration recreating those FKs would emit a plain SET NULL and deletes would fail on organization_id NOT NULL | open |  | 2026-10-14T13:26:02.622Z |  |
| 201 | 07.5 | deviation | packages/db/sql/post-migrate.sql |  | Immutability triggers on the stored tool action and Work Zone proposal do not cover TRUNCATE; add REVOKE TRUNCATE in post-migrate.sql | fixed |  | 2026-10-14T13:26:02.702Z | 2026-10-15T12:01:48.221Z |
| 202 | 07.5 | deviation | packages/db/src/schema/app.ts |  | conversation_id, event_id and requested_for_user_id on 07.5 tables have no FK; 07.5-07/08 must resolve them inside withTenant | fixed |  | 2026-10-14T13:26:02.781Z | 2026-10-15T07:15:02.121Z |
| 203 | 07.5 | deviation | packages/contracts/src/agent-card-route.ts |  | Stubs until later plans: toPrompt proposedBy is always null (07.5-08 wires it); the memory inbox shows 07.5 approvals title-only (07.5-12 filters by kind); the '/approvals' route prefix grep now targets agent-card-route.ts | fixed |  | 2026-10-14T14:00:24.659Z | 2026-10-14T19:14:34.707Z |
| 204 | 07.5 | deviation | apps/api/src/modules/approval |  | A server_apply decision via /approvals by someone who cannot read the conversation still starts (and meters) a bot turn for that decider (bot reply is refused); an unused grant keeps a running card forever; the pending total stops at 1000 scanned rows | fixed |  | 2026-10-14T15:04:59.297Z | 2026-10-15T12:01:48.298Z |
| 205 | 07.5 | deviation | apps/api/src/modules/work-session/routes.ts |  | The HTTP route's 'lower to the default mode' is dead code: Zod defaults permissionMode to 'default', so a member limited to plan who starts a session without picking a mode gets 403 device_grant instead of a plan session (only proposals lower) | fixed |  | 2026-10-14T15:32:46.937Z | 2026-10-15T12:01:48.375Z |
| 206 | 07.5 | deviation | packages/contracts/src/sensitive-data.test.ts |  | The linear-time ratio test (<8x) failed once at 10.42x with load average 18 (parallel executors); consider a looser ratio or more samples | fixed |  | 2026-10-14T15:32:47.075Z | 2026-10-15T12:01:48.982Z |
| 207 | 07.5 | deviation | apps/api/src/modules/tool-approval |  | DECIDED (fix in gate): deleting a unit cascades its tool approval policies with no tool_approval_policy.deleted audit (principle 12); answer 409 unit_has_policies as for keys and templates | fixed |  | 2026-10-14T15:40:25.353Z | 2026-10-15T12:01:48.144Z |
| 208 | 07.5 | deviation | apps/api/src/modules/tool-approval |  | History query has no audit_events index on (action, scopeUnitId); silent caps: /access 500 units, catalog 200 tools/group and 100 groups; a 'users' rule whose people are gone must count as no approver in 07.5-07 canDecide | open |  | 2026-10-14T15:40:25.495Z |  |
| 209 | 07.5 | unrun-verify | apps/openclaw-channel/src/tool-guard.ts |  | The TOOL_PIN_PRIORITY pin relies on OpenClaw 2026.9.7 'last returned params win' (assumption A2), unverified; a plugin registered below -10000 could rewrite after the pin; the 07.5-15 real-cell smoke must record it | fixed |  | 2026-10-14T15:58:17.312Z | 2026-10-15T12:01:48.826Z |
| 210 | 07.5 | deviation | apps/openclaw-channel/src/connector-tools.ts |  | Denial note parsed from the end of the server sentence (no cardAction.note in contracts); approval_denied does not say who decided; flagged connector tools still use the old 32 KB message; fake /tool-calls never answers no_trigger | fixed |  | 2026-10-14T15:58:17.419Z | 2026-10-15T05:03:39.191Z |
| 211 | 07.5 | deviation | apps/api/src/modules/tool-approval |  | MUST FIX (07.5-11/gate): a review_only tool.call card still carries Approve and the server accepts an approval from the card route; only the web hides it. Refuse server-side | fixed |  | 2026-10-14T17:45:03.509Z | 2026-10-15T05:03:39.033Z |
| 212 | 07.5 | deviation | apps/api/src/modules/tool-approval |  | 07.5-11 must map denial {deciderName, note} onto the 409 and add an explicit cardAction note to contracts + plugin mirror (replace sentence parsing); 'You can't approve your own request' copy must follow viewerCan; real use window is min(15 min, request expiry); review view counts readers with one check per member | fixed |  | 2026-10-14T17:45:03.593Z | 2026-10-15T05:03:39.115Z |
| 213 | 07.5 | deviation | apps/api/src/testing.ts |  | Test Redis containers leak (208 redis:8 found running, 1-2 h old): TestStack.stop() awaits built.close() before stopping containers, so a throwing close skips redis.stop(); make it try/finally and check why Ryuk did not reap them (fix in the 07.5 gate) | fixed |  | 2026-10-14T17:47:21.500Z | 2026-10-15T12:01:48.525Z |
| 214 | 07.5 | unrun-verify | apps/openclaw-channel/src/work-zone-tools.ts |  | Work Zone proposal tools unproven in a real cell (alsoAllow, model use, taint refusal) and only tested against the fake; 07.5-15 must run SMOKE_ONLY=work_zone and an API parity test after 07.5-08; import cycle tool-guard <-> work-zone-tools (harmless, commented) | fixed |  | 2026-10-14T17:49:14.525Z | 2026-10-15T12:01:48.903Z |
| 215 | 07.5 | deviation | apps/api/src/modules/work-session |  | When a Work Zone proposal Start fails the bot hears 'approved' without the error code (add resultCode to CardAction); each Work Zone card read recomputes its live state with several queries | fixed |  | 2026-10-14T18:19:32.619Z | 2026-10-15T05:03:39.267Z |
| 216 | 07.5 | deviation | apps/web/components/ui/avatar.tsx |  | Shared avatar initials are 4.25-4.48:1 at 12 px (below AA, axe flaky by random id); move text from *-700 to *-800 | fixed |  | 2026-10-14T18:27:17.175Z | 2026-10-15T07:14:53.085Z |
| 217 | 07.5 | deviation | apps/web/components/settings |  | Approval history shows a raw m…__* pattern for a rule on a deleted server; the policies page does not warn when /access or the catalog are truncated | open |  | 2026-10-14T18:27:17.253Z |  |
| 218 | 07.5 | deviation | apps/web/components/approvals |  | Mobile shows 'Approvals' twice (top bar and back link, per UI-SPEC); 'To review' sorts client-side over loaded pages; the e2e fake cell answers approval_* without the plugin's fixed sentences | open |  | 2026-10-14T19:14:27.881Z |  |
| 219 | 07.5 | unrun-verify | apps/api/src/modules/agent-channel |  | Approval card posted inside the claim transaction (<2 s measured) needs a concurrent-channel contention test (07.5-16); connector grant names the logical tool while the bot calls ocw_connector_call, unproven in a real cell (07.5-15 smoke); fake MCP has no 5xx after a consumed grant | open |  | 2026-10-15T05:03:39.342Z |  |
| 220 | 07.5 | deviation | apps/api/src/modules/agent-channel |  | An ocw_http_request URL normalised differently counts as a different action and opens a new approval; plugin failure texts duplicate the UI-SPEC copy | open |  | 2026-10-15T05:03:39.415Z |  |
| 221 | 07.5 | deviation | apps/api/src/modules/tool-approval/kind.ts |  | The tool.call 'target' field carries the internal MCP server name (e.g. mc4866abe); hide it in the API view and the 07.5-14 card | fixed |  | 2026-10-15T06:05:38.732Z | 2026-10-15T07:14:53.016Z |
| 222 | 07.5 | deviation | apps/api/src/modules/realtime |  | A diagnostic run hit 'deadlock detected' writing to a user: stream, failing a bot reply with 500 (investigate in 07.5-16) | fixed |  | 2026-10-15T06:05:38.809Z | 2026-10-15T06:39:02.837Z |
| 223 | 07.5 | deviation | e2e/tests |  | Decided approvals stay in the run's DB; specs must filter by their own ids; the phone top bar lacks the Approvals count the UI-SPEC asks for | fixed |  | 2026-10-15T06:05:38.884Z | 2026-10-15T12:01:48.747Z |
| 224 | 07.5 | deviation | apps/api/src/modules/approval/service.ts |  | Remaining lock-order risks (not reproduced): a server_apply approval (e.g. memory) still notifies user: streams before the conversation; notifications notify in recipient order, not ascending; no retry on 40P01 | fixed |  | 2026-10-15T06:38:56.276Z | 2026-10-15T12:01:48.451Z |
| 225 | 07.5 | deviation | apps/api/src/testing.ts |  | ConnectorsStack.stop(): a throwing stop leaves the fake server open and a half-built stack leaves containers alive (same family as the Redis leak); grants bind to the action not the bot run, so Sam's next normal turn may use it once (state in ADR-0026) | fixed |  | 2026-10-15T06:38:56.352Z | 2026-10-15T12:01:48.599Z |
| 226 | 07.5 | deviation | apps/web/components/chat/agent-card.tsx |  | A live linked card grows when its approval link arrives and the list does not stay pinned to the bottom (on mobile the card end hides under the composer); requester name and runtime are parsed from server text (add requesterName/runtime to AgentCardApprovalLink); warnings are classified by exact copy match | fixed |  | 2026-10-15T07:14:53.155Z | 2026-10-15T12:01:48.673Z |
| 227 | 07.5 | deviation | apps/web/components/chat/composer.tsx |  | Composer hint text is under AA contrast; e2e specs share one DB so fixture names collide across phases; e2e specs reading response bodies across a navigation can hang | open |  | 2026-10-15T12:01:49.057Z |  |
| 228 | 07.5 | deviation | apps/openclaw-channel/src/tool-guard.ts |  | Pin limits (ADR-0026): a plugin registered below -10000 or one answering OpenClaw's own approval first can still beat TOOL_PIN_PRIORITY | open |  | 2026-10-15T12:01:49.128Z |  |
| 229 | 07.5 | deviation | apps/api/src/modules/approval |  | After #204 the bot does not hear decisions made from /approvals by someone outside the conversation; Work Zone Start has no applyTopics; cards still parse requester and runtime from server text | open |  | 2026-10-15T12:01:49.197Z |  |
| 230 | 07.8 | deviation | packages/db/src/schema/app.ts |  | Hard-deleting a bot removes its browser_sessions rows but leaves their browser_session secrets; revoke/purge/sweeper in 07.8-21/27 must delete them; nothing cleans browser_sessions when a member leaves the org | fixed |  | 2026-10-15T15:08:27.289Z | 2026-10-22T05:37:51.070Z |
| 231 | 07.8 | deviation | packages/db/src/schema/app.ts |  | DECIDE in 07.8-18: the app role can change an approved sandbox package's pinned fields (sha256, tree_sha256, lockfile, dependency_count, review_token); add an immutability trigger after approval. Every new secret kind now needs a migration (secrets_kind_check), note in ADR-0029 | fixed |  | 2026-10-15T15:08:27.379Z | 2026-10-21T20:12:08.062Z |
| 232 | 07.8 | deviation | packages/contracts/src/sandbox.ts |  | Wiring left for later plans: turn.activity not registered in realtime EventTypes (07.8-10); SandboxdContextInput.events is loose until tightened to LiveInputFrame (07.8-16); PATCH /agents/:id/capabilities ignores sandbox/browser until 07.8-15 | fixed |  | 2026-10-15T15:10:12.850Z | 2026-10-22T03:47:11.925Z |
| 233 | 07.8 | deviation | packages/contracts/src/sandbox.ts |  | File upload/download/import travel as base64 JSON up to 50 MiB (~67 MiB on the wire): check the body limit or stream (07.8-09/11); cap_reached/tainted answer 403 here vs 409 on 07.4 connector routes, unify in 05/10/14; npm lockfiles with sha1-only integrity fail PackageTreeEntry, refuse with a reason in 17/18 | fixed |  | 2026-10-15T15:10:12.922Z | 2026-10-21T20:12:08.140Z |
| 234 | 07.8 | deviation | packages/db/src/schema/app.ts |  | MUST (07.8-21): app.message_cards kind check and Drizzle enum accept only the 8 old kinds; a sign-in ('browser') card cannot be stored until a new migration (chained after 07.8-02) adds it. ApprovalToolSourceKind lacks a sandbox/browser source (07.8-14; update SOURCE_ICON) | fixed |  | 2026-10-15T15:23:46.137Z | 2026-10-22T05:37:50.996Z |
| 235 | 07.8 | deviation | apps/sandboxd/src |  | sandboxd: running processes tracked in memory only (unpollable after a restart, still end at timeout); /tmp/ocw-proc group files not removed; runtime_unavailable and docker_too_old share docker_unavailable; diskBytes 0 until 07.8-09 | open |  | 2026-10-15T16:42:21.790Z |  |
| 236 | 07.8 | deviation | infra/sandbox |  | sbx apt versions approved but not pinned in the Dockerfile (later builds pick newer security versions); gVisor path proven by unit tests only until the 07.8-24 CI job; CODEOWNERS lacks apps/sandboxd (07.8-29) | open |  | 2026-10-15T16:42:21.880Z |  |
| 237 | 07.8 | deviation | infra/sandbox/brw |  | brw: iframes are outside the snapshot (screenshot masks them whole after human input); a page that rebuilds an input after typing loses the human-typed marker (password type fields stay redacted); live frames to other viewers are unmasked, F-5/U-2 must hold in the API (07.8-16) | fixed |  | 2026-10-15T16:43:10.209Z | 2026-10-22T03:47:11.846Z |
| 238 | 07.8 | deviation | infra/sandbox/brw |  | sandboxd (07.8-13) must strip the context-id tag from type-0 frames and map the new brw codes (paused, internal, maskRects, resize mode); brw proven on arm64 Docker Desktop only, amd64 runc and the gVisor CI job remain (07.8-24); apt not pinned to a snapshot | open |  | 2026-10-15T16:43:10.294Z |  |
| 239 | 07.8 | deviation | apps/openclaw-channel/src |  | API does not send CellProvider.imageModels or turn.maxSandboxCalls yet (07.8-05/14): screenshot reaches no model and the gate uses default 40; sign-in skipped/expired sentences unwired (07.8-21); OpenClaw image rescaling (imageMaxDimensionPx) untested (8x8 fake JPEG, 07.8-13/28) | fixed |  | 2026-10-15T16:49:17.151Z | 2026-10-22T09:00:45.076Z |
| 240 | 07.8 | deviation | apps/api/src/modules/agent-channel |  | 6 offered sandbox tools have no API route until 07.8-10 (404); confirm GET /cell alsoAllow carries ocw_sandbox_*/ocw_browser_* (plugin withTurnScopedTools); 403 (sandbox/board) vs 409 (07.4 connectors) refusal split: align or record in ADR-0029 | fixed |  | 2026-10-15T17:21:21.782Z | 2026-10-15T22:12:53.756Z |
| 241 | 07.8 | deviation | apps/api/src/modules/sandbox |  | Orphan 'starting' reservation rows (API dies between reserve and ensure) hold a cap slot until cleaned (07.8-11); kill does not push policy {killed:true} to sandboxd nor bump settings version (07.8-11); sandbox approval cards read 'Web request' (07.8-14); OCW_SANDBOX_URL/TOKEN missing in e2e-isolated.sh, .woodpecker, compose, .env.example (07.8-08/24) | fixed |  | 2026-10-15T17:21:21.854Z | 2026-10-15T21:29:54.137Z |
| 242 | 07.8 | deviation | scripts/guard/guard.test.mjs |  | guard.test.mjs (Semgrep rule tests) runs neither in CI nor pnpm verify; ocw.raw-egress covers only apps/sandboxd/src/egress; CODEOWNERS lacks packages/egress-policy and apps/sandboxd/src/egress | open |  | 2026-10-15T18:33:30.173Z |  |
| 243 | 07.8 | deviation | apps/sandboxd/src/egress/proxy.ts |  | Egress proxy: public mode proven by unit tests only (real egress in 07.8-13/24); no per-network tunnel limit; platform names refused by name (not resolved) | open |  | 2026-10-15T18:33:30.267Z |  |
| 244 | 07.8 | deviation | apps/api/src/modules/sandbox |  | Pending purges and policy re-push after a sandboxd restart reach only orgs with events or a failed purge in this process (needs a SECURITY DEFINER org list or a sandboxd boot event); no 'crashed' stop reason in contract/DB; egress audit hourly dedupe queries audit_events metadata without an index; the event consumer holds a pool connection; fake sandboxd stores files as UTF-8 text (breaks binaries) | open |  | 2026-10-15T21:29:49.204Z |  |
| 245 | 07.8 | deviation | apps/api/src/modules/agent-channel |  | Sandbox activity steps never carry approvalMessageRoute (07.8-14/20); bot_turn_activity.running stays true for a turn that never replies, web live label needs a timeout (07.8-20); a write body over Fastify's 2 MiB limit returns Fastify's 413 not too_large; shared images show as downloads, no preview (07.8-25); fake sandboxd codes (404 read folder, 409 busy delete) to check against the real one (07.8-08/09) | open |  | 2026-10-15T22:12:53.836Z |  |
| 246 | 07.8 | deviation | apps/sandboxd/src |  | MUST FIX (fail-open): sandboxd keeps policy, kill state and disk_full in memory; after a sandboxd restart the defaults apply (2 GiB, 15 min idle, NOT killed) until the API re-pushes, and the API only re-pushes for orgs with events. Fix: sandboxd refuses ensure/restart for an org with no policy (409 policy_missing) and the API pushes policy then retries; plus a boot event | fixed |  | 2026-10-15T22:14:34.757Z | 2026-10-21T20:35:29.061Z |
| 247 | 07.8 | deviation | apps/sandboxd/src |  | Soft quota counts apparent size (sparse files in full) and may overshoot up to one 60 s sweep (document XFS hard quota at the gate); transfers hold ~67 MiB JSON + 50 MiB decoded in memory, two at once; after a sandboxd restart a running background process no longer prevents idling; a container death during the watcher's 2 s reconnect is not reported; OCW_SANDBOXD_SWEEP_MS needs compose and env parity (07.8-24) | fixed |  | 2026-10-15T22:14:34.840Z | 2026-10-22T04:13:28.623Z |
| 248 | 07.8 | deviation | apps/api/src/modules/agent-channel |  | When the org is killed or switched off the bot is not offered the sandbox tool and cannot say why (add a withheld reason killed/sandbox_off, 07.8-10/14/19); a message 1-2 s after a member turns Sandbox on can still get 'not offered' (UI should show applying, 07.8-15); cell-proof.sh PROOF_BUILD=1 still builds the demo's :local tags; e2e-reset.sh label cleanup untested locally | open |  | 2026-10-15T22:38:49.256Z |  |
| 249 | 07.8 | deviation | apps/api/src/modules/browser |  | MUST FIX (D-11 floor): when an admins/unit_leads 07.5 policy applies to ocw_browser_act, those approvers decide a member's signed-in action instead of the member; signed-in acts must always need the requesting member's approval | fixed |  | 2026-10-21T19:53:39.333Z | 2026-10-21T20:35:28.921Z |
| 250 | 07.8 | deviation | apps/api/src/modules/browser |  | act answers download:null until 07.8-25; a session counts as loaded by session_id but stored state is not passed to sandboxd until 07.8-21; kill does not close browser contexts in its own tx (rows stay open if sandboxd is down); image-capable model list is hand-kept; approval chip icons reuse package/globe | open |  | 2026-10-21T19:53:39.439Z |  |
| 251 | 07.8 | deviation | e2e/tests/memory-files.spec.ts |  | FIX IN GATE: memory-files.spec.ts:548 (keyboard and ARIA on desktop) fails intermittently on the phase branch (2 of 3 runs alongside other specs; race between the tab stop and deep-link expansion); passes alone | fixed |  | 2026-10-21T20:05:41.977Z | 2026-10-22T12:38:30.998Z |
| 252 | 07.8 | deviation | apps/web/components/bots |  | Sandbox file list route has no offset/cursor beyond 500 entries ('{n} more not listed'); Capabilities switches are 20x36 (<44 px, same as the existing Internet row); sandbox state events carry no runtime so a sandbox started outside the API ensure shows 'hardened' until restart; upload dialog does not intercept in-app navigation | open |  | 2026-10-21T20:05:42.084Z |  |
| 253 | 07.8 | deviation | infra/sandbox/sbx |  | sbx has no HTTP(S)_PROXY env, so curl/pip/npm in the shell ignore the egress proxy unless given -x (allowlisted egress unusable by default); set the proxy env in the sbx spec (07.8-17/24) | fixed |  | 2026-10-21T20:09:53.837Z | 2026-10-22T02:53:29.247Z |
| 254 | 07.8 | deviation | apps/sandboxd/src/egress/proxy.ts |  | The proxy passes an upstream X-OCW-Egress header through (a site can make its own http page look refused): strip it; a failed policy write to the proxy answers 503 after sandboxd stored it (proxy lags until retry); a recreated proxy restores each bot's egress only on its next ensure | fixed |  | 2026-10-21T20:09:53.930Z | 2026-10-22T12:38:31.073Z |
| 255 | 07.8 | deviation | apps/sandboxd/src |  | A sandboxd restart forgets its context map (agent answers no_context until it closes after 5 idle min, API must reopen); browserLimits idleStopMs/diskQuotaBytes unused (fixed 5 min); API owes resize mode, browserSandbox and http navigation_refused handling (07.8-16); 24 owes OCW_SANDBOX_BRW_IMAGE/EGRESS_IMAGE/BRW_SECCOMP env and gVisor/amd64 runs | fixed |  | 2026-10-21T20:09:54.014Z | 2026-10-22T04:13:28.548Z |
| 256 | 07.8 | deviation | apps/api/src/modules/sandbox |  | Package installs run synchronously on the first call of a stopped sandbox (up to 600 s per package, can outlast the plugin deadline); a package reaches a running sandbox only at its next start (UI copy in 07.8-23); newerVersion always null; failed installs notify no admin beyond audit; package audit metadata includes registry name/version/digests | open |  | 2026-10-21T20:12:08.217Z |  |
| 257 | 07.8 | deviation | apps/web/components/sandbox/settings/limits-form.tsx |  | 07.8-19: the container limits line copies the API CONTAINER_LIMITS because the settings view does not expose them (low) | open |  | 2026-10-22T02:52:51.781Z |  |
| 258 | 07.8 | deviation | infra/fake-model/fake-sandboxd.mjs |  | 07.8-19: the fake sandboxd always reports gVisor; no switch to fake hardened, Docker too old or container-only runtimes (low) | open |  | 2026-10-22T02:52:51.861Z |  |
| 259 | 07.8 | deviation | apps/api/src/modules/sandbox |  | SHOULD FIX (07.8-17): the API's sandboxd client uses plain fetch (undici 300 s default); a package install taking 300-540 s fails at the API while sandboxd completes it. Give package install/review an explicit 600 s timeout (07.8-24/28) | fixed |  | 2026-10-22T02:53:29.323Z | 2026-10-22T04:13:28.698Z |
| 260 | 07.8 | deviation | apps/sandboxd/src/packages.ts |  | 07.8-17: a sandboxd crash mid review/install leaves its ocw-pnet-* network behind (container and temp volume self-remove); add to 28's orphan sweep | fixed |  | 2026-10-22T02:53:29.401Z | 2026-10-22T09:00:44.780Z |
| 261 | 07.8 | deviation | apps/sandboxd/src/packages.ts |  | 07.8-17: the per-bot packages volume has no disk quota of its own (only the sandbox quota policy); record in ADR-0029 soft-quota note (29) | open |  | 2026-10-22T02:53:29.477Z |  |
| 262 | 07.8 | deviation | apps/sandboxd/src/packages.ts |  | 07.8-17: when two packages provide the same bin or module name the first on PATH/NODE_PATH wins silently; surface a conflict at review (low) | open |  | 2026-10-22T02:53:29.552Z |  |
| 263 | 07.8 | deviation | infra/compose |  | MUST (07.8-24): add OCW_SANDBOX_NPM_REGISTRY, OCW_SANDBOX_PYPI_INDEX, OCW_CLAWHUB_URL (must equal the API's) and OCW_SANDBOX_REGISTRIES to sandboxd in compose and Woodpecker | fixed |  | 2026-10-22T02:53:29.628Z | 2026-10-22T04:13:28.471Z |
| 264 | 07.8 | deviation | apps/sandboxd/src/packages.ts |  | 07.8-17: npm 11.19 warns about allowScripts but still runs install scripts; a future npm enforcing it needs an allow-list (low); Debian packages only unit-tested (VALIDATION manual row) | open |  | 2026-10-22T02:53:29.706Z |  |
| 265 | 07.8 | deviation | packages/contracts/src/browser.ts |  | 07.8-20 (for 21): ActivityStep has no requester, so sign-in and paused rows cannot name the person ("Asked you / Asked Sam" is built and tested, waiting for data) | fixed |  | 2026-10-22T03:14:25.296Z | 2026-10-22T05:37:51.148Z |
| 266 | 07.8 | deviation | packages/contracts/src/browser.ts |  | 07.8-20: activity steps carry no http/https flag, so step hosts show no lock or Not secure (only the card and review do) (low) | open |  | 2026-10-22T03:14:25.387Z |  |
| 267 | 07.8 | deviation | apps/web/components/browser/bot-activity.tsx |  | 07.8-20: for a top-level channel mention the live label shows in the main list while the reply lands in the thread; a tab opened mid-turn shows no label until the next step (low) | open |  | 2026-10-22T03:14:25.479Z |  |
| 268 | 07.8 | deviation | apps/sandboxd/src/packages.ts |  | 07.8-23 (medium): no package version listing in sandboxd or the API, so the web version picker is a typed field and "Update to {version}" never appears | open |  | 2026-10-22T03:43:44.118Z |  |
| 269 | 07.8 | deviation | apps/api/src/modules/sandbox |  | 07.8-23: the package list carries no install failure code (17's timeout cannot show) and no removing count; an approved package with no started sandbox reads Installing and polls every 5 s (low) | open |  | 2026-10-22T03:43:44.197Z |  |
| 270 | 07.8 | deviation | apps/web/components/ui/sheet.tsx |  | 07.8-23: the shared sheet close button is 32 px on phones (marketplace plugin review sheet too); the packages review sheet has its own 44 px close (low) | open |  | 2026-10-22T03:43:44.276Z |  |
| 271 | 07.8 | deviation | apps/api/src/modules/browser/takeover.ts |  | 07.8-16 (medium): a takeover lease held by an API instance that died stays until expiry; only a live view reading the row clears it (same cross-organization lister gap as #244) — 28's sweep | fixed |  | 2026-10-22T03:47:12.000Z | 2026-10-22T09:00:44.702Z |
| 272 | 07.8 | deviation | apps/api/src/modules/browser/live-view.ts |  | 07.8-16: watching resizes the bot's page from 1280x800 to 960x600 (UI-SPEC default); 22/28 decide whether the small default stays (low) | fixed |  | 2026-10-22T03:47:12.076Z | 2026-10-22T05:12:57.096Z |
| 273 | 07.8 | deviation | packages/contracts/src/browser.ts |  | 07.8-16: the live-view state frame has no browserSandbox, so the floating window cannot show isolation per page (low, 22/26) | waived | 07.8-22: the UI-SPEC never shows isolation in the live window, only on the Browser tab and in Settings | 2026-10-22T03:47:12.153Z | 2026-10-22T05:12:57.169Z |
| 274 | 07.8 | deviation | infra/fake-model/fake-sandboxd.mjs |  | 07.8-16: a crashed event in the fake sandboxd does not end the frame stream (the real broker does) (low); the live-input Semgrep rule covers only declared types and field names in listed paths (low) | open |  | 2026-10-22T03:47:12.229Z |  |
| 275 | 07.8 | deviation | apps/sandboxd/src/egress-attach.ts |  | MUST FIX (07.8-24): under gVisor (runsc) Docker's embedded DNS 127.0.0.11 does not answer on bot networks, so sbx/brw cannot resolve sandbox-egress and have no egress at all (fails closed; breaks every gVisor install). Give each sandbox the proxy IP (ExtraHosts or pinned address); then drop failure: ignore on gvisor-browser in .woodpecker/sandbox.yaml | fixed |  | 2026-10-22T04:13:28.773Z | 2026-10-22T05:12:56.931Z |
| 276 | 07.8 | deviation | infra/fake-model/server.test.mjs |  | MUST FIX: "serves the fake sandboxd behind its token ... exec round trip" gets 409 policy_missing since the fake requires a policy push (red since policyfix); runs in cell-smoke on Woodpecker and GitHub | fixed |  | 2026-10-22T04:13:28.849Z | 2026-10-22T05:12:57.014Z |
| 277 | 07.8 | unrun-verify | .woodpecker/sandbox.yaml |  | 07.8-24: no real Woodpecker run of sandbox.yaml yet (steps run by hand in dind); record link and duration on first push; full gate:compose --with-sandbox (with Playwright, proxy, backup) not run | open |  | 2026-10-22T04:13:28.921Z |  |
| 278 | 07.8 | deviation | apps/api/Dockerfile |  | 07.8-24: no retry for pnpm first-use binary download (timed out on Docker Desktop); CI dind keeps docker:dind (~500 MB) between gVisor runs (low) | open |  | 2026-10-22T04:13:28.997Z |  |
| 279 | 07.8 | deviation | apps/sandboxd/src/egress-attach.ts |  | dnsfix: if the egress proxy restarts with a new IP, a running sandbox keeps the old /etc/hosts entry and has no egress until its next start/restart (fails closed; runc used to follow via Docker DNS) (low); packages smoke does not print its runtime | open |  | 2026-10-22T05:12:46.799Z |  |
| 280 | 07.8 | deviation | apps/web/components/browser |  | 07.8-22 (medium): non-Latin IME input does not work on the desktop live-view frame during a takeover (paste works); an editable frame would leak composed text into our DOM | open |  | 2026-10-22T05:12:57.253Z |  |
| 281 | 07.8 | deviation | apps/web/components/browser |  | 07.8-22: a reply on screen keeps its Watch link after the page closes until the list refetches (shows Ended) (low); at 320 px the host truncates early (low) | open |  | 2026-10-22T05:12:57.333Z |  |
| 282 | 07.8 | deviation | apps/local-runtime |  | 07.8-22: a local-runtime test fails when the repo is checked out outside the home folder (low) | open |  | 2026-10-22T05:12:57.408Z |  |
| 283 | 07.8 | unrun-verify | infra/sandbox/browser |  | 07.8-21: the brw smoke for the new sandboxd op contextLock (site lock on a member-signed-in page) was not run against the real brw image | open |  | 2026-10-22T05:37:51.226Z |  |
| 284 | 07.8 | deviation | apps/api/src/modules/browser |  | 07.8-21 (medium): a site that sets a cookie before any login is sealed as signed in; re-seal runs only after each call; a lock failure ends the page as crashed | fixed |  | 2026-10-22T05:37:51.300Z | 2026-10-22T09:00:44.853Z |
| 285 | 07.8 | deviation | apps/api/src/modules/browser |  | 07.8-21: the 15-minute sign-in expiry can hit a member still in control; a page holding a departed member's cookies lives until the 5-minute idle stop; an expired sign-in delivers no turn to the bot (expired sentence unused) | open |  | 2026-10-22T05:37:51.379Z |  |
| 286 | 07.8 | deviation | apps/api/src/modules/browser |  | 07.8-21: the Browser tab activity shows the page's current host (low) | fixed |  | 2026-10-22T05:37:51.461Z | 2026-10-22T06:39:03.293Z |
| 287 | 07.8 | deviation | apps/api/src/modules/browser |  | SHOULD FIX (07.8-27, medium): deleting a bot is a soft delete and the #230 secret clean-up trigger fires only on hard delete, so a deleted bot's sealed sessions stay until expiry or the 7-day purge (listed and revocable, never loaded) — 28 | fixed |  | 2026-10-22T06:39:03.378Z | 2026-10-22T09:00:44.623Z |
| 288 | 07.8 | deviation | apps/web/components/browser |  | 07.8-27: no "sign-in pending for you" flag on the row so Open live view is never primary; Browser tab polls every 10 s (no realtime); rows before the opened_host migration show the current host; "Stopped on {host}" copy differs from UI-SPEC (low) | open |  | 2026-10-22T06:39:03.462Z |  |
| 289 | 07.8 | deviation | apps/web/components/browser |  | 07.8-26 (medium, with #280): IME composition on the phone's hidden input stays in the input until compositionend; the hidden input may also fix desktop IME | open |  | 2026-10-22T06:53:46.168Z |  |
| 290 | 07.8 | deviation | apps/web/components/browser |  | 07.8-26: the live chip refreshes on turn.activity, focus and every 20 s, so a page closed for idleness can show up to 20 s; closing with no open page shows a "Blocked: a page" step (from 20); the AI chat has no chip (low) | open |  | 2026-10-22T06:53:46.251Z |  |
| 291 | 07.8 | deviation | infra/sandbox/browser |  | 07.8-26: the phone viewport is proven only against the fake sandboxd; the real brw smoke for phone mode is not run | fixed |  | 2026-10-22T06:53:46.333Z | 2026-10-22T09:00:44.997Z |
| 292 | 07.8 | deviation | apps/api/src/modules/agent-channel |  | MUST FIX (07.8-25, coordinator decision for 28 + ADR-0029): member_data (P-11, D-13) holds only for the turn that loaded the session, but the bot's OpenClaw history in that conversation may still contain what it read. Decision: member_data is sticky per (bot, conversation) once a member session was loaded there, until the bot's history for that conversation is reset; every later turn there carries it (floors, routing, import refusal) | fixed |  | 2026-10-22T06:56:37.815Z | 2026-10-22T09:00:44.543Z |
| 293 | 07.8 | deviation | apps/api/src/modules/sandbox |  | 07.8-25: a download that only arrives through the event feed (not in the act response) is not stored; audienceCovers checks person by person and refuses above 1,000 (low) | open |  | 2026-10-22T06:56:37.891Z |  |
| 294 | 07.8 | deviation | apps/api/src/modules/tool-approval |  | 07.8-25: in a plain 07.5 exec approval the generic view does not mask --password=x style flags (only the D-13 view does) (low, 28) | fixed |  | 2026-10-22T06:56:37.968Z | 2026-10-22T09:00:44.925Z |
| 295 | 07.8 | deviation | infra/sandbox/browser |  | MUST FIX before 29 (07.8-28): pinned Chromium 153.0.8010.12 is an August beta; stable 156.0.8078.47 and several stable security releases are missing. Bump playwright-core (1.64.x ships Chromium 156) or the current stable CfT build, re-pin digests, re-run browser/stack smokes | fixed |  | 2026-10-22T09:00:45.152Z | 2026-10-22T09:40:57.707Z |
| 296 | 07.8 | deviation | infra/sandbox/browser |  | SHOULD FIX (07.8-28, medium): the first contextOpen on a freshly started brw sometimes does not answer (2 of ~9 starts on Docker Desktop) and the API answers service_unavailable after 15 s; a retry works; brw keeps no logs so it cannot be diagnosed | fixed |  | 2026-10-22T09:00:45.226Z | 2026-10-22T09:40:57.779Z |
| 297 | 07.8 | deviation | apps/api/src/modules/keychain |  | SHOULD FIX (07.8-28, medium): PUT /keychain/private-hosts does not re-push the sandbox policy to sandboxd; it keeps the old allowlist until the next settings change, kill/resume or restart | fixed |  | 2026-10-22T09:00:45.302Z | 2026-10-22T09:40:57.851Z |
| 298 | 07.8 | deviation | apps/api/src/modules/agent-channel |  | 07.8-28: confirm a DM can never gain human participants (else another person would decide D-13 approvals over Sam's data); member_data marking (#292) has no reset, so in a DM where a session was loaded every other site asks for approval forever; a page opened unsigned in a marked turn is locked to its host (too strict) (low) | open |  | 2026-10-22T09:00:45.383Z |  |
| 299 | 07.8 | deviation | infra |  | 07.8-28: bump CI Docker 29.8.2 -> 29.9.2 and local Docker Desktop 29.6.2 (CVE not reachable from a bot) (low) | open |  | 2026-10-22T09:00:45.461Z |  |
| 300 | 07.8 | deviation | infra/sandbox/browser |  | hardening: nothing watches new stable Chrome releases for brw; each one needs the same bump (CfT stable build, sha256 pinned) — add a scheduled check (low) | open |  | 2026-10-22T09:40:57.925Z |  |
| 301 | 07.8 | deviation | .woodpecker |  | hardening: rebuild the ocw-ci image for Playwright 1.64.1 browsers; gVisor with Chromium 156 unverified until the first push (gvisor-browser job) | open |  | 2026-10-22T09:40:58.007Z |  |
| 302 | 07.8 | deviation | apps/api/src/modules/chat |  | hardening: "a DM never gains humans" is enforced only in the API; a DB trigger would be defence in depth (low) | open |  | 2026-10-22T09:40:58.083Z |  |
| 303 | 07.8 | deviation | apps/web |  | 07.8-29 (medium): useSignIn does not clear the previous session's query cache on sign-in | open |  | 2026-10-22T12:38:31.152Z |  |
| 304 | 07.8 | deviation | apps/web |  | 07.8-29: other useTopic callers may multiply invalidations the same way /me/permissions did (low) | open |  | 2026-10-22T12:38:31.229Z |  |
| 305 | 07.9 | deviation | packages/db/sql/post-migrate.sql |  | 07.9-02 (coordinator decision, record in ADR-0030): a revoked personal device grant does not override the device's "shared with everyone"; the person keeps seeing its sessions through the share (same as deviceModeCap today); sessions on a revoked device stay visible to former grantees as history | open |  | 2026-10-23T01:28:25.186Z |  |
| 306 | 07.9 | deviation | packages/db/sql/post-migrate.sql |  | 07.9-02: who-can-see and project-member listings check every active member one by one; fine at expected size, plan 12's perf test must cover it | open |  | 2026-10-23T01:28:25.262Z |  |
| 307 | 07.9 | deviation | packages/db/sql/post-migrate.sql |  | MUST (07.9-12, D-14): app.work_project_access's team branch must exclude descendants of kind project, so an assigned team never reaches members of projects nested under it; with a test | open |  | 2026-10-23T03:52:58.538Z |  |
| 308 | 07.9 | deviation | apps/api/src/modules/work-session/facts.ts |  | 07.9-05: the list calls work_session_access once per session of the organization (Pitfall 8); plan 12's perf test must measure it | open |  | 2026-10-23T03:52:58.614Z |  |

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
  },
  {
    "id": 70,
    "kind": "unrun-verify",
    "phase": "06",
    "file": "apps/openclaw-channel/src/mention-mapper.ts",
    "line": null,
    "description": "06-10 ai_chat persona delivery (flat, per-mention session, withheld block, gate refusal) not yet proven in a real OpenClaw cell (CI cell-smoke unavailable)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-07T10:45:46.645Z",
    "resolved_at": null
  },
  {
    "id": 71,
    "kind": "deviation",
    "phase": "06",
    "file": "apps/api/src/modules/notification/service.ts",
    "line": null,
    "description": "06-13 card_updated notifies a follower only on a card's first status change (one notification row per user+message; later changes do not re-notify)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-07T11:15:43.269Z",
    "resolved_at": null
  },
  {
    "id": 72,
    "kind": "unrun-verify",
    "phase": "06",
    "file": "infra/openclaw/test/run-container-smoke.sh",
    "line": null,
    "description": "06-14 cell-smoke scenario card (ocw_agent_card create/update, agent.card_action.v1 turn) not yet run in a real OpenClaw cell; e2e specs updated for ocw_agent_card not run",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-07T11:45:56.476Z",
    "resolved_at": null
  },
  {
    "id": 73,
    "kind": "unrun-verify",
    "phase": "06",
    "file": ".planning/phases/06-multiplayer-ai-chat/06-16-PLAN.md",
    "line": null,
    "description": "06-16 Task 3: metered spoofing eval and OpenAI ChatGPT-plan terms check not run (eval deferred, human_needed)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-07T15:33:04.842Z",
    "resolved_at": null
  },
  {
    "id": 74,
    "kind": "deviation",
    "phase": "06",
    "file": "apps/api/src/modules/chat/index.ts",
    "line": null,
    "description": "Phase 4 chat routes authenticate in preHandler: anonymous malformed bodies get 400 before 401 (card routes fixed in 06-16)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-07T15:33:04.922Z",
    "resolved_at": null
  },
  {
    "id": 75,
    "kind": "deviation",
    "phase": "06",
    "file": "apps/web/components/bots/add-to-channel-dialog.tsx",
    "line": null,
    "description": "Add to channel lists channels where the caller gets 403; bots.spec now picks #general",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-07T15:33:04.995Z",
    "resolved_at": null
  },
  {
    "id": 76,
    "kind": "deviation",
    "phase": "06.1",
    "file": "apps/api/src/modules/work-session/images.int.test.ts",
    "line": null,
    "description": "attachment_not_linkable acceptance grep is 3 (<6); rejection matrix is table-driven",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-07T17:14:33.250Z",
    "resolved_at": null
  },
  {
    "id": 77,
    "kind": "deviation",
    "phase": "06.1",
    "file": "packages/contracts/src/work-session.ts",
    "line": null,
    "description": "WorkPrompt.attachments is in upload order, not request order; 06.1-02 must dispatch in request order",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-07T17:14:33.320Z",
    "resolved_at": "2026-10-07T18:10:28.424Z"
  },
  {
    "id": 78,
    "kind": "deviation",
    "phase": "06.1",
    "file": "apps/local-runtime/src/codex/codex-runtime.ts",
    "line": null,
    "description": "Codex turn/start error surfaces as session.error + failed prompt.completed, not a prompt() rejection (plan said reject)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-07T17:48:58.224Z",
    "resolved_at": null
  },
  {
    "id": 79,
    "kind": "deviation",
    "phase": "06.1",
    "file": "apps/local-runtime/src/codex",
    "line": null,
    "description": "Synthetic Codex image fixture reuses recorded initialize/thread/start lines",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-07T17:48:58.298Z",
    "resolved_at": null
  },
  {
    "id": 80,
    "kind": "deviation",
    "phase": "06.1",
    "file": "packages/db",
    "line": null,
    "description": "06.1-02 added migration work_prompt_image_order outside its files_modified (needed for request order)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-07T18:10:28.511Z",
    "resolved_at": null
  },
  {
    "id": 81,
    "kind": "unmet-truth",
    "phase": "06.1",
    "file": "apps/api/src/modules/work-session/turn-mode.int.test.ts",
    "line": null,
    "description": "One standalone turn-mode.int run failed in beforeAll with no captured cause; 9 reruns passed (unconfirmed flake)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-07T18:10:28.587Z",
    "resolved_at": null
  },
  {
    "id": 82,
    "kind": "deviation",
    "phase": "06.1",
    "file": "e2e/tests/work-zone-images.spec.ts",
    "line": null,
    "description": "Task 2 e2e written before implementation but not run red on its own",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-07T19:02:07.423Z",
    "resolved_at": null
  },
  {
    "id": 83,
    "kind": "unrun-verify",
    "phase": "06.1",
    "file": "apps/web/components/work-zone/composer.tsx",
    "line": null,
    "description": "Real Ctrl+V on a non-macOS host not run (paste event is key-agnostic)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-07T19:02:07.493Z",
    "resolved_at": null
  },
  {
    "id": 84,
    "kind": "deviation",
    "phase": "06.1",
    "file": "apps/web/components/chat/attachment-grid.tsx",
    "line": null,
    "description": "attachment-grid.tsx changed outside files_modified (optional className)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-07T19:02:07.565Z",
    "resolved_at": null
  },
  {
    "id": 85,
    "kind": "unrun-verify",
    "phase": "06.1",
    "file": ".planning/phases/06.1-work-zone-image-attachments/06.1-05-PLAN.md",
    "line": null,
    "description": "06.1-05 Task 3 real-runtime image check (Claude Code, Codex) deferred, human_needed",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-07T21:32:00.387Z",
    "resolved_at": null
  },
  {
    "id": 86,
    "kind": "deviation",
    "phase": "06.1",
    "file": "apps/api/src/lib/redis.ts",
    "line": null,
    "description": "Gate fixed a Phase 1 realtime subscribe/unsubscribe race outside files_modified (redis.int.test.ts)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-07T21:32:00.457Z",
    "resolved_at": null
  },
  {
    "id": 87,
    "kind": "deviation",
    "phase": "06.1",
    "file": "apps/web/components/search/search-palette.tsx",
    "line": null,
    "description": "Gate fixed a Phase 4 search palette focus defect outside files_modified",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-07T21:32:00.531Z",
    "resolved_at": null
  },
  {
    "id": 88,
    "kind": "unmet-truth",
    "phase": "07",
    "file": "apps/api/src/realtime-presence.int.test.ts",
    "line": null,
    "description": "Rate-limit presence test (line ~430) flaky under load; failed once while a parallel dump ran, 9/9 alone",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-08T00:51:08.081Z",
    "resolved_at": null
  },
  {
    "id": 89,
    "kind": "deviation",
    "phase": "07",
    "file": "apps/api/src/app.ts",
    "line": null,
    "description": "trustProxy wired through fastifyTrustProxy() (Fastify fails closed on numeric trustProxy); plan grep differs",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-08T01:09:05.045Z",
    "resolved_at": null
  },
  {
    "id": 90,
    "kind": "deviation",
    "phase": "07",
    "file": "scripts/guard",
    "line": null,
    "description": "claude-agent-sdk license exception and server-everything license clarification pending owner/legal confirmation (D-14, ADR-0021)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-08T01:18:30.440Z",
    "resolved_at": null
  },
  {
    "id": 91,
    "kind": "deviation",
    "phase": "07",
    "file": "compose.yaml",
    "line": null,
    "description": "Garage has no healthcheck: compose --wait does not wait for it (backup gate retries 60s after recreate)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-08T02:11:23.801Z",
    "resolved_at": null
  },
  {
    "id": 92,
    "kind": "deviation",
    "phase": "07",
    "file": "compose.yaml",
    "line": null,
    "description": "docker compose start also reruns the one-shot migrate service (idempotent)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-08T02:11:23.891Z",
    "resolved_at": null
  },
  {
    "id": 93,
    "kind": "deviation",
    "phase": "07",
    "file": "compose.yaml",
    "line": null,
    "description": "With OCW_TRUST_PROXY=1 a process on the host or the compose network can still forge X-Forwarded-For; closing it needs a fixed Caddy IP/subnet",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-08T02:29:43.449Z",
    "resolved_at": null
  },
  {
    "id": 94,
    "kind": "deviation",
    "phase": "07",
    "file": "compose.yaml",
    "line": null,
    "description": "API has no depends_on openbao in vault mode: a cold start may exit once and retry",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-08T02:33:44.398Z",
    "resolved_at": null
  },
  {
    "id": 95,
    "kind": "unmet-truth",
    "phase": "07",
    "file": "scripts/ocw/backup.mjs",
    "line": null,
    "description": "ocw backup omits the openbao-data volume and secrets/ when the vault profile is on; a restore would not boot (fix in 07-10/07-11)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-08T02:33:44.475Z",
    "resolved_at": "2026-10-08T04:16:52.638Z"
  },
  {
    "id": 96,
    "kind": "unrun-verify",
    "phase": "07",
    "file": "scripts/gate/compose-gate.mjs",
    "line": null,
    "description": "gate:compose default (short) variant and --steps playwright alone not run separately; covered by the full run",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-08T04:16:52.709Z",
    "resolved_at": null
  },
  {
    "id": 97,
    "kind": "deviation",
    "phase": "07",
    "file": "scripts/ocw/backup.mjs",
    "line": null,
    "description": "Backup omits caddy-data: a restore on fresh volumes gives Caddy a new local CA",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-08T04:16:52.781Z",
    "resolved_at": null
  },
  {
    "id": 98,
    "kind": "unmet-truth",
    "phase": "07",
    "file": "docs/INSTALL.md",
    "line": null,
    "description": "Owner clean-machine install on real hardware deferred (human_needed), incl. Linux check of OpenBao capabilities",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-08T05:06:11.267Z",
    "resolved_at": null
  },
  {
    "id": 99,
    "kind": "deviation",
    "phase": "07",
    "file": "scripts/ocw/backup.mjs",
    "line": null,
    "description": "A vault-enabled backup contains the OpenBao seal key; as sensitive as .env (documented)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-08T05:06:11.340Z",
    "resolved_at": null
  },
  {
    "id": 100,
    "kind": "deviation",
    "phase": "07.3",
    "file": "apps/web/components/settings/account-nav",
    "line": null,
    "description": "AI chat account entry hidden only when the permission is decided off (P-08), not via can()",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-10T01:03:30.376Z",
    "resolved_at": null
  },
  {
    "id": 101,
    "kind": "deviation",
    "phase": "07.3",
    "file": "apps/web/components/organization/unit-modules-card.tsx",
    "line": null,
    "description": "Read-only reason reads the member's role for copy only; edit rights still come from canEdit",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-10T01:03:30.449Z",
    "resolved_at": null
  },
  {
    "id": 102,
    "kind": "unmet-truth",
    "phase": "07.3",
    "file": "apps/api/src/modules/agent-channel",
    "line": null,
    "description": "Proactive agent messages and queued AI chat prompts are not re-decided against module rules (07.6/07.7 scope)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-10T01:03:30.526Z",
    "resolved_at": null
  },
  {
    "id": 103,
    "kind": "deviation",
    "phase": "07.1",
    "file": "apps/api/src/modules/chat/board",
    "line": null,
    "description": "Possible deadlock: DELETE /messages on a card root racing a card text edit can abort one (500); delete should take the stream lock first",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-12T13:51:08.419Z",
    "resolved_at": "2026-10-12T21:23:03.467Z"
  },
  {
    "id": 104,
    "kind": "deviation",
    "phase": "07.1",
    "file": "apps/api/src/modules/chat/board/access.ts",
    "line": null,
    "description": "A card create with @channel and an invalid columnId spends the channel's per-minute mention slot before the 400 (claim happens before column validation)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-12T13:53:16.172Z",
    "resolved_at": "2026-10-12T21:23:03.542Z"
  },
  {
    "id": 105,
    "kind": "unrun-verify",
    "phase": "07.1",
    "file": "apps/api/src/modules/chat/board/routes.ts",
    "line": null,
    "description": "Card PATCH does not pass the new body to writableBoard: confirm in 07.1-14 that edits never broadcast @channel (as generic message edits) or gate them with channel.mention_all",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-12T13:53:16.261Z",
    "resolved_at": "2026-10-12T21:23:03.617Z"
  },
  {
    "id": 106,
    "kind": "deviation",
    "phase": "07.1",
    "file": "apps/web/app/globals.css",
    "line": null,
    "description": "Dark mode: white text on the primary colour is 3.44:1 (< 4.5:1 AA) on every enabled primary button; fix the dark primary token in 07.1-14 with before/after screenshots",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-12T15:31:56.286Z",
    "resolved_at": "2026-10-12T21:23:03.688Z"
  },
  {
    "id": 107,
    "kind": "deviation",
    "phase": "07.1",
    "file": "packages/realtime-client",
    "line": null,
    "description": "A dead socket the browser does not report is still not detected (no pong timeout)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-12T15:37:41.294Z",
    "resolved_at": null
  },
  {
    "id": 108,
    "kind": "deviation",
    "phase": "07.1",
    "file": "apps/openclaw-channel/src/turn-scoped-tools.ts",
    "line": null,
    "description": "ocw_board_card alsoAllow lives in the plugin reconciler (a bot's own alsoAllow overrides the global one in OpenClaw 2026.9.7)",
    "status": "waived",
    "reason": "By design, recorded in ADR-0022",
    "recorded_at": "2026-10-12T17:15:54.121Z",
    "resolved_at": "2026-10-12T21:23:03.760Z"
  },
  {
    "id": 109,
    "kind": "deviation",
    "phase": "07.1",
    "file": "apps/openclaw-channel/src/board-tool.ts",
    "line": null,
    "description": "Agents can move/set waiting only on the thread's card or cards they created in this conversation (board read returns only the thread card version)",
    "status": "waived",
    "reason": "By design, recorded in ADR-0022",
    "recorded_at": "2026-10-12T17:15:54.192Z",
    "resolved_at": "2026-10-12T21:23:03.829Z"
  },
  {
    "id": 110,
    "kind": "deviation",
    "phase": "07.1",
    "file": "apps/web/app/globals.css",
    "line": null,
    "description": "Dark destructive buttons (white on --destructive oklch(0.66 0.2 22)) measure ~3.3:1 (< 4.5:1 AA); same fill/text split as primary fixes it",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-12T21:23:03.898Z",
    "resolved_at": "2026-10-12T22:27:16.906Z"
  },
  {
    "id": 111,
    "kind": "deviation",
    "phase": "07.1",
    "file": "apps/web/components/chat/board/card-strip.tsx",
    "line": null,
    "description": "A card with a typed title and empty description shows an empty root message body in its thread (author and time only)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-12T21:23:03.967Z",
    "resolved_at": "2026-10-12T22:27:16.978Z"
  },
  {
    "id": 112,
    "kind": "deviation",
    "phase": "07.1",
    "file": "e2e/tests/search.spec.ts",
    "line": null,
    "description": "Composer-focus regression e2e was not RED on the pre-fix build; fix rests on run-1 evidence, a focus probe and a unit test",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-12T21:23:04.036Z",
    "resolved_at": null
  },
  {
    "id": 113,
    "kind": "deviation",
    "phase": "07.1",
    "file": "apps/web/components/chat/channel-view.tsx",
    "line": null,
    "description": "Board Messages view: a card root beyond the first 100 cards of its column is not cached, so Edit message falls back to the inline editor (400 board_card_use_board)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-12T21:23:04.109Z",
    "resolved_at": "2026-10-12T22:27:17.051Z"
  },
  {
    "id": 114,
    "kind": "deviation",
    "phase": "07.2",
    "file": "packages/contracts/src/memory.ts",
    "line": null,
    "description": "Folder rule pathPrefix is accepted by the contract but dropped by the API until 07.2-03; an allow memory.write on hr/ would apply to the whole scope meanwhile; must close before the phase merges",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T03:20:41.553Z",
    "resolved_at": "2026-10-13T04:39:31.651Z"
  },
  {
    "id": 115,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/web/components/shell/module-gate.tsx",
    "line": null,
    "description": "Settings > Modules shows a Memory toggle with no memory UI until 07.2-10; screenshot the 4-row panel in 10/13",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T03:20:41.625Z",
    "resolved_at": "2026-10-13T07:35:47.237Z"
  },
  {
    "id": 116,
    "kind": "deviation",
    "phase": "07.2",
    "file": "packages/db/src/schema/memory.ts",
    "line": null,
    "description": "approval_requests has no personal-owner column: an admin with direct SQL can see that an approval for a personal proposal exists (metadata, not content); decide in 07.2-06",
    "status": "waived",
    "reason": "API owner-only visibility proven by test; no RLS by design (ADR-0023 decision 16)",
    "recorded_at": "2026-10-13T03:45:07.675Z",
    "resolved_at": "2026-10-13T04:50:57.537Z"
  },
  {
    "id": 117,
    "kind": "deviation",
    "phase": "07.2",
    "file": "packages/db/src/schema/memory.ts",
    "line": null,
    "description": "Personal bot notebook owner assumes a personal bot never changes owner or kind; recompute the owner if that ever changes",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-13T03:45:07.777Z",
    "resolved_at": null
  },
  {
    "id": 118,
    "kind": "deviation",
    "phase": "07.2",
    "file": "packages/db/src/schema/memory.ts",
    "line": null,
    "description": "A file moved across scopes keeps old revisions with the previous owner (conservative); 07.2-08 must account for it",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T03:45:07.876Z",
    "resolved_at": "2026-10-13T05:47:46.872Z"
  },
  {
    "id": 119,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/api/src/modules/policy/module-access-enforcement.int.test.ts",
    "line": null,
    "description": "testcontainers Redis port wait can time out under Docker load and fail verify once",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-13T03:45:07.976Z",
    "resolved_at": null
  },
  {
    "id": 120,
    "kind": "deviation",
    "phase": "07.2",
    "file": "compose.yaml",
    "line": null,
    "description": "The internal pii network is created by every compose project even with the profile off (uses Docker address pools); adding it recreates the api once on the next up",
    "status": "waived",
    "reason": "One internal network per stack is the accepted cost (D-08); the dev host had 30 networks from dead per-branch projects, cleaned to 16",
    "recorded_at": "2026-10-13T04:19:12.931Z",
    "resolved_at": "2026-10-13T15:20:56.912Z"
  },
  {
    "id": 121,
    "kind": "unrun-verify",
    "phase": "07.2",
    "file": "infra/presidio/recognizers.yaml",
    "line": null,
    "description": "Spanish Presidio accuracy only checked on fixed samples (missed a Spanish name in a probe); owner manual check on real documents",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-13T04:19:13.026Z",
    "resolved_at": null
  },
  {
    "id": 122,
    "kind": "deviation",
    "phase": "07.2",
    "file": "scripts/ocw.mjs",
    "line": null,
    "description": "No pnpm ocw enable pii: turning on the pii profile means editing .env by hand, unlike other profiles",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-13T04:19:13.134Z",
    "resolved_at": null
  },
  {
    "id": 123,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/openclaw-channel/src/memory-files-tool.ts",
    "line": null,
    "description": "/memory/* Agent Channel routes exist only in the fake API until 07.2-11; the real API would 404 (no turn offers the tools yet)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T04:30:05.478Z",
    "resolved_at": "2026-10-13T07:15:00.114Z"
  },
  {
    "id": 124,
    "kind": "deviation",
    "phase": "07.2",
    "file": "infra/openclaw",
    "line": null,
    "description": "No memory scenario in the real-cell smoke yet; add it in 07.2-15",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T04:30:05.563Z",
    "resolved_at": "2026-10-13T15:20:09.715Z"
  },
  {
    "id": 125,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/openclaw-channel/src/agent-channel-protocol.ts",
    "line": null,
    "description": "memoryFiles mirror uses the exact scopeKind enum: a new API scopeKind silently drops all files and falls back to legacy notes until the mirror is updated",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-13T04:30:05.650Z",
    "resolved_at": null
  },
  {
    "id": 126,
    "kind": "deviation",
    "phase": "07.2",
    "file": "packages/contracts/src/sensitive-data.ts",
    "line": null,
    "description": "detectSensitive returns unbounded spans while MemoryProposalView caps 200 spans / 50 findings; 07.2-09 must cap before building the view",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T04:39:23.084Z",
    "resolved_at": "2026-10-13T06:30:45.615Z"
  },
  {
    "id": 127,
    "kind": "deviation",
    "phase": "07.2",
    "file": "packages/contracts/src/sensitive-data.ts",
    "line": null,
    "description": "False positives (warn): any bare 9-digit number starting 6-9 is a phone; git@github.com:org/repo is an email; Luhn accepts 0000 0000 0000 0000",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-13T04:39:23.163Z",
    "resolved_at": null
  },
  {
    "id": 128,
    "kind": "deviation",
    "phase": "07.2",
    "file": "packages/contracts/src/sensitive-data.ts",
    "line": null,
    "description": "Keyed secrets (DB_PASSWORD=, Bearer, URL credentials): span and masked sample start at the key, so the UI highlight is wider than the value (no leak)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-13T04:39:23.242Z",
    "resolved_at": null
  },
  {
    "id": 129,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/api/src/modules/policy",
    "line": null,
    "description": "unit_has_memory counts only live files; soft-deleted files and pending proposals cascade with the unit; decide in 07.2-08/09",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T04:39:31.734Z",
    "resolved_at": "2026-10-13T05:47:47.036Z"
  },
  {
    "id": 130,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/api/src/modules/policy",
    "line": null,
    "description": "A standard owner of a team bot can write its notebook but not promote (memory.promote is lead/admin); needs an explicit product exception if wanted",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-13T04:39:31.819Z",
    "resolved_at": null
  },
  {
    "id": 131,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/api/src/modules/policy",
    "line": null,
    "description": "An agent decision with no human evaluates only the agent; 07.2-08 and 07.2-11 must always pass the human the agent acts for",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T04:39:31.902Z",
    "resolved_at": "2026-10-13T05:47:46.953Z"
  },
  {
    "id": 132,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/api/src/modules/approval",
    "line": null,
    "description": "Decisions mirrored onto a card do not send the usual card-updated notification to its followers",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-13T04:50:57.608Z",
    "resolved_at": null
  },
  {
    "id": 133,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/api/src/modules/approval",
    "line": null,
    "description": "Inbox list checks each row's decider rule one by one (up to 500 per page), so a page can come back short with a cursor",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T04:50:57.677Z",
    "resolved_at": "2026-10-13T09:48:45.635Z"
  },
  {
    "id": 134,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/api/src/modules/approval",
    "line": null,
    "description": "An apply that throws (instead of returning an error code) rolls back the whole decision and leaves the request pending",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-13T04:50:57.748Z",
    "resolved_at": null
  },
  {
    "id": 135,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/api/src/modules/approval",
    "line": null,
    "description": "An approved grant's card shows succeeded before the grant is used; decide in 07.5",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T04:50:57.827Z",
    "resolved_at": "2026-10-14T15:04:59.179Z"
  },
  {
    "id": 136,
    "kind": "deviation",
    "phase": "07.2",
    "file": "packages/db/src/schema",
    "line": null,
    "description": "The DB still allows changing a memory file's scope_id; moving across scopes is prevented only in the API",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T05:47:47.110Z",
    "resolved_at": "2026-10-13T10:56:27.250Z"
  },
  {
    "id": 137,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/api/src/modules/memory",
    "line": null,
    "description": "Pending proposals cascade with unit/bot/forgotten scope but their approval_requests rows stay; 07.2-09 must read a missing proposal as scope_gone, not 500",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T05:47:47.183Z",
    "resolved_at": "2026-10-13T06:30:45.684Z"
  },
  {
    "id": 138,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/api/src/modules/memory",
    "line": null,
    "description": "A deleted memory file cannot be restored over REST (restore works only on live files)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-13T05:47:47.259Z",
    "resolved_at": null
  },
  {
    "id": 139,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/api/src/modules/memory",
    "line": null,
    "description": "GET /memory/scopes writes: it lazily creates the org scope and missing unit scopes",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-13T05:47:47.334Z",
    "resolved_at": null
  },
  {
    "id": 140,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/api/src/modules/memory",
    "line": null,
    "description": "A 256 KiB body of escaped control chars exceeds Fastify's 1 MiB limit and returns Fastify's 413, not memory_file_too_large",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T05:47:47.411Z",
    "resolved_at": "2026-10-13T10:56:27.416Z"
  },
  {
    "id": 141,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/api/src/modules/memory/search.ts",
    "line": null,
    "description": "Memory search loads every readable file's content (listReadableFiles) per scope just to get ids, calls listScopes (which writes) and one permission pass per scope; heavy at scale — select ids only",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T06:29:37.690Z",
    "resolved_at": "2026-10-13T10:56:27.012Z"
  },
  {
    "id": 142,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/api/src/modules/memory/search.ts",
    "line": null,
    "description": "Snippet highlighting scans full content: up to 50 files x 3 configs x 256 KiB per search",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T06:29:37.759Z",
    "resolved_at": "2026-10-13T10:56:27.087Z"
  },
  {
    "id": 143,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/api/src/modules/memory/search.ts",
    "line": null,
    "description": "Path-only matches return an unmarked snippet; snippet helpers are duplicated from the chat search module",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T06:29:37.838Z",
    "resolved_at": "2026-10-13T07:35:47.307Z"
  },
  {
    "id": 144,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/api/src/modules/approval",
    "line": null,
    "description": "A proposal that disappears in a cascade leaves its approval request and card pending (fail-closed) until 14-day expiry; needs a 'gone' hook in the primitive to close it as failed/scope_gone",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T06:30:45.754Z",
    "resolved_at": "2026-10-13T10:56:26.855Z"
  },
  {
    "id": 145,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/api/src/modules/memory/proposals.ts",
    "line": null,
    "description": "Presidio runs inside the proposal transaction: up to 2 s holding the connection and advisory lock",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T06:30:45.823Z",
    "resolved_at": "2026-10-13T10:56:26.934Z"
  },
  {
    "id": 146,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/api/src/modules/memory/proposals.ts",
    "line": null,
    "description": "canDecide and audience are expensive per row (audience calls usersAllowed over all members); related to #133",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-13T06:30:45.892Z",
    "resolved_at": null
  },
  {
    "id": 147,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/api/src/modules/memory/proposals.ts",
    "line": null,
    "description": "Proposal view spans are layer 1 only (Presidio spans not stored; findings shown per line); requestedBy.agent is required, 07.6 will need it nullable",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-13T06:30:45.960Z",
    "resolved_at": null
  },
  {
    "id": 148,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/api/src/modules/agent-channel/memory-files.ts",
    "line": null,
    "description": "Agent memory list/read count against the turn limit only in the /tool-calls gate; the route does not check it",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T07:15:00.193Z",
    "resolved_at": "2026-10-13T10:56:27.168Z"
  },
  {
    "id": 149,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/api/src/modules/agent-channel/memory-files.ts",
    "line": null,
    "description": "Agent memory list costs one decision per file; each memory turn queries the bot notebook and decides twice in a DM (related to #139)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-13T07:15:00.266Z",
    "resolved_at": null
  },
  {
    "id": 150,
    "kind": "unrun-verify",
    "phase": "07.2",
    "file": "e2e/tests/bot-memory.spec.ts",
    "line": null,
    "description": "bot-capabilities.spec and bot-memory.spec not run after 07.2-11; the fake API never answers no_trigger, the 07.2-15 smoke should cover an expired-turn call",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T07:15:00.344Z",
    "resolved_at": "2026-10-13T15:20:09.783Z"
  },
  {
    "id": 151,
    "kind": "deviation",
    "phase": "07.2",
    "file": "packages/db/src/schema",
    "line": null,
    "description": "app.agent_memories is now dead data (notes live in the private MEMORY.md); dropping it needs a later migration once the backfill has been in production",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-13T07:15:00.428Z",
    "resolved_at": null
  },
  {
    "id": 152,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/api/src/modules/bot-capabilities/memory.ts",
    "line": null,
    "description": "Legacy notes share one createdAt (file mtime); a note refused for a secret reaches the model as 'not accepted' with no reason",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-13T07:15:00.503Z",
    "resolved_at": null
  },
  {
    "id": 153,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/web/components/memory",
    "line": null,
    "description": "The Proposals row links to /memory/proposals (built by 07.2-13, not-found until then) and on mobile shows for everyone, while the UI-SPEC limits it to deciders and proposers",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T07:35:47.377Z",
    "resolved_at": "2026-10-13T09:48:45.555Z"
  },
  {
    "id": 154,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/web/components/markdown",
    "line": null,
    "description": "axe heading-order (moderate) in the memory viewer: Markdown # renders as h3 under the breadcrumb h1; fix in the shared renderer",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T07:35:47.448Z",
    "resolved_at": "2026-10-13T11:20:21.727Z"
  },
  {
    "id": 155,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/web/components/organization",
    "line": null,
    "description": "Settings > Modules copy still says 'Work Zone, AI chats and bots' and does not name Memory; memory dates show '3 hours ago' instead of the spec's '3h ago'",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T07:35:47.519Z",
    "resolved_at": "2026-10-13T11:20:21.869Z"
  },
  {
    "id": 156,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/web/components/memory",
    "line": null,
    "description": "Revisions do not carry who approved them, so history shows 'Approved proposal' instead of 'Approved by {person}'",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T08:49:37.424Z",
    "resolved_at": "2026-10-13T09:48:45.713Z"
  },
  {
    "id": 157,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/web/lib/memory-queries.ts",
    "line": null,
    "description": "Team memory files do not update live: memory.changed reaches only the owner of private memory",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T08:49:37.498Z",
    "resolved_at": "2026-10-13T10:56:27.500Z"
  },
  {
    "id": 158,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/web/components/memory",
    "line": null,
    "description": "History paginates on the client (API returns all revisions); a file saved without a trailing newline shows an extra empty line in the diff",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-13T08:49:37.571Z",
    "resolved_at": null
  },
  {
    "id": 159,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/web/package.json",
    "line": null,
    "description": "lang-markdown pulls HTML/CSS/JS modes into the editor bundle; Cmd/Ctrl+S label uses deprecated navigator.platform",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-13T08:49:37.641Z",
    "resolved_at": null
  },
  {
    "id": 160,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/api/src/modules/approval",
    "line": null,
    "description": "The live card event is emitted before the card is linked to its approval (client works around it); the server should emit message.updated after linking. Expiry does not arrive live (card stays Pending until reload)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T08:49:54.347Z",
    "resolved_at": "2026-10-13T09:48:45.787Z"
  },
  {
    "id": 161,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/web/components/ui/dialog.tsx",
    "line": null,
    "description": "The shared Dialog close X is 32 px below 1024 (UI-SPEC asks 44)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T08:49:54.419Z",
    "resolved_at": "2026-10-13T11:20:21.799Z"
  },
  {
    "id": 162,
    "kind": "deviation",
    "phase": "07.2",
    "file": "e2e/tests/memory-files.spec.ts",
    "line": null,
    "description": "memory-files.spec depends on run order: it expects exact scopes for Sam and breaks once other specs leave private scopes of Sam in the shared DB",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T09:44:33.028Z",
    "resolved_at": "2026-10-13T11:20:21.651Z"
  },
  {
    "id": 163,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/api/src/modules/memory",
    "line": null,
    "description": "Private scopes of deleted bots still appear in /memory/scopes; the bot page waits for the full GET /agents list (no useAgent(id))",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T09:44:33.110Z",
    "resolved_at": "2026-10-13T10:56:27.334Z"
  },
  {
    "id": 164,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/api/src/modules/memory/approval-kind.ts",
    "line": null,
    "description": "Bot delete is soft, so its pending memory proposals stay live and a lead can approve them; the server would write on behalf of a deleted bot",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T09:48:45.861Z",
    "resolved_at": "2026-10-13T10:56:26.772Z"
  },
  {
    "id": 165,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/web/components/memory",
    "line": null,
    "description": "'No sensitive data found' next to 'Extended scan unavailable' can read as reassuring; review-memory-scopes-390 screenshot from 07.2-10 is stale (shows the now-hidden Proposals row)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T09:48:45.937Z",
    "resolved_at": "2026-10-13T11:20:21.939Z"
  },
  {
    "id": 166,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/api/src/modules/approval",
    "line": null,
    "description": "Requests orphaned before the gone path stay pending until expiry (no sweep); if removing a member ever cascades their personal scopes, that path does not call closeGone",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-13T10:56:27.581Z",
    "resolved_at": null
  },
  {
    "id": 167,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/api/src/modules/memory",
    "line": null,
    "description": "memory.changed: a rename only notifies readers of the new path; unit-scope writes emit one event per reader (a unit: topic would scale better); no e2e for live team-file updates",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-13T10:56:27.664Z",
    "resolved_at": null
  },
  {
    "id": 168,
    "kind": "deviation",
    "phase": "07.2",
    "file": "apps/api/src/modules/agent-channel",
    "line": null,
    "description": "Stored cell stream events keep private memory content (turn payloads) and forgetting a scope does not purge them",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-13T15:20:09.851Z",
    "resolved_at": null
  },
  {
    "id": 169,
    "kind": "deviation",
    "phase": "07.4",
    "file": "packages/db/src/schema/app.ts",
    "line": null,
    "description": "Cross-org ids: 07.4 FKs check ids only (RLS bypassed), so a row can reference another org's server/key/agent/template; the API must resolve every id inside withTenant (same pattern as bot_tool_grants)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T22:54:38.207Z",
    "resolved_at": "2026-10-14T08:44:37.392Z"
  },
  {
    "id": 170,
    "kind": "deviation",
    "phase": "07.4",
    "file": "packages/db/src/schema/app.ts",
    "line": null,
    "description": "No owner-only restrictive DB policy on personal keys or member connector connections (only tenant isolation); enforce owner-only in the API (07.4-07/10) and add a restrictive policy before the gate, as 07.2 did for personal memory",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T22:54:38.296Z",
    "resolved_at": "2026-10-14T02:33:13.571Z"
  },
  {
    "id": 171,
    "kind": "deviation",
    "phase": "07.4",
    "file": "packages/db/src/schema/app.ts",
    "line": null,
    "description": "Template versions are immutable only in the API (no trigger); share resource_id has no FK so deleting a connector or key leaves an inert share row",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T22:54:38.389Z",
    "resolved_at": "2026-10-14T00:55:32.808Z"
  },
  {
    "id": 172,
    "kind": "deviation",
    "phase": "07.4",
    "file": "packages/db/src/schema/app.ts",
    "line": null,
    "description": "vault_items.secret_ref accepts env/file/openbao providers in the DB; D-07 db-only must be enforced by the API; SecretsService.putSealed must accept connector_credential and vault_item (07.4-07/10)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T22:54:38.476Z",
    "resolved_at": "2026-10-14T00:13:09.654Z"
  },
  {
    "id": 173,
    "kind": "deviation",
    "phase": "07.4",
    "file": "infra/fake-model/fake-mcp-oauth.mjs",
    "line": null,
    "description": "The fake shares DCR/CIMD clients across issuers (main and alt); 07.4-10 must prove in the API that client credentials are never reused across issuers; default cimdFetch never runs in tests",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T22:56:12.635Z",
    "resolved_at": "2026-10-14T00:13:21.114Z"
  },
  {
    "id": 174,
    "kind": "deviation",
    "phase": "07.4",
    "file": ".planning/phases/07.4-per-member-connectors-agent-keychain-and-templates/07.4-VALIDATION.md",
    "line": null,
    "description": "Plans and VALIDATION use 'node --test infra/fake-model/' which Node 24 treats as a file; use the glob form",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T22:56:12.721Z",
    "resolved_at": "2026-10-14T04:20:55.677Z"
  },
  {
    "id": 175,
    "kind": "deviation",
    "phase": "07.4",
    "file": "apps/api/src/lib/egress.ts",
    "line": null,
    "description": "MCP SDK OAuth helpers and transports fall back to global fetch without fetchFn and no rule catches the missing argument; every 07.4 SDK call must pass egress.bound(policy) (check in 07.4-10/11 and the gate)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T22:56:48.885Z",
    "resolved_at": "2026-10-14T02:33:13.785Z"
  },
  {
    "id": 176,
    "kind": "deviation",
    "phase": "07.4",
    "file": "apps/api/src/lib/egress.ts",
    "line": null,
    "description": "One undici Agent per request (no keep-alive reuse); privateAllow tested only up to the connect attempt",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-13T22:56:48.969Z",
    "resolved_at": null
  },
  {
    "id": 177,
    "kind": "deviation",
    "phase": "07.4",
    "file": "packages/contracts/src/module-access.ts",
    "line": null,
    "description": "HIGH: units/orgs with Bots already off hold the old 5 deny rules; the catalog now has 7, so the API reads them as custom and does not deny connector.connect / vault.use until Bots is toggled again; needs a backfill migration",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T23:06:14.969Z",
    "resolved_at": "2026-10-14T08:44:36.959Z"
  },
  {
    "id": 178,
    "kind": "deviation",
    "phase": "07.4",
    "file": "packages/contracts/src/mcp.ts",
    "line": null,
    "description": "memberHeaderName is not checked against forbidden headers in the schema (import cycle); 07.4-06 and 07.4-10 must apply isAllowedInjectionHeader() on the server",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-13T23:06:15.041Z",
    "resolved_at": "2026-10-14T00:54:30.968Z"
  },
  {
    "id": 179,
    "kind": "deviation",
    "phase": "07.4",
    "file": "apps/api/src/modules/mcp",
    "line": null,
    "description": "CIMD is chosen even when the AS cannot read the document (e.g. internal CA); 07.4-10 must allow preferring DCR or pre-registration; servers without RFC 9728 metadata cannot be connected per member",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T00:00:48.322Z",
    "resolved_at": "2026-10-14T02:33:13.713Z"
  },
  {
    "id": 180,
    "kind": "deviation",
    "phase": "07.4",
    "file": "apps/api/src/modules/mcp",
    "line": null,
    "description": "No positive SSE round-trip test (fake speaks only streamable HTTP); MCP session not closed with DELETE after a timeout; revokeToken Basic-encodes client id/secret (SDK does not)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-14T00:00:48.417Z",
    "resolved_at": null
  },
  {
    "id": 181,
    "kind": "deviation",
    "phase": "07.4",
    "file": "apps/api/src/modules/keychain",
    "line": null,
    "description": "OAuth keychain token URLs must be https but the e2e fake on :4291 is http; 07.4-13/14 need an https fake or a test-host exemption",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-14T00:13:09.756Z",
    "resolved_at": null
  },
  {
    "id": 182,
    "kind": "deviation",
    "phase": "07.4",
    "file": "packages/db/sql/post-migrate.sql",
    "line": null,
    "description": "agent_vault_grants has no owner-only policy: grants on personal keys (ids only) are visible to any session in the org",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T00:13:09.855Z",
    "resolved_at": "2026-10-14T08:44:37.030Z"
  },
  {
    "id": 183,
    "kind": "deviation",
    "phase": "07.4",
    "file": "apps/api/src/modules/keychain",
    "line": null,
    "description": "07.4-11 must run keychain use with the turn's human as the RLS user (never no user or another member); CODEOWNERS does not cover modules/keychain; client-credentials token cache is per process (not in an ADR)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T00:13:09.951Z",
    "resolved_at": "2026-10-14T02:01:27.888Z"
  },
  {
    "id": 184,
    "kind": "deviation",
    "phase": "07.4",
    "file": "apps/openclaw-channel/src/connector-tools.ts",
    "line": null,
    "description": "07.4-11 must put the three static tool names (never logical m…__tool names) in the /cell snapshot alsoAllow; only a 20 s connector call was proven in the real cell (add a 30 s case to the ADR-0025 checklist); tool descriptions from ocw_connector_list do not taint the turn",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T00:27:30.749Z",
    "resolved_at": "2026-10-14T02:01:27.974Z"
  },
  {
    "id": 185,
    "kind": "deviation",
    "phase": "07.4",
    "file": "infra/openclaw/test/run-container-smoke.sh",
    "line": null,
    "description": "Without SMOKE_BUILD the marketplace scenario fails on macOS Docker Desktop (docker cp leaves install-policy.mjs as uid 501); CI unaffected",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-14T00:27:30.826Z",
    "resolved_at": null
  },
  {
    "id": 186,
    "kind": "deviation",
    "phase": "07.4",
    "file": "packages/db/sql/post-migrate.sql",
    "line": null,
    "description": "If #170 adds an owner-only policy on connector_connections, the admin member count and clear-on-switch/delete will only see the admin's rows and leave other members' credentials behind silently; that policy needs an mcp.manage path (07.4-10)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T00:54:31.051Z",
    "resolved_at": "2026-10-14T02:33:13.642Z"
  },
  {
    "id": 187,
    "kind": "deviation",
    "phase": "07.4",
    "file": "apps/web/components/ui/badge.tsx",
    "line": null,
    "description": "Shared Badge warning variant fails contrast in light mode (1.91:1); 'Probing' still uses it; PanelDialog close is 32 px at 390",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T00:54:31.132Z",
    "resolved_at": "2026-10-14T04:12:43.848Z"
  },
  {
    "id": 188,
    "kind": "deviation",
    "phase": "07.4",
    "file": "e2e/support/a11y.ts",
    "line": null,
    "description": "The a11y helper waits for infinite animations (pulse, spinner, skeleton) and hangs to timeout; specs cancel them before axe; fix in the helper",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T00:55:32.882Z",
    "resolved_at": "2026-10-14T04:12:43.932Z"
  },
  {
    "id": 189,
    "kind": "deviation",
    "phase": "07.4",
    "file": "apps/web/components/bots",
    "line": null,
    "description": "Template 'Connect' links point to /settings/connections (built by 07.4-13); the empty state copy above Templates predates templates; skip notices are generic (no effective value in the contract)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T00:55:32.956Z",
    "resolved_at": "2026-10-14T04:12:43.768Z"
  },
  {
    "id": 190,
    "kind": "deviation",
    "phase": "07.4",
    "file": ".github/CODEOWNERS",
    "line": null,
    "description": "CODEOWNERS does not cover apps/api/src/modules/keychain (and the new connectors module); client-credentials token cache is per process, record in ADR-0025; prove a 30 s connector call in the real cell in 07.4-14",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T02:01:28.061Z",
    "resolved_at": "2026-10-14T08:44:37.104Z"
  },
  {
    "id": 191,
    "kind": "deviation",
    "phase": "07.4",
    "file": "apps/api/src/modules/keychain",
    "line": null,
    "description": "DECISION NEEDED in 07.4-12/14: unit keys are offered in public channels and shared AI chats, so results fetched with a unit's key can reach people outside the unit; apply the audience rule (every reader inside the unit) as memory does",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T02:01:28.146Z",
    "resolved_at": "2026-10-14T04:20:45.906Z"
  },
  {
    "id": 192,
    "kind": "deviation",
    "phase": "07.4",
    "file": "apps/openclaw-channel/src/tool-guard.ts",
    "line": null,
    "description": "Plugin local gate uses fixed list flags: after a list it lets a local write through and the API refuses it as tainted (safe, less precise message); /tool-calls still opens its tx with no user",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-14T02:01:28.231Z",
    "resolved_at": null
  },
  {
    "id": 193,
    "kind": "deviation",
    "phase": "07.4",
    "file": "apps/api/src/modules/connectors",
    "line": null,
    "description": "On issuer_changed or any terminal failure the credential is dropped without revoking at the old issuer (live until expiry); concurrent DCR registrations for one issuer leave the loser orphaned at the provider; each refresh rediscovers the provider (2 extra requests)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T02:33:13.855Z",
    "resolved_at": "2026-10-14T08:44:37.462Z"
  },
  {
    "id": 194,
    "kind": "deviation",
    "phase": "07.4",
    "file": "apps/api/src/modules/connectors",
    "line": null,
    "description": "conversationName is null for DMs and groups, so the UI would show 'a conversation you can no longer open'; a single member's probe failure puts the whole server in error",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T02:33:13.926Z",
    "resolved_at": "2026-10-14T04:20:45.978Z"
  },
  {
    "id": 195,
    "kind": "deviation",
    "phase": "07.4",
    "file": "packages/db/sql/post-migrate.sql",
    "line": null,
    "description": "connector_credential secrets are readable as ciphertext by any session in the org (AAD binds them to the member); CIMD proven only up to the client_id in the authorization URL",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-14T02:33:13.999Z",
    "resolved_at": null
  },
  {
    "id": 196,
    "kind": "deviation",
    "phase": "07.4",
    "file": "apps/web/components/settings",
    "line": null,
    "description": "With Bots off the Connections page does not allow disconnect although the API does; ReadersPreview lacks the unit name (unbounded line always says 'Everyone in the organization'); Re-probe toast on needs_reconnect says 'Connect … first'",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T04:12:44.017Z",
    "resolved_at": "2026-10-14T08:44:37.177Z"
  },
  {
    "id": 197,
    "kind": "deviation",
    "phase": "07.4",
    "file": "apps/web/components/devices-settings.tsx",
    "line": null,
    "description": "devices-settings.tsx:325 and work-zone/meta.tsx:166 use text-warning by hand and probably fail AA; agent-templates.spec still cancels animations by hand",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T04:12:44.094Z",
    "resolved_at": "2026-10-14T08:44:37.252Z"
  },
  {
    "id": 198,
    "kind": "deviation",
    "phase": "07.4",
    "file": "apps/openclaw-channel/src/connector-tools.ts",
    "line": null,
    "description": "For needs_reconnect the plugin says 'You haven't connected…' (should say reconnect); a unit key held back by the audience rule gives the bot no explanation; each connector call opens a new MCP session",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T04:20:46.057Z",
    "resolved_at": "2026-10-14T08:44:37.322Z"
  },
  {
    "id": 199,
    "kind": "deviation",
    "phase": "07.4",
    "file": "apps/web/components/markdown",
    "line": null,
    "description": "In-app links in chat Markdown open a new tab (all chat links do); ReadersPreview still lacks the unit name; the cell smoke needs the plugin built first in a fresh worktree",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-14T08:44:37.532Z",
    "resolved_at": null
  },
  {
    "id": 200,
    "kind": "deviation",
    "phase": "07.5",
    "file": "packages/db/drizzle",
    "line": null,
    "description": "The column list in SET NULL (col) is not in the drizzle snapshot; a future migration recreating those FKs would emit a plain SET NULL and deletes would fail on organization_id NOT NULL",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-14T13:26:02.622Z",
    "resolved_at": null
  },
  {
    "id": 201,
    "kind": "deviation",
    "phase": "07.5",
    "file": "packages/db/sql/post-migrate.sql",
    "line": null,
    "description": "Immutability triggers on the stored tool action and Work Zone proposal do not cover TRUNCATE; add REVOKE TRUNCATE in post-migrate.sql",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T13:26:02.702Z",
    "resolved_at": "2026-10-15T12:01:48.221Z"
  },
  {
    "id": 202,
    "kind": "deviation",
    "phase": "07.5",
    "file": "packages/db/src/schema/app.ts",
    "line": null,
    "description": "conversation_id, event_id and requested_for_user_id on 07.5 tables have no FK; 07.5-07/08 must resolve them inside withTenant",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T13:26:02.781Z",
    "resolved_at": "2026-10-15T07:15:02.121Z"
  },
  {
    "id": 203,
    "kind": "deviation",
    "phase": "07.5",
    "file": "packages/contracts/src/agent-card-route.ts",
    "line": null,
    "description": "Stubs until later plans: toPrompt proposedBy is always null (07.5-08 wires it); the memory inbox shows 07.5 approvals title-only (07.5-12 filters by kind); the '/approvals' route prefix grep now targets agent-card-route.ts",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T14:00:24.659Z",
    "resolved_at": "2026-10-14T19:14:34.707Z"
  },
  {
    "id": 204,
    "kind": "deviation",
    "phase": "07.5",
    "file": "apps/api/src/modules/approval",
    "line": null,
    "description": "A server_apply decision via /approvals by someone who cannot read the conversation still starts (and meters) a bot turn for that decider (bot reply is refused); an unused grant keeps a running card forever; the pending total stops at 1000 scanned rows",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T15:04:59.297Z",
    "resolved_at": "2026-10-15T12:01:48.298Z"
  },
  {
    "id": 205,
    "kind": "deviation",
    "phase": "07.5",
    "file": "apps/api/src/modules/work-session/routes.ts",
    "line": null,
    "description": "The HTTP route's 'lower to the default mode' is dead code: Zod defaults permissionMode to 'default', so a member limited to plan who starts a session without picking a mode gets 403 device_grant instead of a plan session (only proposals lower)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T15:32:46.937Z",
    "resolved_at": "2026-10-15T12:01:48.375Z"
  },
  {
    "id": 206,
    "kind": "deviation",
    "phase": "07.5",
    "file": "packages/contracts/src/sensitive-data.test.ts",
    "line": null,
    "description": "The linear-time ratio test (<8x) failed once at 10.42x with load average 18 (parallel executors); consider a looser ratio or more samples",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T15:32:47.075Z",
    "resolved_at": "2026-10-15T12:01:48.982Z"
  },
  {
    "id": 207,
    "kind": "deviation",
    "phase": "07.5",
    "file": "apps/api/src/modules/tool-approval",
    "line": null,
    "description": "DECIDED (fix in gate): deleting a unit cascades its tool approval policies with no tool_approval_policy.deleted audit (principle 12); answer 409 unit_has_policies as for keys and templates",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T15:40:25.353Z",
    "resolved_at": "2026-10-15T12:01:48.144Z"
  },
  {
    "id": 208,
    "kind": "deviation",
    "phase": "07.5",
    "file": "apps/api/src/modules/tool-approval",
    "line": null,
    "description": "History query has no audit_events index on (action, scopeUnitId); silent caps: /access 500 units, catalog 200 tools/group and 100 groups; a 'users' rule whose people are gone must count as no approver in 07.5-07 canDecide",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-14T15:40:25.495Z",
    "resolved_at": null
  },
  {
    "id": 209,
    "kind": "unrun-verify",
    "phase": "07.5",
    "file": "apps/openclaw-channel/src/tool-guard.ts",
    "line": null,
    "description": "The TOOL_PIN_PRIORITY pin relies on OpenClaw 2026.9.7 'last returned params win' (assumption A2), unverified; a plugin registered below -10000 could rewrite after the pin; the 07.5-15 real-cell smoke must record it",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T15:58:17.312Z",
    "resolved_at": "2026-10-15T12:01:48.826Z"
  },
  {
    "id": 210,
    "kind": "deviation",
    "phase": "07.5",
    "file": "apps/openclaw-channel/src/connector-tools.ts",
    "line": null,
    "description": "Denial note parsed from the end of the server sentence (no cardAction.note in contracts); approval_denied does not say who decided; flagged connector tools still use the old 32 KB message; fake /tool-calls never answers no_trigger",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T15:58:17.419Z",
    "resolved_at": "2026-10-15T05:03:39.191Z"
  },
  {
    "id": 211,
    "kind": "deviation",
    "phase": "07.5",
    "file": "apps/api/src/modules/tool-approval",
    "line": null,
    "description": "MUST FIX (07.5-11/gate): a review_only tool.call card still carries Approve and the server accepts an approval from the card route; only the web hides it. Refuse server-side",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T17:45:03.509Z",
    "resolved_at": "2026-10-15T05:03:39.033Z"
  },
  {
    "id": 212,
    "kind": "deviation",
    "phase": "07.5",
    "file": "apps/api/src/modules/tool-approval",
    "line": null,
    "description": "07.5-11 must map denial {deciderName, note} onto the 409 and add an explicit cardAction note to contracts + plugin mirror (replace sentence parsing); 'You can't approve your own request' copy must follow viewerCan; real use window is min(15 min, request expiry); review view counts readers with one check per member",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T17:45:03.593Z",
    "resolved_at": "2026-10-15T05:03:39.115Z"
  },
  {
    "id": 213,
    "kind": "deviation",
    "phase": "07.5",
    "file": "apps/api/src/testing.ts",
    "line": null,
    "description": "Test Redis containers leak (208 redis:8 found running, 1-2 h old): TestStack.stop() awaits built.close() before stopping containers, so a throwing close skips redis.stop(); make it try/finally and check why Ryuk did not reap them (fix in the 07.5 gate)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T17:47:21.500Z",
    "resolved_at": "2026-10-15T12:01:48.525Z"
  },
  {
    "id": 214,
    "kind": "unrun-verify",
    "phase": "07.5",
    "file": "apps/openclaw-channel/src/work-zone-tools.ts",
    "line": null,
    "description": "Work Zone proposal tools unproven in a real cell (alsoAllow, model use, taint refusal) and only tested against the fake; 07.5-15 must run SMOKE_ONLY=work_zone and an API parity test after 07.5-08; import cycle tool-guard <-> work-zone-tools (harmless, commented)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T17:49:14.525Z",
    "resolved_at": "2026-10-15T12:01:48.903Z"
  },
  {
    "id": 215,
    "kind": "deviation",
    "phase": "07.5",
    "file": "apps/api/src/modules/work-session",
    "line": null,
    "description": "When a Work Zone proposal Start fails the bot hears 'approved' without the error code (add resultCode to CardAction); each Work Zone card read recomputes its live state with several queries",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T18:19:32.619Z",
    "resolved_at": "2026-10-15T05:03:39.267Z"
  },
  {
    "id": 216,
    "kind": "deviation",
    "phase": "07.5",
    "file": "apps/web/components/ui/avatar.tsx",
    "line": null,
    "description": "Shared avatar initials are 4.25-4.48:1 at 12 px (below AA, axe flaky by random id); move text from *-700 to *-800",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-14T18:27:17.175Z",
    "resolved_at": "2026-10-15T07:14:53.085Z"
  },
  {
    "id": 217,
    "kind": "deviation",
    "phase": "07.5",
    "file": "apps/web/components/settings",
    "line": null,
    "description": "Approval history shows a raw m…__* pattern for a rule on a deleted server; the policies page does not warn when /access or the catalog are truncated",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-14T18:27:17.253Z",
    "resolved_at": null
  },
  {
    "id": 218,
    "kind": "deviation",
    "phase": "07.5",
    "file": "apps/web/components/approvals",
    "line": null,
    "description": "Mobile shows 'Approvals' twice (top bar and back link, per UI-SPEC); 'To review' sorts client-side over loaded pages; the e2e fake cell answers approval_* without the plugin's fixed sentences",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-14T19:14:27.881Z",
    "resolved_at": null
  },
  {
    "id": 219,
    "kind": "unrun-verify",
    "phase": "07.5",
    "file": "apps/api/src/modules/agent-channel",
    "line": null,
    "description": "Approval card posted inside the claim transaction (<2 s measured) needs a concurrent-channel contention test (07.5-16); connector grant names the logical tool while the bot calls ocw_connector_call, unproven in a real cell (07.5-15 smoke); fake MCP has no 5xx after a consumed grant",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-15T05:03:39.342Z",
    "resolved_at": null
  },
  {
    "id": 220,
    "kind": "deviation",
    "phase": "07.5",
    "file": "apps/api/src/modules/agent-channel",
    "line": null,
    "description": "An ocw_http_request URL normalised differently counts as a different action and opens a new approval; plugin failure texts duplicate the UI-SPEC copy",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-15T05:03:39.415Z",
    "resolved_at": null
  },
  {
    "id": 221,
    "kind": "deviation",
    "phase": "07.5",
    "file": "apps/api/src/modules/tool-approval/kind.ts",
    "line": null,
    "description": "The tool.call 'target' field carries the internal MCP server name (e.g. mc4866abe); hide it in the API view and the 07.5-14 card",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-15T06:05:38.732Z",
    "resolved_at": "2026-10-15T07:14:53.016Z"
  },
  {
    "id": 222,
    "kind": "deviation",
    "phase": "07.5",
    "file": "apps/api/src/modules/realtime",
    "line": null,
    "description": "A diagnostic run hit 'deadlock detected' writing to a user: stream, failing a bot reply with 500 (investigate in 07.5-16)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-15T06:05:38.809Z",
    "resolved_at": "2026-10-15T06:39:02.837Z"
  },
  {
    "id": 223,
    "kind": "deviation",
    "phase": "07.5",
    "file": "e2e/tests",
    "line": null,
    "description": "Decided approvals stay in the run's DB; specs must filter by their own ids; the phone top bar lacks the Approvals count the UI-SPEC asks for",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-15T06:05:38.884Z",
    "resolved_at": "2026-10-15T12:01:48.747Z"
  },
  {
    "id": 224,
    "kind": "deviation",
    "phase": "07.5",
    "file": "apps/api/src/modules/approval/service.ts",
    "line": null,
    "description": "Remaining lock-order risks (not reproduced): a server_apply approval (e.g. memory) still notifies user: streams before the conversation; notifications notify in recipient order, not ascending; no retry on 40P01",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-15T06:38:56.276Z",
    "resolved_at": "2026-10-15T12:01:48.451Z"
  },
  {
    "id": 225,
    "kind": "deviation",
    "phase": "07.5",
    "file": "apps/api/src/testing.ts",
    "line": null,
    "description": "ConnectorsStack.stop(): a throwing stop leaves the fake server open and a half-built stack leaves containers alive (same family as the Redis leak); grants bind to the action not the bot run, so Sam's next normal turn may use it once (state in ADR-0026)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-15T06:38:56.352Z",
    "resolved_at": "2026-10-15T12:01:48.599Z"
  },
  {
    "id": 226,
    "kind": "deviation",
    "phase": "07.5",
    "file": "apps/web/components/chat/agent-card.tsx",
    "line": null,
    "description": "A live linked card grows when its approval link arrives and the list does not stay pinned to the bottom (on mobile the card end hides under the composer); requester name and runtime are parsed from server text (add requesterName/runtime to AgentCardApprovalLink); warnings are classified by exact copy match",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-15T07:14:53.155Z",
    "resolved_at": "2026-10-15T12:01:48.673Z"
  },
  {
    "id": 227,
    "kind": "deviation",
    "phase": "07.5",
    "file": "apps/web/components/chat/composer.tsx",
    "line": null,
    "description": "Composer hint text is under AA contrast; e2e specs share one DB so fixture names collide across phases; e2e specs reading response bodies across a navigation can hang",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-15T12:01:49.057Z",
    "resolved_at": null
  },
  {
    "id": 228,
    "kind": "deviation",
    "phase": "07.5",
    "file": "apps/openclaw-channel/src/tool-guard.ts",
    "line": null,
    "description": "Pin limits (ADR-0026): a plugin registered below -10000 or one answering OpenClaw's own approval first can still beat TOOL_PIN_PRIORITY",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-15T12:01:49.128Z",
    "resolved_at": null
  },
  {
    "id": 229,
    "kind": "deviation",
    "phase": "07.5",
    "file": "apps/api/src/modules/approval",
    "line": null,
    "description": "After #204 the bot does not hear decisions made from /approvals by someone outside the conversation; Work Zone Start has no applyTopics; cards still parse requester and runtime from server text",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-15T12:01:49.197Z",
    "resolved_at": null
  },
  {
    "id": 230,
    "kind": "deviation",
    "phase": "07.8",
    "file": "packages/db/src/schema/app.ts",
    "line": null,
    "description": "Hard-deleting a bot removes its browser_sessions rows but leaves their browser_session secrets; revoke/purge/sweeper in 07.8-21/27 must delete them; nothing cleans browser_sessions when a member leaves the org",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-15T15:08:27.289Z",
    "resolved_at": "2026-10-22T05:37:51.070Z"
  },
  {
    "id": 231,
    "kind": "deviation",
    "phase": "07.8",
    "file": "packages/db/src/schema/app.ts",
    "line": null,
    "description": "DECIDE in 07.8-18: the app role can change an approved sandbox package's pinned fields (sha256, tree_sha256, lockfile, dependency_count, review_token); add an immutability trigger after approval. Every new secret kind now needs a migration (secrets_kind_check), note in ADR-0029",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-15T15:08:27.379Z",
    "resolved_at": "2026-10-21T20:12:08.062Z"
  },
  {
    "id": 232,
    "kind": "deviation",
    "phase": "07.8",
    "file": "packages/contracts/src/sandbox.ts",
    "line": null,
    "description": "Wiring left for later plans: turn.activity not registered in realtime EventTypes (07.8-10); SandboxdContextInput.events is loose until tightened to LiveInputFrame (07.8-16); PATCH /agents/:id/capabilities ignores sandbox/browser until 07.8-15",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-15T15:10:12.850Z",
    "resolved_at": "2026-10-22T03:47:11.925Z"
  },
  {
    "id": 233,
    "kind": "deviation",
    "phase": "07.8",
    "file": "packages/contracts/src/sandbox.ts",
    "line": null,
    "description": "File upload/download/import travel as base64 JSON up to 50 MiB (~67 MiB on the wire): check the body limit or stream (07.8-09/11); cap_reached/tainted answer 403 here vs 409 on 07.4 connector routes, unify in 05/10/14; npm lockfiles with sha1-only integrity fail PackageTreeEntry, refuse with a reason in 17/18",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-15T15:10:12.922Z",
    "resolved_at": "2026-10-21T20:12:08.140Z"
  },
  {
    "id": 234,
    "kind": "deviation",
    "phase": "07.8",
    "file": "packages/db/src/schema/app.ts",
    "line": null,
    "description": "MUST (07.8-21): app.message_cards kind check and Drizzle enum accept only the 8 old kinds; a sign-in ('browser') card cannot be stored until a new migration (chained after 07.8-02) adds it. ApprovalToolSourceKind lacks a sandbox/browser source (07.8-14; update SOURCE_ICON)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-15T15:23:46.137Z",
    "resolved_at": "2026-10-22T05:37:50.996Z"
  },
  {
    "id": 235,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/sandboxd/src",
    "line": null,
    "description": "sandboxd: running processes tracked in memory only (unpollable after a restart, still end at timeout); /tmp/ocw-proc group files not removed; runtime_unavailable and docker_too_old share docker_unavailable; diskBytes 0 until 07.8-09",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-15T16:42:21.790Z",
    "resolved_at": null
  },
  {
    "id": 236,
    "kind": "deviation",
    "phase": "07.8",
    "file": "infra/sandbox",
    "line": null,
    "description": "sbx apt versions approved but not pinned in the Dockerfile (later builds pick newer security versions); gVisor path proven by unit tests only until the 07.8-24 CI job; CODEOWNERS lacks apps/sandboxd (07.8-29)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-15T16:42:21.880Z",
    "resolved_at": null
  },
  {
    "id": 237,
    "kind": "deviation",
    "phase": "07.8",
    "file": "infra/sandbox/brw",
    "line": null,
    "description": "brw: iframes are outside the snapshot (screenshot masks them whole after human input); a page that rebuilds an input after typing loses the human-typed marker (password type fields stay redacted); live frames to other viewers are unmasked, F-5/U-2 must hold in the API (07.8-16)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-15T16:43:10.209Z",
    "resolved_at": "2026-10-22T03:47:11.846Z"
  },
  {
    "id": 238,
    "kind": "deviation",
    "phase": "07.8",
    "file": "infra/sandbox/brw",
    "line": null,
    "description": "sandboxd (07.8-13) must strip the context-id tag from type-0 frames and map the new brw codes (paused, internal, maskRects, resize mode); brw proven on arm64 Docker Desktop only, amd64 runc and the gVisor CI job remain (07.8-24); apt not pinned to a snapshot",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-15T16:43:10.294Z",
    "resolved_at": null
  },
  {
    "id": 239,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/openclaw-channel/src",
    "line": null,
    "description": "API does not send CellProvider.imageModels or turn.maxSandboxCalls yet (07.8-05/14): screenshot reaches no model and the gate uses default 40; sign-in skipped/expired sentences unwired (07.8-21); OpenClaw image rescaling (imageMaxDimensionPx) untested (8x8 fake JPEG, 07.8-13/28)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-15T16:49:17.151Z",
    "resolved_at": "2026-10-22T09:00:45.076Z"
  },
  {
    "id": 240,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/api/src/modules/agent-channel",
    "line": null,
    "description": "6 offered sandbox tools have no API route until 07.8-10 (404); confirm GET /cell alsoAllow carries ocw_sandbox_*/ocw_browser_* (plugin withTurnScopedTools); 403 (sandbox/board) vs 409 (07.4 connectors) refusal split: align or record in ADR-0029",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-15T17:21:21.782Z",
    "resolved_at": "2026-10-15T22:12:53.756Z"
  },
  {
    "id": 241,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/api/src/modules/sandbox",
    "line": null,
    "description": "Orphan 'starting' reservation rows (API dies between reserve and ensure) hold a cap slot until cleaned (07.8-11); kill does not push policy {killed:true} to sandboxd nor bump settings version (07.8-11); sandbox approval cards read 'Web request' (07.8-14); OCW_SANDBOX_URL/TOKEN missing in e2e-isolated.sh, .woodpecker, compose, .env.example (07.8-08/24)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-15T17:21:21.854Z",
    "resolved_at": "2026-10-15T21:29:54.137Z"
  },
  {
    "id": 242,
    "kind": "deviation",
    "phase": "07.8",
    "file": "scripts/guard/guard.test.mjs",
    "line": null,
    "description": "guard.test.mjs (Semgrep rule tests) runs neither in CI nor pnpm verify; ocw.raw-egress covers only apps/sandboxd/src/egress; CODEOWNERS lacks packages/egress-policy and apps/sandboxd/src/egress",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-15T18:33:30.173Z",
    "resolved_at": null
  },
  {
    "id": 243,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/sandboxd/src/egress/proxy.ts",
    "line": null,
    "description": "Egress proxy: public mode proven by unit tests only (real egress in 07.8-13/24); no per-network tunnel limit; platform names refused by name (not resolved)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-15T18:33:30.267Z",
    "resolved_at": null
  },
  {
    "id": 244,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/api/src/modules/sandbox",
    "line": null,
    "description": "Pending purges and policy re-push after a sandboxd restart reach only orgs with events or a failed purge in this process (needs a SECURITY DEFINER org list or a sandboxd boot event); no 'crashed' stop reason in contract/DB; egress audit hourly dedupe queries audit_events metadata without an index; the event consumer holds a pool connection; fake sandboxd stores files as UTF-8 text (breaks binaries)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-15T21:29:49.204Z",
    "resolved_at": null
  },
  {
    "id": 245,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/api/src/modules/agent-channel",
    "line": null,
    "description": "Sandbox activity steps never carry approvalMessageRoute (07.8-14/20); bot_turn_activity.running stays true for a turn that never replies, web live label needs a timeout (07.8-20); a write body over Fastify's 2 MiB limit returns Fastify's 413 not too_large; shared images show as downloads, no preview (07.8-25); fake sandboxd codes (404 read folder, 409 busy delete) to check against the real one (07.8-08/09)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-15T22:12:53.836Z",
    "resolved_at": null
  },
  {
    "id": 246,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/sandboxd/src",
    "line": null,
    "description": "MUST FIX (fail-open): sandboxd keeps policy, kill state and disk_full in memory; after a sandboxd restart the defaults apply (2 GiB, 15 min idle, NOT killed) until the API re-pushes, and the API only re-pushes for orgs with events. Fix: sandboxd refuses ensure/restart for an org with no policy (409 policy_missing) and the API pushes policy then retries; plus a boot event",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-15T22:14:34.757Z",
    "resolved_at": "2026-10-21T20:35:29.061Z"
  },
  {
    "id": 247,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/sandboxd/src",
    "line": null,
    "description": "Soft quota counts apparent size (sparse files in full) and may overshoot up to one 60 s sweep (document XFS hard quota at the gate); transfers hold ~67 MiB JSON + 50 MiB decoded in memory, two at once; after a sandboxd restart a running background process no longer prevents idling; a container death during the watcher's 2 s reconnect is not reported; OCW_SANDBOXD_SWEEP_MS needs compose and env parity (07.8-24)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-15T22:14:34.840Z",
    "resolved_at": "2026-10-22T04:13:28.623Z"
  },
  {
    "id": 248,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/api/src/modules/agent-channel",
    "line": null,
    "description": "When the org is killed or switched off the bot is not offered the sandbox tool and cannot say why (add a withheld reason killed/sandbox_off, 07.8-10/14/19); a message 1-2 s after a member turns Sandbox on can still get 'not offered' (UI should show applying, 07.8-15); cell-proof.sh PROOF_BUILD=1 still builds the demo's :local tags; e2e-reset.sh label cleanup untested locally",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-15T22:38:49.256Z",
    "resolved_at": null
  },
  {
    "id": 249,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/api/src/modules/browser",
    "line": null,
    "description": "MUST FIX (D-11 floor): when an admins/unit_leads 07.5 policy applies to ocw_browser_act, those approvers decide a member's signed-in action instead of the member; signed-in acts must always need the requesting member's approval",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-21T19:53:39.333Z",
    "resolved_at": "2026-10-21T20:35:28.921Z"
  },
  {
    "id": 250,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/api/src/modules/browser",
    "line": null,
    "description": "act answers download:null until 07.8-25; a session counts as loaded by session_id but stored state is not passed to sandboxd until 07.8-21; kill does not close browser contexts in its own tx (rows stay open if sandboxd is down); image-capable model list is hand-kept; approval chip icons reuse package/globe",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-21T19:53:39.439Z",
    "resolved_at": null
  },
  {
    "id": 251,
    "kind": "deviation",
    "phase": "07.8",
    "file": "e2e/tests/memory-files.spec.ts",
    "line": null,
    "description": "FIX IN GATE: memory-files.spec.ts:548 (keyboard and ARIA on desktop) fails intermittently on the phase branch (2 of 3 runs alongside other specs; race between the tab stop and deep-link expansion); passes alone",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-21T20:05:41.977Z",
    "resolved_at": "2026-10-22T12:38:30.998Z"
  },
  {
    "id": 252,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/web/components/bots",
    "line": null,
    "description": "Sandbox file list route has no offset/cursor beyond 500 entries ('{n} more not listed'); Capabilities switches are 20x36 (<44 px, same as the existing Internet row); sandbox state events carry no runtime so a sandbox started outside the API ensure shows 'hardened' until restart; upload dialog does not intercept in-app navigation",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-21T20:05:42.084Z",
    "resolved_at": null
  },
  {
    "id": 253,
    "kind": "deviation",
    "phase": "07.8",
    "file": "infra/sandbox/sbx",
    "line": null,
    "description": "sbx has no HTTP(S)_PROXY env, so curl/pip/npm in the shell ignore the egress proxy unless given -x (allowlisted egress unusable by default); set the proxy env in the sbx spec (07.8-17/24)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-21T20:09:53.837Z",
    "resolved_at": "2026-10-22T02:53:29.247Z"
  },
  {
    "id": 254,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/sandboxd/src/egress/proxy.ts",
    "line": null,
    "description": "The proxy passes an upstream X-OCW-Egress header through (a site can make its own http page look refused): strip it; a failed policy write to the proxy answers 503 after sandboxd stored it (proxy lags until retry); a recreated proxy restores each bot's egress only on its next ensure",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-21T20:09:53.930Z",
    "resolved_at": "2026-10-22T12:38:31.073Z"
  },
  {
    "id": 255,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/sandboxd/src",
    "line": null,
    "description": "A sandboxd restart forgets its context map (agent answers no_context until it closes after 5 idle min, API must reopen); browserLimits idleStopMs/diskQuotaBytes unused (fixed 5 min); API owes resize mode, browserSandbox and http navigation_refused handling (07.8-16); 24 owes OCW_SANDBOX_BRW_IMAGE/EGRESS_IMAGE/BRW_SECCOMP env and gVisor/amd64 runs",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-21T20:09:54.014Z",
    "resolved_at": "2026-10-22T04:13:28.548Z"
  },
  {
    "id": 256,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/api/src/modules/sandbox",
    "line": null,
    "description": "Package installs run synchronously on the first call of a stopped sandbox (up to 600 s per package, can outlast the plugin deadline); a package reaches a running sandbox only at its next start (UI copy in 07.8-23); newerVersion always null; failed installs notify no admin beyond audit; package audit metadata includes registry name/version/digests",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-21T20:12:08.217Z",
    "resolved_at": null
  },
  {
    "id": 257,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/web/components/sandbox/settings/limits-form.tsx",
    "line": null,
    "description": "07.8-19: the container limits line copies the API CONTAINER_LIMITS because the settings view does not expose them (low)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T02:52:51.781Z",
    "resolved_at": null
  },
  {
    "id": 258,
    "kind": "deviation",
    "phase": "07.8",
    "file": "infra/fake-model/fake-sandboxd.mjs",
    "line": null,
    "description": "07.8-19: the fake sandboxd always reports gVisor; no switch to fake hardened, Docker too old or container-only runtimes (low)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T02:52:51.861Z",
    "resolved_at": null
  },
  {
    "id": 259,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/api/src/modules/sandbox",
    "line": null,
    "description": "SHOULD FIX (07.8-17): the API's sandboxd client uses plain fetch (undici 300 s default); a package install taking 300-540 s fails at the API while sandboxd completes it. Give package install/review an explicit 600 s timeout (07.8-24/28)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-22T02:53:29.323Z",
    "resolved_at": "2026-10-22T04:13:28.698Z"
  },
  {
    "id": 260,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/sandboxd/src/packages.ts",
    "line": null,
    "description": "07.8-17: a sandboxd crash mid review/install leaves its ocw-pnet-* network behind (container and temp volume self-remove); add to 28's orphan sweep",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-22T02:53:29.401Z",
    "resolved_at": "2026-10-22T09:00:44.780Z"
  },
  {
    "id": 261,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/sandboxd/src/packages.ts",
    "line": null,
    "description": "07.8-17: the per-bot packages volume has no disk quota of its own (only the sandbox quota policy); record in ADR-0029 soft-quota note (29)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T02:53:29.477Z",
    "resolved_at": null
  },
  {
    "id": 262,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/sandboxd/src/packages.ts",
    "line": null,
    "description": "07.8-17: when two packages provide the same bin or module name the first on PATH/NODE_PATH wins silently; surface a conflict at review (low)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T02:53:29.552Z",
    "resolved_at": null
  },
  {
    "id": 263,
    "kind": "deviation",
    "phase": "07.8",
    "file": "infra/compose",
    "line": null,
    "description": "MUST (07.8-24): add OCW_SANDBOX_NPM_REGISTRY, OCW_SANDBOX_PYPI_INDEX, OCW_CLAWHUB_URL (must equal the API's) and OCW_SANDBOX_REGISTRIES to sandboxd in compose and Woodpecker",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-22T02:53:29.628Z",
    "resolved_at": "2026-10-22T04:13:28.471Z"
  },
  {
    "id": 264,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/sandboxd/src/packages.ts",
    "line": null,
    "description": "07.8-17: npm 11.19 warns about allowScripts but still runs install scripts; a future npm enforcing it needs an allow-list (low); Debian packages only unit-tested (VALIDATION manual row)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T02:53:29.706Z",
    "resolved_at": null
  },
  {
    "id": 265,
    "kind": "deviation",
    "phase": "07.8",
    "file": "packages/contracts/src/browser.ts",
    "line": null,
    "description": "07.8-20 (for 21): ActivityStep has no requester, so sign-in and paused rows cannot name the person (\"Asked you / Asked Sam\" is built and tested, waiting for data)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-22T03:14:25.296Z",
    "resolved_at": "2026-10-22T05:37:51.148Z"
  },
  {
    "id": 266,
    "kind": "deviation",
    "phase": "07.8",
    "file": "packages/contracts/src/browser.ts",
    "line": null,
    "description": "07.8-20: activity steps carry no http/https flag, so step hosts show no lock or Not secure (only the card and review do) (low)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T03:14:25.387Z",
    "resolved_at": null
  },
  {
    "id": 267,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/web/components/browser/bot-activity.tsx",
    "line": null,
    "description": "07.8-20: for a top-level channel mention the live label shows in the main list while the reply lands in the thread; a tab opened mid-turn shows no label until the next step (low)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T03:14:25.479Z",
    "resolved_at": null
  },
  {
    "id": 268,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/sandboxd/src/packages.ts",
    "line": null,
    "description": "07.8-23 (medium): no package version listing in sandboxd or the API, so the web version picker is a typed field and \"Update to {version}\" never appears",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T03:43:44.118Z",
    "resolved_at": null
  },
  {
    "id": 269,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/api/src/modules/sandbox",
    "line": null,
    "description": "07.8-23: the package list carries no install failure code (17's timeout cannot show) and no removing count; an approved package with no started sandbox reads Installing and polls every 5 s (low)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T03:43:44.197Z",
    "resolved_at": null
  },
  {
    "id": 270,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/web/components/ui/sheet.tsx",
    "line": null,
    "description": "07.8-23: the shared sheet close button is 32 px on phones (marketplace plugin review sheet too); the packages review sheet has its own 44 px close (low)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T03:43:44.276Z",
    "resolved_at": null
  },
  {
    "id": 271,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/api/src/modules/browser/takeover.ts",
    "line": null,
    "description": "07.8-16 (medium): a takeover lease held by an API instance that died stays until expiry; only a live view reading the row clears it (same cross-organization lister gap as #244) — 28's sweep",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-22T03:47:12.000Z",
    "resolved_at": "2026-10-22T09:00:44.702Z"
  },
  {
    "id": 272,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/api/src/modules/browser/live-view.ts",
    "line": null,
    "description": "07.8-16: watching resizes the bot's page from 1280x800 to 960x600 (UI-SPEC default); 22/28 decide whether the small default stays (low)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-22T03:47:12.076Z",
    "resolved_at": "2026-10-22T05:12:57.096Z"
  },
  {
    "id": 273,
    "kind": "deviation",
    "phase": "07.8",
    "file": "packages/contracts/src/browser.ts",
    "line": null,
    "description": "07.8-16: the live-view state frame has no browserSandbox, so the floating window cannot show isolation per page (low, 22/26)",
    "status": "waived",
    "reason": "07.8-22: the UI-SPEC never shows isolation in the live window, only on the Browser tab and in Settings",
    "recorded_at": "2026-10-22T03:47:12.153Z",
    "resolved_at": "2026-10-22T05:12:57.169Z"
  },
  {
    "id": 274,
    "kind": "deviation",
    "phase": "07.8",
    "file": "infra/fake-model/fake-sandboxd.mjs",
    "line": null,
    "description": "07.8-16: a crashed event in the fake sandboxd does not end the frame stream (the real broker does) (low); the live-input Semgrep rule covers only declared types and field names in listed paths (low)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T03:47:12.229Z",
    "resolved_at": null
  },
  {
    "id": 275,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/sandboxd/src/egress-attach.ts",
    "line": null,
    "description": "MUST FIX (07.8-24): under gVisor (runsc) Docker's embedded DNS 127.0.0.11 does not answer on bot networks, so sbx/brw cannot resolve sandbox-egress and have no egress at all (fails closed; breaks every gVisor install). Give each sandbox the proxy IP (ExtraHosts or pinned address); then drop failure: ignore on gvisor-browser in .woodpecker/sandbox.yaml",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-22T04:13:28.773Z",
    "resolved_at": "2026-10-22T05:12:56.931Z"
  },
  {
    "id": 276,
    "kind": "deviation",
    "phase": "07.8",
    "file": "infra/fake-model/server.test.mjs",
    "line": null,
    "description": "MUST FIX: \"serves the fake sandboxd behind its token ... exec round trip\" gets 409 policy_missing since the fake requires a policy push (red since policyfix); runs in cell-smoke on Woodpecker and GitHub",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-22T04:13:28.849Z",
    "resolved_at": "2026-10-22T05:12:57.014Z"
  },
  {
    "id": 277,
    "kind": "unrun-verify",
    "phase": "07.8",
    "file": ".woodpecker/sandbox.yaml",
    "line": null,
    "description": "07.8-24: no real Woodpecker run of sandbox.yaml yet (steps run by hand in dind); record link and duration on first push; full gate:compose --with-sandbox (with Playwright, proxy, backup) not run",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T04:13:28.921Z",
    "resolved_at": null
  },
  {
    "id": 278,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/api/Dockerfile",
    "line": null,
    "description": "07.8-24: no retry for pnpm first-use binary download (timed out on Docker Desktop); CI dind keeps docker:dind (~500 MB) between gVisor runs (low)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T04:13:28.997Z",
    "resolved_at": null
  },
  {
    "id": 279,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/sandboxd/src/egress-attach.ts",
    "line": null,
    "description": "dnsfix: if the egress proxy restarts with a new IP, a running sandbox keeps the old /etc/hosts entry and has no egress until its next start/restart (fails closed; runc used to follow via Docker DNS) (low); packages smoke does not print its runtime",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T05:12:46.799Z",
    "resolved_at": null
  },
  {
    "id": 280,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/web/components/browser",
    "line": null,
    "description": "07.8-22 (medium): non-Latin IME input does not work on the desktop live-view frame during a takeover (paste works); an editable frame would leak composed text into our DOM",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T05:12:57.253Z",
    "resolved_at": null
  },
  {
    "id": 281,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/web/components/browser",
    "line": null,
    "description": "07.8-22: a reply on screen keeps its Watch link after the page closes until the list refetches (shows Ended) (low); at 320 px the host truncates early (low)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T05:12:57.333Z",
    "resolved_at": null
  },
  {
    "id": 282,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/local-runtime",
    "line": null,
    "description": "07.8-22: a local-runtime test fails when the repo is checked out outside the home folder (low)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T05:12:57.408Z",
    "resolved_at": null
  },
  {
    "id": 283,
    "kind": "unrun-verify",
    "phase": "07.8",
    "file": "infra/sandbox/browser",
    "line": null,
    "description": "07.8-21: the brw smoke for the new sandboxd op contextLock (site lock on a member-signed-in page) was not run against the real brw image",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T05:37:51.226Z",
    "resolved_at": null
  },
  {
    "id": 284,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/api/src/modules/browser",
    "line": null,
    "description": "07.8-21 (medium): a site that sets a cookie before any login is sealed as signed in; re-seal runs only after each call; a lock failure ends the page as crashed",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-22T05:37:51.300Z",
    "resolved_at": "2026-10-22T09:00:44.853Z"
  },
  {
    "id": 285,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/api/src/modules/browser",
    "line": null,
    "description": "07.8-21: the 15-minute sign-in expiry can hit a member still in control; a page holding a departed member's cookies lives until the 5-minute idle stop; an expired sign-in delivers no turn to the bot (expired sentence unused)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T05:37:51.379Z",
    "resolved_at": null
  },
  {
    "id": 286,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/api/src/modules/browser",
    "line": null,
    "description": "07.8-21: the Browser tab activity shows the page's current host (low)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-22T05:37:51.461Z",
    "resolved_at": "2026-10-22T06:39:03.293Z"
  },
  {
    "id": 287,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/api/src/modules/browser",
    "line": null,
    "description": "SHOULD FIX (07.8-27, medium): deleting a bot is a soft delete and the #230 secret clean-up trigger fires only on hard delete, so a deleted bot's sealed sessions stay until expiry or the 7-day purge (listed and revocable, never loaded) — 28",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-22T06:39:03.378Z",
    "resolved_at": "2026-10-22T09:00:44.623Z"
  },
  {
    "id": 288,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/web/components/browser",
    "line": null,
    "description": "07.8-27: no \"sign-in pending for you\" flag on the row so Open live view is never primary; Browser tab polls every 10 s (no realtime); rows before the opened_host migration show the current host; \"Stopped on {host}\" copy differs from UI-SPEC (low)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T06:39:03.462Z",
    "resolved_at": null
  },
  {
    "id": 289,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/web/components/browser",
    "line": null,
    "description": "07.8-26 (medium, with #280): IME composition on the phone's hidden input stays in the input until compositionend; the hidden input may also fix desktop IME",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T06:53:46.168Z",
    "resolved_at": null
  },
  {
    "id": 290,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/web/components/browser",
    "line": null,
    "description": "07.8-26: the live chip refreshes on turn.activity, focus and every 20 s, so a page closed for idleness can show up to 20 s; closing with no open page shows a \"Blocked: a page\" step (from 20); the AI chat has no chip (low)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T06:53:46.251Z",
    "resolved_at": null
  },
  {
    "id": 291,
    "kind": "deviation",
    "phase": "07.8",
    "file": "infra/sandbox/browser",
    "line": null,
    "description": "07.8-26: the phone viewport is proven only against the fake sandboxd; the real brw smoke for phone mode is not run",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-22T06:53:46.333Z",
    "resolved_at": "2026-10-22T09:00:44.997Z"
  },
  {
    "id": 292,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/api/src/modules/agent-channel",
    "line": null,
    "description": "MUST FIX (07.8-25, coordinator decision for 28 + ADR-0029): member_data (P-11, D-13) holds only for the turn that loaded the session, but the bot's OpenClaw history in that conversation may still contain what it read. Decision: member_data is sticky per (bot, conversation) once a member session was loaded there, until the bot's history for that conversation is reset; every later turn there carries it (floors, routing, import refusal)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-22T06:56:37.815Z",
    "resolved_at": "2026-10-22T09:00:44.543Z"
  },
  {
    "id": 293,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/api/src/modules/sandbox",
    "line": null,
    "description": "07.8-25: a download that only arrives through the event feed (not in the act response) is not stored; audienceCovers checks person by person and refuses above 1,000 (low)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T06:56:37.891Z",
    "resolved_at": null
  },
  {
    "id": 294,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/api/src/modules/tool-approval",
    "line": null,
    "description": "07.8-25: in a plain 07.5 exec approval the generic view does not mask --password=x style flags (only the D-13 view does) (low, 28)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-22T06:56:37.968Z",
    "resolved_at": "2026-10-22T09:00:44.925Z"
  },
  {
    "id": 295,
    "kind": "deviation",
    "phase": "07.8",
    "file": "infra/sandbox/browser",
    "line": null,
    "description": "MUST FIX before 29 (07.8-28): pinned Chromium 153.0.8010.12 is an August beta; stable 156.0.8078.47 and several stable security releases are missing. Bump playwright-core (1.64.x ships Chromium 156) or the current stable CfT build, re-pin digests, re-run browser/stack smokes",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-22T09:00:45.152Z",
    "resolved_at": "2026-10-22T09:40:57.707Z"
  },
  {
    "id": 296,
    "kind": "deviation",
    "phase": "07.8",
    "file": "infra/sandbox/browser",
    "line": null,
    "description": "SHOULD FIX (07.8-28, medium): the first contextOpen on a freshly started brw sometimes does not answer (2 of ~9 starts on Docker Desktop) and the API answers service_unavailable after 15 s; a retry works; brw keeps no logs so it cannot be diagnosed",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-22T09:00:45.226Z",
    "resolved_at": "2026-10-22T09:40:57.779Z"
  },
  {
    "id": 297,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/api/src/modules/keychain",
    "line": null,
    "description": "SHOULD FIX (07.8-28, medium): PUT /keychain/private-hosts does not re-push the sandbox policy to sandboxd; it keeps the old allowlist until the next settings change, kill/resume or restart",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-10-22T09:00:45.302Z",
    "resolved_at": "2026-10-22T09:40:57.851Z"
  },
  {
    "id": 298,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/api/src/modules/agent-channel",
    "line": null,
    "description": "07.8-28: confirm a DM can never gain human participants (else another person would decide D-13 approvals over Sam's data); member_data marking (#292) has no reset, so in a DM where a session was loaded every other site asks for approval forever; a page opened unsigned in a marked turn is locked to its host (too strict) (low)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T09:00:45.383Z",
    "resolved_at": null
  },
  {
    "id": 299,
    "kind": "deviation",
    "phase": "07.8",
    "file": "infra",
    "line": null,
    "description": "07.8-28: bump CI Docker 29.8.2 -> 29.9.2 and local Docker Desktop 29.6.2 (CVE not reachable from a bot) (low)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T09:00:45.461Z",
    "resolved_at": null
  },
  {
    "id": 300,
    "kind": "deviation",
    "phase": "07.8",
    "file": "infra/sandbox/browser",
    "line": null,
    "description": "hardening: nothing watches new stable Chrome releases for brw; each one needs the same bump (CfT stable build, sha256 pinned) — add a scheduled check (low)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T09:40:57.925Z",
    "resolved_at": null
  },
  {
    "id": 301,
    "kind": "deviation",
    "phase": "07.8",
    "file": ".woodpecker",
    "line": null,
    "description": "hardening: rebuild the ocw-ci image for Playwright 1.64.1 browsers; gVisor with Chromium 156 unverified until the first push (gvisor-browser job)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T09:40:58.007Z",
    "resolved_at": null
  },
  {
    "id": 302,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/api/src/modules/chat",
    "line": null,
    "description": "hardening: \"a DM never gains humans\" is enforced only in the API; a DB trigger would be defence in depth (low)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T09:40:58.083Z",
    "resolved_at": null
  },
  {
    "id": 303,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/web",
    "line": null,
    "description": "07.8-29 (medium): useSignIn does not clear the previous session's query cache on sign-in",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T12:38:31.152Z",
    "resolved_at": null
  },
  {
    "id": 304,
    "kind": "deviation",
    "phase": "07.8",
    "file": "apps/web",
    "line": null,
    "description": "07.8-29: other useTopic callers may multiply invalidations the same way /me/permissions did (low)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-22T12:38:31.229Z",
    "resolved_at": null
  },
  {
    "id": 305,
    "kind": "deviation",
    "phase": "07.9",
    "file": "packages/db/sql/post-migrate.sql",
    "line": null,
    "description": "07.9-02 (coordinator decision, record in ADR-0030): a revoked personal device grant does not override the device's \"shared with everyone\"; the person keeps seeing its sessions through the share (same as deviceModeCap today); sessions on a revoked device stay visible to former grantees as history",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-23T01:28:25.186Z",
    "resolved_at": null
  },
  {
    "id": 306,
    "kind": "deviation",
    "phase": "07.9",
    "file": "packages/db/sql/post-migrate.sql",
    "line": null,
    "description": "07.9-02: who-can-see and project-member listings check every active member one by one; fine at expected size, plan 12's perf test must cover it",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-23T01:28:25.262Z",
    "resolved_at": null
  },
  {
    "id": 307,
    "kind": "deviation",
    "phase": "07.9",
    "file": "packages/db/sql/post-migrate.sql",
    "line": null,
    "description": "MUST (07.9-12, D-14): app.work_project_access's team branch must exclude descendants of kind project, so an assigned team never reaches members of projects nested under it; with a test",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-23T03:52:58.538Z",
    "resolved_at": null
  },
  {
    "id": 308,
    "kind": "deviation",
    "phase": "07.9",
    "file": "apps/api/src/modules/work-session/facts.ts",
    "line": null,
    "description": "07.9-05: the list calls work_session_access once per session of the organization (Pitfall 8); plan 12's perf test must measure it",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-23T03:52:58.614Z",
    "resolved_at": null
  }
]
````
