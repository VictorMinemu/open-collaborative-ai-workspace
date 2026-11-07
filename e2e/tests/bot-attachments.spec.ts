import { type APIRequestContext, expect, type Locator, type Page, request, test } from "@playwright/test";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs, SAM, userIdOf } from "../support/actors";
import { cellToken, freshPersonalBot, freshTeamBot } from "../support/bot-tools";
import { ALEX, freshChannel, postAs } from "../support/chat";
import { FakeCellPlugin, type MentionPayload } from "../support/fake-cell-plugin";
import { dropFiles, type FileSpec, mockup } from "../support/files";
import { enableBotSandbox, enableSandboxOrg, resume } from "../support/sandbox";
import { asSuperuser } from "../support/superuser";
import { ADMIN, API_URL } from "./env";

/**
 * Bots read attachments (07.15-09; BRA-01, BRA-02, BRA-03, BRA-05, D-01, D-04, D-13, PD-11, PD-12). The paperclip is
 * on in bot DMs: a member attaches files (a drop on desktop, the paperclip's picker on a phone), sends them, and the bot
 * reads them through the Agent Channel API. The e2e fake cell (e2e/support/fake-cell-plugin.ts) answers for the bot: a
 * message's `[[call ocw_attachment_read {"attachmentId":"{{attachment:N}}"}]]` directives read the turn's N-th listed
 * file, and a turn that lists files ends its reply with ` [attachments: <name>:<access>,…]`. Covered: a personal bot
 * reads an image and a PDF; a text-only model refuses the image and still reads the PDF; a files-only message is
 * answered; team bot DMs take files (a turned-off bot's and a deactivated person's DM do not) with the same input as a
 * person DM; in a channel thread a team bot reads the mentioning message's file and an earlier one of the thread, never
 * one of another message; a CSV is copied into the bot's sandbox and read there. The isolated harness runs its own
 * Garage and the fake sandboxd (scripts/e2e-isolated.sh).
 */

test.describe.configure({ mode: "serial" });

/** A member local to this spec, deactivated and reactivated by the person-DM case. */
const DANA: Actor = { name: "Dana Fox", email: "dana@ocw.test", password: "dana-e2e-password-123" };

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

const csv = (name: string, text: string): FileSpec => ({ name, type: "text/csv", bytes: Buffer.from(text) });

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

/** The tray under `scope` holds `count` files, all uploaded. */
async function expectReady(scope: Page | Locator, count: number) {
  const tray = scope.getByTestId("attachment-tray");
  await expect(tray.getByTestId("attachment-item")).toHaveCount(count);
  await expect(tray.locator('[data-testid="attachment-item"][data-status="ready"]')).toHaveCount(count, {
    timeout: 15_000,
  });
}

/** `[[call ocw_attachment_read …]]` for the turn's listed files at these positions. */
const reads = (...positions: number[]) =>
  positions.map((n) => `[[call ocw_attachment_read {"attachmentId":"{{attachment:${n}}}"}]]`).join(" ");

/** The bot's latest reply containing every `expected` string or pattern. */
function botReply(scope: Page | Locator, ...expected: Array<string | RegExp>): Locator {
  let reply = scope.locator('[data-testid="message"][data-author-kind="agent"]');
  for (const e of expected) reply = reply.filter({ hasText: e });
  return reply.last();
}

/** Sends `text` (possibly empty) with the files already in the DM composer's tray. */
async function sendInDm(page: Page, text: string) {
  if (text) await page.getByTestId("composer").fill(text);
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("attachment-tray")).toBeHidden();
}

/** Uploads a file into a conversation through the API (presign → PUT to storage → complete) and returns its id. */
async function upload(api: APIRequestContext, conversationId: string, f: FileSpec): Promise<string> {
  const presign = await api.post(`/api/v1/conversations/${conversationId}/attachments`, {
    data: { filename: f.name, contentType: f.type, size: f.bytes.length },
  });
  expect(presign.ok(), `presign ${f.name}: ${presign.status()}`).toBe(true);
  const { attachment, upload: put } = (await presign.json()) as {
    attachment: { id: string };
    upload: { url: string; headers: Record<string, string> };
  };
  const plain = await request.newContext();
  const stored = await plain.put(put.url, { headers: put.headers, data: f.bytes });
  expect(stored.ok(), `store ${f.name}: ${stored.status()}`).toBe(true);
  await plain.dispose();
  const done = await api.post(`/api/v1/attachments/${attachment.id}/complete`);
  expect(done.ok(), `complete ${f.name}: ${done.status()}`).toBe(true);
  return attachment.id;
}

/** A DM between the signed-in user of `api` and one participant. */
async function dmWith(api: APIRequestContext, kind: "agent" | "user", id: string): Promise<string> {
  const res = await api.post("/api/v1/dms", { data: { participants: [{ kind, id }] } });
  expect(res.ok(), `DM with ${kind} ${id}: ${res.status()}`).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

/** The agent's @username (team bots get one from their name). */
async function usernameOf(api: APIRequestContext, agentId: string): Promise<string> {
  const listed = (await (await api.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; username: string }>;
  };
  const found = listed.agents.find((a) => a.id === agentId);
  expect(found, `agent ${agentId} listed`).toBeTruthy();
  return (found as { username: string }).username;
}

/** The file input and paperclip the composer offers, as the browser sees them (E1). */
async function attachInput(page: Page) {
  const input = page.getByTestId("attach-file").first();
  await expect(page.getByTestId("attach-button")).toBeEnabled();
  return {
    accept: await input.getAttribute("accept"),
    multiple: await input.evaluate((el) => (el as HTMLInputElement).multiple),
    label: await page.getByTestId("attach-button").getAttribute("aria-label"),
  };
}

let admin: APIRequestContext;
let samApi: APIRequestContext;
let samId: string;
let cell: FakeCellPlugin;
const token = cellToken();

test.beforeAll(async () => {
  test.skip(!token, "OCW_CELL_TOKEN is not configured");
  admin = await apiAs(ADMIN);
  samId = await ensureMember(admin, SAM, "developer");
  samApi = await apiAs(SAM);
  cell = new FakeCellPlugin({ apiUrl: API_URL, token, autoAck: true, autoReply: true });
  await cell.start();
});

test.afterAll(async () => {
  await cell?.stop();
  await samApi?.dispose();
  await admin?.dispose();
});

/** Sam's fresh personal bot, acked by the fake cell so its first turn is delivered. */
async function personalBot() {
  const bot = await freshPersonalBot(SAM, samId);
  await cell.ackAll();
  return bot;
}

/** The mentions the fake cell received in one conversation. */
const mentionsIn = (conversationId: string) =>
  cell.events
    .filter((e) => e.type === "agent.mention.v1")
    .map((e) => e.data as unknown as MentionPayload)
    .filter((m) => m.conversation.id === conversationId);

test("a member attaches an image and a PDF in their personal bot's DM and the bot answers from both", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const bot = await personalBot();
  const from = cell.attachmentRequests.length;
  const s = await openAs(browser, SAM, project);
  try {
    await s.page.goto(`${BASE_URL}/chat/dm/${bot.dmId}`);
    await expect(s.page.getByTestId("dm-view")).toBeVisible();
    const clip = s.page.getByTestId("attach-button");
    await expect(clip).toBeVisible();
    await expect(clip).toBeEnabled();

    await addFiles(s.page, [PHOTO, INVOICE], mobile);
    await expectReady(s.page, 2);
    await sendInDm(s.page, `What do these say? ${reads(0, 1)}`);

    const reply = botReply(
      s.page,
      "image photo.png (image/webp)",
      `read invoice.pdf: ${INVOICE_LINE}`,
      // Two dropped files upload in parallel, so their upload order (the turn's order, PD-04) is either way.
      /\[attachments: (photo\.png:read,invoice\.pdf:read|invoice\.pdf:read,photo\.png:read)\]/,
    );
    await expect(reply).toBeVisible({ timeout: 20_000 });
    // The fake sent only the turn's own file ids, once each, in one turn, and the API answered both.
    const sent = cell.attachmentRequests.slice(from);
    expect(sent.map((r) => r.status)).toEqual([200, 200]);
    expect(new Set(sent.map((r) => r.eventId)).size).toBe(1);
  } finally {
    await s.context.close();
  }
});

test("a text-only bot says it cannot see the image and still reads the PDF (D-04, D-13)", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const botId = await freshTeamBot(admin, mobile ? "Plain reader m" : "Plain reader");
  await asSuperuser(
    "update app.agents set model_provider = 'openai-compatible', model_id = 'local-text-1' where id = $1",
    [botId],
  );
  await cell.ackAll();
  const dmId = await dmWith(samApi, "agent", botId);
  const s = await openAs(browser, SAM, project);
  try {
    await s.page.goto(`${BASE_URL}/chat/dm/${dmId}`);
    await addFiles(s.page, [PHOTO, INVOICE], mobile);
    await expectReady(s.page, 2);
    await sendInDm(s.page, `Both please ${reads(0, 1)}`);
    await expect(
      botReply(
        s.page,
        "Tool ocw_attachment_read: refused (model_no_images)",
        `read invoice.pdf: ${INVOICE_LINE}`,
        /\[attachments: (photo\.png:(none|import),invoice\.pdf:read|invoice\.pdf:read,photo\.png:(none|import))\]/,
      ),
    ).toBeVisible({ timeout: 20_000 });
  } finally {
    await s.context.close();
    await asSuperuser("update app.agents set model_provider = 'mock', model_id = 'mock-1' where id = $1", [
      botId,
    ]);
  }
});

test("a files-only message (no text) in a bot DM sends and is answered (E2)", async ({ browser }, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const bot = await personalBot();
  const s = await openAs(browser, SAM, project);
  try {
    await s.page.goto(`${BASE_URL}/chat/dm/${bot.dmId}`);
    await addFiles(s.page, [csv("notes.csv", "day,item\nmon,coffee\n")], mobile);
    await expectReady(s.page, 1);
    await expect(s.page.getByTestId("composer")).toHaveValue("");
    await sendInDm(s.page, "");
    await expect(botReply(s.page, "Asked by Sam Lee", "[attachments: notes.csv:read]")).toBeVisible({
      timeout: 20_000,
    });
    // The API delivered the message's empty text as stored, with the file listed (the plugin words the body).
    const turn = mentionsIn(bot.dmId).at(-1);
    expect(turn?.message.text).toBe("");
    expect(turn?.turn?.attachments?.map((a) => [a.name, a.kind, a.access])).toEqual([
      ["notes.csv", "text", "read"],
    ]);
  } finally {
    await s.context.close();
  }
});

test("a team bot's DM takes files like a person DM; a turned-off bot's and a deactivated person's DM do not (E1)", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const botId = await freshTeamBot(admin, mobile ? "Desk helper m" : "Desk helper");
  await cell.ackAll();
  const botDm = await dmWith(samApi, "agent", botId);
  const adminId = await userIdOf(admin);
  const personDm = await dmWith(samApi, "user", adminId);
  const danaId = await ensureMember(admin, DANA, "developer");
  const danaDm = await dmWith(samApi, "user", danaId);
  const s = await openAs(browser, SAM, project);
  try {
    // ---- the team bot's DM: the same input as a person DM, and the bot reads what is sent
    await s.page.goto(`${BASE_URL}/chat/dm/${botDm}`);
    const forBot = await attachInput(s.page);
    await s.page.goto(`${BASE_URL}/chat/dm/${personDm}`);
    const forPerson = await attachInput(s.page);
    expect(forBot).toEqual(forPerson);

    await s.page.goto(`${BASE_URL}/chat/dm/${botDm}`);
    // The same size limit as everywhere: refused in the tray before any upload.
    await s.page
      .getByTestId("attach-file")
      .first()
      .setInputFiles({
        name: "raw.mov",
        mimeType: "video/quicktime",
        buffer: Buffer.alloc(26 * 1024 * 1024, 1),
      });
    const refused = s.page.locator('[data-testid="attachment-item"][data-status="error"]');
    await expect(refused.getByTestId("attachment-error")).toHaveText("Larger than the 25 MB limit");
    await refused.getByTestId("attachment-remove").click();
    await expect(s.page.getByTestId("attachment-tray")).toBeHidden();
    await addFiles(s.page, [csv("brief.csv", "owner,task\nsam,ship\n")], mobile);
    await expectReady(s.page, 1);
    await sendInDm(s.page, `Summarise ${reads(0)}`);
    await expect(botReply(s.page, "read brief.csv: owner,task", "[attachments: brief.csv:read]")).toBeVisible(
      { timeout: 20_000 },
    );

    // ---- turned off: the DM is archived with the bot (03.1 D-04) and no longer opens, so nothing can be attached
    expect((await admin.patch(`/api/v1/agents/${botId}`, { data: { enabled: false } })).ok()).toBe(true);
    await s.page.goto(`${BASE_URL}/chat/dm/${botDm}`);
    await expect(s.page.getByTestId("dm-missing")).toBeVisible();
    await expect(s.page.getByTestId("composer")).toHaveCount(0);
    await expect(s.page.getByTestId("attach-button")).toHaveCount(0);
    await expect(s.page.getByTestId("attach-file")).toHaveCount(0);

    // ---- a deactivated person's DM: read-only, no paperclip
    expect((await admin.post(`/api/v1/members/${danaId}/deactivate`)).ok()).toBe(true);
    await s.page.goto(`${BASE_URL}/chat/dm/${danaDm}`);
    await expect(s.page.getByTestId("dm-readonly")).toBeVisible();
    await expect(s.page.getByTestId("attach-button")).toHaveCount(0);
  } finally {
    await s.context.close();
    await admin.post(`/api/v1/members/${danaId}/reactivate`);
    await admin.patch(`/api/v1/agents/${botId}`, { data: { enabled: true } });
  }
});

test("in a channel thread a team bot reads the mentioning message's file and an earlier one of the thread, never another message's (SC2)", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const project = info.project.name;
  const botId = await freshTeamBot(admin, project === "mobile" ? "Thread clerk m" : "Thread clerk");
  const handle = await usernameOf(admin, botId);
  await ensureMember(admin, ALEX, "developer");
  const alexApi = await apiAs(ALEX);
  const channel = await freshChannel(admin, [samApi, alexApi], "bot-files");
  const added = await admin.post(`/api/v1/channels/${channel.id}/members`, {
    data: { kind: "agent", id: botId },
  });
  expect(added.ok(), `add the bot: ${added.status()}`).toBe(true);
  await cell.ackAll();

  // Thread T, a file on another top-level message, and Alex's reply in T with a CSV.
  const root = await postAs(samApi, channel.id, "Q4 planning");
  const elsewhere = await upload(samApi, channel.id, csv("other.csv", "secret,1\n"));
  await postAs(samApi, channel.id, "Unrelated numbers", { attachmentIds: [elsewhere] });
  const earlier = await upload(alexApi, channel.id, csv("a.csv", "region,total\neu,1300\n"));
  await postAs(alexApi, channel.id, "Numbers for the plan", {
    threadRootId: root.id,
    attachmentIds: [earlier],
  });

  const s = await openAs(browser, SAM, project);
  try {
    await s.page.goto(`${BASE_URL}/chat/${channel.id}?thread=${root.id}`);
    const panel = s.page.getByTestId("thread-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("message")).toHaveCount(2);
    await panel
      .getByTestId("attach-file")
      .setInputFiles({ name: "b.png", mimeType: "image/png", buffer: mockup(480, 300, [16, 185, 129]) });
    await expectReady(panel, 1);
    await panel
      .getByTestId("thread-composer")
      .fill(`@${handle} compare ${reads(0, 1)} [[call ocw_attachment_read {"attachmentId":"${elsewhere}"}]]`);
    await panel.getByTestId("thread-composer-send").click();
    await expect(
      botReply(
        panel,
        "image b.png (image/webp)",
        "read a.csv: region,total",
        "Tool ocw_attachment_read: refused (not_found)",
        "[attachments: b.png:read,a.csv:read]",
      ),
    ).toBeVisible({ timeout: 20_000 });
    // The other message's file was asked for by id and refused by the API, never listed for the turn.
    const turn = mentionsIn(channel.id).at(-1);
    expect(turn?.turn?.attachments?.map((a) => a.id)).not.toContain(elsewhere);
    expect(cell.attachmentRequests.find((r) => r.attachmentId === elsewhere)?.status).toBe(200);
  } finally {
    await s.context.close();
    await alexApi.dispose();
  }
});

test("a CSV attached in a personal bot's DM is copied into its sandbox and read there (SC3, BRA-03)", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const settings = await admin.get("/api/v1/sandbox/settings");
  const wasOn =
    settings.ok() && ((await settings.json()) as { settings: { enabled: boolean } }).settings.enabled;
  await enableSandboxOrg(admin);
  await resume(admin);
  const bot = await personalBot();
  await enableBotSandbox(samApi, bot.id, { sandbox: true });
  const s = await openAs(browser, SAM, project);
  try {
    await s.page.goto(`${BASE_URL}/chat/dm/${bot.dmId}`);
    await addFiles(s.page, [csv("numbers.csv", "a,b\n1,2\n")], mobile);
    await expectReady(s.page, 1);
    await sendInDm(
      s.page,
      '[[call ocw_sandbox_import {"attachmentId":"{{attachment:0}}"}]] [[call ocw_sandbox_read {"path":"downloads/numbers.csv"}]]',
    );
    await expect(
      botReply(
        s.page,
        "Tool ocw_sandbox_import: imported downloads/numbers.csv",
        "Tool ocw_sandbox_read: read downloads/numbers.csv: a,b",
        "1,2",
      ),
    ).toBeVisible({ timeout: 20_000 });
  } finally {
    await s.context.close();
    await enableBotSandbox(samApi, bot.id, { sandbox: false });
    if (!wasOn) await enableSandboxOrg(admin, false);
  }
});
