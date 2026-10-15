import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { apiAs, BASE_URL, ensureMember, openAs, SAM, userIdOf } from "../support/actors";
import {
  clearApprovalPolicies,
  clearPendingApprovals,
  ensureUnitRole,
  MARTA,
  NORTHWIND_CRM,
  openApprovals,
  proposeWorkZoneFromDm,
  seedApprovalMcp,
  seedApprovalPeople,
  setApprovalPolicy,
} from "../support/approvals";
import { freshTeamBot } from "../support/bot-tools";
import { cellToken } from "../support/cell-token";
import { freshChannel, postAs } from "../support/chat";
import { type CardActionPayload, FakeCellPlugin, type MentionPayload } from "../support/fake-cell-plugin";
import {
  captureReview,
  expectNoSidewaysScroll,
  expectTouchTargets,
  unnamedControls,
} from "../support/layout";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import { ADMIN, API_URL } from "./env";

/**
 * 07.5-13 (APPROVE-02, D-02, D-04, UI-SPEC Surface 2, R7, R11, C-03): the action review in `/approvals`, end to end with
 * the fake cell (no model, no provider). An "Always ask" rule on Northwind CRM's `write_note` stops the bot; Sam opens the
 * review from the inbox, sees exactly what will be sent (fact strip, ACTION, WHAT LEDGER WILL SEND, the canonical JSON),
 * approves, and the bot runs it exactly once and replies. Then four-eyes (a Sales lead approves a member's channel
 * request while the member sees the waiting footer), deny with a note the bot hears, a second decider who comes too late
 * ("Someone already decided this."), and a 32 KB arguments object that scrolls inside its viewer. Phone, dark, axe and
 * the reviewed screenshots: approvals-inbox-<w>, approval-review-<w>, approval-review-four-eyes-1440,
 * approval-deny-dialog-390 (each with -dark).
 */

test.describe.configure({ mode: "serial" });

const BOT = "Ledger";
const DEVICE = "MacBook Pro";
const PROJECT = "billing-api";

let admin: APIRequestContext;
let samApi: APIRequestContext;
let martaApi: APIRequestContext;
let samId: string;
let martaId: string;
let adminId: string;
let salesId: string;
let safeName: string;
let botId: string;
let dmId: string;
let cell: FakeCellPlugin;
let device: FakeDeviceHandle | null = null;
/** The persona's own call when a message says `[[big]]` (a 32 KB object cannot travel in a chat message). */
let bigArgs: Record<string, unknown> | null = null;

const writeNote = () => `${safeName}__write_note`;
const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");
const toast = (page: Page, text: string) => page.locator("[data-sonner-toast]").filter({ hasText: text });

type DetailJson = {
  id: string;
  kind: string;
  status: string;
  actionHash: string;
  decidedBy: { displayName: string } | null;
  view: { type: string; argumentsJson: string; argumentsBytes: number; usedAt: string | null };
};

async function detailOf(api: APIRequestContext, id: string): Promise<DetailJson> {
  const res = await api.get(`/api/v1/approvals/${id}`);
  expect(res.ok(), `GET approval ${id}: ${res.status()}`).toBe(true);
  return (await res.json()) as DetailJson;
}

/** The newest pending `tool.call` request `api` may decide (the bot never shows its id). */
async function newestPendingCall(api: APIRequestContext): Promise<string> {
  let id = "";
  await expect
    .poll(
      async () => {
        const res = await api.get("/api/v1/approvals?role=decider&status=pending&kinds=tool.call");
        const items = ((await res.json()) as { items: Array<{ id: string; createdAt: string }> }).items;
        id = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id ?? "";
        return id;
      },
      { timeout: 20_000, message: "a pending tool.call request" },
    )
    .not.toBe("");
  return id;
}

/** Sends `text` in the open conversation and returns the bot's new reply that contains `expectText`. */
async function ask(page: Page, text: string, expectText: string): Promise<Locator> {
  const reply = page
    .locator('[data-testid="message"][data-author-kind="agent"]')
    .filter({ hasText: expectText });
  const before = await reply.count();
  const box = page.getByTestId("composer");
  await box.click();
  await box.fill(text);
  await box.press("Enter");
  await expect(reply).toHaveCount(before + 1, { timeout: 30_000 });
  return reply.last();
}

/** The screen's invariants: named controls, no sideways scroll, 44 px targets below 1024, axe in light and dark. */
async function invariants(
  page: Page,
  label: string,
  selector: string,
  touchRoot = '[data-testid="approvals-shell"]',
) {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    expect(await unnamedControls(page), `${label} (${theme}): controls without a name`).toEqual([]);
    await expectNoSidewaysScroll(page, `${label} (${theme})`);
    await expectTouchTargets(page, touchRoot);
    await expectNoSeriousA11y(page, selector);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/** The review of `id`, opened from its inbox row (desktop: beside the list; phone: its own screen). */
async function openReview(page: Page, id: string): Promise<Locator> {
  const row = page.getByTestId(`approval-row-${id}`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/approvals/${id}`));
  const view = page.getByTestId("tool-call-view");
  await expect(view).toBeVisible({ timeout: 15_000 });
  return view;
}

/** Opens the review of `id` by its URL (the requester's own view of a request someone else decides). */
async function gotoReview(page: Page, id: string, query = ""): Promise<Locator> {
  await page.goto(`${BASE_URL}/approvals/${id}${query}`);
  const view = page.getByTestId("tool-call-view");
  await expect(view).toBeVisible({ timeout: 15_000 });
  return view;
}

/** The `<dt>` labels of a field list, in order. */
const labelsOf = (list: Locator) => list.locator(":scope > div > dt").allInnerTexts();

/** Sam asks the bot in the Sales channel (a mention through the API, like the composer) and returns the message id. */
async function askInChannel(channelId: string, text: string): Promise<string> {
  const before = cell.toolCallRequests.length;
  const msg = await postAs(samApi, channelId, `@${BOT} ${text}`, {
    mentions: [{ kind: "agent", id: botId }],
  });
  await expect
    .poll(() => cell.toolCallRequests.slice(before).some((r) => r.tool === writeNote()), { timeout: 30_000 })
    .toBe(true);
  return msg.id;
}

/** The approved card action whose grant's canonical arguments contain `text`. */
function cardActionFor(text: string): CardActionPayload | undefined {
  return cell.events
    .filter((e) => e.type === "agent.card_action.v1")
    .map((e) => e.data as unknown as CardActionPayload)
    .find(
      (a) => a.cardAction?.outcome === "approved" && (a.cardAction.grant?.arguments ?? "").includes(text),
    );
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const token = cellToken();
  expect(token, "OCW_CELL_TOKEN is configured").not.toBe("");
  admin = await apiAs(ADMIN);
  adminId = await userIdOf(admin);
  samId = await ensureMember(admin, SAM, "developer");
  samApi = await apiAs(SAM);
  ({ safeName } = await seedApprovalMcp(admin));
  const people = await seedApprovalPeople(admin);
  martaId = people.martaId;
  salesId = people.salesId;
  martaApi = await apiAs(MARTA);
  // Sam works in Sales (a member, not a lead): a Sales rule reaches his requests.
  await ensureUnitRole(admin, salesId, samId, "member");

  // Ledger, a team bot with Northwind CRM's two tools, and Sam's DM with it.
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

  // Requests an earlier spec left pending are closed before this cell listens, so it never answers their denials.
  for (const api of [samApi, martaApi, admin]) await clearPendingApprovals(api);
  cell = new FakeCellPlugin({
    apiUrl: API_URL,
    token,
    autoAck: true,
    autoReply: true,
    replyOnDenied: true,
    toolCallsFor: (m: MentionPayload) =>
      m.message.text.includes("[[big]]") && bigArgs ? [{ tool: "write_note", args: bigArgs }] : [],
  });
  await cell.start();

  // A device for the Work Zone row of the inbox screenshots (an earlier, interrupted run may have left one behind).
  const listed = (await (await samApi.get("/api/v1/devices")).json()) as {
    devices: Array<{ id: string; name: string; ownerUserId: string }>;
  };
  for (const d of listed.devices.filter((x) => x.name === DEVICE && x.ownerUserId === samId)) {
    await samApi.delete(`/api/v1/devices/${d.id}`);
  }
  device = await startFakeDevice(samApi, { name: DEVICE, projectName: PROJECT });
});

test.beforeEach(async () => {
  bigArgs = null;
  await clearApprovalPolicies(admin);
  for (const api of [samApi, martaApi, admin]) await clearPendingApprovals(api);
});

test.afterAll(async () => {
  await clearApprovalPolicies(admin).catch(() => undefined);
  for (const api of [samApi, martaApi, admin]) await clearPendingApprovals(api).catch(() => undefined);
  await admin?.delete(`/api/v1/units/${salesId}/members/${samId}`).catch(() => undefined);
  await device?.stop();
  device = null;
  await cell?.stop();
  await martaApi?.dispose();
  await samApi?.dispose();
  await admin?.dispose();
});

test("Sam approves his bot's note from the review and the bot runs it once", async ({ browser }, info) => {
  test.setTimeout(300_000);
  const project = info.project.name;
  const w = widthOf(project);
  const mobile = project === "mobile";
  if (!device) throw new Error("no device");
  await setApprovalPolicy(admin, {
    scopeUnitId: null,
    toolPattern: writeNote(),
    mode: "always",
    approverKind: "requester",
  });
  const note = `Invoice for September, 3 plants (${w})`;
  const args = { text: note, to: "billing@globex.example", amount: 1250 };
  const sam = await openAs(browser, SAM, project);
  try {
    // ---- the bot asks: approval required, no call yet
    await sam.page.goto(`${BASE_URL}/chat/dm/${dmId}`);
    await expect(sam.page.getByTestId("dm-view")).toBeVisible();
    await ask(
      sam.page,
      `Save it [[call write_note ${JSON.stringify(args)}]]`,
      `Tool ${writeNote()}: approval_required`,
    );
    const id = await newestPendingCall(samApi);
    expect(cell.grantReruns.filter((r) => r.tool === writeNote())).toHaveLength(0);

    // ---- the nav badge: Approvals 1
    if (mobile) await sam.page.getByTestId("mobile-nav-trigger").click();
    const nav = sam.page.getByTestId("nav-approvals").filter({ visible: true }).first();
    await expect(nav).toHaveAccessibleName("Approvals, 1 to review", { timeout: 15_000 });
    if (mobile) await sam.page.keyboard.press("Escape");

    // ---- a Work Zone proposal too, so the inbox shows both kinds
    const wzId = await proposeWorkZoneFromDm(sam.page, cell, {
      projectId: device.projectId,
      deviceId: device.deviceId,
      prompt: "Fix the rounding error in invoice totals.",
    });

    // ---- the inbox
    await openApprovals(sam.page);
    const row = sam.page.getByTestId(`approval-row-${id}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(sam.page.getByTestId(`approval-row-${wzId}`)).toBeVisible();
    await expect(row).toContainText("Run write_note on Northwind CRM");
    await expect(row).toContainText(`${BOT} for you`);
    await expect(row).toContainText("DM");
    await expect(row).toContainText(NORTHWIND_CRM);
    await expect(sam.page.getByTestId("approvals-review-count")).toHaveText("2");
    if (mobile) {
      // WINDOWS #223: the phone top bar carries the section's count, as the UI-SPEC's "☰ Approvals ②" (the visual
      // count is aria-hidden; screen readers hear the count in words).
      await expect(sam.page.getByTestId("mobile-topbar-count")).toHaveText("2");
      await expect(sam.page.getByTestId("mobile-topbar-title").locator(".sr-only")).toHaveText(
        "Approvals, 2 to review",
      );
    }
    await invariants(
      sam.page,
      `inbox ${w}`,
      mobile ? '[data-testid="approvals-shell"]' : '[data-testid="approvals-inbox"]',
    );
    await captureReview(sam.page, `approvals-inbox-${w}`);

    // ---- the review: who approves, who sees it, the action, what will be sent, all arguments
    const view = await openReview(sam.page, id);
    await expect(view.getByTestId("approval-title")).toHaveText("Run write_note on Northwind CRM");
    await expect(view.getByTestId("approval-status").first()).toHaveText("Pending");
    await expect(view.getByTestId("approval-meta")).toContainText(`${BOT} for you`);
    await expect(view.getByTestId("approval-fact-approvers")).toContainText("You");
    await expect(view.getByTestId("approval-fact-approvers")).toContainText("approve this");
    await expect(view.getByTestId("approval-fact-readers")).toContainText("Only you");
    await expect(view.getByTestId("approval-fact-readers")).toContainText("can see the details");
    await expect(view.getByTestId("approval-fact-taint")).toHaveCount(0);
    await expect(view.getByTestId("tool-call-tool")).toContainText("write_note");
    await expect(view.getByTestId("tool-call-tool")).not.toContainText("__");
    await expect(view.getByTestId("tool-call-source")).toContainText(`${NORTHWIND_CRM} · MCP server`);
    await expect(view.getByTestId("tool-call-asked-in")).toContainText(
      `your DM with ${BOT} · only you see this card`,
    );
    await expect(view.getByTestId("tool-call-open-message")).toBeVisible();
    await expect(view.getByTestId("tool-call-why")).toContainText(
      "Organization rule: Always ask for write_note",
    );
    await expect(view.getByTestId("tool-call-why").getByRole("link")).toHaveCount(0);
    await expect(view).toContainText(`What ${BOT} will send`);
    expect(await labelsOf(view.getByTestId("tool-call-preview"))).toEqual(["To", "Amount", "Text"]);
    await expect(view.getByTestId("preview-field-to")).toContainText("billing@globex.example");
    await expect(view.getByTestId("preview-field-to").locator("a")).toHaveCount(0);
    // ALL ARGUMENTS: the canonical JSON approval binds to, keys sorted, exactly as the server gave it.
    const json = view.getByTestId("arguments-json");
    expect(await json.textContent()).toBe(
      `{\n  "amount": 1250,\n  "text": ${JSON.stringify(note)},\n  "to": "billing@globex.example"\n}`,
    );
    expect(await json.textContent()).toBe((await detailOf(samApi, id)).view.argumentsJson);
    await expect(json).toHaveAttribute("role", "region");
    await expect(json).toHaveAttribute("tabindex", "0");
    await expect(json).toHaveAccessibleName(/^All arguments, \d+ B$/);
    await expect(view).toContainText(`Written by ${BOT}. These exact values run once if you approve.`);
    if (mobile) {
      // Labels over values below 640; the viewer caps at 360 and the decision bar sits at the bottom, 44 px tall.
      const to = view.getByTestId("preview-field-to");
      const dt = await to.locator("dt").boundingBox();
      const dd = await to.locator("dd").boundingBox();
      expect((dt?.y ?? 0) + (dt?.height ?? 0)).toBeLessThanOrEqual((dd?.y ?? 0) + 1);
      expect(await json.evaluate((el) => getComputedStyle(el).maxHeight)).toBe("360px");
      for (const b of [sam.page.getByTestId("approval-deny"), sam.page.getByTestId("approval-approve")]) {
        expect((await b.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      }
    } else {
      expect(await json.evaluate((el) => getComputedStyle(el).maxHeight)).toBe("480px");
    }
    await invariants(sam.page, `review ${w}`, '[data-testid="tool-call-view"]');
    await captureReview(sam.page, `approval-review-${w}`);

    // ---- Approve: confirm first, Cancel focused, the exact consequence in words
    await sam.page.getByTestId("approval-approve").click();
    const dialog = sam.page.getByTestId("approval-confirm");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Approve this action?");
    await expect(dialog).toContainText(
      `${BOT} can run write_note once, with exactly these values, within 15 minutes. It runs with the organization's account.`,
    );
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await expectNoSeriousA11y(sam.page, '[data-testid="approval-confirm"]');
    await dialog.getByTestId("approval-confirm-submit").click();
    await expect(toast(sam.page, `Approved. ${BOT} runs it once.`)).toBeVisible({ timeout: 15_000 });

    // ---- the bot runs it once, with exactly these values, and replies
    await expect
      .poll(() => cell.grantReruns.filter((r) => r.tool === writeNote()).flatMap((r) => r.lines), {
        timeout: 30_000,
      })
      .toEqual([`Tool ${writeNote()}: allowed`]);
    const granted = cardActionFor(note);
    expect(granted?.message.author.id, "the re-run is Sam's turn").toBe(samId);
    expect(JSON.parse(granted?.cardAction.grant?.arguments ?? "{}")).toEqual(args);
    await expect(view.getByTestId("approval-status").first()).toHaveText("Used", { timeout: 20_000 });
    const line = view.getByTestId("approval-decision-line");
    await expect(line).toContainText("Approved by Sam Lee");
    await expect(line).toContainText(/Used at \d{1,2}:\d{2}/);
    expect((await detailOf(samApi, id)).status).toBe("applied");

    // ---- the bot's reply in the DM, reached from the review's Open message
    await view.getByTestId("tool-call-open-message").click();
    await expect(sam.page).toHaveURL(new RegExp(`/chat/dm/${dmId}`));
    await expect(
      sam.page
        .locator('[data-testid="message"][data-author-kind="agent"]')
        .filter({ hasText: `Tool ${writeNote()}: allowed` }),
    ).toHaveCount(1, { timeout: 15_000 });
    expect(cell.grantReruns.filter((r) => r.tool === writeNote())).toHaveLength(1);
  } finally {
    await clearPendingApprovals(samApi).catch(() => undefined);
    await sam.context.close();
  }
});

test("four-eyes: a Sales lead approves a member's channel request while the member sees the waiting footer", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const project = info.project.name;
  const w = widthOf(project);
  await setApprovalPolicy(admin, {
    scopeUnitId: salesId,
    toolPattern: writeNote(),
    mode: "always",
    approverKind: "unit_leads",
  });
  const channel = await freshChannel(admin, [samApi], "sales");
  const added = await admin.post(`/api/v1/channels/${channel.id}/members`, {
    data: { kind: "agent", id: botId },
  });
  expect(added.ok(), `add ${BOT} to the channel`).toBe(true);
  const text = `Invoice for Globex, four-eyes (${w})`;
  await askInChannel(
    channel.id,
    `save it [[call write_note ${JSON.stringify({ text, to: "ana@globex.example" })}]]`,
  );
  const id = await newestPendingCall(martaApi);

  let sam: { context: BrowserContext; page: Page } | null = null;
  let marta: { context: BrowserContext; page: Page } | null = null;
  try {
    // ---- Sam, the requester without the right: the waiting footer, no Approve
    sam = await openAs(browser, SAM, project);
    const mine = await gotoReview(sam.page, id, "?box=requested");
    // Requested lists it for Sam (desktop: beside the review, selected).
    if (w === "1440")
      await expect(sam.page.getByTestId(`approval-row-${id}`)).toHaveAttribute("aria-current", "page");
    await expect(mine.getByTestId("approval-fact-approvers")).toContainText("Leads of Sales");
    await expect(mine.getByTestId("approval-fact-readers")).toContainText("2");
    await expect(mine.getByTestId("tool-call-asked-in")).toContainText(`# ${channel.name}`);
    await expect(mine.getByTestId("tool-call-asked-in")).toContainText("see a summary card");
    await expect(sam.page.getByTestId("approval-waiting")).toHaveText(
      "Waiting for a lead of Sales. You can't approve your own request.",
    );
    await expect(sam.page.getByTestId("approval-approve")).toHaveCount(0);
    await expect(sam.page.getByTestId("approval-deny")).toHaveCount(0);
    await invariants(sam.page, `four-eyes ${w}`, '[data-testid="tool-call-view"]');
    if (w === "1440") await captureReview(sam.page, "approval-review-four-eyes-1440");

    // ---- Marta, a lead of Sales, approves from her inbox
    marta = await openAs(browser, MARTA, project);
    await openApprovals(marta.page);
    const view = await openReview(marta.page, id);
    await expect(view.getByTestId("approval-fact-approvers")).toContainText("Leads of Sales");
    await expect(view.getByTestId("approval-meta")).toContainText(`${BOT} for Sam Lee`);
    await marta.page.getByTestId("approval-approve").click();
    const dialog = marta.page.getByTestId("approval-confirm");
    await expect(dialog).toContainText(
      `${BOT} can run write_note once, with exactly these values, within 15 minutes. It runs with the organization's account.`,
    );
    await dialog.getByTestId("approval-confirm-submit").click();
    await expect(toast(marta.page, `Approved. ${BOT} runs it once.`)).toBeVisible({ timeout: 15_000 });

    // ---- the re-run is Sam's turn, once, and its reply lands in the channel thread
    await expect.poll(() => cardActionFor(text)?.message.author.id, { timeout: 30_000 }).toBe(samId);
    await expect
      .poll(() => cell.replies.some((r) => r.mention.eventId === cardActionFor(text)?.eventId), {
        timeout: 30_000,
      })
      .toBe(true);
    const rerun = cardActionFor(text) as CardActionPayload;
    expect(rerun.conversation.id).toBe(channel.id);
    expect(cell.grantReruns.filter((r) => r.eventId === rerun.eventId).flatMap((r) => r.lines)).toEqual([
      `Tool ${writeNote()}: allowed`,
    ]);
    // Sam's review follows live: decided by Marta, used once.
    await expect(mine.getByTestId("approval-status").first()).toHaveText("Used", { timeout: 20_000 });
    await expect(sam.page.getByTestId("approval-decision-line")).toContainText("Approved by Marta Gil");
    await mine.getByTestId("tool-call-open-message").click();
    await expect(sam.page).toHaveURL(new RegExp(`/chat/${channel.id}\\?thread=`));
    await expect(
      sam.page
        .locator('[data-testid="message"][data-author-kind="agent"]')
        .filter({ hasText: `Tool ${writeNote()}: allowed` }),
    ).not.toHaveCount(0, { timeout: 15_000 });
  } finally {
    await sam?.context.close();
    await marta?.context.close();
  }
});

test("a lead denies with a note: Decided shows it, and the bot hears the note", async ({ browser }, info) => {
  test.setTimeout(240_000);
  const project = info.project.name;
  const w = widthOf(project);
  const mobile = project === "mobile";
  await setApprovalPolicy(admin, {
    scopeUnitId: salesId,
    toolPattern: writeNote(),
    mode: "always",
    approverKind: "unit_leads",
  });
  const channel = await freshChannel(admin, [samApi], "sales");
  const added = await admin.post(`/api/v1/channels/${channel.id}/members`, {
    data: { kind: "agent", id: botId },
  });
  expect(added.ok()).toBe(true);
  await askInChannel(
    channel.id,
    `send it [[call write_note ${JSON.stringify({ text: `Invoice for Initech (${w})`, to: "bob@initech.example" })}]]`,
  );
  const id = await newestPendingCall(martaApi);
  const marta = await openAs(browser, MARTA, project);
  try {
    await openApprovals(marta.page);
    const view = await openReview(marta.page, id);
    await marta.page.getByTestId("approval-deny").click();
    const dialog = marta.page.getByTestId("approval-confirm");
    await expect(dialog).toContainText("Deny this action?");
    await expect(dialog).toContainText(`${BOT} won't run it. Sam Lee sees that you denied it.`);
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    const noteBox = dialog.getByTestId("approval-note-input");
    await expect(noteBox).toHaveAttribute("placeholder", "Tell them why");
    await noteBox.fill("Wrong customer");
    expect(await unnamedControls(marta.page)).toEqual([]);
    for (const theme of ["light", "dark"] as const) {
      await marta.page.emulateMedia({ colorScheme: theme });
      await expectNoSeriousA11y(marta.page, '[data-testid="approval-confirm"]');
    }
    await marta.page.emulateMedia({ colorScheme: "light" });
    if (mobile) {
      await expectTouchTargets(marta.page, '[data-testid="approval-confirm"]');
      await captureReview(marta.page, "approval-deny-dialog-390");
    }
    await dialog.getByTestId("approval-confirm-submit").click();
    await expect(toast(marta.page, `Denied. ${BOT} won't run it.`)).toBeVisible({ timeout: 15_000 });
    await expect(view.getByTestId("approval-status").first()).toHaveText("Denied");
    await expect(marta.page.getByTestId("approval-decision-line")).toContainText("Denied by Marta Gil");
    await expect(marta.page.getByTestId("approval-decision-note")).toHaveText("“Wrong customer”");

    // ---- Decided lists it
    await marta.page.goto(`${BASE_URL}/approvals?box=decided&kind=all`);
    const row = marta.page.getByTestId(`approval-row-${id}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByTestId("approval-status")).toHaveText("Denied");

    // ---- the bot hears it, with the note, and never runs it
    const deniedHere = () =>
      cell.events
        .filter((e) => e.type === "agent.card_action.v1")
        .map((e) => e.data as unknown as CardActionPayload)
        .filter((a) => a.cardAction.outcome === "denied" && a.conversation.id === channel.id);
    await expect.poll(() => deniedHere()[0]?.cardAction.note, { timeout: 30_000 }).toBe("Wrong customer");
    const told = deniedHere();
    expect(told).toHaveLength(1);
    expect(told[0]?.cardAction).not.toHaveProperty("grant");
    expect(told[0]?.message.author.id, "the denial is told to Sam's turn").toBe(samId);
    await expect
      .poll(() => cell.replies.some((r) => r.mention.eventId === told[0]?.eventId), { timeout: 30_000 })
      .toBe(true);
    const sam = await openAs(browser, SAM, project);
    try {
      const mine = await gotoReview(sam.page, id);
      await expect(sam.page.getByTestId("approval-decision-note")).toHaveText("“Wrong customer”");
      await mine.getByTestId("tool-call-open-message").click();
      await expect(
        sam.page
          .locator('[data-testid="message"][data-author-kind="agent"]')
          .filter({ hasText: "denied by Marta Gil (“Wrong customer”)" }),
      ).not.toHaveCount(0, { timeout: 15_000 });
    } finally {
      await sam.context.close();
    }
  } finally {
    await marta.context.close();
  }
});

test("two deciders: the one who comes second is told someone already decided, never an automatic decision", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const project = info.project.name;
  const w = widthOf(project);
  await setApprovalPolicy(admin, {
    scopeUnitId: null,
    toolPattern: writeNote(),
    mode: "always",
    approverKind: "users",
    approverUserIds: [martaId, adminId],
  });
  const channel = await freshChannel(admin, [samApi], "ops");
  const added = await admin.post(`/api/v1/channels/${channel.id}/members`, {
    data: { kind: "agent", id: botId },
  });
  expect(added.ok()).toBe(true);
  await askInChannel(
    channel.id,
    `log it [[call write_note ${JSON.stringify({ text: `Call notes, race (${w})`, to: "ops@acme.example" })}]]`,
  );
  const id = await newestPendingCall(martaApi);
  const marta = await openAs(browser, MARTA, project);
  const boss = await openAs(browser, ADMIN, project);
  try {
    const first = await gotoReview(marta.page, id);
    const second = await gotoReview(boss.page, id);
    // The admin opens Approve… and pauses; Marta approves meanwhile.
    await boss.page.getByTestId("approval-approve").click();
    await expect(boss.page.getByTestId("approval-confirm")).toBeVisible();
    await marta.page.getByTestId("approval-approve").click();
    await marta.page.getByTestId("approval-confirm").getByTestId("approval-confirm-submit").click();
    await expect(toast(marta.page, `Approved. ${BOT} runs it once.`)).toBeVisible({ timeout: 15_000 });
    await expect(first.getByTestId("approval-status").first()).not.toHaveText("Pending");
    // The admin confirms what is no longer pending: the API refuses, the review says so and shows the decision.
    await boss.page.getByTestId("approval-confirm").getByTestId("approval-confirm-submit").click();
    await expect(boss.page.getByTestId("approval-notice")).toContainText("Someone already decided this.");
    await expect(
      boss.page.getByTestId("approval-notice").getByRole("button", { name: "Reload" }),
    ).toHaveCount(0);
    await expect(second.getByTestId("approval-status").first()).not.toHaveText("Pending");
    await expect(boss.page.getByTestId("approval-decision-line")).toContainText("Approved by Marta Gil");
    await expect(boss.page.getByTestId("approval-approve")).toHaveCount(0);
    const d = await detailOf(admin, id);
    expect(d.decidedBy?.displayName).toBe("Marta Gil");
    // One decision, one run.
    await expect
      .poll(() => cell.grantReruns.filter((r) => r.eventId === cardActionFor(`race (${w})`)?.eventId))
      .toHaveLength(1);
  } finally {
    await marta.context.close();
    await boss.context.close();
  }
});

test("a 32 KB arguments object scrolls inside its viewer and never sideways", async ({ browser }, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const w = widthOf(project);
  const mobile = project === "mobile";
  await setApprovalPolicy(admin, {
    scopeUnitId: null,
    toolPattern: writeNote(),
    mode: "always",
    approverKind: "requester",
  });
  const rows = Array.from({ length: 285 }, (_, i) => ({
    id: i + 1,
    customer: `Customer ${i + 1} (${w})`,
    email: `customer${i + 1}@globex.example`,
    note: "Invoice for September",
  }));
  bigArgs = { text: `Import these customers (${w})`, rows };
  const bytes = new TextEncoder().encode(JSON.stringify(bigArgs)).length;
  expect(bytes, "the object is close to the 32 KB bound").toBeGreaterThan(25_000);
  expect(bytes).toBeLessThanOrEqual(32_768);
  const sam = await openAs(browser, SAM, project);
  try {
    await sam.page.goto(`${BASE_URL}/chat/dm/${dmId}`);
    await expect(sam.page.getByTestId("dm-view")).toBeVisible();
    await ask(sam.page, "Import them all [[big]]", `Tool ${writeNote()}: approval_required`);
    const id = await newestPendingCall(samApi);
    await openApprovals(sam.page);
    const started = Date.now();
    const view = await openReview(sam.page, id);
    const json = view.getByTestId("arguments-json");
    await expect(json).toContainText("Customer 285");
    console.log(`[tool-approvals] ${w}: 32 KB review rendered in ${Date.now() - started} ms`);
    await expect(view.getByTestId("arguments-size")).toHaveText(/^\d+(\.\d)? KB$/);
    await expect(view.getByTestId("tool-call-truncated")).toBeVisible();
    const box = await json.evaluate((el) => ({
      max: getComputedStyle(el).maxHeight,
      client: el.clientHeight,
      scroll: el.scrollHeight,
      width: el.scrollWidth - el.clientWidth,
    }));
    expect(box.max).toBe(mobile ? "360px" : "480px");
    expect(box.scroll).toBeGreaterThan(box.client);
    expect(box.width, "no sideways scroll inside the viewer").toBeLessThanOrEqual(0);
    await expectNoSidewaysScroll(sam.page, `32 KB ${w}`);
    await invariants(sam.page, `32 KB ${w}`, '[data-testid="tool-call-view"]');
    await view.getByTestId("arguments-view").scrollIntoViewIfNeeded();
    await captureReview(sam.page, `approval-review-arguments-${w}`);
    // Keyboard: the region takes focus and scrolls.
    await json.focus();
    await expect(json).toBeFocused();
    await sam.page.keyboard.press("End");
    await expect.poll(() => json.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    // Expand removes the cap; Collapse restores it.
    const expand = view.getByTestId("arguments-expand");
    await expand.click();
    await expect(expand).toHaveAttribute("aria-expanded", "true");
    expect(await json.evaluate((el) => getComputedStyle(el).maxHeight)).toBe("none");
    await expectNoSidewaysScroll(sam.page, `32 KB expanded ${w}`);
    await expand.click();
    await expect(expand).toHaveAttribute("aria-expanded", "false");
    await expectTouchTargets(sam.page, '[data-testid="approvals-shell"]');
  } finally {
    await clearPendingApprovals(samApi).catch(() => undefined);
    await sam.context.close();
  }
});
