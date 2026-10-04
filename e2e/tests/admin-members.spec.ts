import { type APIRequestContext, type Browser, expect, type Page, request, test } from "@playwright/test";
import { ADMIN, API_URL, shot } from "./env";

/**
 * Settings › Members (02-12): role changes with the four PRD roles, the Team Lead invite ceiling, the role
 * reference matrix and read-only directory for Developers. Runs at 1440 (desktop) and 390 (mobile) against
 * one stack, so every person it creates has a per-project, per-run unique e-mail.
 */

const BASE_URL = process.env.OCW_E2E_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "member-e2e-password-123";
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

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

/**
 * Invite + accept through the API (fast path for people a test only needs to exist). Accepting signs the new
 * member in, so the returned context is their session: no extra sign-in (the API rate-limits sign-in per IP).
 */
async function createMember(p: Person, role: string): Promise<{ id: string; api: APIRequestContext }> {
  const inv = await (await admin.post("/api/v1/invitations", { data: { email: p.email, role } })).json();
  const api = await request.newContext({ baseURL: API_URL, extraHTTPHeaders: { origin: BASE_URL } });
  const res = await api.post(`/api/v1/invitations/${inv.id}/accept`, {
    data: { name: p.name, password: p.password },
  });
  expect(res.ok(), "accept invitation").toBe(true);
  const me = await res.json();
  return { id: me.user.id as string, api };
}

type StorageState = Awaited<ReturnType<APIRequestContext["storageState"]>>;

async function newPage(browser: Browser, project: string, storageState?: StorageState): Promise<Page> {
  const mobile = project === "mobile";
  const context = await browser.newContext({
    ...(storageState ? { storageState } : {}),
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  return context.newPage();
}

/** A browser page that reuses an API session's cookies (the web calls the API with credentials). */
async function pageAs(browser: Browser, api: APIRequestContext, project: string): Promise<Page> {
  return newPage(browser, project, await api.storageState());
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

type Unit = { id: string; name: string; parentId: string | null };

/** Get-or-create a unit (sibling names are unique, and both projects share one stack). */
async function ensureUnit(
  kind: "department" | "team" | "project",
  name: string,
  parentId: string | null,
): Promise<string> {
  const { units } = (await (await admin.get("/api/v1/units")).json()) as { units: Unit[] };
  const found = units.find((u) => u.name === name && u.parentId === parentId);
  if (found) return found.id;
  const res = await admin.post("/api/v1/units", { data: { kind, name, parentId } });
  expect(res.ok(), `create ${kind} ${name}`).toBe(true);
  return (await res.json()).id as string;
}

/** Gives a member three units so the row shows two chips and "+1". Unit leads need the Team Lead or Admin org role; `leadsTeam` is only set for those. */
async function placeInUnits(userId: string, leadsTeam: boolean) {
  const dept = await ensureUnit("department", "Product Engineering", null);
  const team = await ensureUnit("team", "Core Platform", dept);
  const project = await ensureUnit("project", "Atlas Launch", team);
  for (const [unitId, role] of [
    [team, leadsTeam ? "lead" : "member"],
    [dept, "member"],
    [project, "member"],
  ] as const) {
    const res = await admin.post(`/api/v1/units/${unitId}/members`, { data: { userId, role } });
    expect(res.ok(), `add to unit ${unitId}`).toBe(true);
  }
}

async function openRowMenu(page: Page, name: string) {
  await page.getByRole("button", { name: `Actions for ${name}`, exact: true }).click();
}

async function onlyActiveAdmin(): Promise<boolean> {
  const { members } = (await (await admin.get("/api/v1/members")).json()) as {
    members: Array<{ role: string; status: string }>;
  };
  return members.filter((m) => m.role === "admin" && m.status === "active").length === 1;
}

test.describe.configure({ mode: "serial" });

/** One admin session per project run (sign-in is rate limited per IP). */
let admin: APIRequestContext;
test.beforeAll(async () => {
  admin = await apiAs(ADMIN);
});
test.afterAll(async () => {
  await admin?.dispose();
});

test("an admin changes a teammate's role and the teammate's UI follows", async ({ browser }, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const teammate = person(project, "Dana");

  const a = await pageAs(browser, admin, project);
  await openMembers(a);

  // ---- empty state (only on a fresh stack, where the admin is still alone)
  if (await a.getByTestId("members-empty").isVisible()) {
    await expect(a.getByText("It's just you so far")).toBeVisible();
    await expect(a.locator("#invite-email")).toBeFocused();
    await shot(a, `members-empty-${project}`);
    await a.emulateMedia({ colorScheme: "dark" });
    await shot(a, `members-empty-${project}-dark`);
    await a.emulateMedia({ colorScheme: "light" });
  }

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

  // ---- unit chips arrive live (units.updated) and link to the Organization page
  const teammateId = (await row.getAttribute("data-user-id")) as string;
  await placeInUnits(teammateId, true);
  // Two chips at 1440, one at 390; the lead unit comes first.
  await expect(row.getByTestId("member-unit-chip").filter({ visible: true })).toHaveCount(mobile ? 1 : 2);
  await expect(row.getByTestId("member-unit-chip").first()).toContainText("Core Platform");
  await expect(row.getByTestId("member-more-units").filter({ visible: true })).toHaveText(
    mobile ? "+2" : "+1",
  );
  await expect(row.getByTestId("member-unit-chip").first()).toHaveAttribute(
    "href",
    /\/settings\/organization\?unit=[0-9a-f-]{36}/,
  );
  await a.getByTestId("members-list").evaluate((el) => el.scrollIntoView({ block: "start" }));
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
  if (await onlyActiveAdmin()) {
    await openMembers(a);
    await pickRole(a, ADMIN.name, "Developer");
    await expect(a.getByText(/at least one active admin/i)).toBeVisible();
    await expect(rowOf(a, ADMIN.name).getByTestId("member-role-select")).toHaveText(/Organization Admin/);
  }

  await a.context().close();
  await b.context().close();
});

test("'What can each role do?' shows the server's role table", async ({ browser }, info) => {
  const project = info.project.name;
  const a = await pageAs(browser, admin, project);
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
  const dev = person(project, "Devin");
  const { api: devApi } = await createMember(dev, "developer");

  const d = await pageAs(browser, devApi, project);
  await openMembers(d);
  await expect(rowOf(d, dev.name)).toBeVisible();
  await expect(d.getByTestId("member-role-badge").first()).toBeVisible();
  await expect(d.getByTestId("member-role-select")).toHaveCount(0);
  await expect(d.getByTestId("invite-member-form")).toHaveCount(0);
  await expect(d.getByTestId("pending-invitations")).toHaveCount(0);
  await d.context().close();
  await devApi.dispose();
});

test("admins deactivate, reactivate and issue one-time reset links; never on their own row", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const rhea = person(project, "Rhea");
  const { api: rheaApi } = await createMember(rhea, "developer");
  const r = await pageAs(browser, rheaApi, project);
  await r.goto(`${BASE_URL}/chat`);
  await expect(r.getByTestId("app-shell")).toBeVisible();

  const a = await pageAs(browser, admin, project);
  await openMembers(a);
  const row = rowOf(a, rhea.name);
  await expect(row).toBeVisible();

  // ---- reset link: shown once, with copy and expiry; reopening issues a new one
  await openRowMenu(a, rhea.name);
  await a.getByRole("menuitem", { name: "Create password reset link" }).click();
  const dialog = a.getByTestId("reset-link-dialog");
  await expect(dialog.getByTestId("reset-link")).toBeVisible();
  const first = await dialog.getByTestId("reset-link").inputValue();
  expect(first).toMatch(/\/reset-password\?token=/);
  await expect(dialog.getByText("Expires in 24 hours")).toBeVisible();
  await expect(
    dialog.getByText(`Anyone with this link can set a new password for ${rhea.name}`),
  ).toBeVisible();
  await expect(dialog.getByTestId("copy-reset-link")).toBeVisible();
  await shot(a, `members-reset-link-${project}`);
  await a.emulateMedia({ colorScheme: "dark" });
  await shot(a, `members-reset-link-${project}-dark`);
  await a.emulateMedia({ colorScheme: "light" });
  await dialog.getByTestId("reset-link-done").click();
  await expect(dialog).toHaveCount(0);
  await openRowMenu(a, rhea.name);
  await a.getByRole("menuitem", { name: "Create password reset link" }).click();
  await expect(a.getByTestId("reset-link")).toBeVisible();
  expect(await a.getByTestId("reset-link").inputValue()).not.toBe(first);
  await a.keyboard.press("Escape");
  await expect(a.getByTestId("reset-link-dialog")).toHaveCount(0);

  // ---- deactivate: the confirm names the consequences; the row leaves the default list
  await openRowMenu(a, rhea.name);
  await a.getByRole("menuitem", { name: "Deactivate" }).click();
  const confirm = a.getByTestId("member-confirm-dialog");
  await expect(confirm.getByText(`Deactivate ${rhea.name}?`)).toBeVisible();
  await expect(confirm.getByText("Their sessions end now. Messages and history stay.")).toBeVisible();
  await shot(a, `members-deactivate-confirm-${project}`);
  await a.emulateMedia({ colorScheme: "dark" });
  await shot(a, `members-deactivate-confirm-${project}-dark`);
  await a.emulateMedia({ colorScheme: "light" });
  await confirm.getByTestId("member-confirm").click();
  await expect(a.getByText(`${rhea.name} was deactivated`)).toBeVisible();
  await expect(row).toHaveCount(0);
  await a.getByTestId("show-deactivated").click();
  await expect(row).toHaveAttribute("data-status", "deactivated");
  await expect(row.getByTestId("member-deactivated")).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await expect(a.getByText(`${rhea.name} was deactivated`)).toHaveCount(0, { timeout: 10_000 });
  await shot(a, `members-deactivated-${project}`);
  await a.emulateMedia({ colorScheme: "dark" });
  await shot(a, `members-deactivated-${project}-dark`);
  await a.emulateMedia({ colorScheme: "light" });

  // The teammate's session is gone: the next request lands on /login.
  await r.reload();
  await expect(r).toHaveURL(/\/login/);

  // ---- reactivate restores sign-in
  await openRowMenu(a, rhea.name);
  await a.getByRole("menuitem", { name: "Reactivate" }).click();
  await a.getByTestId("member-confirm-dialog").getByTestId("member-confirm").click();
  await expect(a.getByText(`${rhea.name} can sign in again`)).toBeVisible();
  await expect(row).toHaveAttribute("data-status", "active");
  await expect(row.getByTestId("member-deactivated")).toHaveCount(0);
  const again = await apiAs(rhea);
  await again.dispose();

  // ---- no admin actions on your own row
  await openRowMenu(a, ADMIN.name);
  await expect(a.getByRole("menuitem", { name: "View profile" })).toBeVisible();
  await expect(a.getByRole("menuitem")).toHaveCount(1);
  await a.keyboard.press("Escape");

  await r.context().close();
  await rheaApi.dispose();
  await a.context().close();
});

test("anyone opens a member's profile from Members and from a channel", async ({ browser }, info) => {
  test.setTimeout(90_000);
  const project = info.project.name;
  const sam = person(project, "Sam");
  const { id: samId, api: profileUpdate } = await createMember(sam, "developer");
  await placeInUnits(samId, false);
  const updated = await profileUpdate.patch("/api/v1/me/profile", {
    data: { avatarUrl: "🦊", statusEmoji: "🚀", statusText: "Shipping the demo" },
  });
  expect(updated.ok(), "profile update").toBe(true);
  await profileUpdate.dispose();

  // A Developer (not an admin) opens it from the directory.
  const dev = person(project, "Viewer");
  const { api: devApi } = await createMember(dev, "developer");
  const d = await pageAs(browser, devApi, project);
  await openMembers(d);
  await rowOf(d, sam.name).getByTestId("member-name").click();
  const sheet = d.getByTestId("member-profile-sheet");
  await expect(sheet.getByTestId("profile-name")).toHaveText(sam.name);
  await expect(sheet.getByText("Developer", { exact: true })).toBeVisible();
  await expect(sheet.getByTestId("profile-joined")).toContainText("Joined");
  await expect(sheet.getByTestId("profile-units").getByRole("link")).toHaveCount(3);
  await expect(sheet.getByText("Core Platform")).toBeVisible();
  await shot(d, `members-profile-sheet-${project}`);
  await d.emulateMedia({ colorScheme: "dark" });
  await shot(d, `members-profile-sheet-${project}-dark`);
  await d.emulateMedia({ colorScheme: "light" });
  await d.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  // From a channel's member list.
  await d.goto(`${BASE_URL}/chat`);
  await expect(d).toHaveURL(/\/chat\/[0-9a-f-]{36}/);
  const channelId = d.url().match(/\/chat\/([0-9a-f-]{36})/)?.[1];
  await admin.post(`/api/v1/channels/${channelId}/members`, { data: { kind: "user", id: samId } });
  await d.reload();
  await d.getByTestId("channel-members-button").filter({ visible: true }).first().click();
  const members = d.getByTestId("members-dialog");
  await expect(members).toBeVisible();
  await members.getByRole("button", { name: `View ${sam.name}'s profile` }).click();
  await expect(d.getByTestId("member-profile-sheet").getByTestId("profile-name")).toHaveText(sam.name);

  // https avatars never send the workspace as referrer (T-02-12-03).
  const referers: Array<string | undefined> = [];
  await d.context().route("https://avatars.example.test/**", (route) => {
    referers.push(route.request().headers().referer);
    return route.fulfill({ contentType: "image/png", body: Buffer.from(PNG_1X1, "base64") });
  });
  const withPhoto = person(project, "Photo");
  const { id: photoId, api: photo } = await createMember(withPhoto, "standard");
  const patched = await photo.patch("/api/v1/me/profile", {
    data: { avatarUrl: "https://avatars.example.test/photo.png" },
  });
  expect(patched.ok()).toBe(true);
  await photo.dispose();
  await openMembers(d);
  await expect(d.locator(`[data-testid="member-row"][data-user-id="${photoId}"] img`)).toHaveAttribute(
    "referrerpolicy",
    "no-referrer",
  );
  expect(referers.length).toBeGreaterThan(0);
  expect(referers.every((r) => r === undefined)).toBe(true);

  await d.context().close();
  await devApi.dispose();
});
