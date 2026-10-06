---
phase: 04-chat
plan: 11
subsystem: chat
status: complete
tags: [chat, notifications, preferences, dnd, mute, os-notifications, desktop, ipc, web]
requirements: [CHAT-10]
dependency_graph:
  requires: [04-01 (prefs contracts, notification_prefs, conversation_members.notify_level/muted, decideNotify, badgeStyle), 04-09 (notification service, user: frames, inbox cache), 04-10 (ConversationNotifyMenu, counts in list DTOs)]
  provides:
    - "notification/prefs.ts: loadPrefs, registerPrefsRoutes; GET|PUT /api/v1/notification-prefs, PUT /api/v1/conversations/:id/notification-settings (409 not_a_member)"
    - "contracts (add only): EphemeralTypes.messageNotify, MessageNotifyEvent, decideNotify optional actorKind"
    - "ephemeral message.notify on user:<id> for members on level all (never stored)"
    - "web: OsNotifier (AppShell), lib/os-notifications.ts, Settings › Notifications, notify-menu levels and mute, user-menu Pause notifications, muted rows, (N) title count"
    - "desktop: Channels.setBadgeCount, SetBadgeCountArgs, ocwDesktop.setBadgeCount"
  affects: [04-13]
tech-stack:
  added: []
  patterns:
    - "One user: subscription per tab shared by the chat sidebar and the app-level OsNotifier, on the same snapshot cursor (GET /channels userSeq), so neither listener skips the other's frames"
    - "Server decides popup; the client re-applies only its own toggle (desktop vs web) and 'already in front'"
key-files:
  created:
    - apps/api/src/modules/notification/prefs.ts
    - apps/api/src/modules/notification/prefs.int.test.ts
    - apps/web/lib/os-notifications.ts
    - apps/web/lib/os-notifications.test.ts
    - apps/web/components/notifications/os-notifier.tsx
    - apps/web/components/settings/notification-settings.tsx
    - apps/web/app/(app)/settings/notifications/page.tsx
    - e2e/tests/notification-prefs.spec.ts
  modified:
    - packages/contracts/src/{notifications,realtime,chat-workspace.test}.ts
    - apps/api/src/modules/notification/{index,service}.ts
    - apps/web/lib/{chat-queries,notification-queries,desktop}.ts
    - apps/web/components/chat/{conversation-notify-menu,chat-sidebar,sidebar-sections}.tsx
    - apps/web/components/shell/{app-shell,user-menu}.tsx
    - apps/web/components/ui/dropdown-menu.tsx
    - apps/web/components/settings/account-nav.ts
    - apps/desktop/src/shared/{channels,ipc,ipc.test,desktop-api.d}.ts
    - apps/desktop/src/{preload/main,main/index}.ts
    - apps/desktop/e2e/smoke.e2e.ts
decisions:
  - "Bot DM noise (04-09 open item): a bot's reply in a bot DM pops only when it @mentions the member or the member set that DM to All new messages; the row still reaches the inbox and the DM badge"
  - "A muted conversation leaves the All view count and collapsed sections unless something mentions the member (same rule as its badge)"
  - "Settings › Notifications is an Account section (account-nav.ts), not a Workspace one: it is personal and needs no permission"
  - "Pop-ups older than 10 minutes (replays after a long disconnection) are not shown; each id pops once per tab"
  - "Pause notifications is a submenu on wide screens and inline rows on phones (a submenu covered its parent at 390)"
metrics:
  duration: "~95 min"
  completed: 2026-10-06
  tasks: 3
  files: 44
estimate:
  tokens: 180000
actuals:
  tokens: 31500
  tasks: 3
  commits: 3
---

# Phase 4 Plan 11: Notification preferences, OS notifications, title count and dock badge Summary

Members can now mute a conversation and set what it notifies about (Default, All new messages, Mentions only, Nothing) from its bell menu. They can pause notifications for a while from the user menu, and set their default channel level, do not disturb and the desktop/web toggles in Settings › Notifications. Muting or changing a level takes effect at once for pop-ups and badges, while mentions still reach the inbox and the mention badge. Pop-ups are real Web Notifications, shown only while the web or desktop app is open (no service worker, D-02). The tab title shows `(N)` unread mentions, and the desktop app shows the same number on its dock/taskbar badge.

## What was built

- **API (`notification/prefs.ts`):**
  - `GET|PUT /notification-prefs` returns the stored row or the defaults, and upserts only the caller's row.
  - `PUT /conversations/:id/notification-settings`: the resolver decides readability first (hidden = missing = 404). Then only the caller's own membership changes; a non-member gets 409 `not_a_member`.
  - Both writes append `notification_prefs.updated` on `user:<me>`. The 04-09 service keeps deciding `popup` with `decideNotify` from these stored values, now also passing the actor kind.
- **Level all:** for a plain top-level channel message, members whose effective level there is "all" receive an ephemeral `message.notify` after commit. "All" can be set on the channel, or come from a default level of "all". Excluded: muted members, members in DND, the author, anyone who already got a notification row for it, and anyone who cannot read the channel. It is never stored (P-04; the int test checks `stream_events`).
- **Web:**
  - `OsNotifier` is mounted once in the AppShell, so it runs on every page. It shares the tab's `user:` subscription with the sidebar, on the same cursor, and keeps the inbox cache live.
  - It decides pop-ups with `shouldPopup`. Each pop-up's tag is the notification id (the message id for `message.notify`). Clicking one focuses the app and opens the permalink.
  - It keeps the `(N)` title (re-applied after Next.js changes the title) and the badge.
- **Settings › Notifications:**
  - Browser permission status, with "Enable notifications". This is the only place permission is requested, and only on that click.
  - "Send a test notification", the desktop and web switches, and the default channel level.
  - Do not disturb: 30 min / 1 h / 2 h / tomorrow 09:00 / a custom time / Resume now.
- **User menu:** "Pause notifications" with the same presets, a "paused until …" line with Resume, and a small moon on the avatar while paused.
- **Desktop:**
  - `ocw:set-badge-count` is handled only for the trusted web sender. It validates the value as an integer from 0 to 9999 and calls `app.setBadgeCount`.
  - The preload exposes `setBadgeCount` and forwards whole numbers only. It is the only new key on `window.ocwDesktop`.

## Verification

| Check | Result |
|---|---|
| `vitest --project integration notification/prefs.int.test.ts` | 15/15. Task 1: 6 RED first. Task 2: 3 RED first (level-all, default all, bot DM) |
| Neighbours: `notifications.int` / `chat/unread.int` | 25/25, 22/22 |
| `vitest --project unit contracts/chat-workspace.test.ts` | 25/25 (2 new, RED first) |
| `vitest --project web lib/os-notifications.test.ts` | 11/11 (RED first: module missing) |
| `env -u ELECTRON_RUN_AS_NODE pnpm --filter @ocw/desktop test` | 10 files / 67 tests (3 RED first) |
| Electron smoke (`test:smoke` against the isolated stack, temp profile and OCW home) | 1/1: bridge keys, badge 3 → `app.getBadgeCount()` 3, 100000 refused with "invalid arguments", 0 clears |
| `pnpm typecheck --force` after the contract changes | 8/8 |
| `pnpm verify` after each task | 137 files: 1878 → 1890 → 1892 tests, exit 0 |
| e2e task 1: `notification-prefs notifications unread` | 11/11 |
| e2e task 2: `notification-prefs account` | 13/13 |
| Final e2e: `notification-prefs notifications unread account chat-sidebar dms` (desktop + mobile) | 31/31, none skipped or flaky |
| Acceptance greps | all print as required; `serviceWorker\|PushManager` in apps/web is empty |

Screenshots reviewed with the Read tool: `notify-menu-{1440,390}[-dark]`, `sidebar-muted-{1440,390}[-dark]`, `settings-notifications-{1440,390}[-dark]`, `user-menu-pause-{1440,390}`. Three fixes came from the review:
- The All view counted a muted channel. It now counts only rows that show a badge.
- On phones the switches sat below their labels. They now stay inline.
- At 390 the pause submenu covered the menu. The presets are now inline rows on phones.

I also checked the regression captures of other specs (sidebar badges, account drawer showing the new Notifications entry), then restored them; they are not committed.

## Deviations from Plan

1. **[Rule 1/UX] The All view count and collapsed sections no longer show muted rows** unless something mentions the member (chat-sidebar.tsx, sidebar-sections.tsx). Before this, a muted channel still counted in "All".
2. **[Decision] Bot DM pop-ups (04-09 open item).** `decideNotify` takes an optional `actorKind` (add-only). In a bot DM, a bot's reply counts as a plain message, and `default` means "mentions" there. Rows, inbox and badges are unchanged.
3. **[Structure] Settings › Notifications is linked from `account-nav.ts`, not `settings-nav.ts`.** It is a personal section with no permission, next to Profile and Security.
4. **[Structure] Not in the plan's file list:**
   - `components/ui/dropdown-menu.tsx`: submenu parts.
   - `lib/os-notifications.test.ts`.
   - `apps/desktop/e2e/smoke.e2e.ts`: the bridge key list, plus the badge round trip.
   - `notification_prefs.updated` frames are applied by `OsNotifier` (app-wide), not in the sidebar handler. The OsNotifier sees them on every page, so the sidebar does not repeat it.
5. **[Design] OsNotifier subscribes on the sidebar's snapshot cursor (`GET /channels` userSeq).** A second listener on the same topic with a newer cursor could make the shared client skip frames the sidebar still needed. With the same cursor, neither listener skips anything. On non-chat pages this costs one `GET /channels`.
6. **[Spec order] Task 2's e2e clicks "Enable notifications" before toggling web off and on.** With permission still "default" nothing could pop, so the "web off" check would prove nothing. The permission assertions are unchanged: zero requests on load, exactly one after the click.
7. **[Addition] Extra behaviour:**
   - Pop-ups for notifications older than 10 minutes (replays after a long disconnection) are skipped.
   - A moon on the avatar while paused.
   - "Resume now" in Settings.

### CLAUDE.md
- No migration and no permission or policy change. Prefs are keyed to the session user; per-conversation settings need `access.readable` plus the caller's own membership (T-04-11-04).
- Desktop: hardened `webPreferences` and `isTrustedSender` are unchanged. The only new web-reachable API is the badge count (T-04-11-01). No `serviceWorker`, `PushManager` or VAPID was added (T-04-11-03).
- The owner's desktop app, daemon and `~/.ocw` were never touched. The Electron smoke used a temp profile and OCW home against the isolated stack, with `ELECTRON_RUN_AS_NODE` unset.
- `.env` was symlinked only for the isolated e2e and has been removed; I never read it.
- `wt/04-11` is outside the executor's agent-branch allow-list; I committed there as instructed.

## Known Stubs

None.

## Open issues

- Click-to-focus on a desktop (Electron) notification on macOS needs a code-signed build (Pitfall 11). It stays a manual check in 04-VALIDATION.md, together with seeing the dock badge on the real dock.
- Android Chrome only shows notifications through a service worker, which D-02 rules out. There the app shows no pop-ups; the inbox, badges and title count still work. `showOsNotification` swallows the constructor error.
- A desktop window and a browser tab of the same member can both pop the same notification (accepted in Pitfall 12; the same browser de-duplicates by tag).
- The title and dock badge count Mentions-filter notifications (mention, @channel, @here), as the plan specifies. DMs are counted in the sidebar but not in the title.

## Ledger commands (not run: WINDOWS.md is orchestrator-owned)

```bash
gsd windows append --kind deviation --phase 04 --file packages/contracts/src/notifications.ts --description "decideNotify optional actorKind: a bot's reply in a bot DM pops only on a mention or level all (04-09 open item)"
gsd windows append --kind deviation --phase 04 --file apps/web/components/chat/chat-sidebar.tsx --description "All view count and collapsed sections skip muted rows unless mentioned (same rule as the badge)"
gsd windows append --kind deviation --phase 04 --file apps/web/components/settings/account-nav.ts --description "Settings › Notifications linked as an Account section instead of settings-nav.ts"
gsd windows append --kind deviation --phase 04 --file apps/web/components/notifications/os-notifier.tsx --description "OsNotifier shares the sidebar's user: cursor (GET /channels userSeq), applies notification_prefs.updated app-wide, skips pop-ups older than 10 minutes"
gsd windows append --kind deviation --phase 04 --file apps/desktop/e2e/smoke.e2e.ts --description "Smoke bridge key list gains setBadgeCount plus a badge round trip (not in plan list)"
```

## Threat model coverage

- **T-04-11-01:**
  - The channel is in the typed `Channels` list and handled through `handle(…, fromWeb, …)`, so only a trusted web sender reaches it.
  - The value is validated with Zod as an integer from 0 to 9999; errors read "invalid arguments" and never echo the payload (unit test).
  - The preload forwards integers only, and there is no passthrough. The keys test and the smoke test both assert that only `setBadgeCount` was added.
- **T-04-11-02 (accepted):** pop-ups show the member's own notifications only, with snippets of at most 140 characters. Members control DND, mute and the toggles.
- **T-04-11-03:** no service worker, Push API or VAPID (grep is empty). Pop-ups exist only while the app runs.
- **T-04-11-04:** prefs are keyed to the session user. Per-conversation settings need the resolver's `readable` and the caller's own membership. Tests cover non-member 409, hidden 404 and org B 404, and a hidden channel is left unchanged.
- **T-04-11-05:** `message.notify` goes only to members who opted in to "all". It is never sent to muted members or members in DND, and it is ephemeral. One tag per id replaces duplicates.

No new surface beyond the plan.

## Commits

- 0278099 feat(chat): mute a conversation or set its level from the header menu; the server's pop-up decision reaches real OS notifications while the app runs (04-11 task 1)
- c64ed1a feat(chat): do not disturb, levels, default level and desktop/web toggles in Settings › Notifications and the user menu, level-all pop-ups and the tab title count (04-11 task 2)
- 48f2496 feat(desktop): the dock/taskbar badge mirrors unread mentions through one validated IPC channel (04-11 task 3)

## Self-Check: PASSED

All created files exist. Commits 0278099, c64ed1a and 48f2496 are on `wt/04-11`. The working tree was clean before this summary, and the `.env` symlink has been removed.
