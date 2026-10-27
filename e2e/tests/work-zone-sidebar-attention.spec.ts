import {
  type APIRequestContext,
  type Browser,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { type Actor, apiAs, ensureMember, openAs, userIdOf } from "../support/actors";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import { shareDevice } from "../support/work-zone-projects";
import { ADMIN } from "./env";

/**
 * What waits on each person in the Work Zone sidebar (Phase 07.10-04, D-05, UI-SPEC § 3) on the real stack with the
 * real local-runtime daemon in fake mode:
 * - the tracer: Leo's session in Customer portal asks for an approval on the fake device. Leo, who may decide it, finds
 *   it on top of his sidebar under "Needs you", even with Engineering collapsed; Pia, a member who can't decide it,
 *   only reads "Needs approval" on its sub-row; approving it from the session view removes the row live and the
 *   section with it.
 * Every unit, device and session the spec makes is removed in `afterAll`.
 */

test.describe.configure({ mode: "serial" });

const PIA: Actor = { name: "Pia Attention", email: "pia-wzn@ocw.test", password: "pia-e2e-password-123" };
const LEO: Actor = { name: "Leo Attention", email: "leo-wzn@ocw.test", password: "leo-e2e-password-123" };

let admin: APIRequestContext;
let pia: APIRequestContext;
let leo: APIRequestContext;
let tag = "";
let run = "";
let leoId = "";
const units: string[] = [];
const devices: FakeDeviceHandle[] = [];
const sessionIds: string[] = [];
const linked: Array<{ unit: string; repo: string }> = [];
const U = { eng: "", web: "", portal: "", design: "", ops: "", billing: "", lab: "" };
const N = { eng: "", web: "", portal: "", design: "", ops: "", billing: "", lab: "" };
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

async function teamProject(api: APIRequestContext, name: string, parentId: string, members: string[]) {
  const id = (await post<{ id: string }>(api, "/api/v1/work-projects", { name, parentId })).id;
  units.unshift(id);
  for (const userId of members) await post(admin, `/api/v1/units/${id}/members`, { userId, role: "member" });
  return id;
}

async function link(unitId: string, repo: string) {
  await post(admin, `/api/v1/work-projects/${unitId}/repos`, { projectId: repo });
  linked.push({ unit: unitId, repo });
}

/** A session; with a prompt in Supervised mode the fake device asks for an approval before writing. */
async function startSession(
  api: APIRequestContext,
  projectId: string,
  title: string,
  opts: { prompt?: string; mode?: "plan" | "default" } = {},
): Promise<string> {
  const s = await post<{ id: string }>(api, "/api/v1/work-sessions", {
    projectId,
    runtime: "claude-code",
    permissionMode: opts.mode ?? "plan",
    title,
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
  });
  sessionIds.push(s.id);
  return s.id;
}

async function statusOf(api: APIRequestContext, id: string): Promise<string> {
  const r = await api.get(`/api/v1/work-sessions/${id}`);
  return ((await r.json()) as { session: { status: string } }).session.status;
}

/** The sidebar; on a phone it lives in the navigation drawer. */
async function openSidebar(page: Page, mobile: boolean): Promise<Locator> {
  const list = page.getByTestId("session-list");
  if (mobile && !(await list.isVisible())) await page.getByTestId("mobile-nav-trigger").click();
  await expect(list).toBeVisible();
  return list;
}

/** On a phone, a link in the drawer navigates and closes it: wait until it is gone before opening it again. */
async function drawerClosed(page: Page, mobile: boolean) {
  if (mobile) await expect(page.getByTestId("session-list")).toBeHidden();
}

const sectionOf = (list: Locator, key: string) =>
  list.locator(`[data-testid="sidebar-section"][data-section="${key}"]`);
const subRows = (scope: Locator, name: string) =>
  scope.getByRole("list", { name: `Active sessions in ${name}`, exact: true }).getByTestId("session-row");
const needsRow = (list: Locator, title: string) =>
  list.getByTestId("needs-you").getByTestId("needs-you-row").filter({ hasText: title });

const open = (browser: Browser, who: Actor, project: string) => openAs(browser, who, project);

test.beforeAll(async () => {
  test.setTimeout(300_000);
  tag = test.info().project.name === "mobile" ? "390" : "1440";
  run = `${tag}-${Date.now().toString(36)}`;
  admin = await apiAs(ADMIN);
  const piaId = await ensureMember(admin, PIA, "developer");
  leoId = await ensureMember(admin, LEO, "lead");
  pia = await apiAs(PIA);
  leo = await apiAs(LEO);
  expect(await userIdOf(leo)).toBe(leoId);

  N.eng = `Engineering ${run}`;
  N.web = `Web ${run}`;
  N.portal = `Customer portal ${run}`;
  N.design = `Design system ${run}`;
  N.ops = `Operations ${run}`;
  N.billing = `Billing ops ${run}`;
  N.lab = `Leo lab ${run}`;

  U.eng = await unit("department", N.eng, null);
  U.web = await unit("team", N.web, U.eng);
  await post(admin, `/api/v1/units/${U.web}/members`, { userId: piaId, role: "member" });
  await post(admin, `/api/v1/units/${U.web}/members`, { userId: leoId, role: "lead" });
  U.portal = await teamProject(admin, N.portal, U.web, [piaId, leoId]);
  U.design = await teamProject(admin, N.design, U.eng, [piaId, leoId]);
  U.ops = await unit("department", N.ops, null);
  U.billing = await teamProject(admin, N.billing, U.ops, [leoId]);
  // Leo's own project under Web: the admin only manages it (a muted search result for him).
  U.lab = await teamProject(leo, N.lab, U.web, []);

  // The portal's repository: the admin's device, shared with Leo so he can start sessions on it.
  portalRepo = await startFakeDevice(admin, {
    name: `E2E Attention A ${tag}`,
    projectName: `wzn-web-${tag}`,
  });
  devices.push(portalRepo);
  await shareDevice(admin, portalRepo.deviceId, leoId);
  await link(U.portal, portalRepo.projectId);
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
  await leo?.dispose();
  await admin?.dispose();
});

test("tracer: an approval waiting on Leo reaches the top of his sidebar and leaves when he decides it", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const mobile = info.project.name === "mobile";
  const title = `Write the contributing guide ${run}`;
  const id = await startSession(leo, portalRepo.projectId, title, {
    mode: "default",
    prompt: "Add a short CONTRIBUTING guide for new teammates",
  });
  await expect
    .poll(() => statusOf(leo, id), { timeout: 60_000, message: "the fake device asks for an approval" })
    .toBe("waiting_approval");

  // Pia is in the project but may not decide it: no Needs you, and the sub-row says what is happening.
  {
    const { context, page } = await open(browser, PIA, info.project.name);
    try {
      await page.goto("/work-zone");
      const list = await openSidebar(page, mobile);
      const sub = subRows(sectionOf(list, U.eng), N.portal).filter({ hasText: title });
      await expect(sub.getByTestId("row-status")).toHaveText("Needs approval", { timeout: 30_000 });
      await expect(list.getByTestId("needs-you")).toHaveCount(0);
      await expect(list.getByTestId("needs-you-row")).toHaveCount(0);
    } finally {
      await context.close();
    }
  }

  const { context, page } = await open(browser, LEO, info.project.name);
  try {
    await page.goto("/work-zone");
    let list = await openSidebar(page, mobile);
    const needs = list.getByTestId("needs-you");
    const row = needsRow(list, title);
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    // On top: the first section of the nav, expanded, titled "Needs you".
    const first = await list
      .locator("section")
      .first()
      .evaluate((el) => el.getAttribute("data-testid"));
    expect(first).toBe("needs-you");
    await expect(needs.getByTestId("section-toggle")).toHaveText("Needs you");
    await expect(needs.getByTestId("section-toggle")).toHaveAttribute("aria-expanded", "true");
    // The row: badge, title, the warning reason; the project only to screen readers and in the hover title.
    await expect(row.getByTestId("row-project-badge")).toHaveText("CP");
    await expect(row.getByTestId("row-title")).toHaveText(title);
    await expect(row.getByTestId("row-status")).toHaveText("Needs approval");
    await expect(row.getByTestId("row-status")).toHaveAttribute("data-tone", "warning");
    await expect(row.getByTestId("row-project")).toHaveClass(/sr-only/);
    await expect(row.getByTestId("row-project")).toHaveText(N.portal);
    await expect(row).toHaveAttribute("title", `${title} · ${N.portal}`);
    await expect(row).toHaveAccessibleName(`${title}, Needs approval, in ${N.portal}`);
    await expect(row).toHaveAttribute("href", `/work-zone/${id}`);

    // Engineering collapsed: Customer portal stays, with only this session under it (D-01).
    const eng = sectionOf(list, U.eng);
    await eng.getByTestId("section-toggle").click();
    await expect(eng).toHaveAttribute("data-collapsed", "true");
    await expect(eng.getByTestId(`project-row-${U.portal}`)).toBeVisible();
    await expect(eng.getByTestId(`project-row-${U.design}`)).toHaveCount(0);
    await expect(subRows(eng, N.portal)).toHaveCount(1);
    await expect(subRows(eng, N.portal).first()).toContainText(title);
    await eng.getByTestId("section-toggle").click();
    await expect(eng).not.toHaveAttribute("data-collapsed", "true");

    // Approving from the session view removes the row and the section, without a reload.
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/work-zone/${id}$`));
    await drawerClosed(page, mobile);
    const banner = page.getByTestId("approval-banner");
    await expect(banner).toBeVisible({ timeout: 30_000 });
    list = await openSidebar(page, mobile);
    await expect(needsRow(list, title)).toHaveAttribute("aria-current", "page");
    if (mobile) {
      await page.keyboard.press("Escape");
      await drawerClosed(page, mobile);
    }
    await banner.getByTestId("approve-once").click();
    await expect(page.getByTestId("session-view")).toHaveAttribute("data-status", "idle", {
      timeout: 60_000,
    });
    list = await openSidebar(page, mobile);
    await expect(list.getByTestId("needs-you-row")).toHaveCount(0, { timeout: 30_000 });
    await expect(list.getByTestId("needs-you")).toHaveCount(0);
  } finally {
    await context.close();
  }
});
