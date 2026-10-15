import { type APIRequestContext, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { apiAs, BASE_URL, ensureMember, openAs, SAM, userIdOf } from "../support/actors";
import {
  clearApprovalPolicies,
  clearPendingApprovals,
  ensureUnitRole,
  LUIS,
  MARTA,
  NORTHWIND_CRM,
  openApprovals,
  seedApprovalMcp,
  seedApprovalPeople,
  setApprovalPolicy,
} from "../support/approvals";
import { freshTeamBot } from "../support/bot-tools";
import { cellToken } from "../support/cell-token";
import { freshChannel, postAs } from "../support/chat";
import { type CardActionPayload, FakeCellPlugin, type MentionPayload } from "../support/fake-cell-plugin";
import { captureReview, expectNoSidewaysScroll } from "../support/layout";
import { ADMIN, API_URL } from "./env";

/**
 * 07.5-15 (APPROVE-01, APPROVE-02, D-02, D-04, C-03): the two approval journeys end to end, as people live them, with
 * the fake cell (no model, no provider).
 *
 * 1. Sam asks his bot in their DM. An "Always ask" rule stops `write_note`; the exact card appears; Sam approves in the
 *    card; the bot runs it once with exactly those values and says so; the card reads Used.
 * 2. Sam triggers a Sales-rule action in #ops. Marta (a lead of Sales) approves from /approvals; the re-run is Sam's
 *    turn in #ops (the bot's reply arrives there); Sam's card reads Used; Luis (in #ops, outside Sales) only ever sees
 *    the summary.
 *
 * Frames: approvals-journey-dm-{ask,used}-<w> and approvals-journey-channel-{review,used,summary}-<w> (each -dark).
 */

test.describe.configure({ mode: "serial" });

const BOT = "Quill";

let admin: APIRequestContext;
let samApi: APIRequestContext;
let martaApi: APIRequestContext;
let luisApi: APIRequestContext;
let samId: string;
let salesId: string;
let safeName: string;
let botId: string;
let dmId: string;
let cell: FakeCellPlugin;
/** The persona's own calls when a message says `[[persona]]`: values that must never be in the channel's messages. */
let personaCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];

const writeNote = () => `${safeName}__write_note`;
const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");
const toast = (page: Page, text: string) => page.locator("[data-sonner-toast]").filter({ hasText: text });
const agentReply = (page: Page, text: string) =>
  page.locator('[data-testid="message"][data-author-kind="agent"]').filter({ hasText: text });

/** The newest pending `tool.call` request `api` may decide. */
async function newestCall(api: APIRequestContext): Promise<{ id: string; actionHash: string }> {
  let found: { id: string; actionHash: string } | undefined;
  await expect
    .poll(
      async () => {
        const res = await api.get("/api/v1/approvals?role=decider&status=pending&kinds=tool.call");
        const items = (
          (await res.json()) as { items: Array<{ id: string; actionHash: string; createdAt: string }> }
        ).items;
        found = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        return found?.id ?? "";
      },
      { timeout: 20_000, message: "a pending tool.call request" },
    )
    .not.toBe("");
  return found as { id: string; actionHash: string };
}

/** The approved card action whose grant carries `text`. */
function grantFor(text: string): CardActionPayload | undefined {
  return cell.events
    .filter((e) => e.type === "agent.card_action.v1")
    .map((e) => e.data as unknown as CardActionPayload)
    .find(
      (a) => a.cardAction?.outcome === "approved" && (a.cardAction.grant?.arguments ?? "").includes(text),
    );
}

/** A frame of the journey with the card (or the review) fully in view and nothing focused inside it. */
async function frame(page: Page, name: string, target?: ReturnType<Page["getByTestId"]>) {
  await expectNoSidewaysScroll(page, name);
  if (target) {
    await target.evaluate((el) => {
      (document.activeElement as HTMLElement | null)?.blur();
      el.scrollIntoView({ block: "end" });
    });
  }
  await captureReview(page, name);
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  expect(cellToken(), "OCW_CELL_TOKEN is configured").not.toBe("");
  admin = await apiAs(ADMIN);
  samId = await ensureMember(admin, SAM, "developer");
  samApi = await apiAs(SAM);
  expect(await userIdOf(samApi)).toBe(samId);
  ({ safeName } = await seedApprovalMcp(admin));
  salesId = (await seedApprovalPeople(admin)).salesId;
  martaApi = await apiAs(MARTA);
  luisApi = await apiAs(LUIS);
  await ensureUnitRole(admin, salesId, samId, "member");

  botId = await freshTeamBot(admin, BOT);
  const servers = (await (await admin.get("/api/v1/mcp-servers")).json()) as {
    servers: Array<{ id: string; name: string }>;
  };
  const crm = servers.servers.find((s) => s.name === NORTHWIND_CRM);
  expect(crm, "Northwind CRM is registered").toBeTruthy();
  const granted = await admin.patch(`/api/v1/agents/${botId}/capabilities`, {
    data: {
      tools: ["write_note", "echo"].map((t) => ({
        sourceKind: "mcp",
        sourceId: crm?.id,
        tool: `${safeName}__${t}`,
      })),
    },
  });
  expect(granted.ok(), `grant Northwind CRM to ${BOT}: ${granted.status()} ${await granted.text()}`).toBe(
    true,
  );
  const dm = await samApi.post(`/api/v1/agents/${botId}/dm`);
  expect(dm.ok(), `Sam's DM with ${BOT}`).toBe(true);
  dmId = ((await dm.json()) as { dmId: string }).dmId;

  for (const api of [samApi, martaApi, admin]) await clearPendingApprovals(api);
  cell = new FakeCellPlugin({
    apiUrl: API_URL,
    token: cellToken(),
    autoAck: true,
    autoReply: true,
    toolCallsFor: (m: MentionPayload) => (m.message.text.includes("[[persona]]") ? personaCalls : []),
  });
  await cell.start();
});

test.beforeEach(async () => {
  personaCalls = [];
  await clearApprovalPolicies(admin);
  for (const api of [samApi, martaApi, admin]) await clearPendingApprovals(api);
});

test.afterAll(async () => {
  await clearApprovalPolicies(admin).catch(() => undefined);
  for (const api of [samApi, martaApi, admin]) await clearPendingApprovals(api).catch(() => undefined);
  await admin?.delete(`/api/v1/units/${salesId}/members/${samId}`).catch(() => undefined);
  await cell?.stop();
  for (const api of [luisApi, martaApi, samApi, admin]) await api?.dispose();
});

test("journey 1: Sam asks in the DM, approves in the card, and the bot runs it once", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const project = info.project.name;
  const w = widthOf(project);
  await setApprovalPolicy(admin, {
    scopeUnitId: null,
    toolPattern: writeNote(),
    mode: "always",
    approverKind: "requester",
  });
  const text = `Order 40 spare valves for plant B (${w})`;
  const args = { text, to: "purchasing@globex.example" };
  const sam = await openAs(browser, SAM, project);
  try {
    await sam.page.goto(`${BASE_URL}/chat/dm/${dmId}`);
    const box = sam.page.getByTestId("composer");
    await box.click();
    await box.fill(`Place the order [[call write_note ${JSON.stringify(args)}]]`);
    await box.press("Enter");

    // ---- ask: the exact card, waiting for Sam; no call has run yet
    await expect(agentReply(sam.page, `Tool ${writeNote()}: approval_required`)).toHaveCount(1, {
      timeout: 30_000,
    });
    const card = sam.page
      .locator('[data-testid="agent-card"][data-kind="approval"]')
      .filter({ hasText: "Run write_note on Northwind CRM" })
      .last();
    await expect(card.getByTestId("agent-card-status")).toHaveText("Pending", { timeout: 15_000 });
    await expect(card.getByTestId("agent-card-value-field-text")).toContainText(text);
    await expect(card.getByTestId("agent-card-value-field-to")).toHaveText("purchasing@globex.example");
    expect(cell.grantReruns.filter((r) => r.tool === writeNote())).toHaveLength(0);
    await frame(sam.page, `approvals-journey-dm-ask-${w}`, card);

    // ---- approve once, in the card
    await card.getByTestId("agent-card-approve").click();
    const dialog = sam.page.getByTestId("agent-card-confirm");
    await expect(dialog).toContainText("Approve this action?");
    await dialog.getByTestId("agent-card-confirm-submit").click();
    await expect(toast(sam.page, `Approved. ${BOT} runs it once.`)).toBeVisible({ timeout: 15_000 });

    // ---- the result: one re-run with exactly these values, the bot says so, the card reads Used
    await expect
      .poll(() => cell.grantReruns.filter((r) => r.tool === writeNote()).flatMap((r) => r.lines), {
        timeout: 30_000,
      })
      .toEqual([`Tool ${writeNote()}: allowed`]);
    expect(JSON.parse(grantFor(text)?.cardAction.grant?.arguments ?? "{}")).toEqual(args);
    await expect(agentReply(sam.page, `Tool ${writeNote()}: allowed`)).toHaveCount(1, { timeout: 15_000 });
    await expect(card.getByTestId("agent-card-status")).toHaveText("Used", { timeout: 20_000 });
    await expect(card.getByTestId("agent-card-state-line")).toHaveText(
      /^Ran once at \d{1,2}:\d{2}\s?[AP]M\.$/,
    );
    // axe on the card, as every 07.5 card spec does (the composer around it is not this phase's surface).
    const messageId = await card
      .locator("xpath=ancestor::*[@data-message-id][1]")
      .getAttribute("data-message-id");
    await expectNoSeriousA11y(sam.page, `[data-message-id="${messageId}"] [data-testid="agent-card"]`);
    await frame(sam.page, `approvals-journey-dm-used-${w}`, card);
  } finally {
    await sam.context.close();
  }
});

test("journey 2: a Sales lead approves a member's channel action from /approvals; the re-run is the member's", async ({
  browser,
}, info) => {
  test.setTimeout(300_000);
  const project = info.project.name;
  const w = widthOf(project);
  await setApprovalPolicy(admin, {
    scopeUnitId: salesId,
    toolPattern: writeNote(),
    mode: "always",
    approverKind: "unit_leads",
  });
  const channel = await freshChannel(admin, [samApi, martaApi, luisApi], "ops");
  const added = await admin.post(`/api/v1/channels/${channel.id}/members`, {
    data: { kind: "agent", id: botId },
  });
  expect(added.ok(), `add ${BOT} to #${channel.name}`).toBe(true);
  const text = `Credit note for Initech, 120 EUR (${w})`;
  const args = { text, to: "accounts@initech.example" };

  let sam: { context: BrowserContext; page: Page } | null = null;
  let marta: { context: BrowserContext; page: Page } | null = null;
  let luis: { context: BrowserContext; page: Page } | null = null;
  try {
    // ---- Luis is reading #ops, Sam asks there
    luis = await openAs(browser, LUIS, project);
    const frames: string[] = [];
    luis.page.on("websocket", (ws) => ws.on("framereceived", (f) => frames.push(String(f.payload))));
    await luis.page.goto(`${BASE_URL}/chat/${channel.id}`);
    await expect(luis.page.getByTestId("composer")).toBeVisible();
    const before = cell.toolCallRequests.length;
    // The values come from the persona, never from the chat message (which every #ops member reads).
    personaCalls = [{ tool: "write_note", args }];
    await postAs(samApi, channel.id, `@${BOT} please file the credit note [[persona]]`, {
      mentions: [{ kind: "agent", id: botId }],
    });
    await expect
      .poll(() => cell.toolCallRequests.slice(before).find((r) => r.tool === writeNote())?.arguments?.text, {
        timeout: 30_000,
      })
      .toBe(text);
    const { id } = await newestCall(martaApi);

    // ---- Marta approves from her inbox: the review shows exactly what will run
    marta = await openAs(browser, MARTA, project);
    await openApprovals(marta.page);
    const row = marta.page.getByTestId(`approval-row-${id}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    const view = marta.page.getByTestId("tool-call-view");
    await expect(view).toBeVisible({ timeout: 15_000 });
    await expect(view.getByTestId("approval-meta")).toContainText(`${BOT} for Sam Lee`);
    await expect(view.getByTestId("approval-fact-approvers")).toContainText("Leads of Sales");
    await expect(view).toContainText(text);
    await frame(marta.page, `approvals-journey-channel-review-${w}`);
    await marta.page.getByTestId("approval-approve").click();
    await marta.page.getByTestId("approval-confirm").getByTestId("approval-confirm-submit").click();
    await expect(toast(marta.page, `Approved. ${BOT} runs it once.`)).toBeVisible({ timeout: 15_000 });

    // ---- the re-run is Sam's turn in #ops, once, with exactly those values; the bot's reply arrives there
    await expect.poll(() => grantFor(text)?.message.author.id, { timeout: 30_000 }).toBe(samId);
    const rerun = grantFor(text) as CardActionPayload;
    expect(rerun.conversation.id).toBe(channel.id);
    expect(rerun.cardAction.decidedBy?.displayName).toBe("Marta Gil");
    expect(JSON.parse(rerun.cardAction.grant?.arguments ?? "{}")).toEqual(args);
    await expect
      .poll(() => cell.grantReruns.filter((r) => r.eventId === rerun.eventId).flatMap((r) => r.lines), {
        timeout: 30_000,
      })
      .toEqual([`Tool ${writeNote()}: allowed`]);

    // ---- Sam's card in #ops reads Used (he sees the summary: the details stay on the review)
    sam = await openAs(browser, SAM, project);
    await sam.page.goto(`${BASE_URL}/chat/${channel.id}`);
    const samsCard = sam.page
      .locator('[data-testid="agent-card"][data-kind="approval"]')
      .filter({ hasText: `${BOT} wants to run write_note for Sam Lee` })
      .last();
    await expect(samsCard.getByTestId("agent-card-status")).toHaveText("Used", { timeout: 20_000 });
    await expect(samsCard.getByTestId("agent-card-open")).toHaveAttribute("href", `/approvals/${id}`);
    await frame(sam.page, `approvals-journey-channel-used-${w}`, samsCard);

    // ---- Luis (outside Sales) only ever had the summary: no value on his page or in any frame he received
    const luisCard = luis.page
      .locator('[data-testid="agent-card"][data-kind="approval"]')
      .filter({ hasText: `${BOT} wants to run write_note for Sam Lee` })
      .last();
    await expect(luisCard.getByTestId("agent-card-status")).toHaveText("Used", { timeout: 20_000 });
    await expect(luisCard.getByTestId("agent-card-open")).toHaveCount(0);
    await expect(luisCard.getByRole("button")).toHaveCount(0);
    expect(await luis.page.content()).not.toContain(text);
    expect(frames.length, "Luis's page received realtime frames").toBeGreaterThan(0);
    expect(frames.filter((f) => f.includes(text))).toEqual([]);
    await frame(luis.page, `approvals-journey-channel-summary-${w}`, luisCard);
  } finally {
    await sam?.context.close();
    await marta?.context.close();
    await luis?.context.close();
  }
});
