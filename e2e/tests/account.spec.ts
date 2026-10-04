import { type APIRequestContext, expect, type Page, request, test } from "@playwright/test";
import { ADMIN, API_URL, shot } from "./env";

/**
 * Account (AUTH-04, AUTH-05, ORG-06): Settings › Profile, Settings › Security (sessions + change password),
 * /reset-password and the login page's "Forgot password?". Every test uses a fresh invited member per
 * project, so ADMIN's password and sessions are never touched.
 */

const BASE_URL = process.env.OCW_E2E_BASE_URL ?? "http://localhost:3000";
interface TestUser {
  id: string;
  name: string;
  email: string;
  password: string;
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
  await anon.dispose();
  return { id: me.user.id, name, email, password };
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

const toast = (page: Page, text: string | RegExp) =>
  page.locator("[data-sonner-toast]").filter({ hasText: text }).first();

test.describe.configure({ mode: "serial" });

test("profile: edit name, emoji avatar and status; visible across the app", async ({ page }, info) => {
  test.setTimeout(90_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const admin = await apiAs(ADMIN);
  const user = await freshUser(admin, `profile-${project}`, "Morgan Blake");
  await admin.dispose();

  await signIn(page, user);
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
