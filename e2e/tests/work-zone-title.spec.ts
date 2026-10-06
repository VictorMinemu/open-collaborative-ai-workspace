import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import { ADMIN } from "./env";

/**
 * Automatic session titles (Phase 03.2 Plan 12, D-18 … D-20, WZC-07) with the REAL daemon in fake-runtime mode:
 * an untitled session's first prompt comes back from the device as a short title, live in the sidebar row, the
 * breadcrumb and the browser tab of every controller; a typed title is never replaced.
 */

test.describe.configure({ mode: "serial" });

const PROMPT = "Please fix the login redirect bug on the settings page when the session expires";
const AUTO = "Fix login redirect bug settings page";

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

async function createSession(api: APIRequestContext, data: Record<string, unknown>): Promise<string> {
  const res = await api.post("/api/v1/work-sessions", { data: { runtime: "claude-code", ...data } });
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

interface Detail {
  session: { title: string; titleSource: string };
  prompts: Array<{ status: string }>;
}

async function detail(api: APIRequestContext, id: string): Promise<Detail> {
  const res = await api.get(`/api/v1/work-sessions/${id}`);
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as Detail;
}

/** The session's sidebar row (in the navigation drawer on a phone). */
function sessionRow(page: Page, id: string) {
  return page.locator(`a[data-testid="session-row"][href="/work-zone/${id}"]`);
}

async function withSidebar(page: Page, mobile: boolean, fn: () => Promise<void>) {
  if (mobile) await page.getByTestId("mobile-nav-trigger").click();
  await expect(page.getByTestId("session-list")).toBeVisible();
  await fn();
  if (mobile) {
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("session-list")).toBeHidden();
  }
}

test("automatic title: the first prompt comes back as a short title, live for every controller; a typed title stays", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(240_000);
  const mobile = info.project.name === "mobile";
  const tag = mobile ? "390" : "1440";
  const adminApi = await apiAs(ADMIN);
  await ensureMember(adminApi, SAM, "developer");
  let device: FakeDeviceHandle | null = null;
  let sam: Awaited<ReturnType<typeof openAs>> | null = null;

  try {
    device = await startFakeDevice(adminApi, {
      name: `E2E Title ${tag}`,
      projectName: `title-${tag}`,
      env: { OCW_RUNTIME_FAKE_DELAY_MS: "600" },
    });

    // ---- both controllers are on /work-zone BEFORE the session exists; a window marker proves no reload
    await signIn(page);
    await page.goto("/work-zone");
    sam = await openAs(browser, SAM, info.project.name);
    await sam.page.goto(`${BASE_URL}/work-zone`);
    const pages = [page, sam.page];
    for (const p of pages) {
      await p.evaluate(() => {
        (window as unknown as { __ocwTitleMarker?: string }).__ocwTitleMarker = "kept";
      });
    }

    // Plan mode: the fake never asks for approval, so the first turn runs straight through.
    const id = await createSession(adminApi, {
      projectId: device.projectId,
      permissionMode: "plan",
      prompt: PROMPT,
    });

    for (const p of pages) {
      await withSidebar(p, mobile, async () => {
        await expect(sessionRow(p, id).getByTestId("row-title")).toHaveText(AUTO, { timeout: 30_000 });
      });
      expect(
        await p.evaluate(() => (window as unknown as { __ocwTitleMarker?: string }).__ocwTitleMarker),
      ).toBe("kept");
    }
    expect((await detail(adminApi, id)).session).toMatchObject({ title: AUTO, titleSource: "auto" });

    // ---- the session header (breadcrumb) and the browser tab
    for (const p of pages) {
      await p.goto(`${BASE_URL}/work-zone/${id}`);
      await expect(p.getByTestId("session-title")).toHaveText(AUTO);
      await expect(p).toHaveTitle(`${AUTO} · Work Zone`);
    }

    // ---- a typed title is never replaced, even after its first prompt completed
    const typed = await createSession(adminApi, {
      projectId: device.projectId,
      permissionMode: "plan",
      title: `Typed ${tag}`,
      prompt: PROMPT,
    });
    await expect
      .poll(async () => (await detail(adminApi, typed)).prompts[0]?.status, {
        timeout: 60_000,
        message: "the typed session's first prompt completes",
      })
      .toBe("completed");
    // The fake's title call takes 4 × 600 ms: wait past it before asserting nothing changed.
    await page.waitForTimeout(3_000);
    expect((await detail(adminApi, typed)).session).toMatchObject({
      title: `Typed ${tag}`,
      titleSource: "user",
    });
    await page.goto(`/work-zone/${typed}`);
    await expect(page.getByTestId("session-title")).toHaveText(`Typed ${tag}`);
    await expect(page).toHaveTitle(`Typed ${tag} · Work Zone`);
  } finally {
    await sam?.context.close();
    await device?.stop();
  }
});
