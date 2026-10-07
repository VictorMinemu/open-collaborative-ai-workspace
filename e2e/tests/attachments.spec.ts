import { expect, type Locator, type Page, request, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM, userIdOf } from "../support/actors";
import { freshChannel } from "../support/chat";
import { bothThemes, dropFiles, type FileSpec, mockup, pasteFiles } from "../support/files";
import { ADMIN, API_URL, shot } from "./env";

/**
 * CHAT-12 (04-12): files in chat on top of the 04-04 pipeline. Drop (desktop) or pick (phone) an image, watch it
 * upload, send it, and another member sees the preview live and opens it in the lightbox; downloads go through the
 * API's authorized redirect. The isolated harness runs its own Garage (127.0.0.1:4292).
 */

/** Adds files the way the device does: a drop on desktop, the paperclip's picker on a phone. */
async function addFiles(page: Page, files: FileSpec[], mobile: boolean) {
  if (mobile) {
    await page
      .getByTestId("attach-file")
      .first()
      .setInputFiles(files.map((f) => ({ name: f.name, mimeType: f.type, buffer: f.bytes })));
  } else {
    await dropFiles(page, files);
  }
}

/** A minimal one-page PDF (what the server sniffs is the %PDF magic). */
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

/** Waits until an `<img>` decoded (natural width > 0). */
async function expectLoaded(img: Locator) {
  await expect
    .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 10_000 })
    .toBeGreaterThan(0);
}

/** The attachment id in an API attachment URL. */
const idOf = (url: string | null) => /\/api\/v1\/attachments\/([0-9a-f-]{36})\//.exec(url ?? "")?.[1] ?? "";

/** Follows the API's download redirect by hand and returns the status and the bytes behind it. */
async function download(api: Awaited<ReturnType<typeof apiAs>>, id: string) {
  const res = await api.get(`/api/v1/attachments/${id}/download`, { maxRedirects: 0 });
  const location = res.headers().location ?? "";
  const plain = await request.newContext();
  const file = await plain.get(location);
  const body = await file.body();
  await plain.dispose();
  return {
    status: res.status(),
    location,
    fileStatus: file.status(),
    body,
    disposition: file.headers()["content-disposition"] ?? "",
  };
}

test.describe.configure({ mode: "serial" });

test("drop or pick an image, watch it upload, send it; another member sees the preview live and opens the lightbox", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const size = mobile ? "390" : "1440";
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  const sam = await apiAs(SAM);
  const channel = await freshChannel(admin, [sam], "design");
  const image = mockup();

  const a = await openAs(browser, ADMIN, project);
  const s = await openAs(browser, SAM, project);
  try {
    await a.page.goto(`${BASE_URL}/chat/${channel.id}`);
    await s.page.goto(`${BASE_URL}/chat/${channel.id}`);
    await expect(a.page.getByTestId("attach-button")).toBeVisible();

    // ---- the image goes to the tray and uploads straight to storage, with progress, until it is ready
    await addFiles(a.page, [{ name: "onboarding-mockup.png", type: "image/png", bytes: image }], mobile);
    const tray = a.page.getByTestId("attachment-tray");
    await expect(tray).toBeVisible();
    const item = tray.getByTestId("attachment-item");
    await expect(item).toHaveCount(1);
    await expectLoaded(item.getByTestId("attachment-thumb"));
    await expect(item).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
    await expect(item.getByTestId("attachment-progress")).toHaveAttribute("data-done", "true");
    await expect(item.getByTestId("attachment-progress")).toHaveAttribute("aria-valuenow", "100");
    await a.page.getByTestId("composer").fill("Here's the new onboarding mockup");
    await a.page.mouse.move(0, 0);
    await bothThemes(a.page, `attachments-upload-${size}`);

    // ---- sent: the tray empties and Sam sees the preview live (the webp rendition through the API)
    await a.page.getByTestId("composer-send").click();
    await expect(tray).toBeHidden();
    const onSam = s.page.getByTestId("message").filter({ hasText: "the new onboarding mockup" }).last();
    const preview = onSam.getByTestId("attachment-image");
    await expect(preview).toBeVisible({ timeout: 5_000 });
    await expect(preview).toHaveAttribute(
      "src",
      new RegExp(
        `^${API_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/api/v1/attachments/[0-9a-f-]{36}/preview$`,
      ),
    );
    await expectLoaded(preview);
    const id = idOf(await preview.getAttribute("src"));
    expect(id).not.toBe("");
    await s.page.mouse.move(0, 0);
    await bothThemes(s.page, `attachments-grid-${size}`);

    // ---- the lightbox shows the large rendition; Escape closes it
    await onSam.getByTestId("attachment-tile").first().click();
    const lightbox = s.page.getByTestId("lightbox");
    await expect(lightbox).toBeVisible();
    const large = lightbox.getByTestId("lightbox-image");
    await expect(large).toHaveAttribute("src", new RegExp(`/api/v1/attachments/${id}/large$`));
    await expectLoaded(large);
    await expect(lightbox.getByTestId("lightbox-download")).toHaveAttribute(
      "href",
      `${API_URL}/api/v1/attachments/${id}/download`,
    );
    await bothThemes(s.page, `attachments-lightbox-${size}`);
    await s.page.keyboard.press("Escape");
    await expect(lightbox).toBeHidden();
    // Closing the viewer never opened the thread behind it (a tap on a message does that on phones).
    await expect(s.page.getByTestId("thread-panel")).toHaveCount(0);

    // ---- Download: the API answers 302 to a short-lived URL that serves the original bytes as a download
    const got = await download(sam, id);
    expect(got.status).toBe(302);
    expect(got.fileStatus).toBe(200);
    expect(got.body.equals(image)).toBe(true);
    expect(got.disposition).toMatch(/^attachment;/);
  } finally {
    await a.context.close();
    await s.context.close();
    await admin.dispose();
    await sam.dispose();
  }
});

test("paste, a PDF card, an oversized file and removal before sending; threads and DMs take files; a delete hides them; no storage hides the paperclip", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const size = mobile ? "390" : "1440";
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  const sam = await apiAs(SAM);
  const samId = await userIdOf(sam);
  const channel = await freshChannel(admin, [sam], "files");

  const a = await openAs(browser, ADMIN, project);
  const s = await openAs(browser, SAM, project);
  try {
    await a.page.goto(`${BASE_URL}/chat/${channel.id}`);
    await s.page.goto(`${BASE_URL}/chat/${channel.id}`);
    const composer = a.page.getByTestId("composer");
    const send = a.page.getByTestId("composer-send");
    const tray = a.page.getByTestId("attachment-tray");
    const items = tray.getByTestId("attachment-item");

    // ---- paste a screenshot, then pick a PDF and a stray image; remove the stray one before sending
    await pasteFiles(composer, [
      { name: "screenshot.png", type: "image/png", bytes: mockup(800, 500, [16, 185, 129]) },
    ]);
    await expect(items).toHaveCount(1);
    await a.page
      .getByTestId("attach-file")
      .first()
      .setInputFiles([
        { name: "Q3 report.pdf", mimeType: "application/pdf", buffer: PDF },
        { name: "draft.png", mimeType: "image/png", buffer: mockup(320, 200, [244, 63, 94]) },
      ]);
    await expect(items).toHaveCount(3);
    await expect(tray.locator('[data-testid="attachment-item"][data-status="ready"]')).toHaveCount(3, {
      timeout: 15_000,
    });
    await tray.getByRole("button", { name: "Remove draft.png" }).click();
    await expect(items).toHaveCount(2);

    // ---- a file over the limit is refused in the tray before any upload and blocks sending until removed
    await a.page
      .getByTestId("attach-file")
      .first()
      .setInputFiles({
        name: "raw-footage.mov",
        mimeType: "video/quicktime",
        buffer: Buffer.alloc(26 * 1024 * 1024, 1),
      });
    const refused = tray.locator('[data-testid="attachment-item"][data-status="error"]');
    await expect(refused).toHaveCount(1);
    await expect(refused.getByTestId("attachment-error")).toHaveText("Larger than the 25 MB limit");
    await composer.fill("Screens and the Q3 report");
    await expect(send).toBeDisabled();
    await a.page.mouse.move(0, 0);
    await shot(a.page, `attachments-error-${size}`);
    await refused.getByTestId("attachment-remove").click();
    await expect(items).toHaveCount(2);
    await expect(send).toBeEnabled();
    await send.click();
    await expect(tray).toBeHidden();

    // ---- Sam sees the pasted image and a PDF card (name, size, download) live; the stray image never left
    const onSam = s.page.getByTestId("message").filter({ hasText: "Screens and the Q3 report" }).last();
    await expect(onSam.getByTestId("attachment-image")).toHaveCount(1, { timeout: 5_000 });
    await expectLoaded(onSam.getByTestId("attachment-image"));
    const card = onSam.getByTestId("file-card");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("Q3 report.pdf");
    await expect(card).toContainText(`PDF · ${PDF.length} B`);
    const pdfId = (await card.getAttribute("data-attachment-id")) ?? "";
    await expect(card.getByTestId("file-download")).toHaveAttribute(
      "href",
      `${API_URL}/api/v1/attachments/${pdfId}/download`,
    );
    const got = await download(sam, pdfId);
    expect(got.status).toBe(302);
    expect(got.body.equals(PDF)).toBe(true);
    await s.page.mouse.move(0, 0);
    await bothThemes(s.page, `attachments-file-card-${size}`);
    const messageId = (await onSam.getAttribute("data-message-id")) ?? "";

    // ---- the thread panel takes files too
    await a.page.goto(`${BASE_URL}/chat/${channel.id}?thread=${messageId}`);
    const panel = a.page.getByTestId("thread-panel");
    await expect(panel).toBeVisible();
    await panel.getByTestId("attach-file").setInputFiles({
      name: "thread-reply.png",
      mimeType: "image/png",
      buffer: mockup(640, 400, [245, 158, 11]),
    });
    await expect(panel.locator('[data-testid="attachment-item"][data-status="ready"]')).toHaveCount(1, {
      timeout: 15_000,
    });
    await panel.getByTestId("thread-composer-send").click();
    // The root and the delivered reply (a pending row is `message-pending`, not `message`).
    await expect(panel.getByTestId("message")).toHaveCount(2, { timeout: 5_000 });
    await expectLoaded(panel.getByTestId("message").last().getByTestId("attachment-image"));
    const thread = await (await sam.get(`/api/v1/messages/${messageId}/thread`)).json();
    expect(thread.replies.at(-1).attachments.map((x: { filename: string }) => x.filename)).toEqual([
      "thread-reply.png",
    ]);

    // ---- a DM takes files; when the message is deleted, Sam's page drops the image and the download is gone
    const dm = await (
      await admin.post("/api/v1/dms", { data: { participants: [{ kind: "user", id: samId }] } })
    ).json();
    await a.page.goto(`${BASE_URL}/chat/dm/${dm.id}`);
    await s.page.goto(`${BASE_URL}/chat/dm/${dm.id}`);
    await a.page
      .getByTestId("attach-file")
      .first()
      .setInputFiles({
        name: "whiteboard.png",
        mimeType: "image/png",
        buffer: mockup(700, 460, [14, 165, 233]),
      });
    await expect(a.page.locator('[data-testid="attachment-item"][data-status="ready"]')).toHaveCount(1, {
      timeout: 15_000,
    });
    await a.page.getByTestId("composer").fill("From the whiteboard");
    await a.page.getByTestId("composer-send").click();
    const dmOnSam = s.page.getByTestId("message").filter({ hasText: "From the whiteboard" }).last();
    const dmImage = dmOnSam.getByTestId("attachment-image");
    await expect(dmImage).toBeVisible({ timeout: 5_000 });
    const dmImageId = idOf(await dmImage.getAttribute("src"));
    const dmMessageId = (await dmOnSam.getAttribute("data-message-id")) ?? "";
    expect((await admin.delete(`/api/v1/messages/${dmMessageId}`)).ok()).toBe(true);
    await expect(s.page.getByTestId("dm-view").getByTestId("attachment-image")).toHaveCount(0, {
      timeout: 5_000,
    });
    expect((await sam.get(`/api/v1/attachments/${dmImageId}/download`, { maxRedirects: 0 })).status()).toBe(
      404,
    );

    // ---- without storage (config says disabled) there is no paperclip and no drop target; text still sends
    await a.page.route("**/api/v1/attachments/config", (route) =>
      route.fulfill({
        json: { enabled: false, maxBytes: 26214400, maxPerMessage: 10, reason: "not_configured" },
      }),
    );
    await a.page.goto(`${BASE_URL}/chat/${channel.id}`);
    await expect(a.page.getByTestId("composer")).toBeVisible();
    await expect(a.page.getByTestId("attach-button")).toHaveCount(0);
    await expect(a.page.getByTestId("attach-file")).toHaveCount(0);
    await a.page.getByTestId("composer").fill("Text still works");
    await a.page.getByTestId("composer-send").click();
    await expect(a.page.getByTestId("message").filter({ hasText: "Text still works" })).toBeVisible();
  } finally {
    await a.context.close();
    await s.context.close();
    await admin.dispose();
    await sam.dispose();
  }
});
