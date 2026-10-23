import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  type Request,
  test,
} from "@playwright/test";
import { contrastOf, expectNoSeriousA11y } from "../support/a11y";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs } from "../support/actors";
import {
  captureReview,
  expectNoSidewaysScroll,
  expectTouchTargets,
  unnamedControls,
} from "../support/layout";
import { finishedBodies } from "../support/responses";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import {
  createTeamProject,
  linkRepo,
  removeTeamProject,
  setAudience,
  shareDevice,
  type TeamProject,
} from "../support/work-zone-projects";
import { ADMIN, shot } from "./env";

/**
 * Who can see a Work Zone session, from its header (Phase 07.9-10, UI-SPEC Surface 1, D-04, D-07, D-11, D-12, R7), on
 * the real stack with a real fake-runtime device:
 * - the tracer: the owner narrows a session to Only me from the chip; a second person loses it live with the
 *   visibility words and its row leaves their list; Undo gives it back in one request;
 * - the whole panel: the team and people pickers (inactive entries), See all, read-only, a personal project, the
 *   device owner's line, a creator who left the project, the keyboard rule, the bottom sheet;
 * - layout and accessibility at 1440 and 390 in both themes, with the review screenshots this plan owns.
 * The API decides everything; the web only shows its answers.
 */

test.describe.configure({ mode: "serial" });

const LEO: Actor = { name: "Leo Park", email: "leo@ocw.test", password: "leo-e2e-password-123" };
const PIA: Actor = { name: "Pia Gómez", email: "pia@ocw.test", password: "pia-e2e-password-123" };

const ADMIN_FIRST = ADMIN.name.split(" ")[0] ?? ADMIN.name;

/** One run's people, places and leftovers; `cleanup` undoes them in reverse. */
class Fixture {
  readonly api: APIRequestContext;
  readonly sessions: string[] = [];
  readonly projects: TeamProject[] = [];
  readonly units: string[] = [];
  readonly devices: FakeDeviceHandle[] = [];
  readonly contexts: BrowserContext[] = [];

  constructor(api: APIRequestContext) {
    this.api = api;
  }

  async post<T>(path: string, data: unknown, as: APIRequestContext = this.api): Promise<T> {
    const r = await as.post(path, { data });
    expect(r.ok(), `${path}: ${await r.text()}`).toBe(true);
    return (await r.json()) as T;
  }

  async del(path: string): Promise<void> {
    const r = await this.api.delete(path);
    expect(r.ok(), `DELETE ${path}: ${await r.text()}`).toBe(true);
  }

  async unit(kind: "department" | "team", name: string, parentId: string | null): Promise<string> {
    const u = await this.post<{ id: string }>("/api/v1/units", { kind, name, parentId });
    this.units.push(u.id);
    return u.id;
  }

  async device(name: string, projectName: string): Promise<FakeDeviceHandle> {
    const d = await startFakeDevice(this.api, { name, projectName });
    this.devices.push(d);
    return d;
  }

  async session(projectId: string, title: string, as: APIRequestContext = this.api): Promise<string> {
    const s = await this.post<{ id: string }>(
      "/api/v1/work-sessions",
      { projectId, runtime: "claude-code", permissionMode: "plan", title },
      as,
    );
    this.sessions.push(s.id);
    return s.id;
  }

  async cleanup(): Promise<void> {
    for (const c of this.contexts) await c.close().catch(() => undefined);
    for (const id of this.sessions) {
      await this.api.post(`/api/v1/work-sessions/${id}/archive`, { data: {} }).catch(() => undefined);
    }
    for (const p of this.projects) await removeTeamProject(this.api, p).catch(() => undefined);
    for (const id of [...this.units].reverse())
      await this.api.delete(`/api/v1/units/${id}`).catch(() => undefined);
    for (const d of this.devices) await d.stop().catch(() => undefined);
    await this.api.dispose();
  }
}

const isVisibilityPut = (sessionId: string) => (r: Request) =>
  r.method() === "PUT" && r.url().includes(`/api/v1/work-sessions/${sessionId}/visibility`);

/** Counts the visibility PUTs the page sends for `sessionId` from now on. */
function countPuts(page: Page, sessionId: string): () => number {
  let n = 0;
  page.on("request", (r) => {
    if (isVisibilityPut(sessionId)(r)) n += 1;
  });
  return () => n;
}

const chip = (page: Page) => page.getByTestId("session-header").getByTestId("visibility-chip");
const panel = (page: Page) => page.getByTestId("visibility-panel");

/** Opens the chip's popover (≥ 640) or sheet (< 640) and waits for the API's answer. */
async function openPanel(page: Page): Promise<Locator> {
  await chip(page).click();
  const p = panel(page);
  await expect(p).toBeVisible();
  await expect(p).not.toHaveAttribute("data-loading", "true");
  return p;
}

async function closePanel(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
}

/** The session rows of the signed-in person's sidebar (opened from the menu on a phone). */
async function sidebarRow(page: Page, mobile: boolean, title: string): Promise<Locator> {
  if (mobile) {
    const list = page.getByTestId("session-list");
    if (!(await list.isVisible())) await page.getByTestId("mobile-nav-trigger").click();
  }
  return page
    .getByTestId("session-list")
    .getByTestId("session-row")
    .filter({ has: page.getByTestId("row-title").getByText(title, { exact: true }) });
}

async function closeMobileNav(page: Page, mobile: boolean): Promise<void> {
  if (!mobile) return;
  if (await page.getByTestId("session-list").isVisible()) {
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("session-list")).toBeHidden();
  }
}

/**
 * The chip's hit area below 768 is 44 × 44 through its `::before` extension (UI-SPEC §1.1): a point 5 px outside its
 * box on every side still lands on it.
 */
async function expectChipHitArea(page: Page): Promise<void> {
  const missed = await chip(page).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const points: Array<[string, number, number]> = [
      ["left", r.left - 5, r.top + r.height / 2],
      ["right", r.right + 5, r.top + r.height / 2],
      ["top", r.left + r.width / 2, r.top - 5],
      ["bottom", r.left + r.width / 2, r.bottom + 5],
    ];
    return points.flatMap(([side, x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return hit === el || el.contains(hit) ? [] : [`${side}: ${hit?.outerHTML.slice(0, 80) ?? "nothing"}`];
    });
  });
  expect(missed, "the chip's touch target reaches 44 px on every side").toEqual([]);
}

/** No focus ring left over from a keyboard close in a review screenshot. */
async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** axe on `selector` in light and dark (serious and critical fail). */
async function axeBothThemes(page: Page, selector: string): Promise<void> {
  await expectNoSeriousA11y(page, selector);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectNoSeriousA11y(page, selector);
  await page.emulateMedia({ colorScheme: "light" });
}

/** A screenshot that must keep the toast in view (captureReview waits toasts out). */
async function captureWithToast(page: Page, name: string): Promise<void> {
  if (!process.env.OCW_E2E_SCREENSHOT_DIR) return;
  await page.emulateMedia({ colorScheme: "light" });
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

test("narrow from the header: Only me takes the session from Leo live, Undo gives it back", async ({
  browser,
}, info) => {
  test.setTimeout(300_000);
  const mobile = info.project.name === "mobile";
  const tag = mobile ? "390" : "1440";
  const run = `${tag}-${Date.now().toString(36)}`;
  const f = new Fixture(await apiAs(ADMIN));
  try {
    const leoId = await ensureMember(f.api, LEO, "developer");
    const project = await createTeamProject(f.api, { name: `Portal ${run}`, members: [{ userId: leoId }] });
    f.projects.push(project);
    const device = await f.device(`E2E Vis ${run}`, `vis-web-${tag}`);
    await linkRepo(f.api, project.unitId, device.projectId);
    const title = `Fix the login redirect ${run}`;
    const sessionId = await f.session(device.projectId, title);

    const ana = await openAs(browser, ADMIN, info.project.name);
    const leo = await openAs(browser, LEO, info.project.name);
    f.contexts.push(ana.context, leo.context);
    await leo.page.goto(`${BASE_URL}/work-zone/${sessionId}`);
    await expect(leo.page.getByTestId("session-title")).toHaveText(title);
    await expect(await sidebarRow(leo.page, mobile, title)).toHaveCount(1);
    await closeMobileNav(leo.page, mobile);

    await ana.page.goto(`${BASE_URL}/work-zone/${sessionId}`);
    await expect(ana.page.getByTestId("session-title")).toHaveText(title);
    // The chip reads the session's own summary: Project, the default (icon only below 640).
    await expect(chip(ana.page)).toHaveAttribute("data-kind", "project");
    await expect(chip(ana.page).getByTestId("visibility-chip-label")).toHaveText("Project");
    await expect(chip(ana.page)).toHaveAccessibleName(
      `Visible to Everyone in Portal ${run}. Change who can see this session`,
    );
    // The project segment of the breadcrumb opens the team project.
    await expect(ana.page.getByTestId("session-project-link")).toHaveAttribute(
      "href",
      `/work-zone/projects/${project.unitId}`,
    );
    if (mobile) {
      const label = chip(ana.page).getByTestId("visibility-chip-label");
      expect(await label.evaluate((el) => getComputedStyle(el).position)).toBe("absolute"); // sr-only
      await expectChipHitArea(ana.page);
    }
    await captureReview(ana.page, `session-chip-default-${tag}`);

    const p = await openPanel(ana.page);
    await expect(p).toHaveAttribute("data-editable", "true");
    await expect(ana.page.getByTestId("who-can-see")).toHaveAttribute("data-count", "2");
    await expect(ana.page.getByTestId("who-can-see")).toContainText("2 people can see this");
    await expect(ana.page.getByTestId("who-can-see-always")).toHaveText("Admins can always see it.");
    if (mobile) {
      await expect(ana.page.getByTestId("visibility-sheet")).toBeVisible();
      await axeBothThemes(ana.page, '[data-testid="visibility-sheet"]');
      await expectTouchTargets(ana.page, '[data-testid="visibility-sheet"]');
      for (const kind of ["owner", "project", "teams", "people"]) {
        const box = await ana.page.getByTestId(`visibility-option-${kind}`).boundingBox();
        expect(box?.height ?? 0, `${kind} row height`).toBeGreaterThanOrEqual(56);
      }
      await expectNoSidewaysScroll(ana.page, "visibility sheet");
      await captureReview(ana.page, "visibility-sheet-390");
    } else {
      await axeBothThemes(ana.page, '[data-testid="visibility-panel"]');
      await captureReview(ana.page, "visibility-panel-1440");
    }
    expect(await unnamedControls(ana.page)).toEqual([]);

    // ---- Only me applies at once; Leo loses the live view within 2 s, with the visibility words
    const put = ana.page.waitForResponse((r) => isVisibilityPut(sessionId)(r.request()));
    await ana.page.getByTestId("visibility-option-owner").click();
    const answered = Date.now();
    expect((await put).status()).toBe(200);
    await expect(leo.page.getByTestId("session-access-lost")).toBeVisible({ timeout: 2_000 });
    expect(Date.now() - answered).toBeLessThan(2_500);
    await expect(leo.page.getByTestId("session-access-lost")).toHaveAttribute("data-cause", "visibility");
    await expect(leo.page.getByText("You can no longer see this session")).toBeVisible();
    await expect(
      leo.page.getByText(`Who can see it changed. Ask ${ADMIN.name} if you need it back.`),
    ).toBeVisible();
    await expect(leo.page.getByRole("link", { name: "Back to Work Zone" })).toBeVisible();

    await expect(chip(ana.page)).toHaveAttribute("data-kind", "owner");
    await expect(chip(ana.page).getByTestId("visibility-chip-label")).toHaveText("Only me");
    await expect(ana.page.getByTestId("who-can-see")).toContainText("Only you can see this");
    const toast = ana.page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "can't see this session anymore." });
    await expect(toast).toContainText(`${LEO.name} can't see this session anymore.`);
    await expect(toast.getByRole("button", { name: "Undo" })).toBeVisible();
    if (!mobile) await captureWithToast(ana.page, "visibility-undo-toast-1440");

    // Nothing about the session reaches Leo any more: his list drops it, and a reload brings no trace of it.
    await expect(await sidebarRow(leo.page, mobile, title)).toHaveCount(0);
    await closeMobileNav(leo.page, mobile);
    if (mobile) {
      await expectNoSidewaysScroll(leo.page, "access lost");
      await blur(leo.page);
      await captureReview(leo.page, "session-access-lost-390");
    }

    // ---- Undo re-widens in one request; Leo's list has it again and his lost view offers to open it
    const undo = ana.page.waitForResponse((r) => isVisibilityPut(sessionId)(r.request()));
    await toast.getByRole("button", { name: "Undo" }).click();
    expect((await undo).status()).toBe(200);
    await expect(chip(ana.page)).toHaveAttribute("data-kind", "project");
    await expect(leo.page.getByTestId("session-reopen")).toBeVisible({ timeout: 5_000 });
    await expect(await sidebarRow(leo.page, mobile, title)).toHaveCount(1);
    await closeMobileNav(leo.page, mobile);
    await leo.page.getByTestId("session-reopen").click();
    await expect(leo.page.getByTestId("session-title")).toHaveText(title);

    // Only me again, then Leo reloads: no response the page reads carries the session's title.
    await setAudience(f.api, sessionId, { kind: "owner" });
    const bodies = finishedBodies(leo.page, (r) => r.url().includes("/api/v1/"));
    await leo.page.goto(`${BASE_URL}/work-zone`);
    await leo.page.waitForLoadState("networkidle");
    for (const body of await bodies()) expect(body).not.toContain(title);

    if ((await panel(ana.page).count()) > 0) await closePanel(ana.page);
    await expect(chip(ana.page)).toHaveAttribute("data-kind", "owner");
    await blur(ana.page);
    await captureReview(ana.page, `session-chip-${tag}`);
    if (mobile) await expectChipHitArea(ana.page);
  } finally {
    await f.cleanup();
  }
});

test("the whole panel: teams, people, inactive entries, See all, read-only, personal, device owner, creator who left", async ({
  browser,
}, info) => {
  test.setTimeout(420_000);
  const mobile = info.project.name === "mobile";
  const tag = mobile ? "390" : "1440";
  const run = `${tag}-${Date.now().toString(36)}`;
  const f = new Fixture(await apiAs(ADMIN));
  try {
    const leoId = await ensureMember(f.api, LEO, "developer");
    const piaId = await ensureMember(f.api, PIA, "developer");
    // ---- Eng › {Web (Pia), Ops, Legacy} and the team project Portal (Leo) with the three teams assigned
    const eng = await f.unit("department", `Eng ${run}`, null);
    const web = await f.unit("team", `Web ${run}`, eng);
    const ops = await f.unit("team", `Ops ${run}`, eng);
    const legacy = await f.unit("team", `Legacy ${run}`, eng);
    await f.post(`/api/v1/units/${web}/members`, { userId: piaId, role: "member" });
    const portalName = `Portal ${run}`;
    const project = await createTeamProject(f.api, {
      name: portalName,
      parentName: `Eng ${run}`,
      // Pia reaches the project only through Web, so "Through Web" is why she sees a session shared with Web.
      members: [{ userId: leoId }],
    });
    f.projects.push(project);
    for (const t of [web, ops, legacy])
      await f.post(`/api/v1/work-projects/${project.unitId}/teams`, { unitId: t });
    const device = await f.device(`E2E Panel ${run}`, `panel-web-${tag}`);
    await linkRepo(f.api, project.unitId, device.projectId);
    const scratch = await f.device(`E2E Scratch ${run}`, `scratch-${tag}`);

    const T = {
      teams: `Shared with two teams ${run}`,
      plain: `Default session ${run}`,
      mine: `Only mine ${run}`,
      personal: `Personal scratch ${run}`,
    };
    const teamsId = await f.session(device.projectId, T.teams);
    const plainId = await f.session(device.projectId, T.plain);
    const mineId = await f.session(device.projectId, T.mine);
    const personalId = await f.session(scratch.projectId, T.personal);
    await setAudience(f.api, teamsId, { kind: "teams", teamIds: [web, legacy] });
    await setAudience(f.api, mineId, { kind: "owner" });
    // Legacy leaves the project: it stays stored on the session but grants nothing (§1.5).
    await f.del(`/api/v1/work-projects/${project.unitId}/teams/${legacy}`);

    const ana = await openAs(browser, ADMIN, info.project.name);
    f.contexts.push(ana.context);
    const page = ana.page;

    // ---- sidebar markers: none on the default, a lock on Only me, people on the teams session (Surface 2)
    await page.goto(`${BASE_URL}/work-zone/${plainId}`);
    await expect(page.getByTestId("session-title")).toHaveText(T.plain);
    const rowOf = async (title: string) => sidebarRow(page, mobile, title);
    await expect((await rowOf(T.plain)).getByTestId("visibility-marker")).toHaveCount(0);
    await expect((await rowOf(T.mine)).getByTestId("visibility-marker")).toHaveAttribute("data-kind", "lock");
    await expect((await rowOf(T.teams)).getByTestId("visibility-marker")).toHaveAttribute(
      "data-kind",
      "users",
    );
    await captureReview(page, `sidebar-markers-${tag}`);
    await closeMobileNav(page, mobile);

    // ---- keyboard (desktop): arrowing across choices saves only where focus rests 400 ms; Escape back to the chip
    if (!mobile) {
      const puts = countPuts(page, plainId);
      await chip(page).focus();
      await page.keyboard.press("Enter");
      await expect(panel(page)).toBeVisible();
      const projectRadio = page.getByTestId("visibility-option-project").locator('input[type="radio"]');
      await expect(projectRadio).toBeFocused();
      await page.keyboard.press("ArrowUp"); // Only me, passed over
      await page.waitForTimeout(150);
      await page.keyboard.press("ArrowDown"); // Project
      await page.waitForTimeout(150);
      await page.keyboard.press("ArrowDown"); // Teams: opens its picker, saves nothing
      await expect(page.getByTestId("team-picker")).toBeVisible();
      await page.waitForTimeout(900);
      expect(puts(), "no save while arrowing").toBe(0);
      await page.keyboard.press("Escape");
      await expect(panel(page)).toHaveCount(0);
      await expect(chip(page)).toBeFocused();
      await expect(chip(page)).toHaveAttribute("data-kind", "project");
      expect(puts()).toBe(0);
    }

    // ---- the teams session: Web checked, Ops not, Legacy inactive; checking Ops applies at once and drops Legacy
    await page.goto(`${BASE_URL}/work-zone/${teamsId}`);
    await expect(page.getByTestId("session-title")).toHaveText(T.teams);
    await expect(chip(page).getByTestId("visibility-chip-label")).toHaveText(`Web ${run}`);
    await openPanel(page);
    const picker = page.getByTestId("team-picker");
    await expect(picker).toBeVisible();
    await expect(page.getByTestId(`team-option-${web}`).locator("input")).toBeChecked();
    await expect(page.getByTestId(`team-option-${web}`)).toContainText("1 person");
    await expect(page.getByTestId(`team-option-${ops}`).locator("input")).not.toBeChecked();
    const inactive = picker.getByTestId("visibility-inactive");
    await expect(inactive).toContainText(`Legacy ${run}`);
    await expect(inactive).toContainText(`No longer assigned to ${portalName}`);
    await expect(page.getByTestId("who-can-see")).toContainText("2 people can see this");
    if (!mobile) await captureReview(page, "visibility-teams-1440");
    const checkOps = page.waitForResponse((r) => isVisibilityPut(teamsId)(r.request()));
    await page.getByTestId(`team-option-${ops}`).click();
    expect((await checkOps).status()).toBe(200);
    await expect(picker.getByTestId("visibility-inactive")).toHaveCount(0);
    await expect(chip(page).getByTestId("visibility-chip-label")).toHaveText("2 teams");

    // See all lists everyone with the reason they can see it.
    await page.getByTestId("who-can-see-toggle").click();
    const all = page.getByTestId("who-can-see-all");
    await expect(all).toBeVisible();
    await expect(all.locator(`[data-reason="owner"]`)).toContainText("(you)");
    await expect(all.locator(`[data-user-id="${piaId}"]`)).toContainText(`Through Web ${run}`);
    await expect(all.locator(`[data-user-id="${leoId}"]`)).toHaveCount(0);
    if (!mobile) {
      await axeBothThemes(page, '[data-testid="visibility-panel"]');
      await captureReview(page, "visibility-see-all-1440");
    }

    // ---- People: choosing it saves nothing until the first person is picked
    const puts = countPuts(page, teamsId);
    await page.getByTestId("visibility-option-people").click();
    const people = page.getByTestId("people-picker");
    await expect(people).toBeVisible();
    await expect(people).toContainText("Pick at least one person.");
    await expect(people).toContainText(`${ADMIN.name} (you)`);
    expect(puts()).toBe(0);
    const input = page.getByTestId("people-input");
    await input.fill("zzz");
    await expect(people).toContainText(`No one in ${portalName} matches “zzz”.`);
    await input.fill("Pi");
    await expect(page.getByTestId(`people-option-${piaId}`)).toBeVisible();
    const pickPia = page.waitForResponse((r) => isVisibilityPut(teamsId)(r.request()));
    await page.getByTestId(`people-option-${piaId}`).click();
    expect((await pickPia).status()).toBe(200);
    await expect(chip(page).getByTestId("visibility-chip-label")).toHaveText("2 people");
    await expect(page.getByTestId(`people-remove-${piaId}`)).toBeVisible();
    await input.fill("Le");
    await expect(page.getByTestId(`people-option-${leoId}`)).toBeVisible();
    if (mobile) {
      await expectTouchTargets(page, '[data-testid="visibility-sheet"]');
      await axeBothThemes(page, '[data-testid="visibility-sheet"]');
      await captureReview(page, "visibility-sheet-people-390");
    } else {
      await captureReview(page, "visibility-people-1440");
    }
    const pickLeo = page.waitForResponse((r) => isVisibilityPut(teamsId)(r.request()));
    await page.getByTestId(`people-option-${leoId}`).click();
    expect((await pickLeo).status()).toBe(200);
    await expect(chip(page).getByTestId("visibility-chip-label")).toHaveText("3 people");
    expect(await unnamedControls(page)).toEqual([]);
    await expectNoSidewaysScroll(page, "people picker");
    await closePanel(page);

    // A person who leaves the project stays listed, greyed, and stops counting (§1.5).
    await f.del(`/api/v1/units/${project.unitId}/members/${leoId}`);
    await page.reload();
    await openPanel(page);
    const left = page.getByTestId("people-picker").getByTestId("visibility-inactive");
    await expect(left).toContainText(LEO.name);
    await expect(left).toContainText(`Left ${portalName}`);
    await expect(chip(page).getByTestId("visibility-chip-label")).toHaveText("2 people");
    await closePanel(page);
    await f.post(`/api/v1/units/${project.unitId}/members`, { userId: leoId, role: "member" });

    // ---- a personal project: Teams disabled, the device's words
    await page.goto(`${BASE_URL}/work-zone/${personalId}`);
    await expect(page.getByTestId("session-title")).toHaveText(T.personal);
    await expect(page.getByTestId("session-project-link")).toHaveCount(0);
    await openPanel(page);
    const teamsRow = page.getByTestId("visibility-option-teams");
    await expect(teamsRow.locator("input")).toBeDisabled();
    await expect(teamsRow).toContainText("Personal projects have no teams");
    await expect(page.getByTestId("visibility-option-project")).toContainText(
      `Everyone who can use E2E Scratch ${run}`,
    );
    if (!mobile) {
      await axeBothThemes(page, '[data-testid="visibility-panel"]');
      await captureReview(page, "visibility-personal-1440");
    }
    await closePanel(page);

    // ---- read-only for Leo (a member, not an editor): the current choice and who may change it, no radios
    const leo = await openAs(browser, LEO, info.project.name);
    f.contexts.push(leo.context);
    await leo.page.goto(`${BASE_URL}/work-zone/${plainId}`);
    await expect(leo.page.getByTestId("session-title")).toHaveText(T.plain);
    await expect(chip(leo.page)).toHaveAccessibleName(
      `Visible to Everyone in ${portalName}. See who can see this session`,
    );
    await openPanel(leo.page);
    await expect(panel(leo.page)).toHaveAttribute("data-editable", "false");
    await expect(panel(leo.page).locator('input[type="radio"]')).toHaveCount(0);
    await expect(leo.page.getByTestId("visibility-readonly-note")).toHaveText(
      `Only ${ADMIN.name}, project leads and admins can change this.`,
    );
    if (!mobile) {
      await axeBothThemes(leo.page, '[data-testid="visibility-panel"]');
      await captureReview(leo.page, "visibility-readonly-1440");
    }
    await closePanel(leo.page);

    // ---- the device owner always sees (D-11): Pia's session on the admin's device names him in the footer
    await shareDevice(f.api, device.deviceId, piaId);
    const piaApi = await apiAs(PIA);
    const piaTitle = `Pia's session ${run}`;
    const piaSession = await f.session(device.projectId, piaTitle, piaApi);
    await piaApi.dispose();
    const pia = await openAs(browser, PIA, info.project.name);
    f.contexts.push(pia.context);
    await pia.page.goto(`${BASE_URL}/work-zone/${piaSession}`);
    await expect(pia.page.getByTestId("session-title")).toHaveText(piaTitle);
    await openPanel(pia.page);
    await expect(pia.page.getByTestId("who-can-see-always")).toHaveText(
      `Admins and ${ADMIN_FIRST} can always see it: it runs on E2E Panel ${run}.`,
    );
    await closePanel(pia.page);

    // ---- the creator who left (D-12): reads, archives, can't prompt or change who sees it
    await f.del(`/api/v1/units/${web}/members/${piaId}`);
    await pia.page.reload();
    await expect(pia.page.getByTestId("session-title")).toHaveText(piaTitle);
    await expect(pia.page.getByTestId("composer-left-project")).toHaveText(
      `You left ${portalName}. You can still read and archive this session.`,
    );
    await expect(pia.page.getByTestId("composer")).toHaveCount(0);
    await openPanel(pia.page);
    await expect(panel(pia.page)).toHaveAttribute("data-editable", "false");
    await expect(pia.page.getByTestId("visibility-readonly-note")).toHaveText(
      `You left ${portalName}, so you can't change this.`,
    );
    await closePanel(pia.page);
    await pia.page.getByRole("button", { name: "Session actions" }).click();
    await pia.page.getByRole("menuitem", { name: "Archive session" }).click();
    await expect(pia.page).toHaveURL(/\/work-zone$/);
  } finally {
    await f.cleanup();
  }
});

test("the chip and its sheet keep the header calm at 390 and the icon readable in both themes", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "mobile", "phone-only checks");
  test.setTimeout(240_000);
  const run = `390c-${Date.now().toString(36)}`;
  const f = new Fixture(await apiAs(ADMIN));
  try {
    const device = await f.device(`E2E Calm ${run}`, `calm-${run}`);
    const id = await f.session(device.projectId, `Calm header ${run}`);
    await page.goto("/login");
    await page.getByLabel("Email").fill(ADMIN.email);
    await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
    await page
      .getByTestId("login-form")
      .getByRole("button", { name: /sign in|log in/i })
      .click();
    await expect(page).toHaveURL(/\/chat/);
    await page.goto(`/work-zone/${id}`);
    await expect(page.getByTestId("session-title")).toHaveText(`Calm header ${run}`);
    const box = await chip(page).boundingBox();
    expect(box?.width).toBe(32);
    expect(box?.height).toBe(32);
    const icon = chip(page).locator("svg");
    expect(await contrastOf(icon)).toBeGreaterThanOrEqual(3);
    await page.emulateMedia({ colorScheme: "dark" });
    expect(await contrastOf(icon)).toBeGreaterThanOrEqual(3);
    await page.emulateMedia({ colorScheme: "light" });
    await expectChipHitArea(page);
    await expectNoSidewaysScroll(page, "session header");
  } finally {
    await f.cleanup();
  }
});
