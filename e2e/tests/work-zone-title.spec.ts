import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import { ADMIN, shot } from "./env";

/**
 * Automatic session titles (Phase 03.2 Plan 12, D-18 … D-20, WZC-07) with the REAL daemon in fake-runtime mode:
 * an untitled session's first prompt comes back from the device as a short title, live in the sidebar row, the
 * breadcrumb and the browser tab of every controller; a typed title is never replaced. A session created empty
 * gets its title from its first prompt; when the org policy leaves the small model out, the first line stays; and
 * both fit the sidebar row, the breadcrumb and the page at 1440 and 390, light and dark (`wz-title-*`).
 */

test.describe.configure({ mode: "serial" });

const PROMPT = "Please fix the login redirect bug on the settings page when the session expires";
const AUTO = "Fix login redirect bug settings";

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

/** Width of an element's text box against its own box, and how it overflows. */
function measure(page: Page, testId: string, scope?: ReturnType<Page["locator"]>) {
  const loc = (scope ?? page).getByTestId(testId).first();
  return loc.evaluate((el) => {
    const contentWidth = (e: Element) => {
      const cs = getComputedStyle(e);
      const edges = ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"] as const;
      return e.getBoundingClientRect().width - edges.reduce((sum, k) => sum + Number.parseFloat(cs[k]), 0);
    };
    const range = document.createRange();
    range.selectNodeContents(el);
    return {
      scroll: el.scrollWidth,
      client: el.clientWidth,
      box: contentWidth(el),
      /** The text's own width, even when the box clips it (scrollWidth never drops below clientWidth). */
      textWidth: range.getBoundingClientRect().width,
      textOverflow: getComputedStyle(el).textOverflow,
      title: el.getAttribute("title"),
    };
  });
}

/**
 * Whether each text would fit, untruncated, in the element's box: a hidden clone of the element (same classes, same
 * parent, so the same font and width) carries the text and is measured, then removed.
 */
function fitsLike(loc: ReturnType<Page["locator"]>, texts: string[]) {
  return loc.evaluate((el, ts) => {
    const contentWidth = (e: Element) => {
      const cs = getComputedStyle(e);
      const edges = ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"] as const;
      return e.getBoundingClientRect().width - edges.reduce((sum, k) => sum + Number.parseFloat(cs[k]), 0);
    };
    return ts.map((t) => {
      const probe = el.cloneNode(false) as HTMLElement;
      probe.textContent = t;
      probe.style.visibility = "hidden";
      el.parentElement!.appendChild(probe);
      const range = document.createRange();
      range.selectNodeContents(probe);
      const fit = {
        text: t,
        scroll: probe.scrollWidth,
        client: probe.clientWidth,
        box: contentWidth(probe),
        textWidth: range.getBoundingClientRect().width,
      };
      probe.remove();
      return fit;
    });
  }, texts);
}

/** The two recorded fixture titles as stored today: 32 and 31 characters, the longest the shape allows. */
const RECORDED_TITLES = ["Fix settings page login redirect", "Redirección de login al expirar"];

/**
 * Shown in full: the box does not scroll and the text's own width fits the box's content width (fractional pixels;
 * 0.5 px for sub-pixel layout, since clientWidth rounds and a content-sized box equals its text).
 */
function expectNotTruncated(
  m: { scroll: number; client: number; box: number; textWidth: number },
  message: string,
) {
  expect(m.client, `${message}: the box has a width`).toBeGreaterThan(100);
  expect(m.scroll, message).toBeLessThanOrEqual(m.client);
  expect(m.textWidth, message).toBeLessThanOrEqual(m.box + 0.5);
}

/** No horizontal page overflow. */
async function expectPageFits(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "no horizontal page overflow",
  ).toBe(true);
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

test("a session created without a prompt takes its title from the first prompt sent from the composer, live for both controllers", async ({
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
  const FIRST = "Add a dark mode toggle to the account settings page";
  const AUTO_DARK = "Add dark mode toggle account";

  try {
    // Slower fake: the first line is visible for ~4 s before the generated title replaces it.
    device = await startFakeDevice(adminApi, {
      name: `E2E Title Empty ${tag}`,
      projectName: `title-empty-${tag}`,
      env: { OCW_RUNTIME_FAKE_DELAY_MS: "1000" },
    });
    const id = await createSession(adminApi, { projectId: device.projectId, permissionMode: "plan" });
    const placeholder = `title-empty-${tag} · Claude Code`;
    expect((await detail(adminApi, id)).session).toMatchObject({
      title: placeholder,
      titleSource: "heuristic",
    });

    await signIn(page);
    await page.goto(`/work-zone/${id}`);
    await expect(page.getByTestId("session-view")).toHaveAttribute("data-status", "idle", {
      timeout: 30_000,
    });
    sam = await openAs(browser, SAM, info.project.name);
    await sam.page.goto(`${BASE_URL}/work-zone/${id}`);
    const pages = [page, sam.page];
    for (const p of pages) await expect(p.getByTestId("session-title")).toHaveText(placeholder);

    await page.getByTestId("composer").fill(FIRST);
    await page.getByTestId("send-prompt").click();
    for (const p of pages)
      await expect(p.getByTestId("session-title")).toHaveText(FIRST, { timeout: 15_000 });
    for (const p of pages) {
      await expect(p.getByTestId("session-title")).toHaveText(AUTO_DARK, { timeout: 30_000 });
      await expect(p).toHaveTitle(`${AUTO_DARK} · Work Zone`);
    }
    expect((await detail(adminApi, id)).session).toMatchObject({ title: AUTO_DARK, titleSource: "auto" });
  } finally {
    await sam?.context.close();
    await device?.stop();
  }
});

test("fallback and fit: a policy without haiku keeps the first line; titles fit the row, the breadcrumb and the page in both themes", async ({
  page,
}, info) => {
  test.setTimeout(300_000);
  const mobile = info.project.name === "mobile";
  const tag = mobile ? "390" : "1440";
  const adminApi = await apiAs(ADMIN);
  let device: FakeDeviceHandle | null = null;
  const LONG =
    "Investigate why the nightly export job sometimes writes duplicate rows into the analytics warehouse after a retry";
  const FALLBACK = `${LONG.slice(0, 77)}…`;
  const policy = (allowed: string[]) =>
    adminApi.put("/api/v1/work-zone-policy", {
      data: { allowedModels: { "claude-code": allowed, codex: [] } },
    });

  try {
    device = await startFakeDevice(adminApi, {
      name: `E2E Title Fit ${tag}`,
      projectName: `title-fit-${tag}`,
      env: { OCW_RUNTIME_FAKE_DELAY_MS: "300" },
    });
    // ---- the automatic title (sample prompt)
    const auto = await createSession(adminApi, {
      projectId: device.projectId,
      permissionMode: "plan",
      prompt: PROMPT,
    });
    await expect
      .poll(async () => (await detail(adminApi, auto)).session.titleSource, { timeout: 30_000 })
      .toBe("auto");

    // ---- policy fallback: the org allows only opus and sonnet for Claude Code
    expect(LONG.length).toBeGreaterThan(80); // 113 characters: cut to 77 + "…" by the first-line rule
    let fallback: string;
    try {
      const put = await policy(["opus", "sonnet"]);
      expect(put.ok(), await put.text()).toBe(true);
      fallback = await createSession(adminApi, {
        projectId: device.projectId,
        permissionMode: "plan",
        prompt: LONG,
      });
      await expect
        .poll(async () => (await detail(adminApi, fallback)).prompts[0]?.status, {
          timeout: 60_000,
          message: "the fallback session's first prompt completes",
        })
        .toBe("completed");
      await page.waitForTimeout(2_000); // past the fake's title time (4 × 300 ms): nothing may arrive
      expect((await detail(adminApi, fallback)).session).toMatchObject({
        title: FALLBACK,
        titleSource: "heuristic",
      });
    } finally {
      const restore = await policy([]);
      expect(restore.ok(), await restore.text()).toBe(true);
    }

    // ---- the automatic title fits: row, breadcrumb, page; full text in the title attribute
    await signIn(page);
    await page.goto(`/work-zone/${auto}`);
    await expect(page.getByTestId("session-title")).toHaveText(AUTO);
    await expect(page).toHaveTitle(`${AUTO} · Work Zone`);
    const header = await measure(page, "session-title");
    expect(header.title).toBe(AUTO);
    expectNotTruncated(header, `the breadcrumb title is not truncated at ${tag}`);
    if (!mobile) {
      const row = await measure(page, "row-title", sessionRow(page, auto));
      expect(row.title).toBe(AUTO);
      // D-20: a title of at most 32 characters fits the ref-4 sidebar row (~219 px) in full.
      expectNotTruncated(row, "the auto title is not truncated in its 1440 sidebar row");
      expect(row.client, "the row stays inside the 256 px sidebar").toBeLessThanOrEqual(240);
      for (const fit of await fitsLike(sessionRow(page, auto).getByTestId("row-title"), RECORDED_TITLES)) {
        expectNotTruncated(fit, `"${fit.text}" fits a 1440 sidebar row`);
      }
    }
    await expectPageFits(page);
    await bothThemes(page, `wz-title-${tag}`);
    if (mobile) {
      await page.getByTestId("mobile-nav-trigger").click();
      await expect(page.getByTestId("session-list")).toBeVisible();
      const row = await measure(page, "row-title", sessionRow(page, auto));
      expect(row.title).toBe(AUTO);
      expectNotTruncated(row, "the auto title is not truncated in the 390 drawer");
      for (const fit of await fitsLike(sessionRow(page, auto).getByTestId("row-title"), RECORDED_TITLES)) {
        expectNotTruncated(fit, `"${fit.text}" fits a 390 drawer row`);
      }
      await expectPageFits(page);
      await bothThemes(page, "wz-title-sidebar-390");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("session-list")).toBeHidden();
    }

    // ---- the fallback first line is cut with an ellipsis inside its row and header, never past the page
    await page.goto(`/work-zone/${fallback!}`);
    await expect(page.getByTestId("session-title")).toHaveText(FALLBACK);
    const fh = await measure(page, "session-title");
    expect(fh.title).toBe(FALLBACK);
    expect(fh.textOverflow).toBe("ellipsis");
    // The wide 1440 header shows all 78 characters; the phone header cuts them with the ellipsis.
    if (mobile) expect(fh.scroll, "the long header title is truncated at 390").toBeGreaterThan(fh.client);
    if (mobile) await page.getByTestId("mobile-nav-trigger").click();
    await expect(page.getByTestId("session-list")).toBeVisible();
    const fr = await measure(page, "row-title", sessionRow(page, fallback!));
    expect(fr.title).toBe(FALLBACK);
    expect(fr.textOverflow).toBe("ellipsis");
    expect(fr.scroll, "the long row title is truncated").toBeGreaterThan(fr.client);
    await expectPageFits(page);
    if (mobile) {
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("session-list")).toBeHidden();
    }
    await expectPageFits(page);
    await bothThemes(page, `wz-title-fallback-${tag}`);
  } finally {
    await device?.stop();
  }
});
