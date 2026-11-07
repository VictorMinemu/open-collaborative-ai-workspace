import { expect, type Locator, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { cellToken, freshPersonalBot } from "../support/bot-tools";
import { FakeCellPlugin } from "../support/fake-cell-plugin";
import { dropFiles, type FileSpec, mockup } from "../support/files";
import { ADMIN, API_URL } from "./env";

/**
 * Bots read attachments (07.15-09; BRA-01, BRA-05, D-01, PD-11, PD-12). The paperclip is on in bot DMs: a member
 * attaches files (a drop on desktop, the paperclip's picker on a phone), sends them, and the bot reads them through the
 * Agent Channel API. The e2e fake cell (e2e/support/fake-cell-plugin.ts) answers for the bot: a message's
 * `[[call ocw_attachment_read {"attachmentId":"{{attachment:N}}"}]]` directives read the turn's N-th listed file, and
 * a turn that lists files ends its reply with ` [attachments: <name>:<access>,…]`. The isolated harness runs its own
 * Garage (scripts/e2e-isolated.sh).
 */

test.describe.configure({ mode: "serial" });

/** One line of text on a one-page PDF (Helvetica), with a correct cross-reference table, so the API extracts it. */
function pdfWith(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const INVOICE_LINE = "Invoice 42 total 1300 EUR";
const PHOTO: FileSpec = { name: "photo.png", type: "image/png", bytes: mockup(640, 400) };
const INVOICE: FileSpec = { name: "invoice.pdf", type: "application/pdf", bytes: pdfWith(INVOICE_LINE) };

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

/** The composer's tray holds `count` files, all uploaded. */
async function expectReady(page: Page, count: number) {
  const tray = page.getByTestId("attachment-tray");
  await expect(tray.getByTestId("attachment-item")).toHaveCount(count);
  await expect(tray.locator('[data-testid="attachment-item"][data-status="ready"]')).toHaveCount(count, {
    timeout: 15_000,
  });
}

/** `[[call ocw_attachment_read …]]` for the turn's listed files at these positions. */
const reads = (...positions: number[]) =>
  positions.map((n) => `[[call ocw_attachment_read {"attachmentId":"{{attachment:${n}}}"}]]`).join(" ");

/** The bot's latest reply containing every `expected` string. */
function botReply(scope: Page | Locator, ...expected: string[]): Locator {
  let reply = scope.locator('[data-testid="message"][data-author-kind="agent"]');
  for (const e of expected) reply = reply.filter({ hasText: e });
  return reply.last();
}

test("a member attaches an image and a PDF in their personal bot's DM and the bot answers from both", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const token = cellToken();
  test.skip(!token, "OCW_CELL_TOKEN is not configured");

  const admin = await apiAs(ADMIN);
  const samId = await ensureMember(admin, SAM, "developer");
  const bot = await freshPersonalBot(SAM, samId);
  const cell = new FakeCellPlugin({ apiUrl: API_URL, token, autoAck: true, autoReply: true });
  await cell.start();
  const s = await openAs(browser, SAM, project);
  try {
    await s.page.goto(`${BASE_URL}/chat/dm/${bot.dmId}`);
    await expect(s.page.getByTestId("dm-view")).toBeVisible();
    const clip = s.page.getByTestId("attach-button");
    await expect(clip).toBeVisible();
    await expect(clip).toBeEnabled();

    await addFiles(s.page, [PHOTO, INVOICE], mobile);
    await expectReady(s.page, 2);
    await s.page.getByTestId("composer").fill(`What do these say? ${reads(0, 1)}`);
    await s.page.getByTestId("composer-send").click();
    await expect(s.page.getByTestId("attachment-tray")).toBeHidden();

    const reply = botReply(
      s.page,
      "image photo.png (image/webp)",
      `read invoice.pdf: ${INVOICE_LINE}`,
      "[attachments: photo.png:read,invoice.pdf:read]",
    );
    await expect(reply).toBeVisible({ timeout: 20_000 });
    // The fake sent only the turn's own file ids, each once, and the API answered both.
    const read = cell.attachmentRequests.filter((r) => r.status === 200);
    expect(read).toHaveLength(2);
    expect(new Set(read.map((r) => r.eventId)).size).toBe(1);
  } finally {
    await s.context.close();
    await cell.stop();
    await admin.dispose();
  }
});
