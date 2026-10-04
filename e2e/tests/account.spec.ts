import { type APIRequestContext, expect, type Page, request, test } from "@playwright/test";
import { ADMIN, API_URL, shot } from "./env";

/**
 * Account (AUTH-04, AUTH-05, ORG-06): Settings › Profile, Settings › Security (sessions + change password),
 * /reset-password and the login page's "Forgot password?". Every test uses a fresh invited member per
 * project, so ADMIN's password and sessions are never touched.
 *
 * Sign-ins are rate limited (30/min per IP) and the whole suite shares one IP, so this spec signs in only
 * where the sign-in itself is under test: browsers reuse the session the invitation acceptance opened.
 */

const BASE_URL = process.env.OCW_E2E_BASE_URL ?? "http://localhost:3000";
/** The Electron shell's user agent: the API tags these sessions "desktop" ("Desktop app on macOS"). */
const ELECTRON_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) OCW/0.1.0 Chrome/138.0.0.0 Electron/37.2.0 Safari/537.36";
const INVALID_LINK = "This link is invalid or has expired. Ask an Organization Admin for a new one.";

interface TestUser {
  id: string;
  name: string;
  email: string;
  password: string;
  /** API context holding the session opened by accepting the invitation. */
  session: APIRequestContext;
}

async function apiAs(user: { email: string; password: string }): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL: API_URL, extraHTTPHeaders: { origin: BASE_URL } });
  const res = await ctx.post("/api/auth/sign-in/email", {
    data: { email: user.email, password: user.password },
  });
  expect(res.ok(), `sign in ${user.email}`).toBe(true);
  return ctx;
}

/** A brand-new member (invite + accept through the API). */
async function freshUser(admin: APIRequestContext, slug: string, name: string): Promise<TestUser> {
  const email = `${slug}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@ocw.test`;
  const password = `${slug}-e2e-password-123`;
  const inv = await admin.post("/api/v1/invitations", { data: { email, role: "developer" } });
  expect(inv.ok(), "create invitation").toBe(true);
  const { id: invitationId } = (await inv.json()) as { id: string };
  const anon = await request.newContext({ baseURL: API_URL, extraHTTPHeaders: { origin: BASE_URL } });
  const res = await anon.post(`/api/v1/invitations/${invitationId}/accept`, { data: { name, password } });
  expect(res.ok(), "accept invitation").toBe(true);
  const me = (await res.json()) as { user: { id: string } };
  return { id: me.user.id, name, email, password, session: anon };
}

/** One admin API session per worker (each sign-in counts against the shared rate limit). */
let adminCtx: Promise<APIRequestContext> | null = null;
const admin = () => {
  adminCtx ??= apiAs(ADMIN);
  return adminCtx;
};
test.afterAll(async () => {
  if (adminCtx) await (await adminCtx).dispose();
  adminCtx = null;
});

/** Hands the user's existing session to the browser (no extra sign-in) and opens the app. */
async function useSession(page: Page, user: TestUser) {
  const { cookies } = await user.session.storageState();
  await page.context().addCookies(cookies);
  await page.goto("/chat");
  await expect(page.getByTestId("app-shell")).toBeVisible();
}

async function signIn(page: Page, user: { email: string; password: string }) {
  await page.goto("/login");
  await expect(page.getByTestId("login-form")).toBeVisible();
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page
    .getByTestId("login-form")
    .getByRole("button", { name: /sign in/i })
    .click();
  await expect(page).toHaveURL(/\/chat/);
  await expect(page.getByTestId("app-shell")).toBeVisible();
}

const userMenu = (page: Page) => page.getByTestId("user-menu").filter({ visible: true }).first();

async function openFromUserMenu(page: Page, item: "profile" | "security") {
  await userMenu(page).click();
  await page.getByTestId(`user-menu-${item}`).click();
  await expect(page).toHaveURL(new RegExp(`/settings/${item}$`));
}

/** Light then dark capture of the current view (`account-<view>-<project>[-dark]`). */
async function shots(page: Page, view: string, project: string) {
  await page.emulateMedia({ colorScheme: "light" });
  await shot(page, `account-${view}-${project}`);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `account-${view}-${project}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** Scroll the page's content column back to the top (review shots show the header area). */
async function scrollTop(page: Page) {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll(".overflow-y-auto")) el.scrollTop = 0;
  });
}

async function toastsGone(page: Page) {
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
}

const toast = (page: Page, text: string | RegExp) =>
  page.locator("[data-sonner-toast]").filter({ hasText: text }).first();

test.describe.configure({ mode: "serial" });

test("profile: edit name, emoji avatar and status; visible across the app", async ({ page }, info) => {
  test.setTimeout(90_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const user = await freshUser(await admin(), `profile-${project}`, "Morgan Blake");
  await useSession(page, user);
  await user.session.dispose();
  await openFromUserMenu(page, "profile");
  await expect(page.getByTestId("profile-form")).toBeVisible();
  await expect(page.getByLabel("Display name")).toHaveValue(user.name);

  // The Settings sidebar groups Account above Workspace (desktop column / mobile drawer).
  if (mobile) await page.getByTestId("mobile-nav-trigger").click();
  const nav = page.getByRole("navigation", { name: "Settings" });
  await expect(nav.getByRole("group", { name: "Account" })).toBeVisible();
  await expect(nav.getByTestId("settings-nav-profile")).toHaveAttribute("aria-current", "page");
  await expect(nav.getByTestId("settings-nav-security")).toBeVisible();
  const groups = await nav.getByRole("group").allTextContents();
  expect(groups[0]).toContain("Account");
  if (groups.length > 1) expect(groups[1]).toContain("Workspace");
  if (mobile) {
    await shots(page, "settings-drawer", project);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
  }

  // Plain http avatars are refused inline and block saving.
  const save = page.getByTestId("profile-save");
  await page.getByLabel("Or use an image URL").fill("http://example.com/me.png");
  await expect(page.getByText("Use an https:// image URL or an emoji")).toBeVisible();
  await expect(save).toBeDisabled();
  await shots(page, "profile-invalid-avatar", project);

  // Pick 🦊 (clears the URL), rename, set a status.
  await page.getByRole("button", { name: "Fox" }).click();
  await expect(page.getByText("Use an https:// image URL or an emoji")).toBeHidden();
  await expect(page.getByRole("button", { name: "Fox" })).toHaveAttribute("aria-pressed", "true");
  const newName = `Morgan Rivera ${project}`;
  await page.getByLabel("Display name").fill(newName);
  await page.getByTestId("status-emoji").click();
  await page.getByRole("option", { name: "🌴" }).click();
  await page.getByLabel("Status", { exact: true }).fill("Back Monday");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(toast(page, "Profile updated")).toBeVisible();
  await expect(page.getByText("All changes saved")).toBeVisible();

  // The shell shows the new name and avatar at once.
  await expect(userMenu(page)).toHaveAttribute("aria-label", `Account: ${newName}`);
  await expect(userMenu(page).locator('[data-avatar="emoji"]')).toHaveText("🦊");
  await scrollTop(page);
  await shots(page, "profile", project);

  // The menu shows the status; the member directory shows the name and avatar.
  await userMenu(page).click();
  await expect(page.getByTestId("user-menu-status")).toContainText("🌴");
  await expect(page.getByTestId("user-menu-status")).toContainText("Back Monday");
  await page.keyboard.press("Escape");
  await page.goto("/settings");
  const row = page.getByTestId("member-row").filter({ hasText: newName });
  await expect(row).toBeVisible();
  await expect(row.locator('[data-avatar="emoji"]')).toHaveText("🦊");

  // Chat shows the emoji avatar next to the user's messages.
  await page.goto("/chat");
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}/);
  const composer = page.getByTestId("composer");
  await composer.click();
  await composer.fill(`Hello from ${newName}`);
  await composer.press("Enter");
  const message = page.getByTestId("message").filter({ hasText: `Hello from ${newName}` });
  await expect(message.locator('[data-avatar="emoji"]').first()).toHaveText("🦊");

  // Survives a reload; Clear removes the status.
  await page.goto("/settings/profile");
  await expect(page.getByLabel("Display name")).toHaveValue(newName);
  await expect(page.getByLabel("Status", { exact: true })).toHaveValue("Back Monday");
  await page.getByTestId("clear-status").click();
  await expect(page.getByLabel("Status", { exact: true })).toHaveValue("");
  await save.click();
  await expect(toast(page, "Profile updated").last()).toBeVisible();
  await expect(page.getByText("All changes saved")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Status", { exact: true })).toHaveValue("");
  await expect(page.getByTestId("status-emoji")).toHaveAccessibleName("Choose a status emoji");
  await userMenu(page).click();
  await expect(page.getByTestId("user-menu-profile")).toBeVisible();
  await expect(page.getByTestId("user-menu-status")).toHaveCount(0);
  await shots(page, "user-menu", project);
  await page.keyboard.press("Escape");
});

test("security: sessions with client identity, revoke one, sign out everywhere else, change password", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const user = await freshUser(await admin(), `security-${project}`, "Riley Chen");
  // Sessions: this browser (the one the invitation acceptance opened), the desktop app (Electron user
  // agent, signed in through the UI) and a script.
  await useSession(page, user);
  const desktopCtx = await browser.newContext({
    baseURL: BASE_URL,
    userAgent: ELECTRON_UA,
    viewport: { width: 1280, height: 800 },
  });
  const desktop = await desktopCtx.newPage();
  await signIn(desktop, user);
  const script = await apiAs(user);

  await openFromUserMenu(page, "security");
  const rows = page.getByTestId("session-row");
  await expect(rows).toHaveCount(3);
  const current = rows.and(page.locator("[data-current]"));
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAttribute("data-kind", "web");
  await expect(current.getByTestId("session-current")).toHaveText("This device");
  await expect(current).toContainText(/Chrome on \w+/);
  const desktopRow = rows.and(page.locator('[data-kind="desktop"]'));
  await expect(desktopRow).toContainText("Desktop app on macOS");
  await expect(desktopRow).toContainText(/Active/);
  await scrollTop(page);
  await shots(page, "security", project);

  // Revoke the desktop session: it is gone from the list and the desktop is sent to sign in.
  await desktopRow.getByTestId("session-revoke").click();
  await expect(page.getByTestId("confirm-sign-out")).toContainText("Desktop app on macOS");
  await page.getByTestId("confirm-sign-out-submit").click();
  await expect(toast(page, "Signed out Desktop app on macOS")).toBeVisible();
  await expect(rows).toHaveCount(2);
  await desktop.goto(`${BASE_URL}/settings`);
  await expect(desktop).toHaveURL(/\/login/);
  await desktopCtx.close();

  // Sign out everywhere else: only this device remains, and the script's session is dead.
  await page.getByTestId("sign-out-others").click();
  await page.getByTestId("confirm-sign-out-submit").click();
  await expect(toast(page, "Signed out everywhere else")).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(page.getByTestId("sign-out-others")).toHaveCount(0);
  expect((await script.get("/api/v1/me")).status()).toBe(401);
  await script.dispose();

  // Change password: the wrong current password is refused, the right one works. (On 390 px the toast sits
  // over the full-width submit button until it times out.)
  await toastsGone(page);
  const form = page.getByTestId("change-password-form");
  const newPassword = `${user.password}-changed`;
  await form.getByLabel("Current password").fill("not-my-password-123");
  await form.getByLabel("New password", { exact: true }).fill(newPassword);
  await form.getByLabel("Confirm new password").fill(newPassword);
  await form.getByRole("button", { name: "Update password" }).click();
  await expect(form.getByText("Current password is incorrect")).toBeVisible();
  await shots(page, "security-password-error", project);
  await form.getByLabel("Current password").fill(user.password);
  await form.getByRole("button", { name: "Update password" }).click();
  await expect(toast(page, "Password updated")).toBeVisible();
  await expect(form.getByLabel("Current password")).toHaveValue("");

  // Sign out; only the new password signs in.
  await userMenu(page).click();
  await page.getByTestId("sign-out").click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page
    .getByTestId("login-form")
    .getByRole("button", { name: /sign in/i })
    .click();
  await expect(page.getByText("Incorrect email or password.")).toBeVisible();
  await signIn(page, { email: user.email, password: newPassword });
});

test("reset password: admin-issued link, single use, invalid states", async ({ page }, info) => {
  test.setTimeout(90_000);
  const project = info.project.name;
  const user = await freshUser(await admin(), `reset-${project}`, "Sam Ortiz");
  await user.session.dispose();
  const res = await (await admin()).post(`/api/v1/members/${user.id}/password-reset-link`);
  expect(res.ok(), "issue reset link").toBe(true);
  const { link } = (await res.json()) as { link: string };
  const url = new URL(link);
  const resetPath = `${url.pathname}${url.search}`;
  expect(url.pathname).toBe("/reset-password");

  await page.goto(resetPath);
  const form = page.getByTestId("reset-password-form");
  await expect(form).toBeVisible();
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
  await shots(page, "reset-password", project);

  // Mismatch is caught in the browser.
  const newPassword = `${user.password}-reset`;
  await form.getByLabel("New password", { exact: true }).fill(newPassword);
  await form.getByLabel("Confirm new password").fill(`${newPassword}x`);
  await form.getByRole("button", { name: "Update password" }).click();
  await expect(form.getByText("Passwords don't match")).toBeVisible();

  await form.getByLabel("Confirm new password").fill(newPassword);
  await form.getByRole("button", { name: "Update password" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(toast(page, "Password updated. Sign in with your new password.")).toBeVisible();

  // The link works once; a missing token shows the same state.
  await page.goto(resetPath);
  await page.getByLabel("New password", { exact: true }).fill(`${newPassword}-again`);
  await page.getByLabel("Confirm new password").fill(`${newPassword}-again`);
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByTestId("reset-invalid")).toHaveText(INVALID_LINK);
  await page.goto("/reset-password");
  await expect(page.getByTestId("reset-invalid")).toHaveText(INVALID_LINK);
  await shots(page, "reset-invalid", project);

  await signIn(page, { email: user.email, password: newPassword });
});

test("forgot password: ask an admin without SMTP, e-mail form with SMTP", async ({ page }, info) => {
  const project = info.project.name;

  await page.goto("/login");
  await page.getByTestId("forgot-password").click();
  const dialog = page.getByTestId("forgot-password-dialog");
  await expect(dialog.getByTestId("forgot-ask-admin")).toHaveText(
    "Ask an Organization Admin to create a reset link for you.",
  );
  await shots(page, "forgot", project);
  await dialog.getByRole("button", { name: "Got it" }).click();
  await expect(dialog).toBeHidden();

  // With SMTP configured (capabilities mocked: the e2e stack has no mail server) the dialog asks for an
  // e-mail and answers the same way for any address; the real API still answers { ok }.
  await page.route("**/api/v1/auth/capabilities", (route) =>
    // Cross-origin (web → API): answer with the CORS headers the real API sends.
    route.fulfill({
      json: { passwordResetEmail: true },
      headers: { "access-control-allow-origin": BASE_URL, "access-control-allow-credentials": "true" },
    }),
  );
  await page.reload();
  await page.getByLabel("Email").fill(`nobody-${project}@ocw.test`);
  await page.getByTestId("forgot-password").click();
  await expect(dialog.getByLabel("Email")).toHaveValue(`nobody-${project}@ocw.test`);
  await shots(page, "forgot-email", project);
  await dialog.getByRole("button", { name: "Send reset link" }).click();
  await expect(dialog.getByTestId("forgot-sent")).toHaveText(
    "If an account exists for that email, we sent a link.",
  );
  await shots(page, "forgot-sent", project);
});
