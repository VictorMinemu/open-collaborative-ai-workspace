import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
import { type Actor, apiAs, ensureMember, openAs } from "../support/actors";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import { ADMIN } from "./env";

/**
 * The Work Zone sidebar by team (Phase 07.10-03, UI-SPEC § 4-§ 7, D-01…D-04, D-06, D-09) on the real stack with the
 * real local-runtime daemon in fake mode, at 1440 and 390 (the drawer):
 * - the tracer: Pia, in Customer portal (a project of the Web team, in Engineering), finds it under ENGINEERING with
 *   the Web pill and its live session under it; the project row opens the project page, the sub-row the session.
 * Every unit, device and session the spec makes is removed in `afterAll`.
 */

test.describe.configure({ mode: "serial" });

const PIA: Actor = { name: "Pia Sidebar", email: "pia-wzs@ocw.test", password: "pia-e2e-password-123" };

let admin: APIRequestContext;
let tag = "";
let run = "";
let piaId = "";
const units: string[] = [];
const devices: FakeDeviceHandle[] = [];
const sessionIds: string[] = [];
const linked: Array<{ unit: string; repo: string }> = [];
const U = { eng: "", web: "", portal: "" };
const N = { eng: "", web: "", portal: "" };
const T = { one: "" };

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

async function teamProject(name: string, parentId: string): Promise<string> {
  const id = (await post<{ id: string }>(admin, "/api/v1/work-projects", { name, parentId })).id;
  units.unshift(id);
  return id;
}

async function link(unitId: string, repo: string) {
  await post(admin, `/api/v1/work-projects/${unitId}/repos`, { projectId: repo });
  linked.push({ unit: unitId, repo });
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
async function openSidebar(page: Page, mobile: boolean) {
  const list = page.getByTestId("session-list");
  if (mobile && !(await list.isVisible())) await page.getByTestId("mobile-nav-trigger").click();
  await expect(list).toBeVisible();
  return list;
}

const open = (browser: Browser, who: Actor, project: string) => openAs(browser, who, project);

test.beforeAll(async () => {
  test.setTimeout(300_000);
  tag = test.info().project.name === "mobile" ? "390" : "1440";
  run = `${tag}-${Date.now().toString(36)}`;
  admin = await apiAs(ADMIN);
  piaId = await ensureMember(admin, PIA, "developer");

  N.eng = `Engineering ${run}`;
  N.web = `Web ${run}`;
  N.portal = `Customer portal ${run}`;
  U.eng = await unit("department", N.eng, null);
  U.web = await unit("team", N.web, U.eng);
  U.portal = await teamProject(N.portal, U.web);
  await post(admin, `/api/v1/units/${U.portal}/members`, { userId: piaId, role: "member" });

  const portalRepo = await startFakeDevice(admin, {
    name: `E2E Sidebar A ${tag}`,
    projectName: `wzs-web-${tag}`,
  });
  devices.push(portalRepo);
  await link(U.portal, portalRepo.projectId);
  T.one = `Fix the login redirect ${run}`;
  await startSession(admin, portalRepo.projectId, T.one);
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
  await admin.dispose();
});

test("tracer: Pia opens her department's project from the sidebar, and its session from the row under it", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const mobile = info.project.name === "mobile";
  const { context, page } = await open(browser, PIA, info.project.name);
  try {
    await page.goto("/work-zone");
    let list = await openSidebar(page, mobile);
    const section = list.locator(`[data-testid="sidebar-section"][data-section="${U.eng}"]`);
    await expect(section.getByTestId("section-toggle")).toHaveText(N.eng, { timeout: 30_000 });
    await expect(section.getByTestId("section-toggle")).toHaveAttribute("aria-expanded", "true");
    // The title is uppercased by CSS only (UI-SPEC copy rule).
    await expect(section.getByTestId("section-toggle").locator("span").first()).toHaveCSS(
      "text-transform",
      "uppercase",
    );
    const row = section.getByTestId(`project-row-${U.portal}`);
    await expect(row).toContainText(N.portal);
    await expect(row.getByTestId("project-pill")).toHaveText(N.web);
    await expect(row).toHaveAttribute("href", `/work-zone/projects/${U.portal}`);
    const sub = section
      .getByRole("list", { name: `Active sessions in ${N.portal}` })
      .getByTestId("session-row")
      .filter({ hasText: T.one });
    await expect(sub).toHaveCount(1, { timeout: 30_000 });

    await row.click();
    await expect(page).toHaveURL(new RegExp(`/work-zone/projects/${U.portal}$`));
    await expect(page.getByTestId("project-page")).toBeVisible();
    list = await openSidebar(page, mobile);
    await expect(list.getByTestId(`project-row-${U.portal}`)).toHaveAttribute("aria-current", "page");
    await expect(list.getByTestId("sidebar-projects")).not.toHaveAttribute("aria-current", "page");

    await list.getByTestId("session-row").filter({ hasText: T.one }).click();
    await expect(page).toHaveURL(/\/work-zone\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("session-header")).toBeVisible({ timeout: 30_000 });
    list = await openSidebar(page, mobile);
    await expect(list.getByTestId("session-row").filter({ hasText: T.one })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(list.getByTestId(`project-row-${U.portal}`)).not.toHaveAttribute("aria-current", "page");
  } finally {
    await context.close();
  }
});
