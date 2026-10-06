import { crc32, deflateSync } from "node:zlib";
import { expect, type Locator, type Page, request, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { freshChannel } from "../support/chat";
import { ADMIN, API_URL, shot } from "./env";

/**
 * CHAT-12 (04-12): files in chat on top of the 04-04 pipeline. Drop (desktop) or pick (phone) an image, watch it
 * upload, send it, and another member sees the preview live and opens it in the lightbox; downloads go through the
 * API's authorized redirect. The isolated harness runs its own Garage (127.0.0.1:4292).
 */

async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** An RGB PNG drawn by `pixel` (no image library needed). */
function png(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A soft gradient "mockup" with a card in the middle, so previews and the lightbox look like real screenshots. */
function mockup(width = 960, height = 600, hue: [number, number, number] = [99, 102, 241]): Buffer {
  return png(width, height, (x, y) => {
    const inCard = x > width * 0.2 && x < width * 0.8 && y > height * 0.25 && y < height * 0.75;
    if (inCard) {
      const bar = y > height * 0.32 && y < height * 0.36 && x < width * 0.55;
      return bar ? [hue[0], hue[1], hue[2]] : [250, 250, 252];
    }
    const t = (x / width + y / height) / 2;
    return [
      Math.round(hue[0] + (255 - hue[0]) * t * 0.6),
      Math.round(hue[1] + (255 - hue[1]) * t * 0.6),
      Math.round(hue[2] + (255 - hue[2]) * t * 0.3),
    ];
  });
}

/** Drops files on the conversation pane the way a browser does (a DataTransfer built in the page). */
async function dropFiles(page: Page, files: Array<{ name: string; type: string; bytes: Buffer }>) {
  const dt = await page.evaluateHandle(
    (list) => {
      const dataTransfer = new DataTransfer();
      for (const f of list) {
        const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
        dataTransfer.items.add(new File([bytes], f.name, { type: f.type }));
      }
      return dataTransfer;
    },
    files.map((f) => ({ name: f.name, type: f.type, b64: f.bytes.toString("base64") })),
  );
  const zone = page.getByTestId("drop-zone").first();
  await zone.dispatchEvent("dragenter", { dataTransfer: dt });
  await expect(page.getByTestId("drop-zone-overlay")).toBeVisible();
  await zone.dispatchEvent("dragover", { dataTransfer: dt });
  await zone.dispatchEvent("drop", { dataTransfer: dt });
  await expect(page.getByTestId("drop-zone-overlay")).toBeHidden();
}

/** Adds files the way the device does: a drop on desktop, the paperclip's picker on a phone. */
async function addFiles(
  page: Page,
  files: Array<{ name: string; type: string; bytes: Buffer }>,
  mobile: boolean,
) {
  if (mobile) {
    await page
      .getByTestId("attach-file")
      .first()
      .setInputFiles(files.map((f) => ({ name: f.name, mimeType: f.type, buffer: f.bytes })));
  } else {
    await dropFiles(page, files);
  }
}

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
