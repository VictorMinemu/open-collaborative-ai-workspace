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
 * What waits on each person in the Work Zone sidebar, its history and its search (Phase 07.10-04, D-01, D-04, D-05,
 * D-08, UI-SPEC § 3, § 8, § 11, States, § Keyboard, C-01, C-02) on the real stack with the real local-runtime daemon in
 * fake mode, at 1440 and 390, light and dark:
 * - the tracer: Leo's session in Customer portal asks for an approval on the fake device. Leo, who may decide it, finds
 *   it on top of his sidebar under "Needs you", even with Engineering collapsed; Pia, a member who can't decide it,
 *   only reads "Needs approval" on its sub-row; approving it from the session view removes the row live and the
 *   section with it.
 * - "Your turn": a turn of Leo's that ended while he was elsewhere waits for him until he opens the session; a new
 *   turn starting removes it; once seen it stays away in this browser.
 * - the whole sidebar: Needs you (an approval and a turn), two departments (Operations collapsed, keeping the row that
 *   needs him), a team pill, a project with more than 3 sessions and one with none, Personal, Settled collapsed; Settled
 *   opens and pages 10 then "Show 2 more".
 * - search: grouped Projects (a managed one muted), Sessions and Repositories, "Show all {n}", "Nothing matches"; Pia
 *   never finds the project she can't open by its name (C-01).
 * - a failing sessions request keeps the project rows with "Couldn't load sessions." and Try again.
 * - keys (desktop): ArrowDown from search into the results and the rows, ↑/↓/Home/End, ←/→ on a toggle, Escape clears
 *   the query; focus stays in Needs you when the focused row leaves because its approval was decided elsewhere,
 *   and is never pulled back into the sidebar once it left it (07.10-07, LO-03).
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
const U = { eng: "", web: "", portal: "", design: "", ops: "", billing: "", lab: "", reports: "", vault: "" };
const N = { eng: "", web: "", portal: "", design: "", ops: "", billing: "", lab: "", reports: "", vault: "" };
/** The hidden project's own words: Pia's search never finds them (the run tag is shared with every other name). */
const VAULT_WORDS = ["Quillback", "Zephyrine"];
/** Titles; `S` the ids of the sessions later tests act on. */
const T = { approval: "", turn: "", invoices: "", scratch: "", ledger: "", onDevice: "" };
const S = { approval: "", invoices: "" };
let portalRepo: FakeDeviceHandle;
let billingRepo: FakeDeviceHandle;
let leoScratch: FakeDeviceHandle;
let ledgerRepo: FakeDeviceHandle;
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

async function statuses(api: APIRequestContext, ids: string[]): Promise<string[]> {
  const r = await api.get("/api/v1/work-sessions");
  const all = ((await r.json()) as { sessions: Array<{ id: string; status: string }> }).sessions;
  return ids.map((id) => all.find((s) => s.id === id)?.status ?? "missing");
}

/** Decides the session's pending approval through the API, as if from another tab or person. */
async function approve(api: APIRequestContext, id: string) {
  const r = await api.get(`/api/v1/work-sessions/${id}`);
  const detail = (await r.json()) as { approvals: Array<{ id: string; status: string }> };
  const pending = detail.approvals.find((a) => a.status === "pending");
  expect(pending, "a pending approval").toBeDefined();
  await post(api, `/api/v1/work-sessions/${id}/approvals/${pending?.id}`, { decision: "once" });
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

/** axe on the nav in light and dark, named controls, no sideways scroll and 44 px targets at 390 (C-02). */
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

/** The text and test id of the focused element. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      testId: el?.getAttribute("data-testid") ?? "",
      id: el?.id ?? "",
      text: el?.textContent ?? "",
      inNeeds: el?.closest('[data-testid="needs-you"]') !== null,
    };
  });

const open = (browser: Browser, who: Actor, project: string) => openAs(browser, who, project);

test.beforeAll(async () => {
  test.setTimeout(420_000);
  tag = test.info().project.name === "mobile" ? "390" : "1440";
  run = `${tag}-${Date.now().toString(36)}`;
  admin = await apiAs(ADMIN);
  const adminId = await userIdOf(admin);
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
  N.lab = `Ledger lab ${run}`;
  N.reports = `Ledger reports ${run}`;
  N.vault = `${VAULT_WORDS.join(" ")} ${run}`;

  U.eng = await unit("department", N.eng, null);
  U.web = await unit("team", N.web, U.eng);
  await post(admin, `/api/v1/units/${U.web}/members`, { userId: piaId, role: "member" });
  await post(admin, `/api/v1/units/${U.web}/members`, { userId: leoId, role: "lead" });
  U.portal = await teamProject(admin, N.portal, U.web, [piaId, leoId]);
  U.design = await teamProject(admin, N.design, U.eng, [piaId, leoId]);
  U.ops = await unit("department", N.ops, null);
  U.billing = await teamProject(admin, N.billing, U.ops, [leoId]);
  // Leo's own project under Web: the admin only manages it (a muted search result for him); the admin leads Ledger
  // reports, his own (a plain one); the vault is the admin's and linked to Pia's device, a project she can't open.
  U.lab = await teamProject(leo, N.lab, U.web, []);
  U.reports = await teamProject(admin, N.reports, U.eng, []);
  U.vault = await teamProject(admin, N.vault, U.eng, []);

  // The portal's and Billing's repositories: the admin's devices, shared with Leo so he can start sessions on them.
  // Slow enough that a running turn is seen in the sidebar before it ends.
  portalRepo = await startFakeDevice(admin, {
    name: `E2E Attention A ${tag}`,
    projectName: `wzn-web-${tag}`,
    env: { OCW_RUNTIME_FAKE_DELAY_MS: "400" },
  });
  devices.push(portalRepo);
  await shareDevice(admin, portalRepo.deviceId, leoId);
  await link(U.portal, portalRepo.projectId);
  billingRepo = await startFakeDevice(admin, {
    name: `E2E Attention B ${tag}`,
    projectName: `wzn-ops-${tag}`,
  });
  devices.push(billingRepo);
  await shareDevice(admin, billingRepo.deviceId, leoId);
  await link(U.billing, billingRepo.projectId);
  // Leo's own repository (Personal) and the admin's own one (a repository in his search).
  leoScratch = await startFakeDevice(leo, {
    name: `E2E Leo scratch ${tag}`,
    projectName: `leo-scratch-${tag}`,
  });
  devices.push(leoScratch);
  ledgerRepo = await startFakeDevice(admin, { name: `E2E Ledger ${tag}`, projectName: `ledger-${tag}` });
  devices.push(ledgerRepo);
  // Pia's device, linked to the vault (D-11: she owns the device, never sees the project named).
  piaLinked = await startFakeDevice(pia, { name: `E2E Pia linked ${tag}`, projectName: `pia-linked-${tag}` });
  devices.push(piaLinked);
  await shareDevice(pia, piaLinked.deviceId, adminId);
  await link(U.vault, piaLinked.projectId);

  // Customer portal: 4 quiet active sessions (with Leo's tracer session: more than 3) and 12 settled ones.
  const quiet: string[] = [];
  for (const title of [
    "Audit the cookie banner",
    "Tidy the settings page",
    "Upgrade the payments SDK",
    "Fix 404s",
  ])
    quiet.push(await startSession(admin, portalRepo.projectId, `${title} ${run}`));
  const settled: string[] = [];
  for (let i = 1; i <= 12; i++)
    settled.push(
      await startSession(admin, portalRepo.projectId, `Done ${run} #${String(i).padStart(2, "0")}`),
    );
  T.scratch = `Try the new linter ${run}`;
  await startSession(leo, leoScratch.projectId, T.scratch);
  T.ledger = `Ledger export ${run}`;
  await startSession(admin, ledgerRepo.projectId, T.ledger);
  T.onDevice = `Rotate the signing keys ${run}`;
  await startSession(admin, piaLinked.projectId, T.onDevice);
  // Once the device has answered (idle), settle the 12, so its own answer never overwrites "completed".
  await expect
    .poll(async () => (await statuses(admin, [...quiet, ...settled])).every((s) => s === "idle"), {
      timeout: 60_000,
      message: "the portal's sessions are idle",
    })
    .toBe(true);
  for (const id of settled)
    await asSuperuser("update app.work_sessions set status = $2 where id = $1", [id, "completed"]);
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
  T.approval = `Write the contributing guide ${run}`;
  const id = await startSession(leo, portalRepo.projectId, T.approval, {
    mode: "default",
    prompt: "Add a short CONTRIBUTING guide for new teammates",
  });
  S.approval = id;
  const title = T.approval;
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

test("Your turn: a turn of Leo's that ended elsewhere waits until he opens it; a new turn removes it", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const mobile = info.project.name === "mobile";
  const { context, page } = await open(browser, LEO, info.project.name);
  try {
    await page.goto("/work-zone");
    let list = await openSidebar(page, mobile);
    // The tracer's turn ended in another browser: this one never opened it, so it is his turn here (U-4).
    const tracer = needsRow(list, T.approval);
    await expect(tracer.getByTestId("row-status")).toHaveText("Your turn", { timeout: 30_000 });
    await expect(tracer.getByTestId("row-status")).toHaveAttribute("data-tone", "foreground");
    await expect(tracer).toHaveAccessibleName(`${T.approval}, Your turn, in ${N.portal}`);
    // Opening it removes it; back on the home page it stays away (seen in this browser).
    await tracer.click();
    await expect(page).toHaveURL(new RegExp(`/work-zone/${S.approval}$`));
    await expect(page.getByTestId("session-header")).toBeVisible({ timeout: 30_000 });
    await drawerClosed(page, mobile);
    list = await openSidebar(page, mobile);
    await expect(list.getByTestId("needs-you-row")).toHaveCount(0);
    await page.goto("/work-zone");
    list = await openSidebar(page, mobile);
    await expect(sectionOf(list, U.eng).getByTestId(`project-row-${U.portal}`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(list.getByTestId("needs-you-row")).toHaveCount(0);

    // A turn of his ends while he is here, on another page: "Your turn" appears live.
    T.turn = `Summarise the open issues ${run}`;
    const turn = await startSession(leo, portalRepo.projectId, T.turn, { prompt: "List the open issues" });
    const row = needsRow(list, T.turn);
    await expect(row.getByTestId("row-status")).toHaveText("Your turn", { timeout: 60_000 });
    // A new turn starting removes it (running); when that one ends, it is his turn again.
    await post(leo, `/api/v1/work-sessions/${turn}/prompts`, { body: "And group them by label" });
    await expect(row).toHaveCount(0, { timeout: 30_000 });
    await expect(row.getByTestId("row-status")).toHaveText("Your turn", { timeout: 60_000 });
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/work-zone/${turn}$`));
    await drawerClosed(page, mobile);
    list = await openSidebar(page, mobile);
    await expect(list.getByTestId("needs-you-row")).toHaveCount(0);
    // Not needed by the screens below: archived, so the next browser's Needs you holds exactly two rows.
    await post(admin, `/api/v1/work-sessions/${turn}/archive`, {});
  } finally {
    await context.close();
  }
});

test("the whole sidebar: Needs you, departments with one collapsed, Personal, Settled collapsed and paging", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const mobile = info.project.name === "mobile";
  T.invoices = `Export the invoices ${run}`;
  S.invoices = await startSession(leo, billingRepo.projectId, T.invoices, {
    mode: "default",
    prompt: "Export the invoices of last month to a CSV",
  });
  await expect
    .poll(() => statusOf(leo, S.invoices), {
      timeout: 60_000,
      message: "the fake device asks for an approval",
    })
    .toBe("waiting_approval");

  const { context, page } = await open(browser, LEO, info.project.name);
  try {
    await page.goto("/work-zone");
    const list = await openSidebar(page, mobile);
    const needs = list.getByTestId("needs-you");
    const rows = needs.getByTestId("needs-you-row");
    // An approval first, then his turn (the tracer's, never opened in this browser).
    await expect(rows).toHaveCount(2, { timeout: 30_000 });
    await expect(rows.nth(0)).toContainText(T.invoices);
    await expect(rows.nth(0).getByTestId("row-status")).toHaveText("Needs approval");
    await expect(rows.nth(1)).toContainText(T.approval);
    await expect(rows.nth(1).getByTestId("row-status")).toHaveText("Your turn");

    // Operations collapsed keeps Billing ops and the session that needs him.
    const ops = sectionOf(list, U.ops);
    await ops.getByTestId("section-toggle").click();
    await expect(ops).toHaveAttribute("data-collapsed", "true");
    await expect(subRows(ops, N.billing)).toHaveCount(1);
    await expect(subRows(ops, N.billing).first()).toContainText(T.invoices);
    // Engineering: the Web pill, 3 of the portal's sessions then "+N more"; Design system one quiet line.
    const eng = sectionOf(list, U.eng);
    await expect(eng.getByTestId(`project-row-${U.portal}`).getByTestId("project-pill")).toHaveText(N.web);
    await expect(subRows(eng, N.portal)).toHaveCount(3);
    await expect(eng.getByTestId("project-more")).toHaveText(/^\+\d+ more$/);
    await expect(eng.getByRole("list", { name: `Active sessions in ${N.design}` })).toHaveCount(0);
    // Personal: his own repository and its session.
    const personal = list.getByTestId("personal-section");
    await expect(subRows(personal, `leo-scratch-${tag}`).filter({ hasText: T.scratch })).toHaveCount(1);
    // Settled: collapsed by default, no count, no rows.
    const settled = list.getByTestId("settled-group");
    await expect(settled.getByTestId("settled-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(settled.getByTestId("section-count")).toHaveCount(0);
    await expect(settled.getByTestId("session-row")).toHaveCount(0);
    // The search field and the header "+" are 44 px on a phone (R9).
    if (mobile) {
      for (const target of [page.getByTestId("session-search"), page.getByTestId("sidebar-new-session")]) {
        const box = await target.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(43.5);
      }
      expect(await page.getByTestId("session-search").evaluate((el) => getComputedStyle(el).fontSize)).toBe(
        "16px",
      );
    }
    await checkSidebar(page);
    // From the search field down: the field, Needs you and as much of the tree as the screen holds.
    await page.getByTestId("session-search").evaluate((el) => el.scrollIntoView({ block: "start" }));
    await captureReview(page, `sidebar-full-${tag}`);

    // Settled opens and pages: 10, then "Show 2 more", then "Show fewer".
    await settled.getByTestId("settled-toggle").click();
    await expect(settled.getByTestId("settled-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(settled.getByTestId("session-row")).toHaveCount(10);
    await expect(settled.getByTestId("settled-more")).toHaveText("Show 2 more");
    await settled.getByTestId("settled-more").click();
    await expect(settled.getByTestId("session-row")).toHaveCount(12);
    await expect(settled.getByTestId("settled-more")).toHaveText("Show fewer");
    await expect(settled.getByTestId("settled-more")).toHaveAttribute("aria-expanded", "true");
    await checkSidebar(page);
  } finally {
    await context.close();
  }
});

test("search: grouped results, a managed project muted, Show all, nothing found; never a hidden project's name", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const mobile = info.project.name === "mobile";
  {
    const { context, page } = await open(browser, ADMIN, info.project.name);
    try {
      await page.goto("/work-zone");
      const list = await openSidebar(page, mobile);
      const search = list.getByTestId("session-search");
      await search.fill(`Ledger`);
      const results = list.getByTestId("sidebar-search-results");
      await expect(results).toBeVisible();
      // The tree is replaced; header, search field and foot stay.
      await expect(list.getByTestId("sidebar-section")).toHaveCount(0);
      await expect(list.getByTestId("settled-group")).toHaveCount(0);
      await expect(list.getByTestId("sidebar-projects")).toBeVisible();
      const projects = results.getByTestId("search-group-projects");
      await expect(projects.getByRole("heading", { level: 3 })).toHaveText("Projects");
      // His own project plain, the one he only manages muted, no "+" on either.
      await expect(projects.getByTestId(`project-row-${U.reports}`)).toBeVisible({ timeout: 30_000 });
      await expect(projects.getByTestId(`project-row-${U.lab}`)).toHaveClass(/text-muted-foreground/);
      await expect(projects.getByTestId(`project-row-${U.reports}`)).not.toHaveClass(/text-muted-foreground/);
      await expect(results.getByTestId("project-new-session")).toHaveCount(0);
      const sessions = results.getByTestId("search-group-sessions");
      await expect(sessions.getByTestId("session-row").filter({ hasText: T.ledger })).toHaveCount(1);
      const repos = results.getByTestId("search-group-repos");
      await expect(repos.getByTestId(`repo-row-${ledgerRepo.projectId}`)).toContainText(`ledger-${tag}`);
      await expect(results.getByTestId("repo-new-session")).toHaveCount(0);
      await expect(results.getByRole("status")).toHaveText(/^\d+ results?$/);
      await checkSidebar(page);
      await captureReview(page, `sidebar-search-${tag}`);

      // A capped group: 10 sessions, then "Show all 12".
      await search.fill(`Done ${run}`);
      const capped = list.getByTestId("search-group-sessions");
      await expect(capped.getByTestId("session-row")).toHaveCount(10);
      await expect(capped.getByTestId("search-more-sessions")).toHaveText("Show all 12");
      await capped.getByTestId("search-more-sessions").click();
      await expect(capped.getByTestId("session-row")).toHaveCount(12);
      // Nothing found.
      await search.fill("zzqx nothing");
      await expect(list.getByText("Nothing matches “zzqx nothing”.")).toBeVisible();
      await list.getByRole("button", { name: "Clear search" }).click();
      await expect(list.getByTestId("sidebar-search-results")).toHaveCount(0);
    } finally {
      await context.close();
    }
  }

  // Pia: the project she can't open is never found by its name; its session and repository are, by theirs (C-01).
  const { context, page } = await open(browser, PIA, info.project.name);
  try {
    await page.goto("/work-zone");
    const list = await openSidebar(page, mobile);
    const search = list.getByTestId("session-search");
    await expect(list.getByTestId("personal-section")).toBeVisible({ timeout: 30_000 });
    for (const word of VAULT_WORDS) {
      await search.fill(word);
      await expect(list.getByText(`Nothing matches “${word}”.`)).toBeVisible();
      await expect(list.getByTestId("sidebar-search-results").getByRole("link")).toHaveCount(0);
    }
    await search.fill(`pia-linked-${tag}`);
    const results = list.getByTestId("sidebar-search-results");
    await expect(results.getByTestId(`repo-row-${piaLinked.projectId}`)).toHaveAttribute(
      "title",
      "Linked to a project you can't open",
    );
    await expect(results.getByTestId("session-row").filter({ hasText: T.onDevice })).toHaveCount(1);
    const seen = await page.evaluate(() => document.documentElement.outerHTML);
    for (const word of VAULT_WORDS) expect(seen).not.toMatch(new RegExp(word, "i"));
  } finally {
    await context.close();
  }
});

test("a failing sessions request keeps the project rows, with Couldn't load sessions. and Try again", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const mobile = info.project.name === "mobile";
  const { context, page } = await open(browser, LEO, info.project.name);
  const isSessions = (url: URL) => url.pathname === "/api/v1/work-sessions";
  try {
    await page.route(isSessions, (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "internal", message: "Internal error" } }),
      }),
    );
    await page.goto("/work-zone");
    const list = await openSidebar(page, mobile);
    const error = list.getByTestId("sessions-error");
    await expect(error).toContainText("Couldn't load sessions.", { timeout: 60_000 });
    await expect(error.getByTestId("sessions-retry")).toHaveText("Try again");
    const eng = sectionOf(list, U.eng);
    await expect(eng.getByTestId(`project-row-${U.portal}`)).toBeVisible();
    await expect(eng.getByTestId("project-live-count")).toHaveCount(0);
    await expect(list.getByTestId("session-row")).toHaveCount(0);
    await expect(list.getByTestId("needs-you")).toHaveCount(0);
    await expect(list.getByText("No sessions yet.")).toHaveCount(0);
    await checkSidebar(page);

    await page.unroute(isSessions);
    await error.getByTestId("sessions-retry").click();
    await expect(list.getByTestId("sessions-error")).toHaveCount(0, { timeout: 30_000 });
    await expect(subRows(eng, N.portal).first()).toBeVisible();
  } finally {
    await context.close();
  }
});

test("keys: arrows through the sidebar and the results, toggles, Escape, focus kept when a row leaves", async ({
  browser,
}, info) => {
  test.skip(info.project.name === "mobile", "keyboard navigation is a desktop check");
  test.setTimeout(180_000);
  const { context, page } = await open(browser, LEO, info.project.name);
  try {
    await page.goto("/work-zone");
    const list = await openSidebar(page, false);
    const search = list.getByTestId("session-search");
    await expect(list.getByTestId("needs-you-row")).toHaveCount(2, { timeout: 30_000 });

    // ArrowDown from the search field enters the results; Escape clears the query and keeps focus in the field.
    await search.click();
    await page.keyboard.type("Customer portal");
    await expect(list.getByTestId("sidebar-search-results")).toBeVisible();
    await page.keyboard.press("ArrowDown");
    expect((await focused(page)).testId).toBe(`project-row-${U.portal}`);
    await search.focus();
    await page.keyboard.press("Escape");
    await expect(search).toHaveValue("");
    await expect(search).toBeFocused();
    await expect(list.getByTestId("needs-you")).toBeVisible();

    // Without a query: the first row is Needs you's toggle, then its rows, then the next section's toggle.
    await page.keyboard.press("ArrowDown");
    expect((await focused(page)).id).toBe("wz-section-needs");
    await page.keyboard.press("ArrowDown");
    expect(await focused(page)).toMatchObject({ testId: "needs-you-row", inNeeds: true });
    expect((await focused(page)).text).toContain(T.invoices);
    await page.keyboard.press("ArrowDown");
    expect((await focused(page)).text).toContain(T.approval);
    await page.keyboard.press("ArrowDown");
    expect((await focused(page)).id).toBe(`wz-section-${U.eng}`);
    // ←/→ on a section toggle collapse and expand it.
    const engToggle = sectionOf(list, U.eng).getByTestId("section-toggle");
    await page.keyboard.press("ArrowLeft");
    await expect(engToggle).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("ArrowRight");
    await expect(engToggle).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("ArrowDown");
    expect((await focused(page)).testId).toBe(`project-row-${U.portal}`);
    // Home and End; ArrowUp from the first row returns to the search field.
    await page.keyboard.press("End");
    expect((await focused(page)).text.trim()).toBe("Devices");
    await page.keyboard.press("ArrowUp");
    expect((await focused(page)).testId).toBe("sidebar-projects");
    await page.keyboard.press("Home");
    expect((await focused(page)).id).toBe("wz-section-needs");
    await page.keyboard.press("ArrowUp");
    await expect(search).toBeFocused();

    // Focus survives a live update: the focused approval row leaves when the approval is decided elsewhere, and
    // focus moves to the next row of Needs you, never to the top.
    await needsRow(list, T.invoices).focus();
    expect((await focused(page)).text).toContain(T.invoices);
    await approve(leo, S.invoices);
    await expect
      .poll(
        async () => {
          const f = await focused(page);
          return f.inNeeds && f.testId === "needs-you-row" && f.text.includes(T.approval);
        },
        { timeout: 30_000, message: "focus moves to the next row of Needs you" },
      )
      .toBe(true);

    // 07.10-07 (LO-03): once focus has left the sidebar, a row leaving never pulls it back. Focus rests on the turn's
    // row, then leaves it for the page (as a click on the main pane does); a new turn takes the row away.
    await needsRow(list, T.approval).focus();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const onBody = () => page.evaluate(() => document.activeElement === document.body);
    expect(await onBody()).toBe(true);
    await post(leo, `/api/v1/work-sessions/${S.approval}/prompts`, { body: "One more pass" });
    await expect(needsRow(list, T.approval)).toHaveCount(0, { timeout: 30_000 });
    await page.waitForTimeout(300);
    expect(await onBody(), "focus stays where the person left it").toBe(true);
  } finally {
    await context.close();
  }
});
