import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  type Response,
  test,
} from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs } from "../support/actors";
import {
  captureReview,
  expectNoSidewaysScroll,
  expectTouchTargets,
  unnamedControls,
} from "../support/layout";
import {
  type OwnerDevices,
  sessionAs,
  startOwnerDevices,
  startSessionAs,
  waitIdle,
} from "../support/work-zone-owners";
import {
  createTeamProject,
  linkRepo,
  removeTeamProject,
  type TeamProject,
} from "../support/work-zone-projects";
import { ADMIN } from "./env";

/**
 * Work Zone session owners (Phase 07.13.1.1, D-01 … D-09, WZO-01 … WZO-08) end to end on the real API, web and
 * local-runtime daemon in fake-runtime mode, at 1440 and 390, light and dark:
 * - the tracer: Pia starts a `project` session on a shared server (`OCW_RUNTIME_HOST=service`); Ana takes it over
 *   with Assign to me; the owner moves in both headers live and both timelines carry the take-over line. A second
 *   session of Pia, shared only with Ana, warns that Pia loses access; after the take-over Pia's open page loses it
 *   and her sidebar drops it (D-02, D-03, D-05, D-13, D-15);
 * - a session on a shared desktop device offers no Assign to me, only "Only sessions on a server can be assigned."
 *   (D-04);
 * - Ana renames a session from the header and Pia sees it live; the session's agent renames an untitled session
 *   with the fake runtime's `session rename {…}` line, and is refused on the session a person named (D-06, D-07);
 * - the organization's and the project's naming rules are saved and read back after a reload (D-08);
 * - `/work-zone/people` groups the sessions by owner and filters them by person, project and device (D-01).
 * Every surface passes axe in light and dark, never scrolls sideways and keeps 44 px targets on phones; the review
 * screenshots are `0713111-*` (D-09). Each check reads the second person's page or the API, never only the clicker's
 * (T-07.13.1.1-08-02). Everything the spec makes is removed in `afterAll`, the naming rules included (T-08-03).
 */

test.describe.configure({ mode: "serial" });

const ANA: Actor = { name: "Ana Ferrer", email: "ana-wzo@ocw.test", password: "ana-e2e-password-123" };
const PIA: Actor = { name: "Pia Romero", email: "pia-wzo@ocw.test", password: "pia-e2e-password-123" };

const MANUAL_TITLE = "Login redirect fix";
const AGENT_TITLE = "Fix login redirect";
const RENAME_LINE = `session rename ${JSON.stringify({ title: AGENT_TITLE })}`;
const ORG_RULE = "Start with the area, then the change";
const PROJECT_RULE = "Prefix with the module";

let admin: APIRequestContext;
let ana: APIRequestContext;
let pia: APIRequestContext;
let anaId = "";
let piaId = "";
let tag = "";
let run = "";
let mobile = false;
let devices: OwnerDevices | null = null;
let project: TeamProject | null = null;
let policyTouched = false;
const contexts: BrowserContext[] = [];
const sessionIds: string[] = [];
/** The run's sessions: taken over (project), taken over (people), on the desktop device, renamed by its agent. */
const S = { taken: "", people: "", desktop: "", agent: "" };
const T = { taken: "", people: "", desktop: "" };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function open(browser: Browser, who: Actor): Promise<Page> {
  const { context, page } = await openAs(browser, who, test.info().project.name);
  contexts.push(context);
  return page;
}

/** Opens the session page and waits for its live view. */
async function goSession(page: Page, id: string, title?: string): Promise<void> {
  await page.goto(`${BASE_URL}/work-zone/${id}`);
  await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 30_000 });
  if (title) await expect(page.getByTestId("session-title")).toHaveText(title);
}

async function idle(page: Page): Promise<void> {
  await expect(page.getByTestId("session-view")).toHaveAttribute("data-status", "idle", { timeout: 45_000 });
}

/** The header's owner: the chip's accessible name from 768 px, the "Owner · <name>" line below. */
async function expectOwner(page: Page, name: string, timeout = 10_000): Promise<void> {
  const owner = page.getByTestId("session-header").getByTestId("session-owner");
  if (mobile) await expect(owner).toContainText(`Owner · ${name}`, { timeout });
  else await expect(owner).toHaveAttribute("aria-label", `Owner: ${name}`, { timeout });
}

const actionsButton = (page: Page) =>
  page.getByTestId("session-header").getByRole("button", { name: "Session actions", exact: true });

/** Opens the header's Session actions menu; on a phone every item in it is a 44 px row. */
async function openActions(page: Page): Promise<void> {
  await actionsButton(page).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  if (!mobile) return;
  // The menu opens with a scale transition: measure once it has settled, not mid-animation.
  for (const item of await menu.getByRole("menuitem").all()) {
    await expect
      .poll(async () => (await item.boundingBox())?.height ?? 0, {
        message: `menu item ${await item.textContent()}`,
        timeout: 2_000,
      })
      .toBeGreaterThanOrEqual(43.5);
  }
}

async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
}

/** axe on `selector` in light and dark (serious and critical fail). */
async function axeBothThemes(page: Page, selector: string): Promise<void> {
  await expectNoSeriousA11y(page, selector);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectNoSeriousA11y(page, selector);
  await page.emulateMedia({ colorScheme: "light" });
}

/**
 * The layout rules of one surface: axe light and dark, named controls, no sideways scroll and, unless `touch` is
 * false, 44 px targets below 1024 (`expectTouchTargets` is a no-op from 1024).
 */
async function checkSurface(page: Page, selector: string, label: string, touch = true): Promise<void> {
  await axeBothThemes(page, selector);
  expect(await unnamedControls(page), `${label}: unnamed controls`).toEqual([]);
  await expectNoSidewaysScroll(page, label);
  if (touch) await expectTouchTargets(page, selector);
}

/**
 * The header's Session actions button is the one control this phase added there that a finger must hit: 44 × 44 on
 * phones (the visibility chip reaches 44 px through its own `::before`, checked by work-zone-visibility.spec.ts).
 */
async function expectActionsTarget(page: Page): Promise<void> {
  if (!mobile) return;
  const box = await actionsButton(page).boundingBox();
  expect.soft(box?.width ?? 0, "Session actions width").toBeGreaterThanOrEqual(43.5);
  expect.soft(box?.height ?? 0, "Session actions height").toBeGreaterThanOrEqual(43.5);
}

/** The person's sidebar rows with `title` (opened from the menu on a phone). */
async function sidebarRow(page: Page, title: string): Promise<Locator> {
  if (mobile) {
    const list = page.getByTestId("session-list");
    if (!(await list.isVisible())) await page.getByTestId("mobile-nav-trigger").click();
  }
  return page
    .getByTestId("session-list")
    .getByTestId("session-row")
    .filter({ has: page.getByTestId("row-title").getByText(title, { exact: true }) });
}

async function closeMobileNav(page: Page): Promise<void> {
  if (!mobile) return;
  if (await page.getByTestId("session-list").isVisible()) {
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("session-list")).toBeHidden();
  }
}

const assignPost = (id: string) => (r: Response) =>
  r.request().method() === "POST" && r.url().endsWith(`/api/v1/work-sessions/${id}/assign`);

/** Opens Assign to me from the header and waits for the API's preview (Confirm enabled). */
async function openAssign(page: Page): Promise<Locator> {
  await openActions(page);
  await page.getByTestId("session-assign").click();
  const dialog = page.getByTestId("assign-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("assign-confirm")).toBeEnabled({ timeout: 15_000 });
  return dialog;
}

async function confirmAssign(page: Page, dialog: Locator, id: string): Promise<void> {
  const posted = page.waitForResponse(assignPost(id));
  await dialog.getByTestId("assign-confirm").click();
  expect((await posted).status(), "POST …/assign").toBe(200);
  await expect(dialog).toBeHidden();
}

async function sendPrompt(page: Page, text: string): Promise<void> {
  await page.getByTestId("composer").fill(text);
  await page.getByTestId("send-prompt").click();
}

/** The fake runtime's answer of a turn with session lines (`Session:` then one line per call). */
const sessionAnswer = (page: Page, has: string | RegExp) =>
  page.getByTestId("assistant-message").filter({ hasText: "Session:" }).filter({ hasText: has }).last();

/** Marks the closest `closest` ancestor of the element `testId` with `data-e2e=<mark>` (a CSS hook axe can include). */
async function markAncestor(page: Page, testId: string, closest: string, mark: string): Promise<string> {
  await page
    .getByTestId(testId)
    .evaluate(
      (el, [sel, value]) => el.closest(sel as string)?.setAttribute("data-e2e", value as string),
      [closest, mark],
    );
  const selector = `[data-e2e="${mark}"]`;
  await expect(page.locator(selector)).toHaveCount(1);
  return selector;
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  mobile = test.info().project.name === "mobile";
  tag = mobile ? "390" : "1440";
  run = `${tag}-${Date.now().toString(36)}`;
  admin = await apiAs(ADMIN);
  // Ana leads the team project (only Lead and Admin org roles may lead a unit); Pia is a member.
  anaId = await ensureMember(admin, ANA, "lead");
  piaId = await ensureMember(admin, PIA, "developer");
  ana = await apiAs(ANA);
  pia = await apiAs(PIA);
  devices = await startOwnerDevices(admin, run, { shareWith: [anaId, piaId] });
  project = await createTeamProject(admin, {
    name: `Owners ${run}`,
    members: [
      { userId: anaId, role: "lead" },
      { userId: piaId, role: "member" },
    ],
  });
  await linkRepo(admin, project.unitId, devices.server.projectId);
  await linkRepo(admin, project.unitId, devices.desktop.projectId);
});

test.afterAll(async () => {
  for (const c of contexts) await c.close().catch(() => undefined);
  for (const id of sessionIds) {
    for (const api of [admin, ana, pia]) {
      const res = await api?.post(`/api/v1/work-sessions/${id}/archive`, { data: {} }).catch(() => null);
      if (res?.ok()) break;
    }
  }
  // T-07.13.1.1-08-03: no rule is left for the specs that run after this one.
  if (policyTouched) {
    await admin.put("/api/v1/work-zone-policy", { data: { sessionNamingRule: null } }).catch(() => undefined);
  }
  if (project) {
    await admin
      .patch(`/api/v1/work-projects/${project.unitId}`, { data: { namingRule: null } })
      .catch(() => undefined);
    await removeTeamProject(admin, project).catch(() => undefined);
  }
  await devices?.stop();
  await ana?.dispose();
  await pia?.dispose();
  await admin?.dispose();
});

test("Sessions by person: Ana takes over Pia's session on the shared server", async ({ browser }) => {
  test.setTimeout(240_000);
  const server = devices!.server;
  T.taken = `Fix the login redirect ${run}`;
  S.taken = await startSessionAs(pia, server.projectId, { title: T.taken, visibility: { kind: "project" } });
  sessionIds.push(S.taken);
  await waitIdle(pia, S.taken);

  const piaPage = await open(browser, PIA);
  const anaPage = await open(browser, ANA);
  await goSession(piaPage, S.taken, T.taken);
  await goSession(anaPage, S.taken, T.taken);
  await expectOwner(anaPage, PIA.name);
  await expectOwner(piaPage, PIA.name);

  // ---- the header with someone else's session (D-02): layout, then the review capture
  // The visibility chip's box is under 44 px by design (its `::before` makes the hit area), so the header's targets
  // are checked one by one: the Session actions button here, its menu items by their `max-md:min-h-11` (plan 06).
  await checkSurface(anaPage, '[data-testid="session-header"]', "session header", false);
  await expectActionsTarget(anaPage);
  await captureReview(anaPage, `0713111-header-owner-${tag}`);

  // ---- Assign to me: what changes, no warning (Pia stays in the project's audience)
  const dialog = await openAssign(anaPage);
  await expect(dialog).toContainText(`Take over “${T.taken}”?`);
  await expect(dialog).toContainText(`${PIA.name} stays in its history as the previous owner.`);
  await expect(dialog.getByTestId("assign-warning")).toHaveCount(0);
  await checkSurface(anaPage, '[data-testid="assign-dialog"]', "assign dialog");
  await captureReview(anaPage, `0713111-assign-dialog-${tag}`);
  await confirmAssign(anaPage, dialog, S.taken);

  // The owner moves in both headers (Pia's without a reload) and both timelines carry the take-over line.
  await expectOwner(anaPage, ANA.name);
  await expectOwner(piaPage, ANA.name);
  for (const page of [anaPage, piaPage]) {
    await expect(
      page
        .getByTestId("owner-changed-line")
        .filter({ hasText: `${ANA.name} took over this session from ${PIA.name}` }),
    ).toHaveCount(1, { timeout: 10_000 });
  }
  // The API's own answer to Pia, who still reads the session (D-15: the project audience keeps her).
  expect((await sessionAs(pia, S.taken))?.createdBy).toBe(anaId);
  await captureReview(piaPage, `0713111-owner-changed-${tag}`);

  // ---- a session shared only with Ana: Pia loses it with the take-over
  T.people = `Rotate the API keys ${run}`;
  S.people = await startSessionAs(pia, server.projectId, {
    title: T.people,
    visibility: { kind: "people", userIds: [anaId] },
  });
  sessionIds.push(S.people);
  await waitIdle(pia, S.people);
  await goSession(piaPage, S.people, T.people);
  await expect(await sidebarRow(piaPage, T.people)).toHaveCount(1, { timeout: 15_000 });
  await closeMobileNav(piaPage);

  await goSession(anaPage, S.people, T.people);
  await expectOwner(anaPage, PIA.name);
  const warned = await openAssign(anaPage);
  await expect(warned.getByTestId("assign-warning")).toHaveCount(1);
  await expect(warned.getByTestId("assign-warning")).toHaveText(
    `${PIA.name} will lose access to this session.`,
  );
  await axeBothThemes(anaPage, '[data-testid="assign-dialog"]');
  await captureReview(anaPage, `0713111-assign-warning-${tag}`);
  await confirmAssign(anaPage, warned, S.people);
  await expectOwner(anaPage, ANA.name);

  // Pia's open page leaves the session (the removed-session state), her sidebar drops it, the API says 404.
  await expect(piaPage.getByTestId("session-access-lost")).toBeVisible({ timeout: 10_000 });
  await expect(await sidebarRow(piaPage, T.people)).toHaveCount(0, { timeout: 10_000 });
  await closeMobileNav(piaPage);
  expect(await sessionAs(pia, S.people), "Pia no longer reads the session").toBeNull();
  expect((await sessionAs(ana, S.people))?.createdBy).toBe(anaId);
});

test("a desktop device's session cannot be assigned", async ({ browser }) => {
  test.setTimeout(180_000);
  T.desktop = `Tidy the settings page ${run}`;
  S.desktop = await startSessionAs(pia, devices!.desktop.projectId, {
    title: T.desktop,
    visibility: { kind: "project" },
  });
  sessionIds.push(S.desktop);
  await waitIdle(pia, S.desktop);

  const anaPage = await open(browser, ANA);
  await goSession(anaPage, S.desktop, T.desktop);
  await expectOwner(anaPage, PIA.name);
  await openActions(anaPage);
  await expect(anaPage.getByTestId("session-assign-reason")).toHaveText(
    "Only sessions on a server can be assigned.",
  );
  await expect(anaPage.getByTestId("session-assign")).toHaveCount(0);
  await expect(anaPage.getByRole("menuitem", { name: "Assign to me…" })).toHaveCount(0);
  await captureReview(anaPage, `0713111-assign-reason-${tag}`);
  await closeMenu(anaPage);

  // The API refuses it too, and the owner stays Pia.
  const preview = await ana.get(`/api/v1/work-sessions/${S.desktop}/assign`);
  expect(preview.ok()).toBe(true);
  expect(await preview.json()).toMatchObject({ allowed: false, reason: "not_on_server" });
  const post = await ana.post(`/api/v1/work-sessions/${S.desktop}/assign`);
  expect(post.status(), "POST …/assign on a desktop device").toBe(409);
  expect((await sessionAs(ana, S.desktop))?.createdBy).toBe(piaId);
});

test("people and the agent rename a session", async ({ browser }) => {
  test.setTimeout(300_000);
  const anaPage = await open(browser, ANA);
  const piaPage = await open(browser, PIA);

  // ---- Ana renames her session from the header; Pia's page follows without a reload (D-06)
  await goSession(anaPage, S.taken, T.taken);
  await goSession(piaPage, S.taken, T.taken);
  await openActions(anaPage);
  await anaPage.getByTestId("session-rename").click();
  const rename = anaPage.getByTestId("rename-dialog");
  await expect(rename).toBeVisible();
  await rename.getByTestId("rename-input").fill(MANUAL_TITLE);
  await expect(rename.getByTestId("rename-count")).toHaveText(`${MANUAL_TITLE.length}/200`);
  await expect(rename.getByTestId("rename-save")).toBeEnabled();
  await checkSurface(anaPage, '[data-testid="rename-dialog"]', "rename dialog");
  await captureReview(anaPage, `0713111-rename-dialog-${tag}`);
  await rename.getByTestId("rename-save").click();
  await expect(rename).toBeHidden();
  await expect(anaPage.getByTestId("session-title")).toHaveText(MANUAL_TITLE);
  await expect(piaPage.getByTestId("session-title")).toHaveText(MANUAL_TITLE, { timeout: 10_000 });
  expect((await sessionAs(pia, S.taken))?.title).toBe(MANUAL_TITLE);

  // ---- the agent renames a session nobody titled (D-07): live on both pages, with its tool line
  S.agent = await startSessionAs(pia, devices!.server.projectId, { visibility: { kind: "project" } });
  sessionIds.push(S.agent);
  await waitIdle(pia, S.agent);
  await goSession(piaPage, S.agent);
  await goSession(anaPage, S.agent);
  await sendPrompt(piaPage, RENAME_LINE);
  for (const page of [piaPage, anaPage]) {
    await expect(page.getByTestId("session-title")).toHaveText(AGENT_TITLE, { timeout: 45_000 });
  }
  // The tool card is in the timeline; once the turn ends it folds into "Worked for …", so it is attached, not shown.
  await expect(
    piaPage.getByTestId("tool-card").filter({ hasText: "ocw_session_rename" }).first(),
  ).toBeAttached({ timeout: 45_000 });
  // The quotes may be typographic once rendered as Markdown: any character stands for them.
  await expect(
    sessionAnswer(piaPage, new RegExp(`Renamed the session to .${esc(AGENT_TITLE)}.\\.`)),
  ).toBeVisible({
    timeout: 45_000,
  });
  await idle(piaPage);
  expect((await sessionAs(ana, S.agent))?.title).toBe(AGENT_TITLE);

  // ---- on the session Ana named, the same line is refused and her title stays
  await goSession(piaPage, S.taken, MANUAL_TITLE);
  await idle(piaPage);
  await sendPrompt(piaPage, RENAME_LINE);
  await expect(sessionAnswer(piaPage, "A person named this session, so their title stays.")).toBeVisible({
    timeout: 45_000,
  });
  await expect(
    piaPage.getByTestId("tool-card").filter({ hasText: "ocw_session_rename" }).first(),
  ).toBeAttached();
  await idle(piaPage);
  await expect(piaPage.getByTestId("session-title")).toHaveText(MANUAL_TITLE);
  expect((await sessionAs(ana, S.taken))?.title).toBe(MANUAL_TITLE);
});

test("naming rules are saved", async ({ browser }) => {
  test.setTimeout(180_000);
  const unitId = project!.unitId;

  // ---- the admin's organization rule (Settings › Work Zone policy › Session names)
  const boss = await open(browser, ADMIN);
  await boss.goto(`${BASE_URL}/settings/work-zone-policy`);
  const orgField = boss.getByTestId("policy-naming-rule");
  await expect(orgField).toBeVisible({ timeout: 30_000 });
  policyTouched = true;
  await orgField.fill(ORG_RULE);
  await boss.getByTestId("save-policy").click();
  await expect
    .poll(
      async () =>
        (
          (await (await admin.get("/api/v1/work-zone-policy")).json()) as {
            sessionNamingRule?: string | null;
          }
        ).sessionNamingRule,
      { timeout: 15_000, message: "the policy stores the organization's rule" },
    )
    .toBe(ORG_RULE);
  await boss.reload();
  await expect(boss.getByTestId("policy-naming-rule")).toHaveValue(ORG_RULE, { timeout: 30_000 });
  await boss.getByTestId("policy-naming-rule").scrollIntoViewIfNeeded();
  const section = await markAncestor(boss, "policy-naming-rule", "section", "0713111-policy-naming-rule");
  await checkSurface(boss, section, "policy naming rule");
  await captureReview(boss, `0713111-policy-naming-rule-${tag}`);

  // ---- Ana's project rule, as the project's lead (its Settings tab › Session names)
  const anaPage = await open(browser, ANA);
  await anaPage.goto(`${BASE_URL}/work-zone/projects/${unitId}?tab=settings`);
  const box = anaPage.getByTestId("project-naming-rule");
  await expect(box.getByTestId("naming-rule-input")).toBeVisible({ timeout: 30_000 });
  await box.getByTestId("naming-rule-input").fill(PROJECT_RULE);
  await box.getByTestId("naming-rule-save").click();
  await expect
    .poll(
      async () =>
        ((await (await ana.get(`/api/v1/work-projects/${unitId}`)).json()) as { namingRule?: string | null })
          .namingRule,
      { timeout: 15_000, message: "the project stores its rule" },
    )
    .toBe(PROJECT_RULE);
  await anaPage.reload();
  await expect(anaPage.getByTestId("project-naming-rule").getByTestId("naming-rule-input")).toHaveValue(
    PROJECT_RULE,
    { timeout: 30_000 },
  );
  await anaPage.getByTestId("project-naming-rule").scrollIntoViewIfNeeded();
  await checkSurface(anaPage, '[data-testid="project-naming-rule"]', "project naming rule");
  await captureReview(anaPage, `0713111-project-naming-rule-${tag}`);
});

test("the people view groups and filters, light and dark", async ({ browser }) => {
  test.setTimeout(180_000);
  const d = devices!;
  const anaPage = await open(browser, ANA);
  await anaPage.goto(`${BASE_URL}/work-zone`);
  // On a phone the sidebar lives in the navigation drawer.
  const list = anaPage.getByTestId("session-list");
  await expect(anaPage.getByTestId("mobile-nav-trigger").or(list).first()).toBeVisible({ timeout: 30_000 });
  if (mobile && !(await list.isVisible())) await anaPage.getByTestId("mobile-nav-trigger").click();
  await expect(list).toBeVisible();
  await list.getByTestId("sidebar-people").click();
  await expect(anaPage).toHaveURL(/\/work-zone\/people$/);
  const view = anaPage.getByTestId("people-view");
  await expect(view).toBeVisible();

  const group = (ownerId: string) => view.locator(`[data-testid="people-group"][data-owner="${ownerId}"]`);
  const row = (scope: Locator, id: string) =>
    scope.locator(`[data-testid="people-row"][data-session="${id}"]`);
  const count = view.getByTestId("people-count");

  // ---- grouped by owner: "You" first (the two sessions Ana took over), then Pia's two
  await expect(view.getByTestId("people-group")).toHaveCount(2, { timeout: 15_000 });
  await expect(view.getByTestId("people-group").first()).toHaveAttribute("data-owner", anaId);
  await expect(group(anaId).locator("h2")).toContainText("You");
  await expect(group(anaId).locator("h2")).toContainText("2 sessions");
  await expect(group(piaId).locator("h2")).toContainText(PIA.name);
  await expect(group(piaId).locator("h2")).toContainText("2 sessions");
  for (const id of [S.taken, S.people]) await expect(row(group(anaId), id)).toHaveCount(1);
  for (const id of [S.agent, S.desktop]) await expect(row(group(piaId), id)).toHaveCount(1);
  for (const id of [S.taken, S.people, S.agent]) {
    await expect(row(view, id).getByTestId("server-marker")).toHaveText("Server");
  }
  await expect(row(view, S.desktop).getByTestId("server-marker")).toHaveCount(0);
  await expect(count).toHaveText("4 sessions");
  await checkSurface(anaPage, '[data-testid="people-view"]', "people view");
  await captureReview(anaPage, `0713111-people-${tag}`);

  const pick = async (key: "person" | "project" | "device", label: string) => {
    await view.getByTestId(`people-filter-${key}`).click();
    await anaPage.getByRole("option", { name: label, exact: true }).click();
  };

  // ---- Person: Pia, then Device: the desktop device
  await pick("person", PIA.name);
  await expect(anaPage).toHaveURL(new RegExp(`[?&]person=${esc(piaId)}`));
  await expect(view.getByTestId("people-group")).toHaveCount(1);
  await expect(view.getByTestId("people-group")).toHaveAttribute("data-owner", piaId);
  await expect(count).toHaveText("2 of 4 sessions");
  await pick("device", d.names.desktop);
  await expect(anaPage).toHaveURL(new RegExp(`[?&]device=${esc(d.desktop.deviceId)}`));
  await expect(view.getByTestId("people-row")).toHaveCount(1);
  await expect(row(view, S.desktop)).toHaveCount(1);
  await expect(count).toHaveText("1 of 4 sessions");
  await checkSurface(anaPage, '[data-testid="people-view"]', "people view, filtered");
  await captureReview(anaPage, `0713111-people-filtered-${tag}`);

  // ---- Clear filters, then Project: the server's repository
  await view.getByTestId("people-clear").click();
  await expect(anaPage).toHaveURL(/\/work-zone\/people$/);
  await expect(count).toHaveText("4 sessions");
  await pick("project", d.server.projectName);
  await expect(anaPage).toHaveURL(new RegExp(`[?&]project=${esc(d.server.projectId)}`));
  await expect(view.getByTestId("people-row")).toHaveCount(3);
  await expect(row(view, S.desktop)).toHaveCount(0);
  await expect(count).toHaveText("3 of 4 sessions");
  await view.getByTestId("people-clear").click();
  await expect(count).toHaveText("4 sessions");
});
