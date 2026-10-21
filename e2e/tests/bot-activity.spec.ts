import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { freshTeamBot } from "../support/bot-tools";
import { cellToken } from "../support/cell-token";
import { ALEX, freshChannel, postAs } from "../support/chat";
import { FakeCellPlugin, type MentionPayload } from "../support/fake-cell-plugin";
import {
  captureReview,
  expectNoSidewaysScroll,
  expectTouchTargets,
  unnamedControls,
} from "../support/layout";
import { enableBotSandbox, enableSandboxOrg, resume } from "../support/sandbox";
import { ADMIN, API_URL } from "./env";

/**
 * 07.8-20 (R2, BRW-01, SBX-02, UI-SPEC Surface 5, C-03): what a bot did in its sandbox and browser, in the chat, against
 * the real API, the fake cell (no model) and the fake sandboxd. The cell drives each turn by hand here (no auto reply),
 * so a test can hold a turn open between two calls and see the live label. Every reader of the reply sees the
 * server-composed activity above it, collapsed; expanding shows the masked steps; a person who cannot read the
 * conversation never receives it. Phone, dark, axe and the UI-SPEC screenshots (`chat-activity-*`).
 */

test.describe.configure({ mode: "serial" });

const BOT = "Scout";
/** About 4 KB: the write step reads "reports/late.csv · 4 KB". */
const LATE_CSV = `id,customer,days_late\n${Array.from(
  { length: 400 },
  (_, i) => `${1000 + i},Customer ${i},${i % 9}`,
).join("\n")}`.slice(0, 4096);
const REPLY = "I checked: 12 orders are pending, 3 are late. The list is in reports/late.csv.";

let admin: APIRequestContext;
let samApi: APIRequestContext;
let alexApi: APIRequestContext;
let botId: string;
let dmId: string;
let cell: FakeCellPlugin;
const open: BrowserContext[] = [];

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

test.beforeAll(async () => {
  admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  await ensureMember(admin, ALEX, "developer");
  samApi = await apiAs(SAM);
  alexApi = await apiAs(ALEX);
  await enableSandboxOrg(admin);
  await resume(admin);
  botId = await freshTeamBot(admin, BOT);
  await enableBotSandbox(admin, botId, { sandbox: true, browser: true });
  cell = new FakeCellPlugin({ apiUrl: API_URL, token: cellToken(), autoAck: true, autoReply: false });
  await cell.start();
  const dm = await samApi.post(`/api/v1/agents/${botId}/dm`);
  expect(dm.ok(), `Sam's DM with ${BOT}`).toBe(true);
  dmId = ((await dm.json()) as { dmId: string }).dmId;
});

test.afterAll(async () => {
  for (const c of open.splice(0)) await c.close();
  await cell?.stop();
  await samApi?.dispose();
  await alexApi?.dispose();
  await admin?.dispose();
});

async function signIn(browser: Parameters<typeof openAs>[0], who: typeof SAM, project: string) {
  const s = await openAs(browser, who, project);
  open.push(s.context);
  return s.page;
}

/** The mention the API delivers to the cell for `messageId`. */
async function mentionOf(messageId: string): Promise<MentionPayload> {
  const ev = await cell.waitFor(
    (e) => e.type === "agent.mention.v1" && (e.data as unknown as MentionPayload).message?.id === messageId,
    30_000,
  );
  return ev.data as unknown as MentionPayload;
}

/** Scout's sandbox calls for a turn: write the report, then run the script the fake cannot run (exit 127). */
async function writeAndRun(m: MentionPayload) {
  expect(
    await cell.sandbox(m, "ocw_sandbox_write", {
      path: "reports/late.csv",
      content: LATE_CSV,
      mode: "overwrite",
    }),
  ).toBe("wrote reports/late.csv (4096 bytes)");
  expect(
    await cell.sandbox(m, "ocw_sandbox_exec", { argv: ["python", "fetch.py", "--since", "2026-10-01"] }),
  ).toContain("exit 127");
}

/** The bot's reply row whose text contains `text`. */
function replyRow(page: Page, text: string): Locator {
  return page.locator('[data-testid="message"][data-author-kind="agent"]').filter({ hasText: text }).last();
}

/** axe (light and dark), named controls, no sideways scroll, 44 px targets below 1024. */
async function invariants(page: Page, label: string, root: Locator, selector: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    expect.soft(await unnamedControls(page), `${label} (${theme}): unnamed controls`).toEqual([]);
    await expectNoSidewaysScroll(page, `${label} (${theme})`);
    await expectNoSeriousA11y(page, selector);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await expectTouchTargets(page, root);
}

async function selectorOf(row: Locator): Promise<string> {
  const id = await row.getAttribute("data-message-id");
  expect(id, "the reply's message id").toBeTruthy();
  return `[data-message-id="${id}"] [data-testid="bot-activity"]`;
}

test("Sam sees what Scout did in its sandbox above the reply: collapsed, then the masked steps", async ({
  browser,
}, info) => {
  const project = info.project.name;
  const page = await signIn(browser, SAM, project);
  await page.goto(`${BASE_URL}/chat/dm/${dmId}`);
  await expect(page.getByTestId("composer")).toBeVisible();

  const asked = await postAs(samApi, dmId, `Which orders are late? ${widthOf(project)}`);
  const m = await mentionOf(asked.id);
  await writeAndRun(m);
  await cell.reply(m, REPLY);

  const row = replyRow(page, REPLY);
  await expect(row).toBeVisible({ timeout: 20_000 });
  const group = row.getByTestId("bot-activity");
  const toggle = group.getByTestId("bot-activity-toggle");
  await expect(toggle).toHaveText("Used its sandbox · 2 steps");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(group.getByRole("list", { name: "Steps" })).toBeHidden();
  // Above the reply text, inside the same message.
  const [t, body] = await Promise.all([toggle.boundingBox(), row.getByText(REPLY).boundingBox()]);
  expect(t && body && t.y < body.y, "the activity sits above the reply").toBe(true);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const steps = group.getByTestId("activity-step");
  await expect(steps).toHaveCount(2);
  await expect(steps.nth(0)).toContainText("Wrote");
  await expect(steps.nth(0).getByTestId("activity-target")).toHaveText("reports/late.csv · 4 KB");
  await expect(steps.nth(1)).toContainText("Ran");
  await expect(steps.nth(1).getByTestId("activity-target")).toHaveText("python fetch.py --since 2026-10-01");
  await expect(steps.nth(1).getByTestId("activity-outcome")).toHaveText("Exit 127");

  const run = steps.nth(1).getByRole("button", { name: /^Ran python fetch\.py .*, failed, exit 127$/ });
  await run.click();
  await expect(run).toHaveAttribute("aria-expanded", "true");
  const details = steps.nth(1).getByTestId("activity-details");
  await expect(details).toContainText("$ python fetch.py --since 2026-10-01");
  await expect(details).toContainText(/in workspace · exit 127 · \d/);
  await expect(details.locator("pre")).toHaveText("sh: python: not found");

  await invariants(page, `activity ${widthOf(project)}`, group, await selectorOf(row));
  await row.evaluate((el) => {
    (document.activeElement as HTMLElement | null)?.blur();
    el.scrollIntoView({ block: "end" });
  });
  await captureReview(page, `chat-activity-${widthOf(project)}`);
});

test("in a channel another reader sees the same activity; someone who cannot read the DM never receives it", async ({
  browser,
}, info) => {
  const project = info.project.name;
  const channel = await freshChannel(admin, [samApi, alexApi], "orders");
  const added = await admin.post(`/api/v1/channels/${channel.id}/members`, {
    data: { kind: "agent", id: botId },
  });
  expect(added.ok(), `add ${BOT} to #${channel.name}`).toBe(true);

  // Alex reads the channel (and never Sam's DM) while both turns run; every frame and API answer he gets is kept.
  const alex = await signIn(browser, ALEX, project);
  const frames: string[] = [];
  const bodies: Promise<string>[] = [];
  alex.on("websocket", (ws) => ws.on("framereceived", (f) => frames.push(String(f.payload))));
  alex.on("response", (r) => {
    if (r.url().includes("/api/")) bodies.push(r.text().catch(() => ""));
  });
  await alex.goto(`${BASE_URL}/chat/${channel.id}`);
  await expect(alex.getByTestId("composer")).toBeVisible();

  // ---- a turn in Sam's DM: its event id and reply never reach Alex
  const inDm = await postAs(samApi, dmId, "Run it again, privately");
  const dmTurn = await mentionOf(inDm.id);
  await writeAndRun(dmTurn);
  const dmReply = await cell.reply(dmTurn, "Done privately.");

  // ---- a turn in the channel: Alex sees its activity above the reply
  const inChannel = await postAs(samApi, channel.id, `@${BOT} which orders are late?`, {
    mentions: [{ kind: "agent", id: botId }],
  });
  const chTurn = await mentionOf(inChannel.id);
  await writeAndRun(chTurn);
  await cell.reply(chTurn, REPLY);

  const thread = alex.getByTestId("thread-summary").last();
  await expect(thread).toBeVisible({ timeout: 20_000 });
  await thread.click();
  const panel = alex.getByTestId("thread-panel");
  const row = replyRow(panel, REPLY);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.getByTestId("bot-activity-toggle")).toHaveText("Used its sandbox · 2 steps");
  await row.getByTestId("bot-activity-toggle").click();
  await expect(row.getByTestId("activity-step")).toHaveCount(2);
  await expect(row.getByTestId("activity-step").nth(0)).toContainText("Wrote reports/late.csv · 4 KB");

  // The DM's turn is not readable for Alex: no event id, no reply id, no reply text, nowhere.
  const dmRead = await alexApi.get(`/api/v1/conversations/${dmId}/messages`);
  expect([403, 404]).toContain(dmRead.status());
  await alex.waitForTimeout(1500);
  expect(frames.length, "Alex's page received realtime frames").toBeGreaterThan(0);
  const all = [...frames, ...(await Promise.all(bodies)), await alex.content()];
  for (const secret of [dmTurn.eventId, dmReply.messageId, "Done privately."]) {
    expect(
      all.filter((s) => s.includes(secret)),
      `Alex never receives ${secret}`,
    ).toEqual([]);
  }
});
