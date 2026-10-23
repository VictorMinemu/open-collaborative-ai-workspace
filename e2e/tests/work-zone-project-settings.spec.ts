import {
  type APIRequestContext,
  type Browser,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
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
 * The project Settings tab and Settings › Organization project sections (07.9-13, UI-SPEC Surface 4 part 2 and
 * Surface 5; WZP-01, WZP-03, WZP-10; D-03, D-10, D-14, U-6, U-7, U-8, R9) on the real stack, at 1440 and 390, light
 * and dark:
 * - Leo leads the Web team and created "Portal" under it: he turns the project default off (toast), and the next
 *   session he starts there is Only me (the tracer);
 * - Pia (a plain member) sees every section read-only, with the switch's state and the one line saying who changes it;
 * - Leo assigns the team he leads (never Design, which he does not), the dialog stays open; Quinn (in that team) gets
 *   the project page, and loses it live when Leo removes the team after a confirmation that says who loses access;
 * - Leo links a repository from a device he can use (a repository in another project is shown where it is, disabled,
 *   by name only), then unlinks one with a session: the dialog states the server's count, and Pia stops seeing it;
 * - the admin finds Teams and Work Zone on the project unit in Settings › Organization, assigns a department there and
 *   the project page shows it; the remove-member dialog adds the sessions sentence;
 * - Leo, a manager outside another project (D-14), reads why no session shows and reaches its complete Settings tab.
 * Every unit, project, device and session the spec makes is removed in `afterAll`.
 */

test.describe.configure({ mode: "serial" });

const LEO: Actor = { name: "Leo Settings", email: "leo-wzs@ocw.test", password: "leo-e2e-password-123" };
const PIA: Actor = { name: "Pia Settings", email: "pia-wzs@ocw.test", password: "pia-e2e-password-123" };
const QUINN: Actor = {
  name: "Quinn Settings",
  email: "quinn-wzs@ocw.test",
  password: "quinn-e2e-password-123",
};

let admin: APIRequestContext;
let leo: APIRequestContext;
let tag = "";
let run = "";
let leoId = "";
let piaId = "";
let quinnId = "";
const U = { eng: "", web: "", qa: "", design: "", portal: "", other: "" };
const N = { web: "", qa: "", design: "", portal: "", other: "" };
const devices: FakeDeviceHandle[] = [];
let repoA: FakeDeviceHandle;
let repoB: FakeDeviceHandle;
let repoC: FakeDeviceHandle;
const sessionIds: string[] = [];

async function post<R>(api: APIRequestContext, path: string, data: unknown): Promise<R> {
  const r = await api.post(path, { data });
  expect(r.ok(), `${path}: ${r.status()} ${await r.text()}`).toBe(true);
  return (await r.json()) as R;
}

async function patch(api: APIRequestContext, path: string, data: unknown): Promise<void> {
  const r = await api.patch(path, { data });
  expect(r.ok(), `${path}: ${r.status()} ${await r.text()}`).toBe(true);
}

async function del(api: APIRequestContext, path: string): Promise<void> {
  const r = await api.delete(path);
  expect(r.ok() || r.status() === 404, `${path}: ${r.status()} ${await r.text()}`).toBe(true);
}

async function startSession(
  api: APIRequestContext,
  projectId: string,
  title: string,
): Promise<{ id: string; visibility?: { kind: string } }> {
  const s = await post<{ id: string; visibility?: { kind: string } }>(api, "/api/v1/work-sessions", {
    projectId,
    runtime: "claude-code",
    permissionMode: "plan",
    title,
  });
  sessionIds.push(s.id);
  return s;
}

const unit = async (kind: string, name: string, parentId: string | null) =>
  (await post<{ id: string }>(admin, "/api/v1/units", { kind, name, parentId })).id;

/** axe (light and dark), named controls and no sideways scroll on `testId`; 44 px targets on `touch`. */
async function checkScreen(page: Page, testId: string, touch: readonly string[] = [testId]) {
  await expectNoSeriousA11y(page, `[data-testid="${testId}"]`);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectNoSeriousA11y(page, `[data-testid="${testId}"]`);
  await page.emulateMedia({ colorScheme: "light" });
  expect(await unnamedControls(page)).toEqual([]);
  await expectNoSidewaysScroll(page, testId);
  for (const id of touch) await expectTouchTargets(page, `[data-testid="${id}"]`);
}

/** The parts of the Settings tab this plan builds (the reused `MembersSection` keeps its own sizes, R9). */
const OWN_SECTIONS = ["project-access", "project-default", "project-teams", "project-repos"];

const open = (browser: Browser, who: Actor, project: string) => openAs(browser, who, project);

async function openSettings(page: Page, unitId: string) {
  await page.goto(`/work-zone/projects/${unitId}?tab=settings`);
  await expect(page.getByTestId("project-settings")).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  tag = test.info().project.name === "mobile" ? "390" : "1440";
  run = `${tag}-${Date.now().toString(36)}`;
  admin = await apiAs(ADMIN);
  leoId = await ensureMember(admin, LEO, "lead");
  piaId = await ensureMember(admin, PIA, "developer");
  quinnId = await ensureMember(admin, QUINN, "developer");
  leo = await apiAs(LEO);

  N.web = `Web ${run}`;
  N.qa = `QA ${run}`;
  N.design = `Design ${run}`;
  N.portal = `Portal ${run}`;
  N.other = `Other ${run}`;
  U.eng = await unit("department", `Engineering ${run}`, null);
  U.web = await unit("team", N.web, U.eng);
  U.qa = await unit("team", N.qa, U.web);
  U.design = await unit("department", N.design, null);
  await post(admin, `/api/v1/units/${U.web}/members`, { userId: leoId, role: "lead" });
  await post(admin, `/api/v1/units/${U.qa}/members`, { userId: quinnId, role: "member" });

  // Leo leads Web: he creates Portal there and becomes its lead (D-13). The admin creates Other there (Leo manages it
  // through Web but is not in it, D-14).
  U.portal = (
    await post<{ id: string }>(leo, "/api/v1/work-projects", { name: N.portal, parentId: U.web })
  ).id;
  U.other = (
    await post<{ id: string }>(admin, "/api/v1/work-projects", { name: N.other, parentId: U.web })
  ).id;
  await post(admin, `/api/v1/units/${U.portal}/members`, { userId: piaId, role: "member" });

  repoA = await startFakeDevice(admin, { name: `E2E Settings A ${tag}`, projectName: `wzs-web-${tag}` });
  devices.push(repoA);
  repoB = await startFakeDevice(admin, { name: `E2E Settings B ${tag}`, projectName: `wzs-api-${tag}` });
  devices.push(repoB);
  repoC = await startFakeDevice(admin, { name: `E2E Settings C ${tag}`, projectName: `wzs-other-${tag}` });
  devices.push(repoC);
  // Leo may use all three devices (ADR-0012), so he can link from them (D-10) and start sessions on them (D-13).
  for (const d of [repoA, repoB, repoC]) await shareDevice(admin, d.deviceId, leoId);
  await post(leo, `/api/v1/work-projects/${U.portal}/repos`, { projectId: repoA.projectId });
  await post(admin, `/api/v1/work-projects/${U.other}/repos`, { projectId: repoC.projectId });
});

test.afterAll(async () => {
  for (const id of sessionIds) {
    await admin.post(`/api/v1/work-sessions/${id}/archive`, { data: {} }).catch(() => undefined);
  }
  for (const [project, d] of [
    [U.portal, repoA],
    [U.portal, repoB],
    [U.other, repoC],
  ] as const) {
    if (project && d) {
      await admin.delete(`/api/v1/work-projects/${project}/repos/${d.projectId}`).catch(() => undefined);
    }
  }
  for (const id of [U.portal, U.other, U.qa, U.web, U.eng, U.design]) {
    if (id) await admin.delete(`/api/v1/units/${id}`).catch(() => undefined);
  }
  for (const d of devices) await d.stop();
  await leo?.dispose();
  await admin?.dispose();
});

test("tracer: Leo turns the default off from the Settings tab, and his next session there starts as Only me", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const { context, page } = await open(browser, LEO, info.project.name);
  try {
    await openSettings(page, U.portal);
    await expect(page.getByTestId("project-tab-settings")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("project-tab-sessions")).toHaveAttribute("aria-selected", "false");
    // Leo (lead) and Pia (member): the API's count, never admins.
    await expect(page.getByTestId("project-access")).toContainText("2 people can open this project");
    await expect(page.getByTestId("project-access")).toContainText(
      "Its members, people in its teams, and admins.",
    );
    await expect(page.getByTestId("project-settings-readonly")).toHaveCount(0);
    // Order (UI-SPEC § 4.3): Access, New sessions, People, Teams, Repositories.
    const tops = await Promise.all(
      ["project-access", "project-default", "unit-members", "project-teams", "project-repos"].map(
        async (id) => (await page.getByTestId(id).boundingBox())?.y ?? -1,
      ),
    );
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
    await checkScreen(page, "project-settings", OWN_SECTIONS);
    await captureReview(page, `project-settings-${tag}`);

    const toggle = page.getByTestId("project-default-switch");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(page.getByText(`New sessions in ${N.portal} start as Only me`)).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    // It sticks: a reload reads the API's value.
    await page.reload();
    await expect(page.getByTestId("project-default-switch")).toHaveAttribute("aria-checked", "false", {
      timeout: 30_000,
    });

    // The next session on a linked repository takes the new default (D-03).
    const s = await startSession(leo, repoA.projectId, `Private by default ${run}`);
    expect(s.visibility?.kind).toBe("owner");
    await page.goto(`/work-zone/${s.id}`);
    await expect(page.getByTestId("visibility-chip")).toHaveAttribute("data-kind", "owner", {
      timeout: 30_000,
    });

    // Back on, from the switch again, with its own toast.
    await openSettings(page, U.portal);
    await page.getByTestId("project-default-switch").click();
    await expect(page.getByText(`New sessions in ${N.portal} start visible to everyone`)).toBeVisible();
    await expect(page.getByTestId("project-default-switch")).toHaveAttribute("aria-checked", "true");
    // An unknown tab falls back to Sessions.
    await page.goto(`/work-zone/projects/${U.portal}?tab=bogus`);
    await expect(page.getByTestId("project-tab-sessions")).toHaveAttribute("aria-selected", "true");
    await page.getByTestId("project-tab-settings").click();
    await expect(page).toHaveURL(new RegExp(`/work-zone/projects/${U.portal}\\?tab=settings$`));
    await expect(page.getByTestId("project-settings")).toBeVisible();
  } finally {
    await patch(admin, `/api/v1/work-projects/${U.portal}`, { defaultVisibility: "project" });
    for (const id of sessionIds.splice(0)) {
      await admin.post(`/api/v1/work-sessions/${id}/archive`, { data: {} }).catch(() => undefined);
    }
    await context.close();
  }
});

test("Pia, a plain member, reads every section without actions and the switch's state, disabled", async ({
  browser,
}, info) => {
  const { context, page } = await open(browser, PIA, info.project.name);
  try {
    await patch(admin, `/api/v1/work-projects/${U.portal}`, { defaultVisibility: "owner" });
    await openSettings(page, U.portal);
    await expect(page.getByTestId("project-settings-readonly")).toHaveText(
      "Only project leads and admins change these settings.",
    );
    const toggle = page.getByTestId("project-default-switch");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).toHaveAttribute("aria-disabled", "true");
    for (const id of [
      "assign-teams",
      "remove-team",
      "link-repo",
      "unlink-repo",
      "add-people",
      "remove-member",
    ]) {
      await expect(page.getByTestId(id)).toHaveCount(0);
    }
    await expect(page.getByTestId("project-teams")).toContainText("No teams assigned.");
    await expect(page.getByTestId(`project-repo-row-${repoA.projectId}`)).toContainText(`wzs-web-${tag}`);
    await expect(page.getByTestId(`project-repo-row-${repoA.projectId}`)).toContainText("Online");
    await expect(page.getByTestId(`project-repo-row-${repoA.projectId}`)).toContainText("main");
    await checkScreen(page, "project-settings", OWN_SECTIONS);
    if (tag === "1440") await captureReview(page, "project-settings-readonly-1440");
  } finally {
    await patch(admin, `/api/v1/work-projects/${U.portal}`, { defaultVisibility: "project" });
    await context.close();
  }
});

test("teams: Leo assigns the team he leads (never one he does not), Quinn gets the project, and loses it live when Leo removes it", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const mobile = info.project.name === "mobile";
  const lead = await open(browser, LEO, info.project.name);
  const quinn = await open(browser, QUINN, info.project.name);
  try {
    const { page } = lead;
    await openSettings(page, U.portal);
    await page.getByTestId("assign-teams").click();
    const dialog = page.getByTestId("assign-teams-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`Assign teams to ${N.portal}`);
    await expect(dialog.getByTestId(`assign-team-option-${U.qa}`)).toContainText("Team · 1 person");
    await expect(dialog.getByTestId(`assign-team-option-${U.web}`)).toBeVisible();
    // D-14: the department Leo does not lead is never offered to him.
    await expect(dialog.getByTestId(`assign-team-option-${U.design}`)).toHaveCount(0);
    await expect(dialog.getByTestId(`assign-team-option-${U.eng}`)).toHaveCount(0);
    await dialog.getByTestId("assign-teams-search").fill("zz-no-team");
    await expect(dialog).toContainText("No team matches “zz-no-team”");
    await dialog.getByTestId("assign-teams-search").fill("");
    await expect(dialog.getByTestId(`assign-team-option-${U.qa}`)).toBeVisible();
    await checkScreen(page, "assign-teams-dialog");
    if (mobile) await captureReview(page, "project-assign-teams-390");

    await dialog.getByTestId(`assign-team-option-${U.qa}`).click();
    await expect(page.getByText(`${N.qa} assigned to ${N.portal}`)).toBeVisible();
    // The dialog stays open for more; the assigned team leaves the list.
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId(`assign-team-option-${U.qa}`)).toHaveCount(0);
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();
    const row = page.getByTestId(`project-team-row-${U.qa}`);
    await expect(row).toContainText(N.qa);
    await expect(row).toContainText("Team · 1 person");
    await expect(page.getByTestId("project-access")).toContainText("3 people can open this project");

    // Quinn is in QA: he opens the project now.
    await quinn.page.goto(`/work-zone/projects/${U.portal}`);
    await expect(quinn.page.getByTestId("project-page")).toBeVisible({ timeout: 30_000 });

    await row.getByTestId("remove-team").click();
    const confirm = page.getByTestId("remove-team-dialog");
    await expect(confirm).toContainText(`Remove ${N.qa} from ${N.portal}?`);
    await expect(confirm).toContainText(
      `People who are in ${N.portal} only through ${N.qa} lose access now, including sessions shared with ${N.qa}.`,
    );
    await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
    await checkScreen(page, "remove-team-dialog");
    await confirm.getByTestId("confirm-remove-team").click();
    await expect(page.getByText(`${N.qa} removed from ${N.portal}`)).toBeVisible();
    await expect(page.getByTestId(`project-team-row-${U.qa}`)).toHaveCount(0);
    // Quinn's open page swaps to the no-access state live.
    await expect(quinn.page.getByTestId("project-no-access")).toBeVisible({ timeout: 15_000 });
  } finally {
    await del(admin, `/api/v1/work-projects/${U.portal}/teams/${U.qa}`);
    await lead.context.close();
    await quinn.context.close();
  }
});

test("repositories: Leo links one from a device he can use, then unlinks one whose session becomes personal", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const mobile = info.project.name === "mobile";
  const lead = await open(browser, LEO, info.project.name);
  const pia = await open(browser, PIA, info.project.name);
  try {
    const { page } = lead;
    const bodies = finishedBodies(page, apiRequests());
    await openSettings(page, U.portal);
    await page.getByTestId("link-repo").click();
    const dialog = page.getByTestId("link-repo-dialog");
    await expect(dialog).toContainText(`Link a repository to ${N.portal}`);
    await expect(dialog).toContainText("Its path never leaves the device.");
    const option = (id: string) => dialog.getByTestId(`link-repo-option-${id}`);
    await expect(option(repoA.projectId)).toContainText("Already linked");
    await expect(option(repoA.projectId)).toBeDisabled();
    // Other's repository: Leo manages Other but cannot open it, so it is never named to him (D-14).
    await expect(option(repoC.projectId)).toContainText("In another project");
    await expect(option(repoC.projectId)).toBeDisabled();
    await expect(option(repoB.projectId)).toBeEnabled();
    await expect(dialog).toContainText(`E2E Settings B ${tag}`);
    await checkScreen(page, "link-repo-dialog");
    if (!mobile) await captureReview(page, "project-link-repo-1440");
    await option(repoB.projectId).click();
    await expect(page.getByText(`wzs-api-${tag} linked to ${N.portal}`)).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(option(repoB.projectId)).toContainText("Already linked");
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(page.getByTestId(`project-repo-row-${repoB.projectId}`)).toContainText(`wzs-api-${tag}`);
    // No host path ever reaches the browser (principle 7): the fake devices live under the OS temp directory.
    for (const body of await bodies()) expect(body).not.toMatch(/ocw-e2e-repo-/);

    // A session on the linked repository, visible to the project: Pia follows it.
    const title = `Shared on web ${run}`;
    await startSession(admin, repoA.projectId, title);
    await pia.page.goto(`/work-zone/projects/${U.portal}`);
    const piaRows = pia.page.getByTestId("project-session-row");
    await expect(piaRows.filter({ hasText: title })).toHaveCount(1, { timeout: 30_000 });

    await page.getByTestId(`project-repo-row-${repoA.projectId}`).getByTestId("unlink-repo").click();
    const confirm = page.getByTestId("unlink-repo-dialog");
    await expect(confirm).toContainText(`Unlink wzs-web-${tag} from ${N.portal}?`);
    await expect(confirm.getByTestId("unlink-impact")).toHaveText(
      `1 session on it becomes personal: only people who can use E2E Settings A ${tag} will see it.`,
      { timeout: 15_000 },
    );
    await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
    await checkScreen(page, "unlink-repo-dialog");
    if (mobile) await captureReview(page, "project-unlink-dialog-390");
    await confirm.getByTestId("confirm-unlink-repo").click();
    await expect(page.getByText(`wzs-web-${tag} unlinked from ${N.portal}`)).toBeVisible();
    await expect(page.getByTestId(`project-repo-row-${repoA.projectId}`)).toHaveCount(0);
    // The session became personal: Pia cannot use the device, so it leaves her list.
    await pia.page.reload();
    await expect(pia.page.getByTestId("project-page")).toBeVisible({ timeout: 30_000 });
    await expect(pia.page.getByTestId("project-session-row").filter({ hasText: title })).toHaveCount(0);
  } finally {
    await post(leo, `/api/v1/work-projects/${U.portal}/repos`, { projectId: repoA.projectId }).catch(
      () => undefined,
    );
    await del(admin, `/api/v1/work-projects/${U.portal}/repos/${repoB.projectId}`);
    await lead.context.close();
    await pia.context.close();
  }
});

test("Settings › Organization shows Teams and Work Zone on the project unit; a change there shows on the project page", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const mobile = info.project.name === "mobile";
  const { context, page } = await open(browser, ADMIN, info.project.name);
  try {
    await page.goto(`/settings/organization?unit=${U.portal}`);
    if (mobile) await expect(page.getByTestId("unit-sheet")).toBeVisible();
    const detail = page.getByTestId("unit-detail");
    await expect(page.getByTestId("unit-detail-name")).toHaveText(N.portal);
    const teams = detail.getByTestId("project-teams");
    const workzone = detail.getByTestId("org-unit-workzone");
    await expect(workzone).toBeVisible({ timeout: 30_000 });
    await expect(workzone.getByRole("link", { name: "Open in Work Zone" })).toHaveAttribute(
      "href",
      `/work-zone/projects/${U.portal}`,
    );
    await expect(workzone.getByTestId("project-default-switch")).toHaveAttribute("aria-checked", "true");
    await expect(workzone.getByTestId(`project-repo-row-${repoA.projectId}`)).toBeVisible();
    // After People, before the modules card (Surface 5).
    const y = async (l: Locator) => (await l.boundingBox())?.y ?? -1;
    expect(await y(detail.getByTestId("unit-members"))).toBeLessThan(await y(teams));
    expect(await y(teams)).toBeLessThan(await y(workzone));

    // The remove-member dialog says sessions go too (R9, U-8).
    await detail
      .getByTestId("unit-member")
      .filter({ hasText: PIA.name })
      .getByTestId("remove-member")
      .click();
    const remove = page.getByTestId("remove-member-dialog");
    await expect(remove).toContainText(
      `They also stop seeing ${N.portal}'s sessions unless a team still gives them access.`,
    );
    await remove.getByRole("button", { name: "Cancel" }).click();
    await expect(remove).toBeHidden();

    // The admin may assign any department (D-14): Design, from here.
    await teams.getByTestId("assign-teams").click();
    const dialog = page.getByTestId("assign-teams-dialog");
    await dialog.getByTestId("assign-teams-search").fill(N.design);
    await dialog.getByTestId(`assign-team-option-${U.design}`).click();
    await expect(page.getByText(`${N.design} assigned to ${N.portal}`)).toBeVisible();
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(teams.getByTestId(`project-team-row-${U.design}`)).toContainText("Department · 0 people");
    await checkScreen(page, "unit-detail", ["project-teams", "org-unit-workzone"]);
    // Teams and Work Zone, the two sections this surface adds, in view (at 390 inside the unit sheet).
    await workzone.evaluate((el) => el.scrollIntoView({ block: "end" }));
    await captureReview(page, `org-project-unit-${tag}`);

    // The same components and the same API: the project page shows it at once.
    await workzone.getByRole("link", { name: "Open in Work Zone" }).click();
    await expect(page).toHaveURL(new RegExp(`/work-zone/projects/${U.portal}$`));
    await page.getByTestId("project-tab-settings").click();
    await expect(page.getByTestId(`project-team-row-${U.design}`)).toContainText(N.design);
  } finally {
    await del(admin, `/api/v1/work-projects/${U.portal}/teams/${U.design}`);
    await context.close();
  }
});

test("Leo manages Other from outside (D-14): the Sessions tab says why nothing shows, and its Settings tab is complete", async ({
  browser,
}, info) => {
  const { context, page } = await open(browser, LEO, info.project.name);
  try {
    await page.goto(`/work-zone/projects/${U.other}`);
    const project = page.getByTestId("project-page");
    await expect(project.getByRole("heading", { level: 1 })).toHaveText(N.other, { timeout: 30_000 });
    await expect(project).toContainText("No sessions you can see");
    await expect(project).toContainText(
      "You manage this project but aren't in it. Add yourself under People in Settings to see its sessions.",
    );
    await project.getByRole("button", { name: "Open Settings" }).click();
    await expect(page).toHaveURL(new RegExp(`/work-zone/projects/${U.other}\\?tab=settings$`));
    for (const id of ["assign-teams", "link-repo", "unlink-repo", "add-people"]) {
      await expect(page.getByTestId(id).first()).toBeVisible();
    }
    await expect(page.getByTestId("project-settings-readonly")).toHaveCount(0);
    await expect(page.getByTestId("project-default-switch")).not.toHaveAttribute("aria-disabled", "true");
  } finally {
    await context.close();
  }
});
