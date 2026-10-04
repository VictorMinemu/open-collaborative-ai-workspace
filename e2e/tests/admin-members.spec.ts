import { type APIRequestContext, type Browser, expect, type Page, request, test } from "@playwright/test";
import { ADMIN, API_URL, shot } from "./env";

/**
 * Settings › Members (02-12): role changes with the four PRD roles, the Team Lead invite ceiling, the role
 * reference matrix and read-only directory for Developers. Runs at 1440 (desktop) and 390 (mobile) against
 * one stack, so every person it creates has a per-project, per-run unique e-mail.
 */

const BASE_URL = process.env.OCW_E2E_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "member-e2e-password-123";

type Person = { name: string; email: string; password: string };

function person(project: string, label: string): Person {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  return {
    name: `${label} ${project === "mobile" ? "M" : "D"}${stamp.slice(-4)}`,
    email: `${project}-${label.toLowerCase()}-${stamp}@example.test`,
    password: PASSWORD,
  };
}

async function apiAs(user: { email: string; password: string }): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL: API_URL, extraHTTPHeaders: { origin: BASE_URL } });
  const res = await ctx.post("/api/auth/sign-in/email", {
    data: { email: user.email, password: user.password },
  });
  expect(res.ok(), `sign in ${user.email}`).toBe(true);
  return ctx;
}

/** Invite + accept through the API (fast path for people a test only needs to exist). */
async function createMember(admin: APIRequestContext, p: Person, role: string): Promise<string> {
  const inv = await (await admin.post("/api/v1/invitations", { data: { email: p.email, role } })).json();
  const anon = await request.newContext({ baseURL: API_URL, extraHTTPHeaders: { origin: BASE_URL } });
  const res = await anon.post(`/api/v1/invitations/${inv.id}/accept`, {
    data: { name: p.name, password: p.password },
  });
  expect(res.ok(), "accept invitation").toBe(true);
  const me = await res.json();
  await anon.dispose();
  return me.user.id as string;
}

async function newPage(browser: Browser, project: string): Promise<Page> {
  const mobile = project === "mobile";
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  return context.newPage();
}

async function signIn(browser: Browser, user: { email: string; password: string }, project: string) {
  const page = await newPage(browser, project);
  await page.goto(`${BASE_URL}/login`);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page
    .getByTestId("login-form")
    .getByRole("button", { name: /sign in|log in/i })
    .click();
  await expect(page).toHaveURL(/\/chat/);
  return page;
}

async function openMembers(page: Page) {
  await page.goto(`${BASE_URL}/settings`);
  await expect(page.getByTestId("members-list").getByTestId("member-row").first()).toBeVisible();
}

const rowOf = (page: Page, name: string) => page.getByTestId("member-row").filter({ hasText: name });

async function pickRole(page: Page, name: string, label: string) {
  await rowOf(page, name).getByTestId("member-role-select").click();
  await page.getByRole("option", { name: label, exact: true }).click();
}

async function onlyActiveAdmin(admin: APIRequestContext): Promise<boolean> {
  const { members } = (await (await admin.get("/api/v1/members")).json()) as {
    members: Array<{ role: string; status: string }>;
  };
  return members.filter((m) => m.role === "admin" && m.status === "active").length === 1;
}

test.describe.configure({ mode: "serial" });

test("an admin changes a teammate's role and the teammate's UI follows", async ({ browser }, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const admin = await apiAs(ADMIN);
  const teammate = person(project, "Dana");

  const a = await signIn(browser, ADMIN, project);
  await openMembers(a);

  // ---- invite through the form (Developer is the default role)
  await a.locator("#invite-email").fill(teammate.email);
  await expect(a.getByTestId("invite-role")).toHaveText(/Developer/);
  await a.getByTestId("invite-member-form").getByRole("button", { name: "Invite" }).click();
  const link = await a.getByTestId("invite-link").inputValue();
  expect(link).toContain("/invite/");

  // ---- the teammate accepts in a second browser context
  const b = await newPage(browser, project);
  await b.goto(link);
  await b.getByLabel("Your name").fill(teammate.name);
  await b.getByLabel("Choose a password").fill(teammate.password);
  await b.getByTestId("invite-form").getByRole("button", { name: /join/i }).click();
  await expect(b).toHaveURL(/\/chat/);

  // ---- the admin sees them join live, then makes them Team Lead
  const row = rowOf(a, teammate.name);
  await expect(row).toBeVisible();
  await expect(row.getByTestId("member-role-select")).toHaveText(/Developer/);
  await pickRole(a, teammate.name, "Team Lead");
  await expect(a.getByText("Role updated")).toBeVisible();
  await expect(row.getByTestId("member-role-select")).toHaveText(/Team Lead/);
  await a.waitForTimeout(600);
  await shot(a, `members-list-${project}`);
  await a.emulateMedia({ colorScheme: "dark" });
  await shot(a, `members-list-${project}-dark`);
  await a.emulateMedia({ colorScheme: "light" });

  // ---- the teammate now holds the lead ceiling: Standard User and Developer only
  await b.goto(`${BASE_URL}/settings`);
  await expect(b.getByTestId("invite-member-form")).toBeVisible();
  await b.getByTestId("invite-role").click();
  await expect(b.getByRole("option")).toHaveText(["Standard User", "Developer"]);
  await b.keyboard.press("Escape");
  if (mobile) await b.getByTestId("mobile-nav-trigger").click();
  await expect(b.getByTestId("workspace-switcher").filter({ visible: true })).toContainText("Team Lead");
  if (mobile) await b.keyboard.press("Escape");
  // A lead sees members read-only (no role select) …
  await expect(b.getByTestId("member-role-select")).toHaveCount(0);

  // … and Revoke only on the invitations they created.
  const fromAdmin = person(project, "Pending");
  const created = await admin.post("/api/v1/invitations", {
    data: { email: fromAdmin.email, role: "developer" },
  });
  expect(created.ok()).toBe(true);
  const fromLead = person(project, "Invitee");
  await b.locator("#invite-email").fill(fromLead.email);
  await b.getByTestId("invite-member-form").getByRole("button", { name: "Invite" }).click();
  await expect(b.getByTestId("invite-link")).toBeVisible();
  await b.reload();
  const leadRow = b.locator(`[data-testid="pending-invitation"][data-email="${fromLead.email}"]`);
  const adminRow = b.locator(`[data-testid="pending-invitation"][data-email="${fromAdmin.email}"]`);
  await expect(leadRow).toBeVisible();
  await expect(adminRow).toBeVisible();
  await expect(leadRow.getByTestId("revoke-invitation")).toHaveCount(1);
  await expect(adminRow.getByTestId("revoke-invitation")).toHaveCount(0);

  // ---- the only admin cannot demote themselves: the server's message, and the select reverts
  if (await onlyActiveAdmin(admin)) {
    await openMembers(a);
    await pickRole(a, ADMIN.name, "Developer");
    await expect(a.getByText(/at least one active admin/i)).toBeVisible();
    await expect(rowOf(a, ADMIN.name).getByTestId("member-role-select")).toHaveText(/Organization Admin/);
  }

  await a.context().close();
  await b.context().close();
  await admin.dispose();
});

test("'What can each role do?' shows the server's role table", async ({ browser }, info) => {
  const project = info.project.name;
  const a = await signIn(browser, ADMIN, project);
  await openMembers(a);
  await a.getByTestId("role-reference-trigger").click();
  const sheet = a.getByTestId("role-reference-sheet");
  await expect(sheet).toBeVisible();

  const grants = async (permission: string) =>
    sheet
      .locator(`[data-testid="role-matrix-row"][data-permission="${permission}"] td`)
      .evaluateAll((cells) => cells.map((c) => c.getAttribute("data-grant")));
  expect(await grants("member.manage")).toEqual(["none", "none", "none", "granted"]);
  expect(await grants("invitation.create")).toEqual(["none", "none", "granted", "granted"]);
  expect(await grants("work_session.create")).toEqual(["none", "granted", "granted", "granted"]);
  expect(await grants("channel.post")).toEqual(["granted", "granted", "granted", "granted"]);
  expect(await grants("account.manage")).toEqual(["own", "own", "own", "own"]);
  expect(await grants("device.use")).toEqual(["none", "own", "own", "own"]);
  // Runtime-only permissions belong to devices and the agent cell, not to people.
  await expect(sheet.locator('[data-permission="cell.sync"], [data-permission="device.link"]')).toHaveCount(
    0,
  );
  await expect(sheet.getByText("Administration", { exact: true })).toBeVisible();

  await shot(a, `members-roles-sheet-${project}`);
  await a.emulateMedia({ colorScheme: "dark" });
  await shot(a, `members-roles-sheet-${project}-dark`);
  await a.context().close();
});

test("a Developer sees the directory read-only", async ({ browser }, info) => {
  const project = info.project.name;
  const admin = await apiAs(ADMIN);
  const dev = person(project, "Devin");
  await createMember(admin, dev, "developer");

  const d = await signIn(browser, dev, project);
  await openMembers(d);
  await expect(rowOf(d, dev.name)).toBeVisible();
  await expect(d.getByTestId("member-role-badge").first()).toBeVisible();
  await expect(d.getByTestId("member-role-select")).toHaveCount(0);
  await expect(d.getByTestId("invite-member-form")).toHaveCount(0);
  await expect(d.getByTestId("pending-invitations")).toHaveCount(0);
  await d.context().close();
  await admin.dispose();
});
