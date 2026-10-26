import {
  type APIRequestContext,
  type Browser,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { bothThemes, dropFiles, type FileSpec, mockup, pasteFiles } from "../support/files";
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
    // Both boxes in one frame: the list keeps scrolling while the turn streams, so two separate boundingBox() calls
    // can straddle a scroll (pipeline 74 measured the image 51 px "below" the text on mobile).
    await expect
      .poll(
        () =>
          bubble.evaluate((el) => {
            const img = el.querySelector('[data-testid="attachment-image"]');
            const body = [...el.querySelectorAll("*")].find(
              (n) => n.children.length === 0 && n.textContent?.includes("what is wrong here?"),
            );
            if (!img || !body) return Number.NaN;
            return body.getBoundingClientRect().top - img.getBoundingClientRect().bottom;
          }),
        { timeout: 5_000 },
      )
      .toBeGreaterThanOrEqual(0);

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

/** A minimal one-page PDF (the server sniffs the %PDF magic; the composer must refuse it before any upload). */
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

const image = (name: string, hue: [number, number, number]): FileSpec => ({
  name,
  type: "image/png",
  bytes: mockup(640, 400, hue),
});

/** Adds files the way the device does: a drop on the session pane on desktop, the paperclip's picker on a phone. */
async function addFiles(page: Page, files: FileSpec[], mobile: boolean) {
  if (mobile) {
    await page
      .getByTestId("attach-file")
      .setInputFiles(files.map((f) => ({ name: f.name, mimeType: f.type, buffer: f.bytes })));
  } else {
    await dropFiles(page, files);
  }
}

/** Opens the Queue: the side panel on a wide screen, the sheet on a phone. */
async function openQueue(page: Page, mobile: boolean) {
  await page.getByTestId(mobile ? "open-queue" : "tab-queue").click();
  await expect(page.getByTestId("queue-panel")).toBeVisible();
}

test("Work Zone images: drop or pick, refusals in place, the fifth image, queued thumbnails for everyone, no images with a / command", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(300_000);
  const mobile = info.project.name === "mobile";
  const tag = mobile ? "390" : "1440";
  const s: Setup = { adminApi: await apiAs(ADMIN), device: null, sessionId: null, sam: null };
  // Every presign the composer makes: a refused file must never reach the upload routes.
  const presigned: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && /\/api\/v1\/conversations\/[0-9a-f-]{36}\/attachments$/.test(req.url())) {
      presigned.push(req.postData() ?? "");
    }
  });
  try {
    // Supervised: the fake asks before writing, so a turn waits on the approval while the next prompt is queued.
    await openSession(page, browser, info.project.name, s, {
      name: `img-queue-${tag}`,
      runtime: "claude-code",
      mode: "default",
    });
    const sam = s.sam!;
    const form = page.getByTestId("composer-form");
    const composer = page.getByTestId("composer");
    const send = page.getByTestId("send-prompt");
    const items = form.getByTestId("attachment-item");

    // ---- a turn runs (it waits for the approval)
    await composer.fill("Add a short CONTRIBUTING guide for new teammates");
    await send.click();
    const banner = page.getByTestId("approval-banner");
    await expect(banner).toBeVisible({ timeout: 30_000 });

    // ---- two images and a PDF: the images upload, the PDF is refused in the tray with the reason
    await addFiles(
      page,
      [
        image("header.png", [79, 70, 229]),
        image("footer.png", [16, 185, 129]),
        { name: "notes.pdf", type: "application/pdf", bytes: PDF },
      ],
      mobile,
    );
    await expect(items).toHaveCount(3);
    const pdf = items.filter({ hasText: "notes.pdf" });
    await expect(pdf).toHaveAttribute("data-status", "error");
    await expect(pdf.getByTestId("attachment-error")).toHaveText(
      "Only images (PNG, JPEG, GIF, WebP) can be sent to a session",
    );
    await expect(items.and(page.locator('[data-status="ready"]'))).toHaveCount(2, { timeout: 20_000 });
    expect(presigned.some((body) => body.includes("notes.pdf"))).toBe(false);
    // The chip clamps its reason; the line under the card says it in full.
    await expect(page.getByTestId("composer-hint")).toContainText(
      "notes.pdf: Only images (PNG, JPEG, GIF, WebP) can be sent to a session",
    );
    expect(presigned).toHaveLength(2);
    await composer.fill("Match the spacing of these two mockups");
    await expect(send).toBeDisabled();
    await bothThemes(page, `wz-images-refused-${tag}`);

    // ---- removing the PDF enables Send
    await pdf.getByTestId("attachment-remove").click();
    await expect(items).toHaveCount(2);
    await expect(send).toBeEnabled();

    // ---- a fifth image is refused in place ("Up to 4 images per prompt"); removing the extras keeps the first two
    await addFiles(
      page,
      [
        image("third.png", [245, 158, 11]),
        image("fourth.png", [14, 165, 233]),
        image("fifth.png", [244, 63, 94]),
      ],
      mobile,
    );
    await expect(items).toHaveCount(5);
    const fifth = items.filter({ hasText: "fifth.png" });
    await expect(fifth.getByTestId("attachment-error")).toHaveText("Up to 4 images per prompt");
    await expect(send).toBeDisabled();
    expect(presigned.some((body) => body.includes("fifth.png"))).toBe(false);
    await expect(page.getByTestId("composer-hint")).toContainText("fifth.png: Up to 4 images per prompt");
    await expect(items.and(page.locator('[data-status="ready"]'))).toHaveCount(4, { timeout: 20_000 });
    for (const name of ["fifth.png", "fourth.png", "third.png"]) {
      await items
        .filter({ has: page.locator(`[alt="${name}"], [title="${name}"]`) })
        .first()
        .getByTestId("attachment-remove")
        .click();
    }
    await expect(items).toHaveCount(2);
    await expect(send).toBeEnabled();
    await bothThemes(page, `wz-images-composer-${tag}`);

    // ---- queued while the turn runs: the queue shows both thumbnails, for Víctor and for Sam
    await send.click();
    await expect(items).toHaveCount(0);
    await openQueue(page, mobile);
    const queued = page.getByTestId("queued-prompt").filter({ hasText: "Match the spacing" });
    const thumbs = queued.getByTestId("prompt-thumb");
    await expect(thumbs).toHaveCount(2, { timeout: 10_000 });
    await expect(thumbs.nth(0)).toHaveAttribute("alt", "header.png");
    await expect(thumbs.nth(1)).toHaveAttribute("alt", "footer.png");
    for (const i of [0, 1]) await expectLoaded(thumbs.nth(i));
    // The "Queued #1" toast sits over the panel for a few seconds (and waits while hovered: on a phone the pointer
    // rests on the header's Queue button under it): shoot the queue once it has gone.
    await page.mouse.move(8, page.viewportSize()!.height - 8);
    await expect(page.getByText("Queued #1")).toBeHidden({ timeout: 15_000 });
    await bothThemes(page, `wz-images-queue-${tag}`);
    await openQueue(sam.page, mobile);
    const samThumbs = sam.page
      .getByTestId("queued-prompt")
      .filter({ hasText: "Match the spacing" })
      .getByTestId("prompt-thumb");
    await expect(samThumbs).toHaveCount(2, { timeout: 10_000 });
    for (const i of [0, 1]) await expectLoaded(samThumbs.nth(i));
    if (mobile) await page.keyboard.press("Escape");
    await expect(page.getByTestId("queue-panel")).toBeVisible({ visible: !mobile });

    // ---- the turn goes on; the queued prompt runs and the device lists both images
    await banner.getByTestId("approve-once").click();
    // The first turn ends, the queued prompt starts and asks too (its bubble shows once it is dispatched).
    await expect(page.getByTestId("prompt-bubble").filter({ hasText: "Match the spacing" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await banner.getByTestId("approve-once").click();
    await expect(page.getByTestId("assistant-message").last()).toContainText(
      "Images: 2 (image/png, image/png)",
      {
        timeout: 30_000,
      },
    );
    await expect(
      page
        .getByTestId("prompt-bubble")
        .filter({ hasText: "Match the spacing" })
        .getByTestId("attachment-image"),
    ).toHaveCount(2);
    await expect(page.getByTestId("session-view")).toHaveAttribute("data-status", "idle", {
      timeout: 30_000,
    });

    // ---- a / command never takes images: Send waits and says why
    await pasteFiles(composer, [image("palette.png", [99, 102, 241])]);
    await expect(items).toHaveCount(1);
    await expect(items.first()).toHaveAttribute("data-status", "ready", { timeout: 20_000 });
    await composer.fill("/model sonnet");
    await expect(send).toBeDisabled();
    await expect(page.getByTestId("composer-hint")).toContainText("Images can't be sent with a / command");
    await expect(send).toHaveAttribute("title", "Images can't be sent with a / command");
    await bothThemes(page, `wz-images-slash-${tag}`);
    await composer.fill("Use this palette for the guide");
    await expect(send).toBeEnabled();
  } finally {
    await teardown(s);
  }
});

test("Work Zone images: a Codex session takes a pasted image and its reply lists it", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(240_000);
  const tag = info.project.name === "mobile" ? "390" : "1440";
  const s: Setup = { adminApi: await apiAs(ADMIN), device: null, sessionId: null, sam: null };
  try {
    await openSession(page, browser, info.project.name, s, {
      name: `img-codex-${tag}`,
      runtime: "codex",
      mode: "plan",
    });
    const composer = page.getByTestId("composer");
    await pasteFiles(composer, [image("screen.png", [16, 185, 129])]);
    const item = page.getByTestId("composer-form").getByTestId("attachment-item");
    await expect(item).toHaveAttribute("data-status", "ready", { timeout: 20_000 });
    await composer.fill("Why does this layout overflow?");
    await page.getByTestId("send-prompt").click();
    await expect(page.getByTestId("assistant-message").last()).toContainText("Images: 1 (image/png)", {
      timeout: 30_000,
    });
    const bubble = page.getByTestId("prompt-bubble").filter({ hasText: "Why does this layout overflow?" });
    await expectLoaded(bubble.getByTestId("attachment-image"));
    await expect(
      s
        .sam!.page.getByTestId("prompt-bubble")
        .filter({ hasText: "Why does this layout overflow?" })
        .getByTestId("attachment-image"),
    ).toHaveCount(1, { timeout: 10_000 });
    await bothThemes(page, `wz-images-codex-${tag}`);
  } finally {
    await teardown(s);
  }
});
