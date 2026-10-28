import {
  type APIRequestContext,
  type Browser,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { type Actor, apiAs, ensureMember, openAs, userIdOf } from "../support/actors";
import {
  captureReview,
  expectNoSidewaysScroll,
  expectTouchTargets,
  unnamedControls,
} from "../support/layout";
import { asSuperuser } from "../support/superuser";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import { shareDevice } from "../support/work-zone-projects";
import { ADMIN } from "./env";

/**
 * The Work Zone sidebar by team (Phase 07.10-03, UI-SPEC § 4-§ 7, D-01…D-04, D-06, D-09, C-01…C-03) on the real
 * stack with the real local-runtime daemon in fake mode, at 1440 and 390 (the drawer), light and dark:
 * - the tracer: Pia, in Customer portal (a project of the Web team, in Engineering), finds it under ENGINEERING with
 *   the Web pill and its live session under it; the project row opens the project page, the sub-row the session;
 * - the structure: her own department first (Customer portal with 4 active sessions → 3 rows and "+1 more"; Design
 *   system, directly under Engineering, one quiet line), then Operations (Billing ops, reached through her team);
 *   projects she is not in are absent, and the admin's sidebar lists only the projects he belongs to;
 * - Personal: her unlinked repository with its session, and the admin's session on her device in a project she is not
 *   in, under that repository, the project named nowhere in the page, its titles or its accessible names (C-01); that
 *   session's chip and panel read "a project you can't open" (07.10-07, HI-01, ME-01);
 * - collapse is remembered across a reload, with a count pill, and keeps the open (settled) session visible.
 * Every unit, device and session the spec makes is removed in `afterAll`.
 */

test.describe.configure({ mode: "serial" });

const PIA: Actor = { name: "Pia Sidebar", email: "pia-wzs@ocw.test", password: "pia-e2e-password-123" };
const LEO: Actor = { name: "Leo Sidebar", email: "leo-wzs@ocw.test", password: "leo-e2e-password-123" };

let admin: APIRequestContext;
let pia: APIRequestContext;
let leo: APIRequestContext;
let tag = "";
let run = "";
let piaId = "";
let adminId = "";
const units: string[] = [];
const devices: FakeDeviceHandle[] = [];
const sessionIds: string[] = [];
const linked: Array<{ unit: string; repo: string }> = [];
const U = { eng: "", web: "", portal: "", design: "", vault: "", lab: "", ops: "", billing: "" };
const N = { eng: "", web: "", portal: "", design: "", vault: "", lab: "", ops: "", billing: "" };
/** The hidden project's own words: none may reach Pia's page (the run tag is shared with every other name). */
const VAULT_WORDS = ["Quillback", "Zephyrine"];
const T = { one: "", two: "", three: "", four: "", settled: "", scratch: "", onDevice: "" };
const S = { settled: "", onDevice: "" };
let piaScratch: FakeDeviceHandle;
let piaLinked: FakeDeviceHandle;

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

async function teamProject(api: APIRequestContext, name: string, parentId: string): Promise<string> {
  const id = (await post<{ id: string }>(api, "/api/v1/work-projects", { name, parentId })).id;
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

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sectionOf = (list: Locator, key: string) =>
  list.locator(`[data-testid="sidebar-section"][data-section="${key}"]`);
const subRows = (scope: Locator, name: string) =>
  scope.getByRole("list", { name: `Active sessions in ${name}`, exact: true }).getByTestId("session-row");

/** axe on the nav, named controls, no sideways scroll and 44 px targets below 1024, light and dark. */
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

const open = (browser: Browser, who: Actor, project: string) => openAs(browser, who, project);

test.beforeAll(async () => {
  test.setTimeout(300_000);
  tag = test.info().project.name === "mobile" ? "390" : "1440";
  run = `${tag}-${Date.now().toString(36)}`;
  admin = await apiAs(ADMIN);
  adminId = await userIdOf(admin);
  piaId = await ensureMember(admin, PIA, "developer");
  const leoId = await ensureMember(admin, LEO, "lead");
  pia = await apiAs(PIA);
  leo = await apiAs(LEO);

  for (const k of Object.keys(N) as Array<keyof typeof N>) N[k] = "";
  N.eng = `Engineering ${run}`;
  N.web = `Web ${run}`;
  N.portal = `Customer portal ${run}`;
  N.design = `Design system ${run}`;
  N.vault = `${VAULT_WORDS.join(" ")} ${run}`;
  N.lab = `Leo lab ${run}`;
  N.ops = `Operations ${run}`;
  N.billing = `Billing ops ${run}`;

  U.eng = await unit("department", N.eng, null);
  U.web = await unit("team", N.web, U.eng);
  await post(admin, `/api/v1/units/${U.web}/members`, { userId: piaId, role: "member" });
  await post(admin, `/api/v1/units/${U.web}/members`, { userId: leoId, role: "lead" });
  // Pia's projects: directly (Customer portal, Design system) and through her team (Billing ops, in Operations).
  U.portal = await teamProject(admin, N.portal, U.web);
  await post(admin, `/api/v1/units/${U.portal}/members`, { userId: piaId, role: "member" });
  U.design = await teamProject(admin, N.design, U.eng);
  await post(admin, `/api/v1/units/${U.design}/members`, { userId: piaId, role: "member" });
  U.ops = await unit("department", N.ops, null);
  U.billing = await teamProject(admin, N.billing, U.ops);
  await post(admin, `/api/v1/work-projects/${U.billing}/teams`, { unitId: U.web });
  // Not Pia's: the admin's vault (it links her device's repository) and Leo's lab (the admin only manages it).
  U.vault = await teamProject(admin, N.vault, U.eng);
  U.lab = await teamProject(leo, N.lab, U.web);

  const portalRepo = await startFakeDevice(admin, {
    name: `E2E Sidebar A ${tag}`,
    projectName: `wzs-web-${tag}`,
  });
  devices.push(portalRepo);
  await link(U.portal, portalRepo.projectId);
  T.one = `Fix the login redirect ${run}`;
  T.two = `Upgrade the payments SDK ${run}`;
  T.three = `Tidy the settings page ${run}`;
  T.four = `Audit the cookie banner ${run}`;
  T.settled = `Ship the release notes ${run}`;
  for (const title of [T.four, T.three, T.two, T.one]) await startSession(admin, portalRepo.projectId, title);
  S.settled = await startSession(admin, portalRepo.projectId, T.settled);
  // Both rows are rewritten only once the fake device has settled them (idle), so its own late answer never overwrites
  // the status (pipeline 83: under CI load "running" went back to idle and "● 1" never showed).
  const live = sessionIds.at(-2) as string;
  for (const id of [S.settled, live]) {
    await expect
      .poll(
        async () => {
          const r = await admin.get(`/api/v1/work-sessions/${id}`);
          return r.ok() ? ((await r.json()) as { session: { status: string } }).session.status : undefined;
        },
        { timeout: 30_000, message: "the session is idle before its status is rewritten" },
      )
      .toBe("idle");
  }
  await asSuperuser("update app.work_sessions set status = $2 where id = $1", [S.settled, "completed"]);
  // One live session: the project row shows "● 1".
  await asSuperuser("update app.work_sessions set status = $2 where id = $1", [live, "running"]);

  // Pia's own devices: an unlinked repository, and one linked to the admin's vault (D-11: she owns the device).
  piaScratch = await startFakeDevice(pia, {
    name: `E2E Pia scratch ${tag}`,
    projectName: `pia-scratch-${tag}`,
  });
  devices.push(piaScratch);
  piaLinked = await startFakeDevice(pia, { name: `E2E Pia linked ${tag}`, projectName: `pia-linked-${tag}` });
  devices.push(piaLinked);
  T.scratch = `Try the new linter ${run}`;
  await startSession(pia, piaScratch.projectId, T.scratch);
  await shareDevice(pia, piaLinked.deviceId, adminId);
  await link(U.vault, piaLinked.projectId);
  T.onDevice = `Rotate the signing keys ${run}`;
  S.onDevice = await startSession(admin, piaLinked.projectId, T.onDevice);
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
    const section = sectionOf(list, U.eng);
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
    const sub = subRows(section, N.portal).filter({ hasText: T.one });
    await expect(sub).toHaveCount(1, { timeout: 30_000 });

    await row.click();
    await expect(page).toHaveURL(new RegExp(`/work-zone/projects/${U.portal}$`));
    await expect(page.getByTestId("project-page")).toBeVisible();
    await drawerClosed(page, mobile);
    list = await openSidebar(page, mobile);
    await expect(list.getByTestId(`project-row-${U.portal}`)).toHaveAttribute("aria-current", "page");
    await expect(list.getByTestId("sidebar-projects")).not.toHaveAttribute("aria-current", "page");

    await subRows(list, N.portal).filter({ hasText: T.one }).click();
    await expect(page).toHaveURL(/\/work-zone\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("session-header")).toBeVisible({ timeout: 30_000 });
    await drawerClosed(page, mobile);
    list = await openSidebar(page, mobile);
    await expect(subRows(list, N.portal).filter({ hasText: T.one })).toHaveAttribute("aria-current", "page");
    await expect(list.getByTestId(`project-row-${U.portal}`)).not.toHaveAttribute("aria-current", "page");
  } finally {
    await context.close();
  }
});

test("structure: her departments in order, 3 sessions then +1 more, a quiet project, nothing she is not in", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const mobile = info.project.name === "mobile";
  const { context, page } = await open(browser, PIA, info.project.name);
  try {
    await page.goto("/work-zone");
    const list = await openSidebar(page, mobile);
    const eng = sectionOf(list, U.eng);
    const ops = sectionOf(list, U.ops);
    await expect(eng.getByTestId(`project-row-${U.portal}`)).toBeVisible({ timeout: 30_000 });
    // Her own department (Engineering) first; Operations, reached only through a team, after it.
    const order = await list
      .locator('[data-testid="sidebar-section"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-section")));
    expect(order.indexOf(U.eng)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(U.eng)).toBeLessThan(order.indexOf(U.ops));
    await expect(ops.getByTestId("section-toggle")).toHaveText(N.ops);

    // Customer portal: the Web pill, "● 1" live, 3 of its 4 active sessions (live first), then "+1 more".
    const portal = eng.getByTestId(`project-row-${U.portal}`);
    await expect(portal.getByTestId("project-live-count")).toHaveText("1");
    await expect(portal).toHaveAccessibleName(
      new RegExp(`^${reEscape(N.portal)}\\s*, ${reEscape(N.web)}\\s*, 1 running$`),
    );
    const rows = subRows(eng, N.portal);
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toHaveAttribute("data-status", "running");
    await expect(rows.first().getByTestId("row-status")).toHaveText(/^Working/);
    await expect(rows.filter({ hasText: T.settled })).toHaveCount(0);
    const more = eng.getByTestId("project-more");
    await expect(more).toHaveText("+1 more");
    await expect(more).toHaveAccessibleName(`1 more active session in ${N.portal}`);
    await expect(more).toHaveAttribute("href", `/work-zone/projects/${U.portal}`);

    // Design system sits directly under Engineering: one quiet line, no pill, no count, no sessions.
    const design = eng.getByTestId(`project-row-${U.design}`);
    await expect(design).toHaveText(N.design);
    await expect(design.getByTestId("project-pill")).toHaveCount(0);
    await expect(design.getByTestId("project-live-count")).toHaveCount(0);
    await expect(eng.getByRole("list", { name: `Active sessions in ${N.design}` })).toHaveCount(0);

    // Billing ops: in Operations, through her team; directly under the department, so no pill.
    await expect(ops.getByTestId(`project-row-${U.billing}`)).toHaveText(N.billing);

    // Projects she is not in are not rows (the vault and Leo's lab), anywhere in the sidebar.
    await expect(list.getByTestId(`project-row-${U.vault}`)).toHaveCount(0);
    await expect(list.getByTestId(`project-row-${U.lab}`)).toHaveCount(0);

    await checkSidebar(page);
    await eng.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await captureReview(page, `sidebar-sections-${tag}`);

    // "+1 more" opens the project page, where every session is listed.
    await more.click();
    await expect(page).toHaveURL(new RegExp(`/work-zone/projects/${U.portal}$`));
    await expect(page.getByTestId("project-session-row")).toHaveCount(5, { timeout: 30_000 });
  } finally {
    await context.close();
  }
});

test("Personal: her repository and a project she can't open, never named on her page", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const mobile = info.project.name === "mobile";
  const { context, page } = await open(browser, PIA, info.project.name);
  try {
    await page.goto("/work-zone");
    const list = await openSidebar(page, mobile);
    const personal = list.getByTestId("personal-section");
    await expect(personal.getByTestId("section-toggle")).toHaveText("Personal", { timeout: 30_000 });
    const scratch = personal.getByTestId(`repo-row-${piaScratch.projectId}`);
    await expect(scratch).toHaveText(`pia-scratch-${tag}`);
    await expect(scratch).not.toHaveAttribute("title", /.+/);
    await expect(subRows(personal, `pia-scratch-${tag}`).filter({ hasText: T.scratch })).toHaveCount(1);
    // The repository row is not a link: a repository has no page.
    expect(await scratch.evaluate((el) => el.tagName)).toBe("DIV");

    const linkedRow = personal.getByTestId(`repo-row-${piaLinked.projectId}`);
    // The repository's name, then the hint for screen readers (07.10-07, LO-04), and the same hint as its tooltip.
    await expect(linkedRow).toHaveText(`pia-linked-${tag}, Linked to a project you can't open`);
    await expect(linkedRow.locator(".sr-only")).toHaveText(", Linked to a project you can't open");
    await expect(linkedRow).toHaveAttribute("title", "Linked to a project you can't open");
    await expect(subRows(personal, `pia-linked-${tag}`).filter({ hasText: T.onDevice })).toHaveCount(1, {
      timeout: 30_000,
    });

    // The secrecy backstop (C-01, T-07.10-03-01): no word of the vault's name in the page's markup (text, sr-only
    // text, title attributes, aria labels) nor in any accessible name in the nav.
    const seen = await page.evaluate(() => {
      const nav = document.querySelector('[data-testid="session-list"]');
      const names = [...(nav?.querySelectorAll("a, button, [role], [title], [aria-label]") ?? [])].map(
        (el) =>
          `${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""} ${el.textContent ?? ""}`,
      );
      const titles = [...document.querySelectorAll("[title]")].map((el) => el.getAttribute("title") ?? "");
      return {
        html: document.documentElement.outerHTML,
        text: document.body.innerText,
        names: names.join("\n"),
        titles: titles.join("\n"),
      };
    });
    for (const word of VAULT_WORDS) {
      const re = new RegExp(word, "i");
      expect(seen.html, `"${word}" in the page markup`).not.toMatch(re);
      expect(seen.text, `"${word}" in the page text`).not.toMatch(re);
      expect(seen.names, `"${word}" in an accessible name`).not.toMatch(re);
      expect(seen.titles, `"${word}" in a title`).not.toMatch(re);
    }
    for (const row of await list.getByRole("link").all()) {
      const name = await row.evaluate((el) => el.getAttribute("aria-label") ?? el.textContent ?? "");
      for (const word of VAULT_WORDS) expect(name).not.toMatch(new RegExp(word, "i"));
    }

    if (!mobile) {
      await personal.evaluate((el) => el.scrollIntoView({ block: "start" }));
      await captureReview(page, "sidebar-hidden-project-1440");
    }
    await checkSidebar(page);

    // 07.10-07 (HI-01, ME-01): the session on her device, in a project she can't open. Its header chip says so (never
    // "everyone who can use" her device) and its panel is the read-only hidden form, naming no project.
    await page.goto(`/work-zone/${S.onDevice}`);
    const chip = page.getByTestId("session-header").getByTestId("visibility-chip");
    await expect(chip).toHaveAccessibleName(
      "Visible to Everyone in a project you can't open. See who can see this session",
      { timeout: 30_000 },
    );
    await chip.click();
    const panel = page.getByTestId("visibility-panel");
    await expect(panel).toBeVisible();
    await expect(panel).not.toHaveAttribute("data-loading", "true");
    await expect(panel).toHaveAttribute("data-editable", "false");
    await expect(panel.getByTestId("visibility-readonly-note")).toHaveText(
      "Linked to a project you can't open.",
    );
    await expect(panel.getByRole("radio")).toHaveCount(0);
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    for (const word of VAULT_WORDS)
      expect(html, `"${word}" with the panel open`).not.toMatch(new RegExp(word, "i"));
  } finally {
    await context.close();
  }
});

test("collapse is remembered across a reload, counts what it hides and keeps the open settled session", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const mobile = info.project.name === "mobile";
  const { context, page } = await open(browser, PIA, info.project.name);
  try {
    await page.goto(`/work-zone/${S.settled}`);
    await expect(page.getByTestId("session-header")).toBeVisible({ timeout: 30_000 });
    let list = await openSidebar(page, mobile);
    let eng = sectionOf(list, U.eng);
    // The open session shows under its project even though it is settled.
    const openRow = subRows(eng, N.portal).filter({ hasText: T.settled });
    await expect(openRow).toHaveAttribute("aria-current", "page", { timeout: 30_000 });
    await expect(openRow).toHaveAttribute("data-status", "completed");

    await eng.getByTestId("section-toggle").click();
    await expect(eng).toHaveAttribute("data-collapsed", "true");
    await expect(eng.getByTestId("section-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(eng.getByTestId("section-toggle")).toHaveAttribute("aria-controls", `wz-list-${U.eng}`);
    // Design system is hidden (1); Customer portal stays, with only the open session under it.
    await expect(eng.getByTestId("section-count")).toHaveText("1");
    await expect(eng.getByTestId("section-toggle")).toHaveAccessibleName(
      new RegExp(`^${reEscape(N.eng)}\\s*1\\s*, 1 hidden$`),
    );
    await expect(eng.getByTestId(`project-row-${U.design}`)).toHaveCount(0);
    await expect(subRows(eng, N.portal)).toHaveCount(1);
    await expect(subRows(eng, N.portal).first()).toContainText(T.settled);

    await page.reload();
    await expect(page.getByTestId("session-header")).toBeVisible({ timeout: 30_000 });
    list = await openSidebar(page, mobile);
    eng = sectionOf(list, U.eng);
    await expect(eng).toHaveAttribute("data-collapsed", "true", { timeout: 30_000 });
    await expect(eng.getByTestId("section-count")).toHaveText("1");
    await expect(subRows(eng, N.portal).filter({ hasText: T.settled })).toHaveAttribute(
      "aria-current",
      "page",
    );
    if (!mobile) await captureReview(page, "sidebar-open-session-1440");

    // Every section collapsed, on the home page: header lines with their count pills.
    if (!mobile) {
      await page.goto("/work-zone");
      list = await openSidebar(page, mobile);
      for (const section of [sectionOf(list, U.ops), list.getByTestId("personal-section")]) {
        await section.getByTestId("section-toggle").click();
        await expect(section).toHaveAttribute("data-collapsed", "true");
      }
      await expect(sectionOf(list, U.eng).getByTestId("section-count")).toHaveText("2");
      await expect(sectionOf(list, U.ops).getByTestId("section-count")).toHaveText("1");
      await expect(list.getByTestId("personal-section").getByTestId("section-count")).toHaveText("2");
      await checkSidebar(page);
      await captureReview(page, "sidebar-collapsed-1440");
    }

    // Opening it again shows every project.
    eng = sectionOf(list, U.eng);
    await eng.getByTestId("section-toggle").click();
    await expect(eng).not.toHaveAttribute("data-collapsed", "true");
    await expect(eng.getByTestId(`project-row-${U.design}`)).toBeVisible();
  } finally {
    await context.close();
  }
});

test("the admin's sidebar lists only the projects he belongs to; Browse projects lists the rest", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const mobile = info.project.name === "mobile";
  const { context, page } = await open(browser, ADMIN, info.project.name);
  try {
    await page.goto("/work-zone");
    const list = await openSidebar(page, mobile);
    await expect(sectionOf(list, U.eng).getByTestId(`project-row-${U.vault}`)).toBeVisible({
      timeout: 30_000,
    });
    // Leo's lab: the admin opens and manages it but is not in it (D-02).
    await expect(list.getByTestId(`project-row-${U.lab}`)).toHaveCount(0);
    await list.getByTestId("sidebar-projects").click();
    await expect(page).toHaveURL(/\/work-zone\/projects$/);
    const index = page.getByTestId("projects-index");
    await expect(index.getByTestId(`project-row-${U.lab}`)).toContainText(N.lab, { timeout: 30_000 });
    if (!mobile) await expect(page.getByTestId("sidebar-projects")).toHaveAttribute("aria-current", "page");
  } finally {
    await context.close();
  }
});
