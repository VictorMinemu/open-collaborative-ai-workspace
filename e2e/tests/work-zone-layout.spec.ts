import { expect, type Page, test } from "@playwright/test";
import { apiAs } from "../support/actors";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import { ADMIN, API_URL, shot } from "./env";

/**
 * The Work Zone session screen follows the owner's reference layout (`reference/ref-4-layout.png`, D-17), built
 * from today's data only, with the REAL daemon in fake-runtime mode:
 * - sidebar: active rows (project badge + name, "Working Ns" / "Needs approval", title, branch, diff stat),
 *   a collapsible "Settled" group with "Show N more", and a search box;
 * - stream: completed turns collapse behind "Worked for …" (items stay in the DOM), grouped tool calls, the final
 *   message with its time and a copy button, and a "N changed files +a −b · Open diff" card;
 * - the "1 agent working · View · Stop" bar above the composer and the worktree / diff stat / branch strip below.
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

async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

interface Listed {
  id: string;
  title: string;
  status: string;
}

test("Work Zone layout (ref-4): sidebar rows and groups, collapsible turns, changes card, agent bar and footer strip", async ({
  page,
}, info) => {
  test.setTimeout(300_000);
  const mobile = info.project.name === "mobile";
  const tag = mobile ? "390" : "1440";
  const adminApi = await apiAs(ADMIN);
  let device: FakeDeviceHandle | null = null;
  let settledDevice: FakeDeviceHandle | null = null;
  const sessionIds: string[] = [];

  /** The session list lives in the navigation drawer on a phone. */
  const openSidebar = async () => {
    if (mobile) await page.getByTestId("mobile-nav-trigger").click();
    await expect(page.getByTestId("session-list")).toBeVisible();
  };
  const closeSidebar = async () => {
    if (!mobile) return;
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("session-list")).toBeHidden();
  };

  try {
    // ---- 12 settled sessions: their device shuts down, so each one ends ("completed") and stays listed
    settledDevice = await startFakeDevice(adminApi, {
      name: `E2E Settled ${tag}`,
      projectName: `settled-${tag}`,
    });
    for (let i = 1; i <= 12; i++) {
      const r = await adminApi.post("/api/v1/work-sessions", {
        data: {
          projectId: settledDevice.projectId,
          runtime: "claude-code",
          permissionMode: "plan",
          title: `Settled ${tag} #${i}`,
        },
      });
      expect(r.ok(), await r.text()).toBe(true);
      sessionIds.push(((await r.json()) as { id: string }).id);
    }
    const settledIds = [...sessionIds];
    const listed = async () =>
      ((await (await adminApi.get("/api/v1/work-sessions")).json()) as { sessions: Listed[] }).sessions;
    await expect
      .poll(async () => (await listed()).filter((s) => settledIds.includes(s.id) && s.status === "idle").length, {
        timeout: 30_000,
        message: "the settled sessions start",
      })
      .toBe(12);
    await settledDevice.shutdown();
    await expect
      .poll(
        async () => (await listed()).filter((s) => settledIds.includes(s.id) && s.status === "completed").length,
        { timeout: 30_000, message: "the settled sessions end when their device shuts down" },
      )
      .toBe(12);

    // ---- the live session: Supervised, so the fake asks before writing; slow enough to watch "Working"
    device = await startFakeDevice(adminApi, {
      name: `E2E Layout ${tag}`,
      projectName: `layout-${tag}`,
      env: { OCW_RUNTIME_FAKE_DELAY_MS: "900" },
    });
    const created = await adminApi.post("/api/v1/work-sessions", {
      data: {
        projectId: device.projectId,
        runtime: "claude-code",
        permissionMode: "default",
        title: `Layout ${tag}`,
        prompt: "Add a short CONTRIBUTING guide for new teammates",
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const sessionId = ((await created.json()) as { id: string }).id;
    sessionIds.push(sessionId);

    await signIn(page);
    await page.goto(`/work-zone/${sessionId}`);
    const view = page.getByTestId("session-view");
    await expect(view).toBeVisible();

    // ---- sidebar row while the device works: badge, project, "Working Ns", title
    await openSidebar();
    const row = page.getByTestId("session-row").filter({ hasText: `Layout ${tag}` });
    await expect(row).toBeVisible();
    await expect(row.getByTestId("row-project")).toContainText(`layout-${tag}`);
    await expect(row.getByTestId("row-project-badge")).toHaveText("LA");
    await expect(row.getByTestId("row-status")).toHaveText(/^Working \d+[sm]$/, { timeout: 30_000 });
    await expect(row.getByTestId("row-title")).toHaveText(`Layout ${tag}`);
    await closeSidebar();

    // ---- the agent bar floats above the composer while the runtime works; the composer has no stop button
    const bar = page.getByTestId("agent-bar");
    await expect(bar).toBeVisible();
    await expect(bar).toContainText(/1 agent working|Waiting for approval/);
    await expect(page.getByTestId("composer-controls").getByTestId("interrupt")).toHaveCount(0);

    // ---- approval: the row reads "Needs approval" in the warning tone
    const banner = page.getByTestId("approval-banner");
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(bar).toContainText("Waiting for approval");
    await openSidebar();
    await expect(row.getByTestId("row-status")).toHaveText("Needs approval");
    await expect(row.getByTestId("row-status")).toHaveAttribute("data-tone", "warning");
    await closeSidebar();
    await banner.getByTestId("approve-once").click();
    await expect(view).toHaveAttribute("data-status", "idle", { timeout: 60_000 });
    await expect(bar).toHaveCount(0);

    // ---- after the turn: branch and diff stat on the row and in the footer strip
    await openSidebar();
    await expect(row.getByTestId("row-diffstat")).toHaveText(/^\+\d+/, { timeout: 20_000 });
    await expect(row.getByTestId("row-branch")).toHaveText("main");
    await expect(row.getByTestId("row-status")).not.toContainText("Working");

    // ---- Settled: collapsible, 10 rows then "Show N more"; the search filters by title or project
    const settled = page.getByTestId("settled-group");
    await expect(settled).toBeVisible();
    const search = page.getByTestId("session-search");
    await search.fill(`Settled ${tag}`);
    await expect(page.getByTestId("session-row").filter({ hasText: `Layout ${tag}` })).toHaveCount(0);
    await expect(settled.getByTestId("session-row")).toHaveCount(10);
    await expect(settled.getByTestId("settled-more")).toHaveText("Show 2 more");
    await bothThemes(page, `wz-session-sidebar-${tag}`);
    await settled.getByTestId("settled-more").click();
    await expect(settled.getByTestId("session-row")).toHaveCount(12);
    await settled.getByTestId("settled-toggle").click();
    await expect(settled.getByTestId("session-row")).toHaveCount(0);
    await settled.getByTestId("settled-toggle").click();
    await search.fill(`layout-${tag}`);
    await expect(page.getByTestId("session-row")).toHaveCount(1);
    await expect(page.getByTestId("session-row")).toContainText(`Layout ${tag}`);
    await search.fill("");
    if (!mobile) await bothThemes(page, `wz-session-sidebar-active-${tag}`);
    await closeSidebar();

    // ---- second turn, allowed for the whole session
    await page.getByTestId("composer").fill("Then add a changelog entry for the guide");
    await page.getByTestId("send-prompt").click();
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await banner.getByTestId("allow-session").click();
    await expect(view).toHaveAttribute("data-status", "idle", { timeout: 60_000 });

    // ---- stream: both turns collapse behind "Worked for …"; the final answers stay visible with time + copy
    const summaries = page.getByTestId("turn-summary");
    await expect(summaries).toHaveCount(2);
    for (const i of [0, 1]) await expect(summaries.nth(i)).toHaveText(/^Worked for (\d+m )?\d+s/);
    await expect(page.getByTestId("prompt-bubble")).toHaveCount(2);
    const intro = page.getByTestId("assistant-message").filter({ hasText: "start by reading" });
    await expect(intro).toHaveCount(2);
    await expect(intro.first()).toBeHidden();
    await expect(page.getByTestId("assistant-message").last()).toContainText("Done");
    await expect(page.getByTestId("assistant-message").last()).toBeVisible();
    await expect(page.getByTestId("copy-message")).toHaveCount(2);
    await expect(page.getByTestId("message-time").last()).toHaveText(/^\d{2}:\d{2}$/);
    // Collapsed turns keep their tool cards in the DOM.
    await expect(page.getByTestId("tool-card")).toHaveCount(4);
    await summaries.first().click();
    await expect(intro.first()).toBeVisible();
    const group = page.getByTestId("tool-group").first();
    await expect(group).toBeVisible();
    await expect(group).toContainText("2 tool calls");
    await summaries.first().click();
    await expect(intro.first()).toBeHidden();

    // ---- the changes card after the latest turn; Open diff opens the existing Changes panel
    const card = page.getByTestId("changes-card");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("2 changed files", { timeout: 20_000 });
    await expect(card).toContainText("notes");
    await expect(page.getByTestId("full-access-badge")).toHaveCount(0);
    await bothThemes(page, `wz-session-stream-${tag}`);
    await card.getByTestId("open-diff").click();
    await expect(page.getByTestId("file-diff").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("changed-file")).toHaveCount(2);
    if (mobile) {
      await page.keyboard.press("Escape");
    } else {
      await bothThemes(page, `wz-session-diff-${tag}`);
      await page.getByTestId("tab-changes").click();
    }
    await expect(page.getByTestId("file-diff")).toHaveCount(0);

    // ---- footer strip: Local, diff stat and branch
    const footer = page.getByTestId("session-footer");
    await expect(footer).toContainText("Local");
    await expect(footer).toContainText("main");
    await expect(footer.getByTestId("footer-diffstat")).toHaveText(/^\+\d+ −\d+$/);
    await bothThemes(page, `wz-session-idle-${tag}`);

    // ---- a third turn: the bar's Stop interrupts it (same permission and mutation as before)
    await page.getByTestId("composer").fill("And a short FAQ");
    await page.getByTestId("send-prompt").click();
    await expect(bar).toContainText("1 agent working", { timeout: 30_000 });
    await bothThemes(page, `wz-session-running-${tag}`);
    await bar.getByRole("button", { name: "View" }).click();
    await bar.getByTestId("interrupt").click();
    await expect(view).toHaveAttribute("data-status", "idle", { timeout: 30_000 });
    await expect(bar).toHaveCount(0);
    await expect(summaries).toHaveCount(3);
    await expect(summaries.nth(2)).toContainText("Interrupted");
    const detail = (await (await adminApi.get(`/api/v1/work-sessions/${sessionId}`)).json()) as {
      prompts: Array<{ body: string; status: string }>;
    };
    expect(detail.prompts.find((p) => p.body === "And a short FAQ")?.status).toBe("cancelled");
  } finally {
    for (const id of sessionIds) {
      await adminApi.post(`${API_URL}/api/v1/work-sessions/${id}/archive`, { data: {} }).catch(() => undefined);
    }
    await device?.stop();
    await settledDevice?.stop();
    await adminApi.dispose();
  }
});
