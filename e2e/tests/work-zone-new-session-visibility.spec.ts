import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs, userIdOf } from "../support/actors";
import {
  captureReview,
  expectNoSidewaysScroll,
  expectTouchTargets,
  unnamedControls,
} from "../support/layout";
import { apiRequests, finishedBodies } from "../support/responses";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import {
  createTeamProject,
  linkRepo,
  removeTeamProject,
  shareDevice,
  type TeamProject,
} from "../support/work-zone-projects";
import { ADMIN } from "./env";

/**
 * Starting a session shows where it belongs and who will see it, in one line, before it starts (Phase 07.9-14, UI-SPEC
 * Surface 3, D-01, D-03, D-07, D-13, D-14, R5, R11), on the real stack with real fake-runtime devices:
 * - the repositories are grouped under their team project (with the device in each caption), then Personal by device;
 *   a repository of Pia's own device linked to a project she can't open is shown apart, disabled, never as personal,
 *   and the project's name never reaches her page;
 * - "Visible to: {long label} · Change" follows the chosen repository's default; Change opens the panel in draft mode
 *   (popover ≥ 640, bottom sheet below) with the API's preview count and never calls the save API;
 * - Start session sends the choice: the new session's chip reads Only me;
 * - a stale choice (a person removed from the project meanwhile) is refused inline and nothing is created;
 * - layout and accessibility at 1440 and 390 in both themes, with this plan's review screenshots.
 */

test.describe.configure({ mode: "serial" });

const LEO: Actor = { name: "Leo Park", email: "leo@ocw.test", password: "leo-e2e-password-123" };
const PIA: Actor = { name: "Pia Gómez", email: "pia@ocw.test", password: "pia-e2e-password-123" };

const DESCRIPTION =
  "Runs on a computer in your team. People who can see the session follow it and queue prompts; they run one at a time.";

class Fixture {
  readonly projects: TeamProject[] = [];
  readonly devices: FakeDeviceHandle[] = [];
  readonly contexts: BrowserContext[] = [];
  readonly apis: APIRequestContext[] = [];

  constructor(readonly api: APIRequestContext) {}

  async device(owner: APIRequestContext, name: string, projectName: string): Promise<FakeDeviceHandle> {
    const d = await startFakeDevice(owner, { name, projectName });
    this.devices.push(d);
    return d;
  }

  async cleanup(): Promise<void> {
    for (const c of this.contexts) await c.close().catch(() => undefined);
    // Pia's sessions are archived by the admin (work_session.archive), then the projects unlinked and removed.
    const list = await this.api.get("/api/v1/work-sessions").catch(() => null);
    const ids = new Set(this.devices.map((d) => d.projectId));
    if (list?.ok()) {
      const { sessions } = (await list.json()) as { sessions: Array<{ id: string; projectId: string }> };
      for (const s of sessions.filter((x) => ids.has(x.projectId)))
        await this.api.post(`/api/v1/work-sessions/${s.id}/archive`, { data: {} }).catch(() => undefined);
    }
    for (const p of this.projects) await removeTeamProject(this.api, p).catch(() => undefined);
    for (const d of this.devices) await d.stop().catch(() => undefined);
    for (const a of this.apis) await a.dispose().catch(() => undefined);
    await this.api.dispose();
  }
}

const line = (page: Page) => page.getByTestId("new-session-visibility");
const lineLabel = (page: Page) => page.getByTestId("new-session-visibility-label");

/** The draft panel's surface: the popover on ≥ 640, the nested bottom sheet below. */
const surfaceOf = (page: Page, mobile: boolean) =>
  page.getByTestId(mobile ? "visibility-sheet" : "visibility-popover");

async function openDraft(page: Page, mobile: boolean): Promise<Locator> {
  await page.getByTestId("new-session-visibility-change").click();
  const surface = surfaceOf(page, mobile);
  await expect(surface).toBeVisible();
  await expect(surface.getByTestId("visibility-panel")).toBeVisible();
  return surface;
}

/** Closes the draft panel only: the dialog stays open underneath. */
async function closeDraft(page: Page, mobile: boolean): Promise<void> {
  if (mobile) await surfaceOf(page, mobile).getByRole("button", { name: "Close" }).click();
  else await page.keyboard.press("Escape");
  await expect(surfaceOf(page, mobile)).toHaveCount(0);
  await expect(page.getByTestId("new-session-dialog")).toBeVisible();
}

async function openDialog(page: Page): Promise<Locator> {
  await page.goto(`${BASE_URL}/work-zone`);
  await page.getByTestId("new-session").click();
  const dialog = page.getByTestId("new-session-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

/** axe on `selector` in light and dark (serious and critical fail). */
async function axeBothThemes(page: Page, selector: string): Promise<void> {
  await expectNoSeriousA11y(page, selector);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectNoSeriousA11y(page, selector);
  await page.emulateMedia({ colorScheme: "light" });
}

async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

test("new session: grouped repositories, one 'Visible to' line, a draft choice applied at start, a stale one refused", async ({
  browser,
}, info) => {
  test.setTimeout(360_000);
  const mobile = info.project.name === "mobile";
  const tag = mobile ? "390" : "1440";
  const run = `${tag}-${Date.now().toString(36)}`;
  const f = new Fixture(await apiAs(ADMIN));
  try {
    const adminId = await userIdOf(f.api);
    const leoId = await ensureMember(f.api, LEO, "developer");
    const piaId = await ensureMember(f.api, PIA, "developer");
    const portalName = `Customer portal ${run}`;
    const portal = await createTeamProject(f.api, {
      name: portalName,
      members: [{ userId: piaId }, { userId: leoId }],
    });
    f.projects.push(portal);
    const devA = await f.device(f.api, `E2E NS A ${run}`, `ns-web-${tag}`);
    const devB = await f.device(f.api, `E2E NS B ${run}`, `ns-api-${tag}`);
    const solo = await f.device(f.api, `E2E NS Solo ${run}`, `ns-scratch-${tag}`);
    await linkRepo(f.api, portal.unitId, devA.projectId);
    await linkRepo(f.api, portal.unitId, devB.projectId);
    for (const d of [devA, devB, solo]) await shareDevice(f.api, d.deviceId, piaId);

    // D-14: Pia's own repository, linked by an admin to a project she is not in.
    const piaApi = await apiAs(PIA);
    f.apis.push(piaApi);
    const payrollName = `Payroll ${run}`;
    const own = await f.device(piaApi, `Pia laptop ${run}`, `ns-payroll-${tag}`);
    await shareDevice(piaApi, own.deviceId, adminId);
    const payroll = await createTeamProject(f.api, { name: payrollName, members: [] });
    f.projects.push(payroll);
    await linkRepo(f.api, payroll.unitId, own.projectId);

    const pia = await openAs(browser, PIA, info.project.name);
    f.contexts.push(pia.context);
    const page = pia.page;
    // The repository list (`GET /projects`, and the draft's audience reads under it) as the page received it.
    const repoBodies = finishedBodies(page, apiRequests("/api/v1/projects"));
    // Draft mode never calls the save API (PUT /work-sessions/:id/visibility) nor any session's visibility.
    let saves = 0;
    page.on("request", (r) => {
      if (/\/api\/v1\/work-sessions\/[^/]+\/visibility/u.test(r.url())) saves += 1;
    });

    const dialog = await openDialog(page);
    await expect(dialog.getByText(DESCRIPTION, { exact: true })).toBeVisible();

    // ---- grouping (D-01, R5): the team project first, with both repositories and their devices
    const group = dialog.getByTestId(`project-group-${portal.unitId}`);
    await expect(group).toContainText(`${portalName} · Team project`);
    const teamOptions = group.getByTestId("project-option");
    await expect(teamOptions).toHaveCount(2);
    await expect(teamOptions.filter({ hasText: `ns-web-${tag}` })).toContainText(`E2E NS A ${run}`);
    await expect(teamOptions.filter({ hasText: `ns-web-${tag}` })).toContainText("Online");
    await expect(teamOptions.filter({ hasText: `ns-api-${tag}` })).toContainText(`E2E NS B ${run}`);
    // D-14: shown apart and disabled, never as personal; the project's name never reaches the page.
    const hidden = dialog.getByTestId("project-group-hidden");
    await expect(hidden).toContainText("Linked to a project you can't open");
    await expect(
      hidden.getByTestId("project-option-hidden").filter({ hasText: `ns-payroll-${tag}` }),
    ).toBeDisabled();
    await expect(dialog.getByTestId("project-option").filter({ hasText: `ns-payroll-${tag}` })).toHaveCount(
      0,
    );
    await expect(dialog.getByTestId("project-group-personal")).toHaveText("Personal");
    await expect(dialog.getByTestId("project-option").filter({ hasText: `ns-scratch-${tag}` })).toBeEnabled();

    // ---- the line follows the chosen repository's default (D-03)
    await teamOptions.filter({ hasText: `ns-web-${tag}` }).click();
    await expect(line(page)).toHaveAttribute("data-kind", "project");
    await expect(line(page)).toHaveText(`Visible to: Everyone in ${portalName} · Change`);
    await expect(page.getByTestId("new-session-visibility-change")).toHaveAccessibleName(
      "Change who can see this session",
    );
    if (mobile) {
      // One row: the label and Change share a line; Change is a 44 px target; nothing scrolls sideways.
      await line(page).scrollIntoViewIfNeeded();
      const label = await lineLabel(page).boundingBox();
      const change = await page.getByTestId("new-session-visibility-change").boundingBox();
      expect(
        Math.abs((label?.y ?? 0) + (label?.height ?? 0) / 2 - ((change?.y ?? 0) + (change?.height ?? 0) / 2)),
      ).toBeLessThanOrEqual(2);
      expect((await line(page).boundingBox())?.height ?? 99).toBeLessThanOrEqual(48);
      await expectTouchTargets(page, '[data-testid="new-session-visibility"]');
      await expectNoSidewaysScroll(page, "new-session dialog");
    }
    expect(await unnamedControls(page)).toEqual([]);
    await axeBothThemes(page, '[data-testid="new-session-dialog"]');
    if (mobile) {
      // The whole panel (owner feedback 2026-11-06): 44 px targets and no sideways scroll on a phone.
      await expectTouchTargets(page, '[data-testid="new-session-dialog"]');
      await expectNoSidewaysScroll(page, "new-session dialog (panel)");
      // Nor inside the sheet: a long device name in "Visible to" once widened its column past the screen, pushing
      // the Model list off to the side where the backdrop took the tap.
      expect(
        await dialog.evaluate((el) => {
          const right = el.getBoundingClientRect().right;
          return [...el.querySelectorAll<HTMLElement>("*")]
            .filter((x) => x.getBoundingClientRect().right > right + 1)
            .map((x) => `${x.tagName}.${String(x.className).slice(0, 60)}`);
        }),
        "nothing in the sheet is wider than the screen",
      ).toEqual([]);
    }
    // The footer says what the session starts on; Start is the one primary action.
    await expect(dialog.getByTestId("start-session")).toBeEnabled();
    if (!mobile)
      await expect(dialog.getByTestId("new-session-status")).toHaveText(
        `On E2E NS A ${run} with Claude Code`,
      );
    await blur(page);
    await captureReview(page, `new-session-dialog-${tag}`);

    // ---- Model and permissions: one summary row, opened in place (progressive disclosure), axe in both themes
    const settings = dialog.getByTestId("new-session-settings-toggle");
    await expect(settings).toHaveAttribute("aria-expanded", "false");
    await expect(dialog.getByTestId("new-session-settings-summary")).toHaveText(
      "Default model · Supervised · Current checkout",
    );
    await settings.click();
    await expect(settings).toHaveAttribute("aria-expanded", "true");
    await expect(dialog.getByTestId("mode-default")).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByTestId("new-session-model")).toBeVisible();
    expect(await unnamedControls(page)).toEqual([]);
    await axeBothThemes(page, '[data-testid="new-session-dialog"]');
    if (mobile) await expectTouchTargets(page, '[data-testid="new-session-dialog"]');
    await blur(page);
    await captureReview(page, `new-session-dialog-settings-${tag}`);
    await settings.click();
    await expect(dialog.getByTestId("mode-default")).toHaveCount(0);

    // ---- keyboard: one tab stop per radio group; arrow keys move the choice
    const chosen = dialog.locator('[data-testid="project-option"][aria-checked="true"]');
    await chosen.focus();
    await page.keyboard.press("ArrowDown");
    await expect(chosen).not.toContainText(`ns-web-${tag}`);
    await expect(chosen).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(chosen).toContainText(`ns-web-${tag}`);

    // ---- Change opens the panel in draft mode, with the preview count for the repository
    let surface = await openDraft(page, mobile);
    const draft = surface.getByTestId("visibility-panel");
    await expect(draft.getByTestId("visibility-option-project")).toHaveAttribute("data-checked", "true");
    await expect(draft.getByTestId("visibility-option-project")).toContainText("Default");
    // Pia (owner), Leo (member) and the admin (the project's lead): the API's count, never the browser's.
    await expect(surface.getByTestId("who-can-see")).toHaveAttribute("data-count", "3");
    await expect(surface.getByTestId("who-can-see")).toContainText("3 people can see this");
    if (mobile) {
      await expectTouchTargets(page, '[data-testid="visibility-sheet"]');
      for (const kind of ["owner", "project", "teams", "people"]) {
        const box = await draft.getByTestId(`visibility-option-${kind}`).boundingBox();
        expect(box?.height ?? 0, `${kind} row height`).toBeGreaterThanOrEqual(56);
      }
      await axeBothThemes(page, '[data-testid="visibility-sheet"]');
      await expectNoSidewaysScroll(page, "draft sheet");
      await captureReview(page, "new-session-dialog-sheet-390");
    } else {
      await axeBothThemes(page, '[data-testid="visibility-popover"]');
      await captureReview(page, "new-session-dialog-draft-1440");
    }

    // Only me applies to the draft at once: the line reads Only you, and nothing was saved anywhere.
    await draft.getByTestId("visibility-option-owner").click();
    await expect(line(page)).toHaveAttribute("data-kind", "owner");
    await expect(lineLabel(page)).toHaveText("Only you");
    // Only me still shows the admin: the session runs on his device, so he always sees it (D-11).
    await expect(surface.getByTestId("who-can-see")).toHaveAttribute("data-count", "2");
    await expect(surface.getByTestId("who-can-see")).toContainText("2 people can see this");
    expect(saves).toBe(0);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    await closeDraft(page, mobile);
    await expect(lineLabel(page)).toHaveText("Only you");

    // Another repository resets the line to its default: a personal one is everyone who can use its device.
    await dialog
      .getByTestId("project-option")
      .filter({ hasText: `ns-scratch-${tag}` })
      .click();
    await expect(line(page)).toHaveAttribute("data-kind", "project");
    await expect(lineLabel(page)).toHaveText(`Everyone who can use E2E NS Solo ${run}`);
    await teamOptions.filter({ hasText: `ns-web-${tag}` }).click();
    await expect(lineLabel(page)).toHaveText(`Everyone in ${portalName}`);

    // ---- Start session sends the draft: the new session is visible to Pia only (D-03, D-07)
    surface = await openDraft(page, mobile);
    await surface.getByTestId("visibility-option-owner").click();
    await expect(lineLabel(page)).toHaveText("Only you");
    await closeDraft(page, mobile);
    await dialog.getByTestId("runtime-claude-code").click();
    const created = page.waitForRequest(
      (r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/v1/work-sessions",
    );
    await dialog.getByTestId("start-session").click();
    expect((await created).postDataJSON()).toMatchObject({
      projectId: devA.projectId,
      visibility: { kind: "owner" },
    });
    await expect(page).toHaveURL(/\/work-zone\/[0-9a-f-]{36}$/, { timeout: 15_000 });
    const chip = page.getByTestId("session-header").getByTestId("visibility-chip");
    await expect(chip).toHaveAttribute("data-kind", "owner");
    await expect(chip).toHaveAccessibleName("Visible to Only you. Change who can see this session");
    expect(saves).toBe(0);

    // ---- a stale choice: People with Leo, then Leo leaves the project before Start (D-04, D-13)
    const again = await openDialog(page);
    // The repository of the last session started here is chosen again.
    await expect(again.locator('[data-testid="project-option"][aria-checked="true"]')).toContainText(
      `ns-web-${tag}`,
    );
    await again
      .getByTestId("project-option")
      .filter({ hasText: `ns-web-${tag}` })
      .click();
    surface = await openDraft(page, mobile);
    await surface.getByTestId("visibility-option-people").click();
    await surface.getByTestId("people-input").fill("Leo");
    await surface.getByTestId(`people-option-${leoId}`).click();
    await expect(lineLabel(page)).toHaveText("2 people");
    await closeDraft(page, mobile);
    const del = await f.api.delete(`/api/v1/units/${portal.unitId}/members/${leoId}`);
    expect(del.ok(), `remove Leo: ${await del.text()}`).toBe(true);
    const refused = page.waitForResponse(
      (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v1/work-sessions",
    );
    await again.getByTestId("start-session").click();
    expect((await refused).status()).toBe(422);
    const alert = again.getByRole("alert");
    await expect(alert).toHaveText(`Leo Park isn't in ${portalName} anymore. Choose who can see it again.`);
    await expect(page).toHaveURL(/\/work-zone$/);
    await expect(again).toBeVisible();
    // The error line is brought into view: the person sees why nothing started without scrolling.
    await expect(alert).toBeInViewport();
    if (!mobile) {
      await blur(page);
      await captureReview(page, "new-session-dialog-refusal-1440");
    }
    // Nothing was created: Pia still has exactly the one session she started above on that repository.
    const mine = await piaApi.get("/api/v1/work-sessions");
    const { sessions } = (await mine.json()) as {
      sessions: Array<{ projectId: string; archivedAt?: unknown }>;
    };
    expect(sessions.filter((s) => s.projectId === devA.projectId)).toHaveLength(1);

    // D-14: the link stays hidden: no repository response Pia's page read names Payroll or carries its id. (Unit names
    // themselves are organization data: Settings › Organization and the member list show them to every member.)
    const read = await repoBodies();
    expect(read.length).toBeGreaterThan(0);
    for (const body of read) {
      expect(body).not.toContain(payrollName);
      expect(body).not.toContain(payroll.unitId);
    }
  } finally {
    await f.cleanup();
  }
});
