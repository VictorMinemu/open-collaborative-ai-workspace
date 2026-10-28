import { randomUUID } from "node:crypto";
import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
// The catalog is code (ADR-0024): the spec turns the Work Zone off with exactly the rows the catalog lists.
import { MODULE_CATALOG } from "../../packages/contracts/src/module-access.ts";
import { expectNoSeriousA11y } from "../support/a11y";
import { type Actor, apiAs, ensureMember, openAs } from "../support/actors";
import {
  captureReview,
  expectNoSidewaysScroll,
  expectTouchTargets,
  unnamedControls,
} from "../support/layout";
import { apiRequests, finishedBodies } from "../support/responses";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import { shareDevice } from "../support/work-zone-projects";
import { ADMIN } from "./env";

/**
 * The Work Zone project pages (07.9-11, UI-SPEC Surface 4 part 1, WZP-10; D-01, D-07, D-10, D-13, D-14, R8, R10) on
 * the real stack, at 1440 and 390 in light and dark:
 * - Pia (a developer in "Customer portal", which has two linked repositories) reaches it from the sidebar's Projects
 *   link, and its page lists exactly the sessions she may see: never the admin's "Only me" one, not even in a response
 *   body; her personal repository (a shared device) sits under Personal projects;
 * - the admin's New session opens the dialog on the project's first online repository;
 * - a fresh member sees the empty index without New project; a project they are not in and an unknown id read as the
 *   same "You're not in this project";
 * - Leo, who leads the parent team, creates a project inside it (only the units he leads are offered) and lands on it;
 *   he also opens Customer portal without being in it (D-14), where he sees none of its sessions;
 * - removing Pia from the project swaps her open page to the no-access state live;
 * - with Work Zone off, the projects pages show the off state at once (R8: they are not sessions kept open).
 * Every team project, unit, device and session the spec makes is removed in `afterAll`.
 */

test.describe.configure({ mode: "serial" });

const PIA: Actor = { name: "Pia Projects", email: "pia-wzp@ocw.test", password: "pia-e2e-password-123" };
const LEO: Actor = { name: "Leo Lead", email: "leo-wzp@ocw.test", password: "leo-e2e-password-123" };

let admin: APIRequestContext;
let tag = "";
let run = "";
let piaId = "";
let leoId = "";
let fresh: Actor;
let eng = "";
let web = "";
let portal = "";
let portalName = "";
const devices: FakeDeviceHandle[] = [];
const sessionIds: string[] = [];
const unitsToDelete: string[] = [];
let repoA: FakeDeviceHandle;
let repoB: FakeDeviceHandle;
let scratch: FakeDeviceHandle;
const T = { login: "", sdk: "", spike: "" };

async function post<R>(api: APIRequestContext, path: string, data: unknown): Promise<R> {
  const r = await api.post(path, { data });
  expect(r.ok(), `${path}: ${r.status()} ${await r.text()}`).toBe(true);
  return (await r.json()) as R;
}

async function del(api: APIRequestContext, path: string): Promise<void> {
  const r = await api.delete(path);
  expect(r.ok() || r.status() === 404, `${path}: ${r.status()} ${await r.text()}`).toBe(true);
}

async function startSession(projectId: string, title: string): Promise<string> {
  const s = await post<{ id: string }>(admin, "/api/v1/work-sessions", {
    projectId,
    runtime: "claude-code",
    permissionMode: "plan",
    title,
  });
  sessionIds.push(s.id);
  return s.id;
}

/** The sidebar on phones lives in the navigation drawer. */
async function openSidebar(page: Page, mobile: boolean) {
  if (mobile) await page.getByTestId("mobile-nav-trigger").click();
  await expect(page.getByTestId("session-list")).toBeVisible();
}

/** axe, named controls, no sideways scroll and 44 px targets on `testId`, in light and dark. */
async function checkScreen(page: Page, testId: string) {
  await expectNoSeriousA11y(page, `[data-testid="${testId}"]`);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectNoSeriousA11y(page, `[data-testid="${testId}"]`);
  await page.emulateMedia({ colorScheme: "light" });
  expect(await unnamedControls(page)).toEqual([]);
  await expectNoSidewaysScroll(page, testId);
  await expectTouchTargets(page, `[data-testid="${testId}"]`);
}

/** A browser signed in as `who`, sized like the Playwright project (1440×900 or 390×844 with touch). */
const open = (browser: Browser, who: Actor, project: string) => openAs(browser, who, project);

test.beforeAll(async () => {
  test.setTimeout(300_000);
  tag = test.info().project.name === "mobile" ? "390" : "1440";
  run = `${tag}-${Date.now().toString(36)}`;
  admin = await apiAs(ADMIN);
  piaId = await ensureMember(admin, PIA, "developer");
  leoId = await ensureMember(admin, LEO, "lead");
  fresh = { name: "Fay Fresh", email: `fay-wzp-${run}@ocw.test`, password: "fay-e2e-password-123" };
  await ensureMember(admin, fresh, "developer");

  eng = (
    await post<{ id: string }>(admin, "/api/v1/units", {
      kind: "department",
      name: `Engineering ${run}`,
      parentId: null,
    })
  ).id;
  unitsToDelete.push(eng);
  web = (
    await post<{ id: string }>(admin, "/api/v1/units", { kind: "team", name: `Web ${run}`, parentId: eng })
  ).id;
  unitsToDelete.unshift(web);
  await post(admin, `/api/v1/units/${web}/members`, { userId: leoId, role: "lead" });

  portalName = `Customer portal ${run}`;
  portal = (await post<{ id: string }>(admin, "/api/v1/work-projects", { name: portalName, parentId: web }))
    .id;
  await post(admin, `/api/v1/units/${portal}/members`, { userId: piaId, role: "member" });

  repoA = await startFakeDevice(admin, { name: `E2E Projects A ${tag}`, projectName: `wzp-web-${tag}` });
  devices.push(repoA);
  repoB = await startFakeDevice(admin, { name: `E2E Projects B ${tag}`, projectName: `wzp-api-${tag}` });
  devices.push(repoB);
  scratch = await startFakeDevice(admin, {
    name: `E2E Projects C ${tag}`,
    projectName: `wzp-scratch-${tag}`,
  });
  devices.push(scratch);
  await post(admin, `/api/v1/work-projects/${portal}/repos`, { projectId: repoA.projectId });
  await post(admin, `/api/v1/work-projects/${portal}/repos`, { projectId: repoB.projectId });
  // Pia's personal repository: the scratch device is shared with her (ADR-0012).
  await shareDevice(admin, scratch.deviceId, piaId);

  T.login = `Fix the login redirect ${run}`;
  T.sdk = `Upgrade the payments SDK ${run}`;
  T.spike = `Private spike ${run}`;
  await startSession(repoA.projectId, T.login);
  await startSession(repoB.projectId, T.sdk);
  const spike = await startSession(repoA.projectId, T.spike);
  // The admin keeps this one to themselves (the visibility API of 07.9-06).
  const put = await admin.put(`/api/v1/work-sessions/${spike}/visibility`, { data: { kind: "owner" } });
  expect(put.ok(), `PUT visibility: ${put.status()} ${await put.text()}`).toBe(true);
});

test.afterAll(async () => {
  for (const id of sessionIds) {
    await admin.post(`/api/v1/work-sessions/${id}/archive`, { data: {} }).catch(() => undefined);
  }
  if (portal) {
    for (const d of [repoA, repoB]) {
      if (d)
        await admin.delete(`/api/v1/work-projects/${portal}/repos/${d.projectId}`).catch(() => undefined);
    }
    await admin.delete(`/api/v1/units/${portal}`).catch(() => undefined);
  }
  for (const d of devices) await d.stop();
  for (const id of unitsToDelete) await admin.delete(`/api/v1/units/${id}`).catch(() => undefined);
  await admin.dispose();
});

test("Pia reaches her team project from the sidebar and sees exactly the sessions she may see", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const mobile = info.project.name === "mobile";
  const { context, page } = await open(browser, PIA, info.project.name);
  try {
    const bodies = finishedBodies(page, apiRequests());
    await page.goto("/work-zone");
    await openSidebar(page, mobile);
    const list = page.getByTestId("session-list");
    // Sidebar grouping (07.10): the two sessions on the two linked repositories are sub-rows of the project's row.
    await expect(list.getByTestId(`project-row-${portal}`)).toContainText(portalName, { timeout: 30_000 });
    for (const title of [T.login, T.sdk]) {
      const row = list
        .getByRole("list", { name: `Active sessions in ${portalName}`, exact: true })
        .getByTestId("session-row")
        .filter({ has: page.getByTestId("row-title").getByText(title, { exact: true }) });
      await expect(row).toHaveCount(1, { timeout: 30_000 });
    }
    await expect(list.getByText(T.spike)).toHaveCount(0);

    await expect(page.getByTestId("sidebar-projects")).toHaveText("Browse projects");
    await page.getByTestId("sidebar-projects").click();
    await expect(page).toHaveURL(/\/work-zone\/projects$/);
    const index = page.getByTestId("projects-index");
    await expect(index).toBeVisible();
    // The index's row (the sidebar has a project row of the same id since 07.10).
    const row = index.getByTestId(`project-row-${portal}`);
    await expect(row).toContainText(portalName);
    await expect(row).toContainText(`Engineering ${run} › Web ${run} · 2 people · 2 repositories`);
    await expect(row).toHaveAttribute("title", portalName);
    const personal = page.getByTestId(`personal-row-${scratch.projectId}`);
    await expect(personal).toContainText(`wzp-scratch-${tag}`);
    await expect(personal.getByRole("button", { name: `New session in wzp-scratch-${tag}` })).toBeVisible();
    // A developer who leads nothing never sees New project.
    await expect(page.getByTestId("new-project")).toHaveCount(0);
    if (!mobile) await expect(page.getByTestId("sidebar-projects")).toHaveAttribute("aria-current", "page");
    await checkScreen(page, "projects-index");
    await captureReview(page, `projects-index-${tag}`);

    await row.click();
    await expect(page).toHaveURL(new RegExp(`/work-zone/projects/${portal}$`));
    const project = page.getByTestId("project-page");
    await expect(project).toBeVisible();
    await expect(project.getByRole("heading", { level: 1 })).toHaveText(portalName);
    await expect(project).toContainText(`Engineering ${run} › Web ${run}`);
    // 07.10: the sidebar highlights the open project's row; Browse projects is current only on the index.
    if (!mobile) {
      const sidebar = page.getByTestId("session-list");
      await expect(sidebar.getByTestId(`project-row-${portal}`)).toHaveAttribute("aria-current", "page");
      await expect(sidebar.getByTestId("sidebar-projects")).not.toHaveAttribute("aria-current", "page");
    }
    const rows = page.getByTestId("project-session-row");
    await expect(rows.filter({ hasText: T.login })).toHaveCount(1, { timeout: 30_000 });
    await expect(rows.filter({ hasText: T.sdk })).toHaveCount(1);
    await expect(rows.filter({ hasText: T.spike })).toHaveCount(0);
    await expect(rows.filter({ hasText: T.login })).toContainText(`wzp-web-${tag}`);
    await expect(page.getByTestId("project-sessions-footnote")).toHaveText(
      "Sessions people keep to themselves don't appear here.",
    );
    // Pia cannot use the project's devices: she follows its sessions but has no New session here (D-13). Scoped to the
    // page: since 07.10-05 the sidebar's project "+" carries the same test id (and is absent for her too).
    await expect(project.getByTestId("project-new-session")).toHaveCount(0);
    await expect(page.getByTestId("project-new-session")).toHaveCount(0);
    await checkScreen(page, "project-page");
    await captureReview(page, `project-sessions-${tag}`);

    // The admin's Only-me session never reaches her browser, in any response (T-07.9-11-02).
    for (const body of await bodies()) expect(body).not.toContain(T.spike);

    // A session row opens the session; the project pages are not sessions (R8).
    await rows.filter({ hasText: T.login }).getByRole("link").click();
    await expect(page.getByTestId("session-header")).toBeVisible({ timeout: 30_000 });
  } finally {
    await context.close();
  }
});

test("the admin's New session opens the dialog on the project's first online repository", async ({
  browser,
}, info) => {
  const { context, page } = await open(browser, ADMIN, info.project.name);
  try {
    await page.goto(`/work-zone/projects/${portal}`);
    await expect(page.getByTestId("project-page")).toBeVisible();
    // Admins always see sessions (D-04): the Only-me one is listed for them.
    await expect(page.getByTestId("project-session-row").filter({ hasText: T.spike })).toHaveCount(1, {
      timeout: 30_000,
    });
    // The page's New session (the sidebar's project "+" shares the test id since 07.10-05).
    await page.getByTestId("project-page").getByTestId("project-new-session").click();
    const dialog = page.getByTestId("new-session-dialog");
    await expect(dialog).toBeVisible();
    const selected = dialog.locator('[data-testid="project-option"][aria-checked="true"]');
    await expect(selected).toHaveCount(1);
    await expect(selected).toContainText(/wzp-(web|api)-/);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  } finally {
    await context.close();
  }
});

test("a fresh member: the empty index without New project, and one no-access state for a project and an unknown id", async ({
  browser,
}, info) => {
  const { context, page } = await open(browser, fresh, info.project.name);
  try {
    await page.goto("/work-zone/projects");
    const index = page.getByTestId("projects-index");
    await expect(index).toContainText("No team projects yet");
    await expect(index).toContainText(
      "A team project lets everyone in it see and steer sessions together. Admins and team leads create them.",
    );
    await expect(index).toContainText("No personal repositories. Add one from the desktop app.");
    await expect(page.getByTestId("new-project")).toHaveCount(0);
    await checkScreen(page, "projects-index");
    await captureReview(page, `projects-index-empty-${tag}`);

    await page.goto(`/work-zone/projects/${portal}`);
    const denied = page.getByTestId("project-no-access");
    await expect(denied).toContainText("You're not in this project");
    await expect(denied).toContainText("Ask a project lead to add you.");
    const deniedText = await denied.innerText();
    await expect(page.getByTestId("project-page")).toHaveCount(0);
    await checkScreen(page, "project-no-access");

    for (const id of [randomUUID(), "not-a-project"]) {
      await page.goto(`/work-zone/projects/${id}`);
      await expect(page.getByTestId("project-no-access")).toBeVisible();
      expect(await page.getByTestId("project-no-access").innerText()).toBe(deniedText);
    }
    await page.getByRole("link", { name: "Back to projects" }).click();
    await expect(page).toHaveURL(/\/work-zone\/projects$/);
  } finally {
    await context.close();
  }
});

test("Leo, a team lead, creates a project inside the team he leads and opens the parent's other project (D-14)", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const { context, page } = await open(browser, LEO, info.project.name);
  const leo = await apiAs(LEO);
  let created = "";
  try {
    const parents = (await (await leo.get("/api/v1/work-projects/parents")).json()) as {
      parents: Array<{ id: string; name: string }>;
    };
    // Only the units Leo leads: this run's Web team, never its department (no top level, D-13).
    expect(parents.parents.map((p) => p.id)).toContain(web);
    expect(parents.parents.map((p) => p.id)).not.toContain(eng);

    await page.goto("/work-zone/projects");
    await page.getByTestId("new-project").click();
    const dialog = page.getByTestId("new-project-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Name")).toBeFocused();
    await dialog.getByTestId("new-project-submit").click();
    await expect(dialog.getByRole("alert")).toHaveText("Enter a name");
    const name = `Mobile app ${run}`;
    await dialog.getByLabel("Name").fill(name);
    await dialog.getByTestId("new-project-parent").click();
    const options = page.getByTestId("new-project-parent-option");
    await expect(options).toHaveCount(parents.parents.length);
    await expect(page.getByRole("option", { name: /top level/i })).toHaveCount(0);
    await options.filter({ hasText: `Web ${run}` }).click();
    await expect(dialog.getByTestId("new-project-parent")).toContainText(`Web ${run}`);
    await checkScreen(page, "new-project-dialog");
    await dialog.getByTestId("new-project-submit").click();

    await expect(page).toHaveURL(/\/work-zone\/projects\/[0-9a-f-]{36}\?tab=settings$/);
    created = new URL(page.url()).pathname.split("/").at(-1) ?? "";
    unitsToDelete.unshift(created);
    const project = page.getByTestId("project-page");
    await expect(project.getByRole("heading", { level: 1 })).toHaveText(name);
    await expect(page.getByText(`${name} created`)).toBeVisible();
    // It opens on its Settings tab (07.9-13), where a new project's editor links a repository first.
    await expect(page.getByTestId("project-tab-settings")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("project-repos")).toContainText(
      "No repositories linked. Link one from a device you can use.",
    );
    await page.getByTestId("project-tab-sessions").click();
    // A new project has no repositories: its editor reads how to start (UI-SPEC § Copy).
    await expect(project).toContainText("No repositories yet");
    await expect(project).toContainText("Link a repository so the team can start sessions here.");
    await expect(project.getByTestId("project-new-session")).toHaveCount(0);
    await checkScreen(page, "project-page");
    await captureReview(page, `project-empty-${tag}`);

    // D-14: Leo leads Customer portal's parent, so he opens its page; he is not in the project, so none of its
    // sessions is his to see, and he cannot start one there.
    await page.goto(`/work-zone/projects/${portal}`);
    const other = page.getByTestId("project-page");
    await expect(other.getByRole("heading", { level: 1 })).toHaveText(portalName);
    await expect(other).toContainText("No sessions you can see");
    // 07.9-13: a manager outside the project reads why, not the member's "Start one".
    await expect(other).toContainText("You manage this project but aren't in it.");
    await expect(page.getByTestId("project-session-row")).toHaveCount(0);
    await expect(other.getByTestId("project-new-session")).toHaveCount(0);
  } finally {
    if (created) {
      await del(admin, `/api/v1/units/${created}`);
      unitsToDelete.splice(unitsToDelete.indexOf(created), 1);
    }
    await leo.dispose();
    await context.close();
  }
});

test("losing project access while on the page swaps to the no-access state live; the index drops the project", async ({
  browser,
}, info) => {
  const { context, page } = await open(browser, PIA, info.project.name);
  try {
    await page.goto(`/work-zone/projects/${portal}`);
    await expect(page.getByTestId("project-session-row").filter({ hasText: T.login })).toHaveCount(1, {
      timeout: 30_000,
    });
    await del(admin, `/api/v1/units/${portal}/members/${piaId}`);
    await expect(page.getByTestId("project-no-access")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("project-page")).toHaveCount(0);
    await page.getByRole("link", { name: "Back to projects" }).click();
    await expect(page.getByTestId("projects-index")).toBeVisible();
    await expect(page.getByTestId(`project-row-${portal}`)).toHaveCount(0);
  } finally {
    await post(admin, `/api/v1/units/${portal}/members`, { userId: piaId, role: "member" });
    await context.close();
  }
});

test("with Work Zone off, the projects pages show the off state at once, never kept open as a session (R8)", async ({
  browser,
}, info) => {
  const { context, page } = await open(browser, PIA, info.project.name);
  const rules: string[] = [];
  try {
    await page.goto("/work-zone/projects");
    await expect(page.getByTestId("projects-index").getByTestId(`project-row-${portal}`)).toBeVisible({
      timeout: 30_000,
    });
    for (const permission of MODULE_CATALOG.work_zone.patterns) {
      const rule = await post<{ id: string }>(admin, "/api/v1/permission-rules", {
        scopeUnitId: null,
        subjectKind: "user",
        subjectId: piaId,
        permission,
        effect: "deny",
      });
      rules.push(rule.id);
    }
    // Live: the open index is replaced by the off state (a kept-open session would stay).
    const off = page.getByTestId("module-off");
    await expect(off).toBeVisible({ timeout: 15_000 });
    await expect(off).toHaveAttribute("data-module", "work_zone");
    await expect(page.getByTestId("projects-index")).toHaveCount(0);
    // A deep link to a project page is not a session either.
    await page.goto(`/work-zone/projects/${portal}`);
    await expect(page.getByTestId("module-off")).toHaveAttribute("data-module", "work_zone");
    await expect(page.getByTestId("project-page")).toHaveCount(0);
  } finally {
    for (const id of rules) await del(admin, `/api/v1/permission-rules/${id}`);
    await context.close();
  }
});
