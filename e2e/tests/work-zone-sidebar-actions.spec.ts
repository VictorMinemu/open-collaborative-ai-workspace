import { type APIRequestContext, expect, type Locator, type Page, type Route, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { type Actor, apiAs, ensureMember, openAs } from "../support/actors";
import {
  captureReview,
  expectNoSidewaysScroll,
  expectTouchTargets,
  unnamedControls,
} from "../support/layout";
import { asSuperuser } from "../support/superuser";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import { shareDevice } from "../support/work-zone-projects";
import { ADMIN, shot } from "./env";

/**
 * The Work Zone sidebar's actions (Phase 07.10-05, D-07, D-08, UI-SPEC § 2, § 5, § 7, § 9, States, R3, R5, R6) on the
 * real stack with the real local-runtime daemon in fake mode, at 1440 and 390, light and dark:
 * - the section "+": Leo, lead of Web (in Engineering) and of nothing in Operations, creates a project from
 *   ENGINEERING's "+", preselected on Web, and finds it in that section; OPERATIONS has no "+".
 * - the project "+" (pointer only, in the live count's slot) and the repository "+" (visible on touch, 44 px) open the
 *   new-session dialog on that project's or repository's repository; the header "+" opens it as before.
 * - onboarding (D-08): with no team project, one quiet line, with "Create project" for someone who may create and a
 *   plain line for anyone else; it goes away once a project exists.
 * - a failing projects request shows "Couldn't load projects." with Try again and its active sessions grouped below,
 *   none lost and none twice; Try again brings the sections back.
 * Every screen: axe clean on the nav in light and dark, every control named, no sideways scroll, 44 px targets at 390.
 * Every unit, device and session the spec makes is removed in `afterAll`.
 */

test.describe.configure({ mode: "serial" });

const LEO: Actor = { name: "Leo Actions", email: "leo-wza@ocw.test", password: "leo-e2e-password-123" };
const PIA: Actor = { name: "Pia Actions", email: "pia-wza@ocw.test", password: "pia-e2e-password-123" };

let admin: APIRequestContext;
let pia: APIRequestContext;
let tag = "";
let run = "";
const units: string[] = [];
const devices: FakeDeviceHandle[] = [];
const sessionIds: string[] = [];
const linked: Array<{ unit: string; repo: string }> = [];
const U = { eng: "", web: "", portal: "", ops: "", billing: "" };
const N = { eng: "", web: "", portal: "", ops: "", billing: "", mobileApp: "" };
const T = { live: "", scratch: "" };
let portalRepo: FakeDeviceHandle;
let piaScratch: FakeDeviceHandle;
/** Fresh people with no team project, one per screen width (each run's onboarding starts from nothing). */
let NOVA: Actor;
let DEV: Actor;
let novaDept = "";

async function post<R>(api: APIRequestContext, path: string, data: unknown): Promise<R> {
  const r = await api.post(path, { data });
  expect(r.ok(), `${path}: ${r.status()} ${await r.text()}`).toBe(true);
  return (await r.json()) as R;
}

async function unit(kind: "department" | "team", name: string, parentId: string | null): Promise<string> {
  const id = (await post<{ id: string }>(admin, "/api/v1/units", { kind, name, parentId })).id;
  units.unshift(id);
  return id;
}

async function teamProject(name: string, parentId: string, members: string[]): Promise<string> {
  const id = (await post<{ id: string }>(admin, "/api/v1/work-projects", { name, parentId })).id;
  units.unshift(id);
  for (const userId of members) await post(admin, `/api/v1/units/${id}/members`, { userId, role: "member" });
  return id;
}

async function startSession(api: APIRequestContext, projectId: string, title: string): Promise<string> {
  const s = await post<{ id: string }>(api, "/api/v1/work-sessions", {
    projectId,
    runtime: "claude-code",
    permissionMode: "plan",
    title,
  });
  sessionIds.push(s.id);
  return s.id;
}

/** The sidebar; on a phone it lives in the navigation drawer. */
async function openSidebar(page: Page, mobile: boolean): Promise<Locator> {
  const list = page.getByTestId("session-list");
  if (mobile && !(await list.isVisible())) await page.getByTestId("mobile-nav-trigger").click();
  await expect(list).toBeVisible();
  return list;
}

/** On a phone, a navigation closes the drawer: wait until it is gone before opening it again. */
async function drawerClosed(page: Page, mobile: boolean) {
  if (mobile) await expect(page.getByTestId("session-list")).toBeHidden();
}

const sectionOf = (list: Locator, key: string) =>
  list.locator(`[data-testid="sidebar-section"][data-section="${key}"]`);

async function expectTarget44(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box, "a visible target").not.toBeNull();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(43.5);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(43.5);
}

/** axe on the nav in light and dark, named controls, no sideways scroll, and 44 px targets at 390 (C-02). */
async function checkSidebar(page: Page) {
  const nav = '[data-testid="session-list"]';
  await expectNoSeriousA11y(page, nav);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectNoSeriousA11y(page, nav);
  await page.emulateMedia({ colorScheme: "light" });
  expect(await unnamedControls(page)).toEqual([]);
  await expectNoSidewaysScroll(page, "work zone sidebar");
  await expectTouchTargets(page, nav);
}

/** `GET /api/v1/work-projects` itself (not `/parents` nor a project): the projects request of the sidebar. */
const isProjectsIndex = (url: URL) => url.pathname === "/api/v1/work-projects";
const failIndex = (route: Route) =>
  route.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "internal", message: "Internal error" } }),
  });

test.beforeAll(async () => {
  test.setTimeout(300_000);
  tag = test.info().project.name === "mobile" ? "390" : "1440";
  run = `${tag}-${Date.now().toString(36)}`;
  admin = await apiAs(ADMIN);
  const piaId = await ensureMember(admin, PIA, "developer");
  const leoId = await ensureMember(admin, LEO, "lead");
  pia = await apiAs(PIA);

  N.eng = `Engineering ${run}`;
  N.web = `Web ${run}`;
  N.portal = `Customer portal ${run}`;
  N.ops = `Operations ${run}`;
  N.billing = `Billing ops ${run}`;
  N.mobileApp = `Mobile app ${run}`;

  U.eng = await unit("department", N.eng, null);
  U.web = await unit("team", N.web, U.eng);
  await post(admin, `/api/v1/units/${U.web}/members`, { userId: piaId, role: "member" });
  await post(admin, `/api/v1/units/${U.web}/members`, { userId: leoId, role: "lead" });
  // Customer portal (under Web) holds Pia and Leo; Billing ops (in Operations, which Leo leads nothing of) holds Leo.
  U.portal = await teamProject(N.portal, U.web, [piaId, leoId]);
  U.ops = await unit("department", N.ops, null);
  U.billing = await teamProject(N.billing, U.ops, [leoId]);

  portalRepo = await startFakeDevice(admin, { name: `E2E Actions A ${tag}`, projectName: `wza-web-${tag}` });
  devices.push(portalRepo);
  await post(admin, `/api/v1/work-projects/${U.portal}/repos`, { projectId: portalRepo.projectId });
  linked.push({ unit: U.portal, repo: portalRepo.projectId });
  for (const id of [piaId, leoId]) await shareDevice(admin, portalRepo.deviceId, id);
  T.live = `Fix the login redirect ${run}`;
  const live = await startSession(admin, portalRepo.projectId, T.live);
  await asSuperuser("update app.work_sessions set status = $2 where id = $1", [live, "running"]);

  // Pia's own unlinked repository, with her session: her Personal section.
  piaScratch = await startFakeDevice(pia, {
    name: `E2E Pia actions ${tag}`,
    projectName: `wza-scratch-${tag}`,
  });
  devices.push(piaScratch);
  T.scratch = `Try the new linter ${run}`;
  await startSession(pia, piaScratch.projectId, T.scratch);

  // Onboarding: Nova leads a team that holds no project (she may create); Dev belongs to nothing.
  NOVA = { name: `Nova ${tag}`, email: `nova-wza-${tag}@ocw.test`, password: "nova-e2e-password-123" };
  DEV = { name: `Dev ${tag}`, email: `dev-wza-${tag}@ocw.test`, password: "dev-e2e-password-123" };
  const novaId = await ensureMember(admin, NOVA, "lead");
  await ensureMember(admin, DEV, "developer");
  novaDept = await unit("department", `Nova ${run}`, null);
  const novaTeam = await unit("team", `Nova team ${run}`, novaDept);
  await post(admin, `/api/v1/units/${novaTeam}/members`, { userId: novaId, role: "lead" });
});

test.afterAll(async () => {
  for (const id of sessionIds) {
    await admin.post(`/api/v1/work-sessions/${id}/archive`, { data: {} }).catch(() => undefined);
  }
  for (const l of linked) {
    await admin.delete(`/api/v1/work-projects/${l.unit}/repos/${l.repo}`).catch(() => undefined);
  }
  for (const d of devices) await d.stop();
  for (const id of units) await admin.delete(`/api/v1/units/${id}`).catch(() => undefined);
  await pia?.dispose();
  await admin.dispose();
});

test("section +: Leo creates a project from his department, preselected on his team, and finds it there", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const mobile = info.project.name === "mobile";
  const { context, page } = await openAs(browser, LEO, info.project.name);
  try {
    await page.goto("/work-zone");
    let list = await openSidebar(page, mobile);
    let eng = sectionOf(list, U.eng);
    const ops = sectionOf(list, U.ops);
    await expect(eng.getByTestId(`project-row-${U.portal}`)).toBeVisible({ timeout: 30_000 });
    await expect(ops.getByTestId(`project-row-${U.billing}`)).toBeVisible();

    // Only where he may create (Web, inside Engineering); never in Operations.
    const create = eng.getByTestId("section-create");
    await expect(create).toHaveCount(1);
    await expect(create).toHaveAccessibleName(`New project in ${N.eng}`);
    await expect(ops.getByTestId("section-create")).toHaveCount(0);
    if (mobile) {
      // Touch: always visible, a 44 × 44 target.
      await expect(create).toHaveCSS("opacity", "1");
      await expectTarget44(create);
    } else {
      // Pointer: shown on the header's hover only.
      await expect(create).toHaveCSS("opacity", "0");
      await eng.getByTestId("section-toggle").hover();
      await expect(create).toHaveCSS("opacity", "1");
    }
    await checkSidebar(page);

    // It opens New project, never navigates; Web is preselected (Engineering itself is not his to create in).
    await create.click();
    await expect(page).toHaveURL(/\/work-zone$/);
    const dialog = page.getByTestId("new-project-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("new-project-parent")).toContainText(N.web);
    await dialog.getByLabel("Name").fill(N.mobileApp);
    await dialog.getByTestId("new-project-submit").click();

    // The dialog's existing navigation: the new project's Settings tab.
    await expect(page).toHaveURL(/\/work-zone\/projects\/[0-9a-f-]{36}\?tab=settings$/, { timeout: 30_000 });
    const created = new URL(page.url()).pathname.split("/").at(-1) ?? "";
    units.unshift(created);
    await drawerClosed(page, mobile);
    list = await openSidebar(page, mobile);
    eng = sectionOf(list, U.eng);
    const row = eng.getByTestId(`project-row-${created}`);
    await expect(row).toContainText(N.mobileApp, { timeout: 30_000 });
    await expect(row.getByTestId("project-pill")).toHaveText(N.web);
    await expect(row).toHaveAttribute("aria-current", "page");
  } finally {
    await context.close();
  }
});

/** The new-session dialog, and the one repository it has chosen. */
async function sessionDialog(page: Page): Promise<{ dialog: Locator; chosen: Locator }> {
  const dialog = page.getByTestId("new-session-dialog");
  await expect(dialog).toBeVisible();
  const chosen = dialog.locator('[data-testid="project-option"][aria-checked="true"]');
  await expect(chosen).toHaveCount(1, { timeout: 30_000 });
  return { dialog, chosen };
}

async function closeDialog(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("new-session-dialog")).toHaveCount(0);
}

test("project + and repository +: a session starts where the row is; the header + is unchanged", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const mobile = info.project.name === "mobile";
  const { context, page } = await openAs(browser, PIA, info.project.name);
  try {
    await page.goto("/work-zone");
    let list = await openSidebar(page, mobile);
    const eng = sectionOf(list, U.eng);
    const row = eng.getByTestId(`project-row-${U.portal}`);
    const count = row.getByTestId("project-live-count");
    await expect(count).toHaveText("1", { timeout: 30_000 });
    const plus = eng.getByTestId("project-new-session");

    if (mobile) {
      // U-8: no project "+" on touch (an invisible target over the row is worse than none); the count stays.
      await expect(plus).toBeHidden();
      await expect(count).toBeVisible();
    } else {
      await expect(plus).toHaveAccessibleName(`New session in ${N.portal}`);
      await expect(plus).toHaveCSS("opacity", "0");
      const countBox = await count.boundingBox();
      const nameBox = await row.locator("span[title]").first().boundingBox();
      await row.hover();
      await expect(plus).toHaveCSS("opacity", "1");
      // The "+" takes the count's place: same right edge, the count only hidden, nothing else moves.
      await expect(count).toHaveCSS("visibility", "hidden");
      const plusBox = await plus.boundingBox();
      expect(countBox && plusBox).toBeTruthy();
      if (countBox && plusBox) {
        expect(Math.abs(plusBox.x + plusBox.width - (countBox.x + countBox.width))).toBeLessThanOrEqual(1);
      }
      expect(await row.locator("span[title]").first().boundingBox()).toEqual(nameBox);

      // It opens the dialog, never navigates, on Customer portal's repository, with the project's default audience.
      await plus.click();
      await expect(page).toHaveURL(/\/work-zone$/);
      const { dialog, chosen } = await sessionDialog(page);
      await expect(chosen).toContainText(`wza-web-${tag}`);
      await expect(
        dialog.getByTestId(`project-group-${U.portal}`).locator('[aria-checked="true"]'),
      ).toHaveCount(1);
      await expect(page.getByTestId("new-session-visibility")).toContainText(
        `Visible to: Everyone in ${N.portal}`,
      );
      await closeDialog(page);
    }

    // The repository "+": hover-revealed with a pointer, visible and 44 px on touch; the dialog opens on it.
    list = await openSidebar(page, mobile);
    const repo = list.getByTestId("personal-section").getByTestId(`repo-row-${piaScratch.projectId}`);
    const repoPlus = repo.getByTestId("repo-new-session");
    await expect(repoPlus).toHaveAccessibleName(`New session in wza-scratch-${tag}`);
    if (mobile) {
      await expect(repoPlus).toHaveCSS("opacity", "1");
      await expectTarget44(repoPlus);
    } else {
      await expect(repoPlus).toHaveCSS("opacity", "0");
      await repo.hover();
      await expect(repoPlus).toHaveCSS("opacity", "1");
    }
    await checkSidebar(page);
    await repoPlus.click();
    {
      const { chosen } = await sessionDialog(page);
      await expect(chosen).toContainText(`wza-scratch-${tag}`);
      await closeDialog(page);
    }

    // The header "+": the dialog as before, on the default repository (no preselection).
    await openSidebar(page, mobile);
    await page.getByTestId("sidebar-new-session").click();
    await sessionDialog(page);
    await closeDialog(page);
  } finally {
    await context.close();
  }
});

test("hover: the section + on focus and the project + in place of the count (review capture)", async ({
  browser,
}, info) => {
  test.skip(info.project.name === "mobile", "hover is a pointer state; touch shows the section + always");
  test.setTimeout(120_000);
  const { context, page } = await openAs(browser, LEO, info.project.name);
  try {
    await page.goto("/work-zone");
    const list = await openSidebar(page, false);
    const eng = sectionOf(list, U.eng);
    const row = eng.getByTestId(`project-row-${U.portal}`);
    await expect(row.getByTestId("project-live-count")).toHaveText("1", { timeout: 30_000 });
    // Keyboard focus reveals the section "+" (Tab from its toggle); the pointer rests on Customer portal.
    await eng.getByTestId("section-toggle").focus();
    await page.keyboard.press("Tab");
    const create = eng.getByTestId("section-create");
    await expect(create).toBeFocused();
    await expect(create).toHaveCSS("opacity", "1");
    await row.hover();
    await expect(eng.getByTestId("project-new-session")).toHaveCSS("opacity", "1");
    await expect(row.getByTestId("project-live-count")).toHaveCSS("visibility", "hidden");
    await shot(page, "sidebar-hover-plus-1440");
    await page.emulateMedia({ colorScheme: "dark" });
    await shot(page, "sidebar-hover-plus-1440-dark");
    await page.emulateMedia({ colorScheme: "light" });
  } finally {
    await context.close();
  }
});

test("onboarding: one quiet line, Create project for someone who may create; it leaves once a project exists", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const mobile = info.project.name === "mobile";

  // Anyone who may not create: the plain line, no link, no section.
  {
    const { context, page } = await openAs(browser, DEV, info.project.name);
    try {
      await page.goto("/work-zone");
      const list = await openSidebar(page, mobile);
      const line = list.getByTestId("onboarding-line");
      await expect(line).toHaveText("Team projects you're added to appear here.", { timeout: 30_000 });
      await expect(line.getByRole("button")).toHaveCount(0);
      await expect(list.getByTestId("sidebar-section")).toHaveCount(0);
      await checkSidebar(page);
    } finally {
      await context.close();
    }
  }

  // Nova may create (she leads a team): the line offers it, and goes away once her project exists.
  const { context, page } = await openAs(browser, NOVA, info.project.name);
  try {
    await page.goto("/work-zone");
    let list = await openSidebar(page, mobile);
    const line = list.getByTestId("onboarding-line");
    await expect(line).toHaveText("Share sessions with your team → Create project", { timeout: 30_000 });
    await expect(list.getByText("No sessions yet.")).toBeVisible();
    await expect(list.getByTestId("sidebar-section")).toHaveCount(0);
    await checkSidebar(page);
    await captureReview(page, `sidebar-onboarding-${tag}`);

    await line.getByRole("button", { name: "Create project" }).click();
    const dialog = page.getByTestId("new-project-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("new-project-parent")).toContainText(`Nova team ${run}`);
    await dialog.getByLabel("Name").fill(`Nova app ${run}`);
    await dialog.getByTestId("new-project-submit").click();
    await expect(page).toHaveURL(/\/work-zone\/projects\/[0-9a-f-]{36}\?tab=settings$/, { timeout: 30_000 });
    const created = new URL(page.url()).pathname.split("/").at(-1) ?? "";
    units.unshift(created);
    await drawerClosed(page, mobile);
    list = await openSidebar(page, mobile);
    await expect(sectionOf(list, novaDept).getByTestId(`project-row-${created}`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(list.getByTestId("onboarding-line")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("a failing projects request: the error line, Try again and every active session; Try again brings the sections back", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const mobile = info.project.name === "mobile";
  const { context, page } = await openAs(browser, PIA, info.project.name);
  try {
    await page.route(isProjectsIndex, failIndex);
    await page.goto("/work-zone");
    const list = await openSidebar(page, mobile);
    const error = list.getByTestId("projects-error");
    await expect(error).toContainText("Couldn't load projects.", { timeout: 30_000 });
    const retry = error.getByRole("button", { name: "Try again" });
    await expect(retry).toBeVisible();
    await expect(list.getByTestId("sidebar-section")).toHaveCount(0);

    // Nothing she had disappears, nothing shows twice: Customer portal's live session under its name in the
    // fallback, her own session under Personal.
    const fallback = error
      .getByRole("list", { name: `Active sessions in ${N.portal}`, exact: true })
      .getByTestId("session-row");
    await expect(fallback.filter({ hasText: T.live })).toHaveCount(1);
    await expect(list.getByTestId("session-row").filter({ hasText: T.live })).toHaveCount(1);
    const personal = list.getByTestId("personal-section");
    await expect(personal.getByTestId("session-row").filter({ hasText: T.scratch })).toHaveCount(1);
    await expect(list.getByTestId("session-row").filter({ hasText: T.scratch })).toHaveCount(1);
    await checkSidebar(page);
    if (!mobile) await captureReview(page, "sidebar-error-1440");

    // The request works again: Try again brings the sections back.
    await page.unroute(isProjectsIndex, failIndex);
    await retry.click();
    await expect(sectionOf(list, U.eng).getByTestId(`project-row-${U.portal}`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(list.getByTestId("projects-error")).toHaveCount(0);
  } finally {
    await context.close();
  }
});
