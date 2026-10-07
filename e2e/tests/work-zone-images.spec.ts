import {
  type APIRequestContext,
  type Browser,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { bothThemes, mockup } from "../support/files";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import { ADMIN } from "./env";

/**
 * Work Zone image attachments (06.1, WZ-IMG-01/03/04) with the REAL daemon in fake-runtime mode. Víctor pastes a
 * screenshot into a session's composer (a real Ctrl/Cmd+V of an `image/png` clipboard item), sends it, and Sam, a
 * second controller on the shared device, sees it on the prompt bubble live and opens it; the fake runtime's reply
 * lists the images it received (`Images: N (types)`, 06.1-03), which proves they reached the device.
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

/** Waits until an `<img>` decoded (natural width > 0). */
async function expectLoaded(img: Locator) {
  await expect
    .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 15_000 })
    .toBeGreaterThan(0);
}

/**
 * Puts `bytes` on the clipboard as an `image/png` item (what an OS screenshot copy leaves there) and pastes it into
 * `target` with the platform's shortcut: Cmd+V on macOS, Ctrl+V elsewhere.
 */
async function pasteScreenshot(page: Page, target: Locator, bytes: Buffer) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await target.click();
  await page.evaluate(async (b64) => {
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": new Blob([data], { type: "image/png" }) }),
    ]);
  }, bytes.toString("base64"));
  await page.keyboard.press("ControlOrMeta+V");
}

interface Setup {
  adminApi: APIRequestContext;
  device: FakeDeviceHandle | null;
  sessionId: string | null;
  sam: Awaited<ReturnType<typeof openAs>> | null;
}

/** A fresh fake device shared with Sam and a session on it; Víctor's and Sam's pages open it. */
async function openSession(
  page: Page,
  browser: Browser,
  project: string,
  s: Setup,
  opts: { name: string; runtime: "claude-code" | "codex"; mode: "plan" | "default" },
) {
  const samId = await ensureMember(s.adminApi, SAM, "developer");
  s.device = await startFakeDevice(s.adminApi, { name: `E2E ${opts.name}`, projectName: opts.name });
  const grant = await s.adminApi.put(`/api/v1/devices/${s.device.deviceId}/grants/user/${samId}`, {
    data: { maxMode: "acceptEdits" },
  });
  expect(grant.ok(), await grant.text()).toBe(true);
  const created = await s.adminApi.post("/api/v1/work-sessions", {
    data: {
      projectId: s.device.projectId,
      runtime: opts.runtime,
      permissionMode: opts.mode,
      title: `Images ${opts.name}`,
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  s.sessionId = ((await created.json()) as { id: string }).id;

  await signIn(page);
  await page.goto(`/work-zone/${s.sessionId}`);
  await expect(page.getByTestId("session-view")).toHaveAttribute("data-status", "idle", { timeout: 30_000 });
  s.sam = await openAs(browser, SAM, project);
  await s.sam.page.goto(`${BASE_URL}/work-zone/${s.sessionId}`);
  await expect(s.sam.page.getByTestId("session-view")).toBeVisible();
}

async function teardown(s: Setup) {
  await s.sam?.context.close();
  if (s.sessionId) await s.adminApi.post(`/api/v1/work-sessions/${s.sessionId}/archive`, { data: {} });
  await s.device?.stop();
  await s.adminApi.dispose();
}

test("Work Zone images: a pasted screenshot reaches the device and every controller sees it", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(240_000);
  const tag = info.project.name === "mobile" ? "390" : "1440";
  const s: Setup = { adminApi: await apiAs(ADMIN), device: null, sessionId: null, sam: null };
  try {
    await openSession(page, browser, info.project.name, s, {
      name: `img-paste-${tag}`,
      runtime: "claude-code",
      mode: "plan",
    });
    const sam = s.sam!;

    // ---- the paperclip is a real picker now; a pasted screenshot joins the tray inside the card, above the text
    const attach = page.getByTestId("attach");
    await expect(attach).toBeEnabled();
    await expect(attach).toHaveAttribute("aria-label", /Attach images/);
    const composer = page.getByTestId("composer");
    await pasteScreenshot(page, composer, mockup(1200, 800, [79, 70, 229]));
    const form = page.getByTestId("composer-form");
    const item = form.getByTestId("attachment-item");
    await expect(item).toHaveCount(1);
    await expect(item).toHaveAttribute("data-status", "ready", { timeout: 20_000 });
    await expectLoaded(item.getByTestId("attachment-thumb"));
    const trayBox = (await form.getByTestId("attachment-tray").boundingBox())!;
    const textBox = (await composer.boundingBox())!;
    expect(trayBox.y + trayBox.height).toBeLessThanOrEqual(textBox.y + 1);

    // ---- send: the prompt bubble shows the image above its text
    await composer.fill("what is wrong here?");
    await page.getByTestId("send-prompt").click();
    await expect(item).toHaveCount(0);
    const bubble = page.getByTestId("prompt-bubble").filter({ hasText: "what is wrong here?" }).last();
    const image = bubble.getByTestId("attachment-image");
    await expect(image).toHaveCount(1, { timeout: 15_000 });
    await expectLoaded(image);
    await expect(image).toHaveAttribute("src", /\/api\/v1\/attachments\/[0-9a-f-]{36}\/preview$/);
    const imageBox = (await image.boundingBox())!;
    const bodyBox = (await bubble.getByText("what is wrong here?").boundingBox())!;
    expect(imageBox.y + imageBox.height).toBeLessThanOrEqual(bodyBox.y);

    // ---- the device got it: the fake runtime lists the image it received (a small PNG goes as is, P-02)
    await expect(page.getByTestId("assistant-message").last()).toContainText("Images: 1 (image/png)", {
      timeout: 30_000,
    });
    await expect(page.getByTestId("session-view")).toHaveAttribute("data-status", "idle", {
      timeout: 30_000,
    });

    // ---- Sam, on the same session, sees the same bubble live (no reload) and opens the large rendition
    const samBubble = sam.page.getByTestId("prompt-bubble").filter({ hasText: "what is wrong here?" }).last();
    const samImage = samBubble.getByTestId("attachment-image");
    await expect(samImage).toHaveCount(1, { timeout: 10_000 });
    await expectLoaded(samImage);
    await expect(sam.page.getByTestId("assistant-message").last()).toContainText("Images: 1 (image/png)", {
      timeout: 10_000,
    });
    await bothThemes(page, `wz-images-stream-${tag}`);
    await samBubble.getByTestId("attachment-tile").click();
    const lightbox = sam.page.getByTestId("lightbox");
    await expect(lightbox).toBeVisible();
    const large = lightbox.getByTestId("lightbox-image");
    await expect(large).toHaveAttribute("src", /\/api\/v1\/attachments\/[0-9a-f-]{36}\/large$/);
    await expectLoaded(large);
    await bothThemes(sam.page, `wz-images-lightbox-${tag}`);
    await sam.page.keyboard.press("Escape");
    await expect(lightbox).toBeHidden();
  } finally {
    await teardown(s);
  }
});
