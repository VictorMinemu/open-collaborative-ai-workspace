import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { type Actor, apiAs, ensureMember, openAs } from "../support/actors";
import { asSuperuser } from "../support/superuser";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import { shareDevice } from "../support/work-zone-projects";
import { ADMIN } from "./env";

/**
 * The Work Zone sidebar's actions (Phase 07.10-05, D-07, D-08, UI-SPEC § 2, § 5, § 7, § 9, States, R3, R5, R6) on the
 * real stack with the real local-runtime daemon in fake mode, at 1440 and 390, light and dark:
 * - the section "+": Leo, lead of Web (in Engineering) and of nothing in Operations, creates a project from
 *   ENGINEERING's "+", preselected on Web, and finds it in that section; OPERATIONS has no "+".
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
const T = { live: "" };
let portalRepo: FakeDeviceHandle;

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
