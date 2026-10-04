---
phase: 02-identity-and-organization
plan: 14
subsystem: web (account console)
status: complete
tags: [profile, sessions, password-reset, change-password, settings, e2e, screenshots]
requires: ["02-09", "02-03", "02-02"]
provides:
  - "Settings › Profile (/settings/profile): emoji grid or https avatar, display name, status emoji + text with Clear, read-only e-mail and role"
  - "Settings › Security (/settings/security): session list (client icon, label, IP, last activity, This device), confirmed revoke, sign out everywhere else, change password"
  - "/reset-password landing page for e-mailed and admin-issued links (no-referrer, noindex, single-use invalid state)"
  - "Login 'Forgot password?' dialog branching on GET /api/v1/auth/capabilities"
  - "Settings sidebar Account group (ACCOUNT_SECTIONS) above Workspace; user menu Profile, Security and current status"
  - "lib/account-queries.ts: useProfile, useUpdateProfile, useSessions, useRevokeSession, useRevokeOtherSessions, useChangePassword, useAuthCapabilities, useRequestPasswordReset, useResetPassword"
  - "UserAvatar / PrincipalAvatar render emoji avatars for people and load photos with referrerPolicy no-referrer"
affects: [02-12, 02-15]
tech-stack:
  added: []
  patterns:
    - "Avatar values: isImageSrc() decides photo vs emoji; anything else renders as text in a container-sized span"
    - "Profile form diffs against the stored profile and PATCHes only changed fields"
    - "e2e browsers reuse the invitation-acceptance session (storageState cookies) to stay under the 30/min sign-in limit"
key-files:
  created:
    - apps/web/lib/account-queries.ts
    - apps/web/components/settings/account-nav.ts
    - apps/web/app/(app)/settings/profile/page.tsx
    - apps/web/app/(app)/settings/security/page.tsx
    - apps/web/components/account/profile-form.tsx
    - apps/web/components/account/avatar-picker.tsx
    - apps/web/components/account/sessions-list.tsx
    - apps/web/components/account/change-password-form.tsx
    - apps/web/components/auth/forgot-password-dialog.tsx
    - apps/web/app/(auth)/reset-password/page.tsx
    - apps/web/app/(auth)/reset-password/layout.tsx
    - e2e/tests/account.spec.ts
    - .planning/phases/02-identity-and-organization/screenshots/account-*.png (42)
  modified:
    - apps/web/components/settings/settings-sidebar.tsx
    - apps/web/components/shell/user-menu.tsx
    - apps/web/app/(auth)/login/page.tsx
    - apps/web/components/ui/avatar.tsx
    - apps/web/components/chat/principal-avatar.tsx
decisions:
  - "Emoji avatars render everywhere through UserAvatar (shell, member list, chat); before this plan an emoji avatar fell back to initials"
  - "Clear empties the status fields and the user saves; one save model for the whole form"
  - "The status appears in the user menu (fetched only while the menu is open), since the Members page status column belongs to 02-12"
  - "Reset page gets a server layout with referrer no-referrer and noindex (T-02-14-01)"
  - "Change password defaults to signing out other sessions; the switch can turn it off"
metrics:
  duration: "~95 min"
  completed: "2026-10-04"
  tasks: 3
  files: 18
actuals:
  tokens: 19000
  tasks: 3
  commits: 5
---

# Phase 2 Plan 14: Account console (Profile, Security, reset password) Summary

Members now edit their own name, avatar (emoji grid or https photo) and status in Settings › Profile, and the change appears at once in the shell, the member directory and next to their chat messages. Settings › Security lists their sessions with real client identity ("Chrome on Android · This device", "Desktop app on macOS"), revokes one or all others, and changes the password. A reset link from an admin (or from e-mail when SMTP is set) lands on /reset-password. The login page offers "Forgot password?", which asks an admin when there is no SMTP.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | `a4451f4` | feat(02-14): Settings › Profile with emoji/https avatar, name and status, shown across the app |
| 1 | `eb6707a` | fix(02-14): role badge colour from a lookup map (no web role checks) |
| 2 | `d1f3320` | feat(02-14): Settings › Security (sessions, sign out elsewhere, change password) and reset-password journeys |
| 3 | `7a9a80a` | feat(02-14): polish account pages at 390/1440 in light and dark, reviewed screenshots |

## Verification

| Command | Result |
|---------|--------|
| `pnpm --filter @ocw/web typecheck` | exit 0 (after each task) |
| `bash scripts/e2e-isolated.sh account` (Task 1) | 3 passed (setup + profile at desktop and mobile) |
| `bash scripts/e2e-isolated.sh account smoke` (Task 2) | 11 passed (54.8 s) |
| `OCW_E2E_SCREENSHOT_DIR=… bash scripts/e2e-isolated.sh account` (Task 3, final) | 9 passed (47.8 s) |
| `bash scripts/e2e-isolated.sh` (full suite, final) | **19 passed (1.0 m)**: setup, then account ×4, bots, chat, codex-subscription, smoke and work-zone at 1440 and 390 |
| `pnpm verify` (after Tasks 1, 2 and 3) | exit 0; biome clean (4 pre-existing warnings in apps/local-runtime), turbo 8/8, **52 files / 505 tests passed** |
| `pnpm --filter @ocw/local-runtime test` / `pnpm --filter @ocw/desktop test` | 107 / 58 passed |
| `ls screenshots \| grep -c "^account-"` | 42 |

Acceptance greps: `settings-sidebar.tsx` contains `ACCOUNT_SECTIONS`; `avatar-picker.tsx` contains `referrerPolicy="no-referrer"`; `user-menu.tsx` contains `/settings/profile` and `/settings/security`; `reset-password/page.tsx` contains `useResetPassword`; `login/page.tsx` contains `Forgot password?` and `useAuthCapabilities`; `sessions-list.tsx` contains `This device` and 0 `token`; `account.spec.ts` contains `-dark` and `shot(`.

What the e2e proves, at 1440 and 390:
- **Profile:** user menu → Profile. The sidebar shows Account above Workspace (desktop column and mobile drawer). An http:// URL shows "Use an https:// image URL or an emoji" and keeps Save disabled. Picking 🦊, renaming and setting 🌴 "Back Monday" shows the toast "Profile updated". The user-menu trigger shows the new name and 🦊, the menu shows the status, the Members row shows the name and 🦊, and a chat message shows 🦊. A reload keeps everything, and Clear + Save removes the status.
- **Security:** three sessions are listed: this browser ("This device", web), the desktop app (Electron UA, "Desktop app on macOS", monitor icon) and a script. Revoking the desktop session needs a confirmation, removes the row, and sends the desktop context to /login on its next navigation. "Sign out everywhere else" leaves one row, and the script gets 401. A wrong current password shows "Current password is incorrect". The right one shows "Password updated". After sign-out, the old password fails and the new one signs in.
- **Reset:** the admin issues a link through the API. The page has `<meta name="referrer" content="no-referrer">`. A mismatched confirmation is caught in the browser. Submitting redirects to /login with "Password updated. Sign in with your new password." Reusing the link and opening /reset-password without a token both show the invalid-link message. The new password signs in.
- **Forgot:** without SMTP the dialog says "Ask an Organization Admin to create a reset link for you." With capabilities mocked to `passwordResetEmail: true`, the dialog takes an e-mail, the real API answers `{ ok }`, and the dialog shows "If an account exists for that email, we sent a link."

### Demo stack (hard rule)

`curl :4000/health` 200, `curl :3000/login` 200, and `ocw-demo-openclaw` is still running since 2026-10-04T15:54:27Z. No compose command, no `db:migrate` with the default `.env`, no `demo:*` command and no bind on :4000/:3000. All e2e runs went through `scripts/e2e-isolated.sh`.

## Screenshots (final, 42 files; every view at desktop 1440 and mobile 390, light and `-dark`)

| Files | View | What was polished |
|-------|------|-------------------|
| account-profile-{desktop,mobile}[-dark] (4) | Profile after saving 🦊 + 🌴 status | Sticky save bar is now opaque with safe-area padding (text no longer bleeds through at 390). Discard shows only when there are changes. The emoji grid is 6 × 4 with tiles ≥ 40 px and wraps cleanly at 390 |
| account-profile-invalid-avatar-{desktop,mobile}[-dark] (4) | Inline https-only error, Save disabled | Error red is readable in dark mode; the preview stays on initials while the URL is invalid |
| account-user-menu-{desktop,mobile}[-dark] (4) | User menu with Profile / Security / Settings, emoji avatar | – |
| account-settings-drawer-mobile[-dark] (2) | Mobile drawer: ACCOUNT and WORKSPACE groups | Group labels use the same small uppercase style as the section title in both themes |
| account-security-{desktop,mobile}[-dark] (4) | Three sessions with icons, labels, "This device" | Revoke gets a 40 px target on mobile; "Desktop app on macOS" does not repeat "Desktop app" in its details line |
| account-security-password-error-{desktop,mobile}[-dark] (4) | "Current password is incorrect" | New and confirm fields align top (`content-start`) at 1440 |
| account-reset-password-{desktop,mobile}[-dark] (4) | /reset-password form | Same AuthCard and centring as login/invite; copy tightened |
| account-reset-invalid-{desktop,mobile}[-dark] (4) | Used or missing link | Muted broken-link tile, single "Go to sign in" CTA |
| account-forgot-{desktop,mobile}[-dark] (4) | No SMTP: ask-an-admin dialog with three steps | Bottom sheet on 390, centred modal on 1440 |
| account-forgot-email-{desktop,mobile}[-dark] (4) | SMTP: e-mail form prefilled from the login field | – |
| account-forgot-sent-{desktop,mobile}[-dark] (4) | SMTP: identical confirmation for any address | – |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Emoji avatars rendered as initials everywhere**
- **Found during:** Task 1
- **Issue:** `UserAvatar` and `PrincipalAvatar` passed any avatar value to `<img>`, so an emoji avatar (allowed since 02-09) failed to load and fell back to initials. The truth "sees the change in the app shell and in chat" could not hold.
- **Fix:** `components/ui/avatar.tsx` exports `isImageSrc()`. `UserAvatar` renders non-URL values as an emoji scaled to the avatar size (`@container`, `data-avatar="emoji"`). `PrincipalAvatar`'s person branch delegates emoji values to `UserAvatar`. All photo avatars (people and bots) load with `referrerPolicy="no-referrer"` (T-02-14-03).
- **Files:** `apps/web/components/ui/avatar.tsx` and `apps/web/components/chat/principal-avatar.tsx` (neither is owned by another plan in this wave).
- **Commit:** a4451f4

**2. [Rule 1 - Bug] Web role check tripped the 02-02 legacy guard**
- The Role badge colour first compared `profile.role === "admin"`, which failed `guard.test.ts` ("no unmarked legacy role check in the web"). It is now a `ROLE_VARIANT` lookup map, the same pattern as the invite page.
- **Commit:** eb6707a

**3. [Rule 2 - Security] Reset page layout with referrer and robots metadata**
- `app/(auth)/reset-password/layout.tsx` was not in the plan. It sets `referrer: "no-referrer"` and `robots: noindex`, so the one-time token in the URL is never sent as a Referer and never indexed (T-02-14-01). The e2e asserts the meta tag.
- **Commit:** d1f3320

**4. [Rule 3 - Blocking] The e2e suite hit the API's sign-in rate limit**
- The first full-suite run failed `smoke`, `chat` and `codex-subscription` on mobile with 429 on `POST /api/auth/sign-in/email`. The limit is 30/min per IP, and the whole suite shares 127.0.0.1.
- I did not raise the limit. `account.spec.ts` now hands the invitation-acceptance session to the browser (`storageState` cookies) and shares one admin API session per worker. It signs in only where the sign-in is under test: the desktop session, wrong password, new password and post-reset. After that change the full suite passed: 19/19.
- **Note for the orchestrator:** 02-12 and 02-13 add more specs that sign in. If the merged suite hits 429 again, the fix belongs in shared e2e helpers (reuse sessions) or in an e2e-only rate-limit setting, not in individual specs.
- **Commit:** 7a9a80a

**5. Members page status text (behaviour bullet in Task 1)**
- `members-settings.tsx` belongs to 02-12 (same wave) and does not render status yet on this branch. The e2e therefore checks the status in the user menu (new) and checks the name and 🦊 avatar on the Members row. Once 02-12 merges, its member row shows status emoji and text, and one assertion on `member-row` can be added.

**6. Session count in the security e2e**
- Accepting an invitation opens a session. The test uses that session as "This device", so the list starts at three sessions (this browser, desktop app, script), not two.

**7. Toasts cover the full-width submit at 390**
- The e2e waits for toasts to clear before submitting the password form on mobile. The shared Toaster (`components/ui/sonner.tsx`) was not changed. Moving mobile toasts to the top is a possible app-wide polish item for later.

## Known Stubs

None. Avatar upload is out of scope until object storage exists (Phase 4); the picker takes an emoji or an https URL, as the API allows.

## Threat Flags

None. All new surface is covered by T-02-14-01 to T-02-14-04: the reset page sets no-referrer and noindex and drops the token from history with `router.replace`; forgot-password shows the same copy for every address; avatars are https-only and load with no-referrer; and the revoked-session UI refetches the list.

## Self-Check: PASSED
