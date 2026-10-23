import { expect, type Locator, type Page, test } from "@playwright/test";
import { contrastOf } from "../support/a11y";
import { apiAs } from "../support/actors";
import { captureReview, expectNoSidewaysScroll, unnamedControls } from "../support/layout";
import { asSuperuser } from "../support/superuser";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import { ADMIN, API_URL } from "./env";

/**
 * The sidebar visibility marker (07.9-09, UI-SPEC Surface 2, D-07, N2, N5, R10) on the real stack:
 * - silence on the default: a session that follows its project's default shows no marker and no extra words;
 * - Only me under a default-on project shows a 12 px lock, a session shared with a team a people icon, a personal
 *   repository's Only me a lock; each row link says it to screen readers, the desktop pointer gets a tooltip;
 * - sessions on two repositories linked to one team project sort together under its name; an unlinked one keeps its
 *   repository; the home page's recent sessions show the same marker.
 * The audience is set with the guarded superuser (the visibility API and its UI come in 06 and 10); the API computes
 * `differsFromDefault`, the web only words it.
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

/**
 * axe on a region minus pre-existing findings this plan must not restyle (logged as broken-window candidates in
 * 07.9-09-SUMMARY): the active rows' branch line (`text-muted-foreground/80` at 11.5 px, 3.5:1) and the home rows'
 * green status chip (2.6:1). Everything this plan adds is inside the checked regions.
 */
async function axeWithout(page: Page, include: string, exclude: readonly string[]) {
  const AxeBuilder = (await import("@axe-core/playwright")).default;
  let builder = new AxeBuilder({ page }).include(include);
  for (const e of exclude) builder = builder.exclude(e);
  const result = await builder.analyze();
  const serious = result.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(serious, `serious or critical axe violations in ${include}`).toEqual([]);
}
const sidebarAxe = (page: Page) =>
  axeWithout(page, '[data-testid="session-list"]', ['[data-testid="row-branch"]']);

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
    const web = await post<{ id: string }>("/api/v1/units", {
      kind: "team",
      name: `Web ${run}`,
      parentId: eng.id,
    });
    const design = await post<{ id: string }>("/api/v1/units", {
      kind: "team",
      name: `Design ${run}`,
      parentId: eng.id,
    });
    const portalName = `Portal ${run}`;
    const portal = await post<{ id: string }>("/api/v1/work-projects", {
      name: portalName,
      parentId: web.id,
    });
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
    await startSession(repoA.projectId, T.plain);
    const mine = await startSession(repoA.projectId, T.mine);
    const team = await startSession(repoA.projectId, T.team);
    const scratch = await startSession(repoC.projectId, T.scratch);
    await startSession(repoB.projectId, T.api);
    await setAudience(mine, "owner");
    await setAudience(team, "teams", design.id);
    await setAudience(scratch, "owner");

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

    // ---- silence on the default; one icon and a spoken suffix otherwise
    const plain = rowOf(list, T.plain);
    await expect(plain.getByTestId("visibility-marker")).toHaveCount(0);
    await expect(plain.locator(".sr-only")).toHaveCount(0);
    await expect(rowOf(list, T.api).getByTestId("visibility-marker")).toHaveCount(0);

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

    // ---- grouping: both linked repositories show the team project and sit together; the personal one its repo
    for (const title of [T.plain, T.mine, T.team, T.api])
      await expect(rowOf(list, title).getByTestId("row-project")).toHaveText(portalName);
    await expect(rowOf(list, T.scratch).getByTestId("row-project")).toHaveText(`mk-scratch-${tag}`);
    const ours = new Set(Object.values(T));
    const order = (
      await list.getByTestId("session-row").evaluateAll((rows) =>
        rows.map((r) => ({
          title: r.querySelector('[data-testid="row-title"]')?.textContent ?? "",
          project: r.querySelector('[data-testid="row-project"]')?.textContent ?? "",
        })),
      )
    ).filter((r) => ours.has(r.title));
    expect(order).toHaveLength(5);
    const portalAt = order.flatMap((r, i) => (r.project === portalName ? [i] : []));
    expect(portalAt).toHaveLength(4);
    expect((portalAt.at(-1) ?? 0) - (portalAt[0] ?? 0)).toBe(3);

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
    await axeWithout(page, "main section", ['[data-testid="session-status"]']);
    await expectNoSidewaysScroll(page, "home");
    await captureReview(page, `09-home-markers-${tag}`);
  } finally {
    for (const id of sessionIds) {
      await adminApi
        .post(`${API_URL}/api/v1/work-sessions/${id}/archive`, { data: {} })
        .catch(() => undefined);
    }
    for (const d of devices) await d.stop();
    await adminApi.dispose();
  }
});
