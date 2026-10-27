import { expect, type Locator, type Page, test } from "@playwright/test";
import { contrastOf, expectNoSeriousA11y } from "../support/a11y";
import { apiAs } from "../support/actors";
import {
  captureReview,
  expectNoSidewaysScroll,
  expectTouchTargets,
  unnamedControls,
} from "../support/layout";
import { asSuperuser } from "../support/superuser";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import { removeTeamProject } from "../support/work-zone-projects";
import { ADMIN, API_URL } from "./env";

/**
 * The sidebar visibility marker (07.9-09, UI-SPEC Surface 2, D-07, N2, N5, R10) on the real stack:
 * - silence on the default: a session that follows its project's default shows no marker and no extra words;
 * - Only me under a default-on project shows a 12 px lock, a session shared with a team a people icon, a personal
 *   repository's Only me a lock; each row link says it to screen readers, the desktop pointer gets a tooltip;
 * - sessions on two repositories linked to one team project are sub-rows of its project row (07.10: 3, then "+1 more"
 *   to the project page); an unlinked one sits under its repository; the home page's recent sessions show the same
 *   marker.
 * The audience is set with the guarded superuser (the visibility API and its UI come in 06 and 10); the API computes
 * `differsFromDefault`, the web only words it. Ended and failed sessions sit under Settled with readable badges (07.9
 * polish: axe runs on the whole sidebar and home, with no exclusion), and every sidebar control is 44 px on a phone.
 */

test.describe.configure({ mode: "serial" });

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
  await page
    .getByTestId("login-form")
    .getByRole("button", { name: /sign in|log in/i })
    .click();
  await expect(page).toHaveURL(/\/chat/);
}

async function setAudience(sessionId: string, kind: "owner" | "teams", teamId?: string) {
  await asSuperuser("update app.work_sessions set visibility = $2 where id = $1", [sessionId, kind]);
  if (kind === "teams" && teamId) {
    await asSuperuser(
      `insert into app.work_session_grants (organization_id, work_session_id, subject_kind, subject_id, granted_by)
       select s.organization_id, s.id, 'unit', $2, s.created_by from app.work_sessions s where s.id = $1`,
      [sessionId, teamId],
    );
  }
}

/** axe on the whole sidebar (07.9 polish removed the exclusions 09 needed for the branch line and the home chip). */
const sidebarAxe = (page: Page) => expectNoSeriousA11y(page, '[data-testid="session-list"]');

test("Work Zone sidebar: a quiet marker only where the audience differs, rows grouped by team project", async ({
  page,
}, info) => {
  test.setTimeout(300_000);
  const mobile = info.project.name === "mobile";
  const tag = mobile ? "390" : "1440";
  const run = `${tag}-${Date.now().toString(36)}`;
  const adminApi = await apiAs(ADMIN);
  const devices: FakeDeviceHandle[] = [];
  const sessionIds: string[] = [];
  /** Units this test made, children first (removed at the end, so a later spec's organization tree starts clean). */
  const units: string[] = [];
  let portalUnit: string | null = null;

  const post = async <T>(path: string, data: unknown): Promise<T> => {
    const r = await adminApi.post(path, { data });
    expect(r.ok(), `${path}: ${await r.text()}`).toBe(true);
    return (await r.json()) as T;
  };
  const startSession = async (projectId: string, title: string) => {
    const s = await post<{ id: string }>("/api/v1/work-sessions", {
      projectId,
      runtime: "claude-code",
      permissionMode: "plan",
      title,
    });
    sessionIds.push(s.id);
    return s.id;
  };
  const rowOf = (list: Locator, title: string) =>
    list
      .getByTestId("session-row")
      .filter({ has: page.getByTestId("row-title").getByText(title, { exact: true }) });

  try {
    // ---- a team project ("Portal") with an assigned team ("Design"), two linked repositories and one personal one
    const eng = await post<{ id: string }>("/api/v1/units", {
      kind: "department",
      name: `Engineering ${run}`,
      parentId: null,
    });
    units.unshift(eng.id);
    const web = await post<{ id: string }>("/api/v1/units", {
      kind: "team",
      name: `Web ${run}`,
      parentId: eng.id,
    });
    units.unshift(web.id);
    const design = await post<{ id: string }>("/api/v1/units", {
      kind: "team",
      name: `Design ${run}`,
      parentId: eng.id,
    });
    units.unshift(design.id);
    const portalName = `Portal ${run}`;
    const portal = await post<{ id: string }>("/api/v1/work-projects", {
      name: portalName,
      parentId: web.id,
    });
    portalUnit = portal.id;
    await post(`/api/v1/work-projects/${portal.id}/teams`, { unitId: design.id });
    const repoA = await startFakeDevice(adminApi, {
      name: `E2E Marker A ${tag}`,
      projectName: `mk-web-${tag}`,
    });
    devices.push(repoA);
    const repoB = await startFakeDevice(adminApi, {
      name: `E2E Marker B ${tag}`,
      projectName: `mk-api-${tag}`,
    });
    devices.push(repoB);
    const repoC = await startFakeDevice(adminApi, {
      name: `E2E Marker C ${tag}`,
      projectName: `mk-scratch-${tag}`,
    });
    devices.push(repoC);
    await post(`/api/v1/work-projects/${portal.id}/repos`, { projectId: repoA.projectId });
    await post(`/api/v1/work-projects/${portal.id}/repos`, { projectId: repoB.projectId });

    const T = {
      plain: `Default ${run}`,
      mine: `Only me ${run}`,
      team: `Design only ${run}`,
      api: `API ${run}`,
      scratch: `Scratch ${run}`,
    };
    const plainId = await startSession(repoA.projectId, T.plain);
    const mine = await startSession(repoA.projectId, T.mine);
    const team = await startSession(repoA.projectId, T.team);
    const scratch = await startSession(repoC.projectId, T.scratch);
    const apiId = await startSession(repoB.projectId, T.api);
    await setAudience(mine, "owner");
    await setAudience(team, "teams", design.id);
    await setAudience(scratch, "owner");
    // Two settled sessions (ended, failed): their rows sit under Settled with the quiet badge.
    const S = { ended: `Ended ${run}`, failed: `Failed ${run}` };
    const ended = await startSession(repoC.projectId, S.ended);
    const failed = await startSession(repoC.projectId, S.failed);
    await asSuperuser("update app.work_sessions set status = $2 where id = $1", [ended, "completed"]);
    await asSuperuser("update app.work_sessions set status = $2 where id = $1", [failed, "failed"]);
    // 07.10: a project lists 3 active sessions, then "+1 more". Once every session is idle, the plain one is made the
    // oldest, so the fourth Portal session (behind "+1 more", checked on the project page below) is always the plain
    // one and every marker case stays in the sidebar, whatever order the device answered in.
    await expect
      .poll(
        async () => {
          const all = (await (await adminApi.get(`${API_URL}/api/v1/work-sessions`)).json()) as {
            sessions: Array<{ id: string; status: string }>;
          };
          return [plainId, mine, team, scratch, apiId].every(
            (id) => all.sessions.find((s) => s.id === id)?.status === "idle",
          );
        },
        { timeout: 30_000, message: "the five sessions are idle" },
      )
      .toBe(true);
    await asSuperuser("update app.work_sessions set updated_at = now() - interval '2 hours' where id = $1", [
      plainId,
    ]);

    // The API decides "differs" (default on: project shows nothing; personal: project is the default).
    const listed = (await (await adminApi.get(`${API_URL}/api/v1/work-sessions`)).json()) as {
      sessions: Array<{ id: string; visibility?: { kind: string; differsFromDefault: boolean } }>;
    };
    const byId = new Map(listed.sessions.map((s) => [s.id, s.visibility]));
    expect(byId.get(mine)).toMatchObject({ kind: "owner", differsFromDefault: true });
    expect(byId.get(team)).toMatchObject({ kind: "teams", differsFromDefault: true });
    expect(byId.get(sessionIds[0] as string)).toMatchObject({ kind: "project", differsFromDefault: false });

    await signIn(page);
    await page.goto("/work-zone");
    if (mobile) await page.getByTestId("mobile-nav-trigger").click();
    const list = page.getByTestId("session-list");
    await expect(list).toBeVisible();
    await expect(rowOf(list, T.api)).toHaveCount(1, { timeout: 30_000 });

    // ---- silence on the default; one icon and a spoken suffix otherwise. 07.10: the plain session is the fourth of
    // Portal, behind "+1 more" (its silence is checked on the project page below); the API one is the default here.
    const plain = rowOf(list, T.api);
    await expect(plain.getByTestId("visibility-marker")).toHaveCount(0);
    await expect(plain.locator(".sr-only")).toHaveCount(0);
    await expect(rowOf(list, T.plain)).toHaveCount(0);

    const mineRow = rowOf(list, T.mine);
    await expect(mineRow.getByTestId("visibility-marker")).toHaveAttribute("data-kind", "lock");
    await expect(mineRow).toContainText(", only visible to you");
    const teamRow = rowOf(list, T.team);
    await expect(teamRow.getByTestId("visibility-marker")).toHaveAttribute("data-kind", "users");
    await expect(teamRow).toContainText(`, visible to Design ${run}`);
    await expect(rowOf(list, T.scratch).getByTestId("visibility-marker")).toHaveAttribute(
      "data-kind",
      "lock",
    );

    // The icon is 12 px and muted, never coloured (N5).
    const icon = mineRow.getByTestId("visibility-marker").locator("svg");
    const box = await icon.boundingBox();
    expect(box?.width).toBe(12);
    expect(box?.height).toBe(12);
    await expect(icon).toHaveAttribute("aria-hidden", "true");

    // ---- grouping (07.10): the sessions of both linked repositories are sub-rows of Portal's project row (3, then
    // "+1 more" for the fourth); the personal one is a sub-row of its repository
    await expect(list.getByTestId(`project-row-${portal.id}`)).toContainText(portalName);
    const portalSubs = list.getByRole("list", { name: `Active sessions in ${portalName}`, exact: true });
    for (const title of [T.mine, T.team, T.api]) await expect(rowOf(portalSubs, title)).toHaveCount(1);
    await expect(portalSubs.getByTestId("project-more")).toHaveText("+1 more");
    await expect(list.getByTestId(`repo-row-${repoC.projectId}`)).toHaveText(`mk-scratch-${tag}`);
    const scratchSubs = list.getByRole("list", { name: `Active sessions in mk-scratch-${tag}`, exact: true });
    await expect(rowOf(scratchSubs, T.scratch)).toHaveCount(1);
    const ours = new Set(Object.values(T));
    const order = (
      await list
        .getByTestId("session-row")
        .evaluateAll((rows) =>
          rows.map((r) => r.querySelector('[data-testid="row-title"]')?.textContent ?? ""),
        )
    ).filter((t) => ours.has(t));
    expect(order).toHaveLength(4);

    // ---- the tooltip on a desktop pointer; touch: the row is the target (no new control)
    if (!mobile) {
      await mineRow.getByTestId("visibility-marker").hover();
      await expect(page.getByText("Only visible to you", { exact: true })).toBeVisible();
      await page.mouse.move(1430, 890);
    } else {
      for (const title of [T.mine, T.team, T.scratch]) {
        const r = await rowOf(list, title).boundingBox();
        expect(r?.height ?? 0).toBeGreaterThanOrEqual(44);
      }
    }
    // Settled: the ended and failed rows, 44 px on a phone like every other sidebar control (the hover-only "+"
    // is not offered to a touch screen). 07.10-04: Settled is a section, collapsed by default: open it first.
    const settledGroup = list.getByTestId("settled-group");
    await settledGroup.getByTestId("settled-toggle").click();
    await expect(settledGroup.getByTestId("settled-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(rowOf(settledGroup, S.ended)).toHaveAttribute("data-status", "completed");
    await expect(rowOf(settledGroup, S.failed)).toHaveAttribute("data-status", "failed");
    if (mobile) {
      for (const title of [S.ended, S.failed]) {
        const r = await rowOf(settledGroup, title).boundingBox();
        expect(r?.height ?? 0).toBeGreaterThanOrEqual(44);
      }
      await expectTouchTargets(page, '[data-testid="session-list"]');
    }

    expect(await unnamedControls(page)).toEqual([]);
    await expectNoSidewaysScroll(page, "sidebar");
    // Icons need 3:1 against what they sit on (WCAG 1.4.11), in both themes.
    await sidebarAxe(page);
    expect(await contrastOf(icon)).toBeGreaterThanOrEqual(3);
    await page.emulateMedia({ colorScheme: "dark" });
    await sidebarAxe(page);
    expect(await contrastOf(icon)).toBeGreaterThanOrEqual(3);
    await page.emulateMedia({ colorScheme: "light" });
    await captureReview(page, `09-sidebar-markers-${tag}`);
    // The Settled heading at the top of the list, so the review shows the group from its start.
    await settledGroup.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await captureReview(page, `polish-sidebar-settled-${tag}`);

    // ---- the home page's recent sessions follow the same rule
    if (mobile) {
      await page.keyboard.press("Escape");
      await expect(list).toBeHidden();
    }
    const home = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Recent sessions" }) });
    const recent = home.getByRole("link").filter({ hasText: T.mine });
    await expect(recent.getByTestId("visibility-marker")).toHaveAttribute("data-kind", "lock");
    await expect(recent).toContainText(", only visible to you");
    await expect(
      home.getByRole("link").filter({ hasText: T.plain }).getByTestId("visibility-marker"),
    ).toHaveCount(0);
    await recent.scrollIntoViewIfNeeded();
    // The time is never cut: the names truncate before it ("just nov" at 390 before 07.9 polish).
    const times = home.getByTestId("recent-session-time");
    expect(await times.count()).toBeGreaterThan(0);
    for (const fit of await times.evaluateAll((els) =>
      els.map((el) => ({
        text: el.textContent ?? "",
        right: el.getBoundingClientRect().right,
        captionRight: (el.parentElement as HTMLElement).getBoundingClientRect().right,
        overflow: el.scrollWidth > el.clientWidth,
      })),
    )) {
      expect(fit.overflow, `"${fit.text}" overflows`).toBe(false);
      expect(fit.right, `"${fit.text}" is cut by its caption`).toBeLessThanOrEqual(fit.captionRight + 0.5);
    }
    await expectNoSeriousA11y(page, "main section");
    await page.emulateMedia({ colorScheme: "dark" });
    await expectNoSeriousA11y(page, "main section");
    await page.emulateMedia({ colorScheme: "light" });
    await expectNoSidewaysScroll(page, "home");
    await captureReview(page, `09-home-markers-${tag}`);

    // ---- the fourth Portal session, behind "+1 more" (07.10): the project page lists it, silent on the default,
    // next to the marked ones
    if (mobile) await page.getByTestId("mobile-nav-trigger").click();
    await page
      .getByTestId("session-list")
      .getByRole("list", { name: `Active sessions in ${portalName}`, exact: true })
      .getByTestId("project-more")
      .click();
    await expect(page).toHaveURL(new RegExp(`/work-zone/projects/${portal.id}$`));
    const onPage = page.getByTestId("project-session-row");
    await expect(onPage.filter({ hasText: T.plain })).toHaveCount(1, { timeout: 30_000 });
    await expect(onPage.filter({ hasText: T.plain }).getByTestId("visibility-marker")).toHaveCount(0);
    await expect(onPage.filter({ hasText: T.plain })).not.toContainText("visible to");
    await expect(onPage.filter({ hasText: T.mine }).getByTestId("visibility-marker")).toHaveAttribute(
      "data-kind",
      "lock",
    );
  } finally {
    for (const id of sessionIds) {
      await adminApi
        .post(`${API_URL}/api/v1/work-sessions/${id}/archive`, { data: {} })
        .catch(() => undefined);
    }
    // The team project with its links, then its parents (07.9 polish: admin-org's mobile run clears the tree).
    if (portalUnit) await removeTeamProject(adminApi, { unitId: portalUnit, parentId: "", ownParent: false });
    for (const id of units) {
      const res = await adminApi.delete(`${API_URL}/api/v1/units/${id}`);
      expect(res.ok(), `delete unit ${id}: ${await res.text()}`).toBe(true);
    }
    for (const d of devices) await d.stop();
    await adminApi.dispose();
  }
});
