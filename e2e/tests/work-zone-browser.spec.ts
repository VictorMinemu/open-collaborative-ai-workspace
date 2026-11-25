import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs } from "../support/actors";
import { captureReview, expectTouchTargets } from "../support/layout";
import {
  clearWorkSignIns,
  FIXTURE_LOGIN,
  LOGIN_LAYOUT,
  type LoginSite,
  preseedBrowser,
  setBrowserPolicy,
  startLoginSite,
  tapWorkLive,
  workSignInsOf,
} from "../support/work-zone-browser";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import { ADMIN } from "./env";

/**
 * 07.13-22 Task 3 (D-31; WZB-01, WZB-04, WZB-05, WZB-07 … WZB-11): the Work Zone browser end to end with the REAL
 * daemon (fake runtime, PD-28 `browser <tool> <json>` lines), the REAL pinned headless shell on the device and a local
 * fixture site with a login form (`startLoginSite`). The admin allows the browser in Settings › Work Zone policy; the
 * device's owner (the admin) opts the device in (`OCW_ALLOW_BROWSER`) and lets Mara use it. Mara's agent opens the
 * site's localhost page and she watches it live in the Browser tab; the agent asks her to sign in; she presses "Open
 * and sign in", types the fixture credentials on the device's page (the device's owner sees "private" meanwhile) and
 * hands back with "Done, save my sign-in". A new session on the same device loads the sign-in and reaches the signed-in
 * page; once Noor may use the device too, Noor's turn reads the page signed out; Mara revokes it in Settings › Keychain
 * › Work Zone and a new session is signed out again. Desktop (1440, side panel) and mobile (390, the sheet from the
 * session menu), with light and dark captures and axe on the Browser tab, the sign-in card and the Keychain section.
 *
 * Retry-safe: the policy and Mara's sign-ins are reset at the start, the device and its project carry the retry number,
 * and the policy goes back off at the end. Runs in CI only (the device downloads nothing: `preseedBrowser`).
 */

test.describe.configure({ mode: "serial" });

// Fake members of the e2e stack only; their passwords are assembled at run time (no credential literal in the repo).
const MARA: Actor = {
  name: "Mara Wells",
  email: "mara.wzb@ocw.test",
  password: ["mara", "e2e", "password", "123"].join("-"),
};
const NOOR: Actor = {
  name: "Noor Haddad",
  email: "noor.wzb@ocw.test",
  password: ["noor", "e2e", "password", "123"].join("-"),
};
const REASON = "to read your account";
/** The device's first open launches Chromium: generous, but bounded. */
const COLD = 90_000;
const TURN = 45_000;

let admin: APIRequestContext;
let mara: APIRequestContext;
let noor: APIRequestContext;
let maraId: string;
let noorId: string;
let site: LoginSite;

test.beforeAll(async () => {
  // Once per worker: the pinned build into the shared cache (a no-op when CI pre-seeded it).
  test.setTimeout(12 * 60_000);
  await preseedBrowser();
  admin = await apiAs(ADMIN);
  maraId = await ensureMember(admin, MARA, "developer");
  noorId = await ensureMember(admin, NOOR, "developer");
  mara = await apiAs(MARA);
  noor = await apiAs(NOOR);
  site = await startLoginSite();
});

test.afterAll(async () => {
  await setBrowserPolicy(admin, false).catch(() => undefined);
  await clearWorkSignIns(mara).catch(() => undefined);
  await site?.close();
  await noor?.dispose();
  await mara?.dispose();
  await admin?.dispose();
});

/** Axe on `selector` in light and dark (the shared gate: serious and critical violations fail). */
async function axeBothThemes(page: Page, selector: string): Promise<void> {
  await expectNoSeriousA11y(page, selector);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectNoSeriousA11y(page, selector);
  await page.emulateMedia({ colorScheme: "light" });
}

/** A plan-mode session of `who` on the device (the fake asks nothing before its browser lines), with `prompt`. */
async function newSession(who: APIRequestContext, projectId: string, title: string, prompt?: string) {
  const res = await who.post("/api/v1/work-sessions", {
    data: { projectId, runtime: "claude-code", permissionMode: "plan", title, ...(prompt ? { prompt } : {}) },
  });
  expect(res.ok(), `start ${title}: ${await res.text()}`).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

async function promptAs(who: APIRequestContext, sessionId: string, body: string): Promise<void> {
  const res = await who.post(`/api/v1/work-sessions/${sessionId}/prompts`, { data: { body } });
  expect(res.ok(), `prompt ${sessionId}: ${await res.text()}`).toBe(true);
}

const line = (tool: string, args: Record<string, unknown>) => `browser ${tool} ${JSON.stringify(args)}`;

/** The fake's answer of a turn with browser lines (`Browser:` then one line per call). */
const browserAnswer = (page: Page, has: RegExp) =>
  page.getByTestId("assistant-message").filter({ hasText: "Browser:" }).filter({ hasText: has }).last();

async function idle(page: Page, timeout = TURN): Promise<void> {
  await expect(page.getByTestId("session-view")).toHaveAttribute("data-status", "idle", { timeout });
}

/** Opens the session's Browser tab: the side panel at ≥ 1280, the session menu's Browser item (a sheet) on a phone. */
async function openBrowserTab(page: Page, mobile: boolean): Promise<Locator> {
  if (mobile) {
    await page.getByRole("button", { name: "Session actions" }).click();
    await page.getByTestId("open-browser").click();
  } else {
    const tab = page.getByTestId("tab-browser");
    await expect(tab).toBeVisible({ timeout: 30_000 });
    if ((await tab.getAttribute("aria-pressed")) !== "true") await tab.click();
    await expect(page.locator('[data-testid="session-panel"][data-panel="browser"]')).toBeVisible();
  }
  const panel = page.getByTestId("work-live-panel");
  await expect(panel).toBeVisible();
  return panel;
}

/** Closes the phone's sheet (the side panel stays: it never covers the session). */
async function closeBrowserSheet(page: Page, mobile: boolean): Promise<void> {
  if (!mobile) return;
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("work-live-panel")).toHaveCount(0);
}

/** The point on screen where the live frame draws page CSS pixel `p` (the image's box over its natural size). */
async function onFrame(frame: Locator, p: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const img = frame.locator("img").first();
  await expect
    .poll(async () => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 20_000 })
    .toBeGreaterThan(0);
  return img.evaluate(
    (el, at) => {
      const i = el as HTMLImageElement;
      const r = i.getBoundingClientRect();
      return {
        x: r.left + (at.x * r.width) / i.naturalWidth,
        y: r.top + (at.y * r.height) / i.naturalHeight,
      };
    },
    { x: p.x, y: p.y },
  );
}

/**
 * Mara signs in on the device's page: a tap or click on the username field, then the keyboard (the frame has it on a
 * desktop; on a phone the keyboard input does, after Show keyboard): username, Tab, password, Enter.
 */
async function typeSignIn(page: Page, mobile: boolean): Promise<void> {
  const frame = page.locator('[data-testid="work-live-frame"][data-controlling="true"]');
  await expect(frame).toBeVisible({ timeout: 20_000 });
  const at = await onFrame(frame, LOGIN_LAYOUT.username);
  if (mobile) {
    await page.touchscreen.tap(at.x, at.y);
    await page.getByTestId("work-live-show-keyboard").click();
    await expect(page.getByTestId("work-live-soft-input")).toBeFocused();
  } else {
    await page.mouse.click(at.x, at.y);
    await frame.focus();
  }
  await page.waitForTimeout(250);
  await page.keyboard.type(FIXTURE_LOGIN.username, { delay: 30 });
  await page.keyboard.press("Tab");
  await page.keyboard.type(FIXTURE_LOGIN.password, { delay: 30 });
  await page.keyboard.press("Enter");
}

async function signedInAs(browser: Browser, who: Actor, project: string, open: BrowserContext[]) {
  const s = await openAs(browser, who, project);
  open.push(s.context);
  return s.page;
}

test.describe("work zone browser", () => {
  test("D-31: allow → watch live → sign in by taking control → a new session is signed in → another member's turn is not → revoke ends it", async ({
    browser,
  }, info) => {
    test.setTimeout(8 * 60_000);
    const project = info.project.name;
    const mobile = project === "mobile";
    const w = mobile ? "390" : "1440";
    const retry = info.retry ? `-r${info.retry}` : "";
    const open: BrowserContext[] = [];
    const sessions: string[] = [];
    let device: FakeDeviceHandle | null = null;

    // A clean start for this attempt: the policy off (the UI turns it on), no sign-in of Mara's left.
    await setBrowserPolicy(admin, false);
    await clearWorkSignIns(mara);

    try {
      // ---- 1. The admin allows the browser; the device's owner opts the device in and lets Mara use it.
      const boss = await signedInAs(browser, ADMIN, project, open);
      await boss.goto(`${BASE_URL}/settings/work-zone-policy`);
      const form = boss.getByTestId("work-zone-policy-settings");
      await expect(form).toBeVisible();
      const allow = form.getByTestId("allow-browser");
      await expect(allow).not.toBeChecked();
      await allow.click();
      await expect(allow).toBeChecked();
      await form.getByTestId("save-policy").click();
      await expect
        .poll(
          async () =>
            ((await (await admin.get("/api/v1/work-zone-policy")).json()) as { allowBrowser?: boolean })
              .allowBrowser,
          { timeout: 15_000, message: "the policy allows the browser" },
        )
        .toBe(true);

      device = await startFakeDevice(admin, {
        name: `E2E Browser ${w}${retry}`,
        projectName: `wzb-${w}${retry}`,
        browser: true,
      });
      const granted = await admin.put(`/api/v1/devices/${device.deviceId}/grants/user/${maraId}`, {
        data: { maxMode: "default" },
      });
      expect(granted.ok(), `share the device with Mara: ${await granted.text()}`).toBe(true);

      // ---- 2. Mara's agent opens the site; she watches the page live in the Browser tab.
      const first = await newSession(mara, device.projectId, `Browser ${w}${retry}`);
      sessions.push(first);
      const page = await signedInAs(browser, MARA, project, open);
      const tap = tapWorkLive(page);
      await page.goto(`${BASE_URL}/work-zone/${first}`);
      await idle(page);
      await page
        .getByTestId("composer")
        .fill([line("open", { url: site.url("/") }), line("snapshot", { expect: "Fixture app" })].join("\n"));
      await page.getByTestId("send-prompt").click();
      await expect(
        page
          .getByTestId("tool-card")
          .filter({ hasText: `Opened ${site.host}` })
          .first(),
      ).toBeVisible({
        timeout: COLD,
      });
      await expect(browserAnswer(page, /Contains .Fixture app.: yes/)).toBeVisible({ timeout: TURN });
      await idle(page);

      const panel = await openBrowserTab(page, mobile);
      await expect(panel).toHaveAttribute("data-state", "live", { timeout: 20_000 });
      await expect(panel.getByTestId("work-live-host")).toContainText(site.host);
      await expect(panel.getByTestId("work-live-frame").locator("img")).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(() => tap.binary(), { timeout: 20_000, message: "live JPEG frames arrive" })
        .toBeGreaterThan(0);
      await axeBothThemes(page, '[data-testid="work-live-panel"]');
      await expectTouchTargets(page, '[data-testid="work-live-panel"]');
      await captureReview(page, `wz-browser-live-${w}`);
      await closeBrowserSheet(page, mobile);

      // ---- 3. The agent asks Mara to sign in; she takes control from the card, types and saves her sign-in.
      await promptAs(
        mara,
        first,
        [line("open", { url: site.url("/login") }), line("signin", { host: site.host, reason: REASON })].join(
          "\n",
        ),
      );
      const banner = page.locator('[data-testid="approval-banner"][data-kind="signin"]');
      await expect(banner).toBeVisible({ timeout: TURN });
      await expect(banner.getByTestId("work-signin-card")).toContainText(site.host);
      await expect(banner.getByTestId("work-signin-why")).toContainText(REASON);
      await axeBothThemes(page, '[data-testid="approval-banner"]');
      await expectTouchTargets(page, '[data-testid="approval-banner"]');
      await captureReview(page, `wz-browser-signin-card-${w}`);

      // The device's owner sees the request as Mara's to answer.
      await boss.goto(`${BASE_URL}/work-zone/${first}`);
      await expect(boss.getByTestId("work-signin-only")).toBeVisible({ timeout: 20_000 });

      await banner.getByTestId("work-signin-open").click();
      const controlling = page.getByTestId("work-live-panel");
      await expect(controlling).toHaveAttribute("data-state", "controlling", { timeout: 20_000 });
      await expect(page.getByTestId("work-live-device-lines")).toBeVisible();

      // While Mara is in control the owner's Browser tab is private.
      const ownerPanel = await openBrowserTab(boss, mobile);
      await expect(ownerPanel).toHaveAttribute("data-state", "private", { timeout: 20_000 });
      await axeBothThemes(boss, '[data-testid="work-live-panel"]');
      await captureReview(boss, `wz-browser-private-${w}`);
      await closeBrowserSheet(boss, mobile);

      await typeSignIn(page, mobile);
      await expect
        .poll(() => site.lastLogin(), { timeout: 20_000, message: "the site received what Mara typed" })
        .toEqual(FIXTURE_LOGIN);
      await expect.poll(() => site.signedInViews(), { timeout: 20_000 }).toBeGreaterThan(0);
      await axeBothThemes(page, '[data-testid="work-live-panel"]');
      await expectTouchTargets(page, '[data-testid="work-live-panel"]');
      await captureReview(page, `wz-browser-controlling-${w}`);

      await page.getByTestId("work-live-save").click();
      await expect
        .poll(async () => (await workSignInsOf(mara)).find((s) => s.site === site.host)?.status, {
          timeout: 20_000,
          message: "Mara's sign-in is saved",
        })
        .toBe("active");
      await expect(banner).toHaveCount(0, { timeout: 20_000 });
      await expect(
        browserAnswer(page, new RegExp(`Sign-in on ${site.host.replaceAll(".", "\\.")}`)),
      ).toBeVisible({
        timeout: TURN,
      });
      await expect(page.getByTestId("approval-line").last()).toHaveAttribute("data-status", "approved");
      await idle(page);
      // Nothing Mara typed is on any page of the app.
      for (const p of [page, boss]) {
        const html = await p.content();
        expect(html).not.toContain(FIXTURE_LOGIN.password);
      }

      // ---- 4. A new session on the same device loads it and reaches the signed-in page.
      const account = [
        line("open", { url: site.url("/account") }),
        line("snapshot", { expect: "Signed in as fixture-user" }),
      ].join("\n");
      const second = await newSession(mara, device.projectId, `Signed in ${w}${retry}`, account);
      sessions.push(second);
      await page.goto(`${BASE_URL}/work-zone/${second}`);
      await expect(browserAnswer(page, /Signed in: yes/)).toBeVisible({ timeout: COLD });
      await expect(browserAnswer(page, /Contains .Signed in as fixture-user.: yes/)).toBeVisible();
      await idle(page);

      // ---- 5. Noor may use the device too: the session is no longer Mara's alone, so Noor's turn reads it signed out.
      const shared = await admin.put(`/api/v1/devices/${device.deviceId}/grants/user/${noorId}`, {
        data: { maxMode: "default" },
      });
      expect(shared.ok(), `share the device with Noor: ${await shared.text()}`).toBe(true);
      await promptAs(noor, second, account);
      await expect(browserAnswer(page, /Signed in: no/)).toBeVisible({ timeout: TURN });
      await expect(browserAnswer(page, /Contains .Signed in as fixture-user.: no/)).toBeVisible();
      await idle(page);
      const unshared = await admin.delete(`/api/v1/devices/${device.deviceId}/grants/user/${noorId}`);
      expect(unshared.ok(), `Noor no longer uses the device: ${await unshared.text()}`).toBe(true);

      // ---- 6. Mara revokes the sign-in in Settings › Keychain › Work Zone; a new session is signed out.
      const saved = (await workSignInsOf(mara)).find((s) => s.site === site.host);
      expect(saved, "the saved sign-in").toBeTruthy();
      await page.goto(`${BASE_URL}/settings/keychain`);
      const section = page.getByTestId("work-zone-signins");
      const row = section.getByTestId(`work-signin-row-${saved?.id}`);
      await expect(row).toBeVisible({ timeout: 20_000 });
      await expect(row).toContainText(site.host);
      await section.evaluate((el) => el.scrollIntoView({ block: "start" }));
      await axeBothThemes(page, '[data-testid="work-zone-signins"]');
      await expectTouchTargets(page, '[data-testid="work-zone-signins"]');
      await captureReview(page, `wz-browser-keychain-${w}`);
      await row.getByTestId("work-signin-revoke").click();
      await page.getByTestId("work-signin-revoke-confirm").click();
      await expect(row).toHaveCount(0, { timeout: 15_000 });
      expect((await workSignInsOf(mara)).filter((s) => s.site === site.host)).toEqual([]);

      const third = await newSession(mara, device.projectId, `Revoked ${w}${retry}`, account);
      sessions.push(third);
      await page.goto(`${BASE_URL}/work-zone/${third}`);
      await expect(browserAnswer(page, /Signed in: no/)).toBeVisible({ timeout: COLD });
      await expect(browserAnswer(page, /Contains .Signed in as fixture-user.: no/)).toBeVisible();
      await idle(page);
    } finally {
      for (const c of open.splice(0)) await c.close().catch(() => undefined);
      for (const id of sessions)
        await mara.post(`/api/v1/work-sessions/${id}/archive`, { data: {} }).catch(() => undefined);
      await device?.stop();
      await setBrowserPolicy(admin, false).catch(() => undefined);
    }
  });
});
