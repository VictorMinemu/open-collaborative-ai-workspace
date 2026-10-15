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
  ACME_CRM,
  clearApprovalPolicies,
  clearPendingApprovals,
  ensureUnitRole,
  LUIS,
  MARTA,
  proposeWorkZoneFromDm,
  seedApprovalMcp,
  seedApprovalPeople,
  setApprovalPolicy,
} from "../support/approvals";
import { freshTeamBot } from "../support/bot-tools";
import { cellToken } from "../support/cell-token";
import { freshChannel, postAs } from "../support/chat";
import { type FakeCellOptions, FakeCellPlugin, type MentionPayload } from "../support/fake-cell-plugin";
import {
  captureReview,
  expectNoSidewaysScroll,
  expectTouchTargets,
  unnamedControls,
} from "../support/layout";
import { asSuperuser } from "../support/superuser";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import { ADMIN, API_URL } from "./env";

/**
 * 07.5-14 (APPROVE-02, APPROVE-03, D-02, D-03, D-04, P-07, UI-SPEC Surfaces 1 and 3, R6, R8, R9, R11, C-03): the two
 * 07.5 cards in chat, end to end with the fake cell (no model, no provider) and a REAL local-runtime daemon in
 * fake-runtime mode. Sam's bot needs approval for a note; the exact card appears in Sam's DM; Sam approves in the card;
 * the card turns Approved, then Used after the bot's re-run. Then the summary card's privacy in a channel (a sentinel
 * value never reaches a non-audience reader's page or WebSocket), the truncated and tainted variants, every state, the
 * Work Zone card (start from the card, read-only for others, offline) and "proposed by" in the session. Phone, dark,
 * axe and the reviewed screenshots (approval-card-*, work-zone-proposal-card*, work-zone-proposal-started-1440,
 * work-zone-proposed-by-1440, each with -dark).
 */

test.describe.configure({ mode: "serial" });

const BOT = "Tally";
const DEVICE = "MacBook Pro";
const PROJECT = "billing-api";
const SENTINEL = "SUMMARY-SENTINEL";
/** A note with eight lines: a block value that clamps to six with Show more. */
const NOTE = [
  "Invoice for September, 3 plants. Payment within 30 days.",
  "Plant A: 420 units",
  "Plant B: 510 units",
  "Plant C: 320 units",
  "Ship to: Valencia warehouse, dock 4",
  "Contact: Ana Ruiz",
  "PO: 2026-0917",
  "Thank you",
].join("\n");

let admin: APIRequestContext;
let samApi: APIRequestContext;
let martaApi: APIRequestContext;
let luisApi: APIRequestContext;
let samId: string;
let salesId: string;
let safeName: string;
let crmId: string;
let botId: string;
let dmId: string;
let cell: FakeCellPlugin;
let device: FakeDeviceHandle | null = null;
/** The persona's own calls when a message says `[[persona]]` (values that must never appear in the chat itself). */
let personaCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];

const writeNote = () => `${safeName}__write_note`;
const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");
const toast = (page: Page, text: string) => page.locator("[data-sonner-toast]").filter({ hasText: text });

function cellOptions(extra: Partial<FakeCellOptions> = {}): FakeCellOptions {
  return {
    apiUrl: API_URL,
    token: cellToken(),
    autoAck: true,
    autoReply: true,
    toolCallsFor: (m: MentionPayload) => (m.message.text.includes("[[persona]]") ? personaCalls : []),
    ...extra,
  };
}

/** Every capability allowed (what an organization without a policy row gets), so the bot may read the web. */
async function resetBotPolicy() {
  const allow = { orgWide: true, personal: true };
  const res = await admin.put("/api/v1/bot-policy", {
    data: {
      capabilities: { internet: allow, memory: allow, dateTime: allow, replyModeAll: allow },
      searchProvider: "duckduckgo",
      maxPersonalBotsPerUser: 3,
      personalDailyLimitMax: 100,
      personalAllowedModels: [],
    },
  });
  expect(res.ok(), "reset bot policy").toBe(true);
}

/**
 * A fresh team bot with Acme CRM's tools and the internet (so a turn can read outside content), ready in the cell,
 * and Sam's own DM with it: every DM test starts on an empty conversation, so its cards are the only ones on screen.
 */
async function freshBotAndDm(): Promise<void> {
  botId = await freshTeamBot(admin, BOT);
  const granted = await admin.patch(`/api/v1/agents/${botId}/capabilities`, {
    data: {
      internet: true,
      tools: ["write_note", "echo"].map((t) => ({
        sourceKind: "mcp",
        sourceId: crmId,
        tool: `${safeName}__${t}`,
      })),
    },
  });
  expect(granted.ok(), `grant Acme CRM to ${BOT}: ${granted.status()} ${await granted.text()}`).toBe(true);
  await cell.ackAll();
  const dm = await samApi.post(`/api/v1/agents/${botId}/dm`);
  expect(dm.ok(), `Sam's DM with ${BOT}`).toBe(true);
  dmId = ((await dm.json()) as { dmId: string }).dmId;
}

/** Sends `text` in the open conversation and waits for the bot's new reply containing `expectText`. */
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

/** The newest card of `kind` on the page whose text contains `text`. */
function cardWith(page: Page, kind: "approval" | "work_zone", text: string): Locator {
  return page.locator(`[data-testid="agent-card"][data-kind="${kind}"]`).filter({ hasText: text }).last();
}

/** A selector for exactly this card (its message row), for axe. */
async function selectorOf(card: Locator): Promise<string> {
  const id = await card.locator("xpath=ancestor::*[@data-message-id][1]").getAttribute("data-message-id");
  expect(id, "the card's message id").toBeTruthy();
  return `[data-message-id="${id}"] [data-testid="agent-card"]`;
}

/** The screen's invariants on one card: named controls, no sideways scroll, 44 px targets below 1024, axe, both themes. */
async function invariants(page: Page, label: string, card: Locator) {
  const selector = await selectorOf(card);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    expect(await unnamedControls(page), `${label} (${theme}): controls without a name`).toEqual([]);
    await expectNoSidewaysScroll(page, `${label} (${theme})`);
    await expectTouchTargets(page, card);
    await expectNoSeriousA11y(page, selector);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/**
 * Before a capture: the card fully in view (`end`: its footer; `start`: its header) and no focus left inside it, so
 * the message hover toolbar is not part of the picture.
 */
async function reveal(card: Locator, block: "start" | "end" = "end") {
  await card.evaluate((el, b) => {
    (document.activeElement as HTMLElement | null)?.blur();
    el.scrollIntoView({ block: b });
  }, block);
}

/** The newest pending `tool.call` request `api` asked for or may decide. */
async function newestCall(
  api: APIRequestContext,
  role: "decider" | "requester" = "decider",
): Promise<{
  id: string;
  actionHash: string;
}> {
  let found: { id: string; actionHash: string } | undefined;
  await expect
    .poll(
      async () => {
        const res = await api.get(`/api/v1/approvals?role=${role}&status=pending&kinds=tool.call`);
        const items = (
          (await res.json()) as {
            items: Array<{ id: string; actionHash: string; createdAt: string }>;
          }
        ).items;
        found = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        return found?.id ?? "";
      },
      { timeout: 20_000, message: "a pending tool.call request" },
    )
    .not.toBe("");
  return found as { id: string; actionHash: string };
}

async function decide(
  api: APIRequestContext,
  id: string,
  actionHash: string,
  outcome: string,
  note?: string,
) {
  const res = await api.post(`/api/v1/approvals/${id}/decision`, {
    data: { outcome, actionHash, ...(note ? { note } : {}) },
  });
  expect(res.ok(), `decide ${id}: ${res.status()} ${await res.text()}`).toBe(true);
}

/** Text a screen reader reads under `el` (aria-hidden parts skipped, sr-only parts kept), spaces collapsed. */
const spokenText = (el: Locator) =>
  el.evaluate((root) => {
    const parts: string[] = [];
    const walk = (n: Node) => {
      if (n instanceof Element && n.getAttribute("aria-hidden") === "true") return;
      if (n.nodeType === Node.TEXT_NODE) parts.push(n.textContent ?? "");
      for (const c of n.childNodes) walk(c);
    };
    walk(root);
    return parts.join("").replace(/\s+/g, " ").replace(/\s+,/g, ",").trim();
  });

/** Text a sighted person reads under `el` (sr-only parts skipped), spaces collapsed. */
const visibleText = (el: Locator) =>
  el.evaluate((root) => {
    const parts: string[] = [];
    const walk = (n: Node) => {
      if (n instanceof Element && n.classList.contains("sr-only")) return;
      if (n.nodeType === Node.TEXT_NODE) parts.push(n.textContent ?? "");
      for (const c of n.childNodes) walk(c);
    };
    walk(root);
    return parts.join(" ").replace(/\s+/g, " ").trim();
  });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  expect(cellToken(), "OCW_CELL_TOKEN is configured").not.toBe("");
  admin = await apiAs(ADMIN);
  samId = await ensureMember(admin, SAM, "developer");
  samApi = await apiAs(SAM);
  expect(await userIdOf(samApi)).toBe(samId);
  ({ safeName } = await seedApprovalMcp(admin));
  const people = await seedApprovalPeople(admin);
  salesId = people.salesId;
  martaApi = await apiAs(MARTA);
  luisApi = await apiAs(LUIS);
  // Sam works in Sales (a member, not a lead): a Sales rule reaches his requests; Luis is outside Sales.
  await ensureUnitRole(admin, salesId, samId, "member");
  const servers = (await (await admin.get("/api/v1/mcp-servers")).json()) as {
    servers: Array<{ id: string; name: string }>;
  };
  crmId = servers.servers.find((s) => s.name === ACME_CRM)?.id ?? "";
  expect(crmId, "Acme CRM is registered").not.toBe("");
  await resetBotPolicy();

  for (const api of [samApi, martaApi, admin]) await clearPendingApprovals(api);
  cell = new FakeCellPlugin(cellOptions());
  await cell.start();
  await freshBotAndDm();

  // Sam's device for the Work Zone cards (an earlier, interrupted run may have left one with the same name).
  const listed = (await (await samApi.get("/api/v1/devices")).json()) as {
    devices: Array<{ id: string; name: string; ownerUserId: string }>;
  };
  for (const d of listed.devices.filter((x) => x.name === DEVICE && x.ownerUserId === samId)) {
    await samApi.delete(`/api/v1/devices/${d.id}`);
  }
  device = await startFakeDevice(samApi, { name: DEVICE, projectName: PROJECT });
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
  await device?.stop();
  device = null;
  await cell?.stop();
  for (const api of [luisApi, martaApi, samApi, admin]) await api?.dispose();
});

test("Sam approves his bot's action in the DM card and the card follows it to Used", async ({
  browser,
}, info) => {
  test.setTimeout(300_000);
  const project = info.project.name;
  const w = widthOf(project);
  const mobile = project === "mobile";
  await freshBotAndDm();
  await setApprovalPolicy(admin, {
    scopeUnitId: null,
    toolPattern: writeNote(),
    mode: "always",
    approverKind: "requester",
  });
  const args = { text: NOTE, to: "billing@globex.example", amount: 1250 };
  const sam = await openAs(browser, SAM, project);
  try {
    // ---- the bot asks: approval required, no call yet
    await sam.page.goto(`${BASE_URL}/chat/dm/${dmId}`);
    await expect(sam.page.getByTestId("dm-view")).toBeVisible();
    await ask(
      sam.page,
      `File the invoice note [[call write_note ${JSON.stringify(args)}]]`,
      `Tool ${writeNote()}: approval_required`,
    );
    const { id } = await newestCall(samApi);
    expect(cell.grantReruns.filter((r) => r.tool === writeNote())).toHaveLength(0);

    // ---- the exact card in Sam's DM
    const card = cardWith(sam.page, "approval", "Run write_note on Acme CRM");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByTestId("agent-card-kind")).toHaveText("Approval");
    await expect(card.getByTestId("agent-card-workspace")).toContainText("Created by the workspace");
    await expect(card.getByTestId("agent-card-status")).toHaveText("Pending");
    await expect(card.getByTestId("agent-card-title")).toHaveText("Run write_note on Acme CRM");
    await expect(card.getByRole("heading", { level: 4, name: "Action" })).toBeVisible();
    await expect(card.getByRole("heading", { level: 4, name: `What ${BOT} will send` })).toBeVisible();
    await expect(card.getByTestId("agent-card-action-field-tool")).toHaveText("write_note");
    await expect(card.getByTestId("agent-card-action-field-source")).toHaveText(`${ACME_CRM} · MCP server`);
    // WINDOWS #221: the internal server name is never on the card.
    await expect(card).not.toContainText(safeName);
    await expect(card.getByTestId("agent-card-value-field-to")).toHaveText("billing@globex.example");
    await expect(card.getByTestId("agent-card-value-field-to").locator("a")).toHaveCount(0);
    await expect(card.getByTestId("agent-card-value-field-amount")).toHaveText("1250");
    await expect(card.getByTestId("agent-card-value-field-text")).toContainText(
      "Invoice for September, 3 plants.",
    );
    const showMore = card
      .getByTestId("agent-card-value-field-text")
      .getByRole("button", { name: "Show more" });
    await expect(showMore).toHaveAttribute("aria-expanded", "false");
    await expect(card.getByTestId("agent-card-timer")).toHaveText(
      "Runs once, with exactly these values · Expires in 24 h",
    );
    await expect(card.getByTestId("agent-card-open")).toHaveAttribute("href", `/approvals/${id}`);
    await expect(card.getByTestId("agent-card-approve")).toHaveText("Approve");
    await expect(card.getByTestId("agent-card-deny")).toHaveText("Deny");

    if (mobile) {
      // Phone: the badge on its own line, labels over values, Review full width, Approve / Deny side by side.
      const kindBox = await card.getByTestId("agent-card-kind").boundingBox();
      const badgeBox = await card.getByTestId("agent-card-workspace").boundingBox();
      expect(
        (badgeBox?.y ?? 0) >= (kindBox?.y ?? 0) + (kindBox?.height ?? 0) - 1,
        "badge on its own line",
      ).toBe(true);
      const to = card.getByTestId("agent-card-value-field-to");
      const dt = await to.locator("xpath=preceding-sibling::dt[1]").boundingBox();
      const dd = await to.boundingBox();
      expect((dt?.y ?? 0) + (dt?.height ?? 0)).toBeLessThanOrEqual((dd?.y ?? 0) + 1);
      const footer = await card.getByTestId("agent-card-actions").boundingBox();
      const review = await card.getByTestId("agent-card-open").boundingBox();
      expect(review?.width ?? 0).toBeGreaterThan((footer?.width ?? 0) - 40);
      const approve = await card.getByTestId("agent-card-approve").boundingBox();
      const deny = await card.getByTestId("agent-card-deny").boundingBox();
      expect(Math.abs((approve?.width ?? 0) - (deny?.width ?? 0))).toBeLessThan(4);
      expect(Math.round(approve?.y ?? 0)).toBe(Math.round(deny?.y ?? 1));
      for (const b of [review, approve, deny]) expect(b?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await invariants(sam.page, `dm card ${w}`, card);
    await reveal(card);
    await captureReview(sam.page, `approval-card-dm-${w}`);
    if (mobile) {
      // A phone shows the card in two screens: the header, badge line and ACTION too (extra capture).
      await reveal(card, "start");
      await captureReview(sam.page, "approval-card-dm-390-top");
    }

    // ---- Show more is display only: the whole value, then back
    await showMore.click();
    await expect(card.getByTestId("agent-card-value-field-text")).toContainText("Thank you");
    await card.getByTestId("agent-card-value-field-text").getByRole("button", { name: "Show less" }).click();

    // ---- Approve: confirm first, Cancel focused, the exact consequence in words. The cell is paused so the
    // "Approved" state can be seen before the bot's re-run uses the grant.
    const resumeAt = cell.lastSeq;
    await cell.stop();
    await card.getByTestId("agent-card-approve").click();
    const dialog = sam.page.getByTestId("agent-card-confirm");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Approve this action?");
    await expect(dialog).toContainText(
      `${BOT} can run write_note once, with exactly these values, within 15 minutes. It runs with the organization's account.`,
    );
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await expect(dialog.getByTestId("agent-card-note-input")).toHaveAttribute("maxlength", "280");
    await expectNoSeriousA11y(sam.page, '[data-testid="agent-card-confirm"]');
    await dialog.getByTestId("agent-card-confirm-submit").click();
    await expect(toast(sam.page, `Approved. ${BOT} runs it once.`)).toBeVisible({ timeout: 15_000 });
    await expect(card.getByTestId("agent-card-status")).toHaveText("Approved");
    await expect(card.getByTestId("agent-card-state-line")).toHaveText(
      new RegExp(`^${BOT} runs it once, before \\d{1,2}:\\d{2}\\s?[AP]M\\.$`),
    );
    await expect(card.getByTestId("agent-card-decision")).toContainText("Approved by Sam Lee");
    await expect(card.getByTestId("agent-card-decided")).toBeFocused();
    await expect(card.getByTestId("agent-card-approve")).toHaveCount(0);

    // ---- the bot comes back, re-runs it once with exactly these values, and the card turns Used
    cell = new FakeCellPlugin(cellOptions({ afterSeq: resumeAt }));
    await cell.start();
    await expect
      .poll(() => cell.grantReruns.filter((r) => r.tool === writeNote()).flatMap((r) => r.lines), {
        timeout: 30_000,
      })
      .toEqual([`Tool ${writeNote()}: allowed`]);
    await expect(card.getByTestId("agent-card-status")).toHaveText("Used", { timeout: 20_000 });
    await expect(card.getByTestId("agent-card-state-line")).toHaveText(
      /^Ran once at \d{1,2}:\d{2}\s?[AP]M\.$/,
    );
    await expect(card.getByTestId("agent-card-decision")).toContainText("Approved by Sam Lee");
    await expect(
      sam.page
        .locator('[data-testid="message"][data-author-kind="agent"]')
        .filter({ hasText: `Tool ${writeNote()}: allowed` }),
    ).toHaveCount(1, { timeout: 15_000 });
    expect(((await (await samApi.get(`/api/v1/approvals/${id}`)).json()) as { status: string }).status).toBe(
      "applied",
    );
  } finally {
    await sam.context.close();
  }
});

test("in a channel the card is a summary: a reader outside the audience never receives a value", async ({
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
  const channel = await freshChannel(admin, [samApi, luisApi, martaApi], "ops");
  const added = await admin.post(`/api/v1/channels/${channel.id}/members`, {
    data: { kind: "agent", id: botId },
  });
  expect(added.ok(), `add ${BOT} to #${channel.name}`).toBe(true);
  // The values come from the persona, never from the chat message (which every member reads).
  const secret = `${SENTINEL}-${w} wire 9,800 EUR to the new supplier account`;
  personaCalls = [{ tool: "write_note", args: { text: secret, to: "payments@initech.example" } }];

  let luis: { context: BrowserContext; page: Page } | null = null;
  let marta: { context: BrowserContext; page: Page } | null = null;
  try {
    // ---- Luis (an #ops member outside Sales) is reading the channel when the card arrives
    luis = await openAs(browser, LUIS, project);
    const frames: string[] = [];
    const bodies: Promise<string>[] = [];
    luis.page.on("websocket", (ws) => ws.on("framereceived", (f) => frames.push(String(f.payload))));
    luis.page.on("response", (r) => {
      if (r.url().includes("/api/")) bodies.push(r.text().catch(() => ""));
    });
    await luis.page.goto(`${BASE_URL}/chat/${channel.id}`);
    await expect(luis.page.getByTestId("composer")).toBeVisible();

    const before = cell.toolCallRequests.length;
    await postAs(samApi, channel.id, `@${BOT} please file the supplier note [[persona]]`, {
      mentions: [{ kind: "agent", id: botId }],
    });
    await expect
      .poll(() => cell.toolCallRequests.slice(before).find((r) => r.tool === writeNote())?.arguments?.text, {
        timeout: 30_000,
      })
      .toBe(secret);

    const card = cardWith(luis.page, "approval", `${BOT} wants to run write_note for Sam Lee`);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByTestId("agent-card-status")).toHaveText("Pending");
    await expect(card.getByTestId("agent-card-action-field-tool")).toHaveText("write_note");
    await expect(card.getByTestId("agent-card-action-field-source")).toHaveText(ACME_CRM);
    await expect(card.getByTestId("agent-card-waiting")).toHaveText(
      "Waiting for a lead of Sales · Expires in 24 h",
    );
    await expect(card.getByTestId("agent-card-privacy")).toHaveText(
      "Only Sam Lee and the approvers can see the details.",
    );
    await expect(card.getByTestId("agent-card-open")).toHaveCount(0);
    await expect(card.getByRole("button")).toHaveCount(0);
    await expect(card.getByRole("heading", { level: 4 })).toHaveCount(0);

    // ---- nothing of the value on Luis's page, in any frame his WebSocket received, or in any API answer he got
    await luis.page.waitForTimeout(1500);
    expect(await luis.page.content()).not.toContain(SENTINEL);
    expect(frames.length, "Luis's page received realtime frames").toBeGreaterThan(0);
    expect(frames.filter((f) => f.includes(SENTINEL))).toEqual([]);
    expect((await Promise.all(bodies)).filter((b) => b.includes(SENTINEL))).toEqual([]);

    await invariants(luis.page, `channel card ${w}`, card);
    await reveal(card);
    await captureReview(luis.page, `approval-card-channel-${w}`);

    // ---- Marta, a lead of Sales in #ops: Review, never an in-card Approve (she decides on the review)
    marta = await openAs(browser, MARTA, project);
    await marta.page.goto(`${BASE_URL}/chat/${channel.id}`);
    const hers = cardWith(marta.page, "approval", `${BOT} wants to run write_note for Sam Lee`);
    await expect(hers).toBeVisible({ timeout: 20_000 });
    const { id } = await newestCall(martaApi);
    await expect(hers.getByTestId("agent-card-open")).toHaveAttribute("href", `/approvals/${id}`);
    await expect(hers.getByTestId("agent-card-approve")).toHaveCount(0);
    await expect(hers.getByTestId("agent-card-deny")).toHaveCount(0);
    expect(await marta.page.content()).not.toContain(SENTINEL);
  } finally {
    await luis?.context.close();
    await marta?.context.close();
  }
});

test("a value too long for the card: the notice, Review as the primary action and Deny, never Approve", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const project = info.project.name;
  const w = widthOf(project);
  await freshBotAndDm();
  await setApprovalPolicy(admin, {
    scopeUnitId: null,
    toolPattern: writeNote(),
    mode: "always",
    approverKind: "requester",
  });
  personaCalls = [
    {
      tool: "write_note",
      args: {
        text: `Quarterly summary for Globex. ${"Line items reconciled against the ledger. ".repeat(14)}`.trim(),
      },
    },
  ];
  const sam = await openAs(browser, SAM, project);
  try {
    await sam.page.goto(`${BASE_URL}/chat/dm/${dmId}`);
    await ask(sam.page, "Write the quarterly summary [[persona]]", `Tool ${writeNote()}: approval_required`);
    const { id } = await newestCall(samApi);
    const card = cardWith(sam.page, "approval", "Run write_note on Acme CRM");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByTestId("agent-card-truncated")).toHaveText(
      "Some values are too long for the card. Review them in full before approving.",
    );
    const review = card.getByTestId("agent-card-open");
    await expect(review).toHaveAttribute("href", `/approvals/${id}`);
    await expect(review).toHaveClass(/bg-primary/);
    await expect(card.getByTestId("agent-card-deny")).toBeVisible();
    await expect(card.getByTestId("agent-card-approve")).toHaveCount(0);
    await invariants(sam.page, `truncated card ${w}`, card);
    await reveal(card);
    if (w === "1440") await captureReview(sam.page, "approval-card-truncated-1440");

    // Deny stays available in the card.
    await card.getByTestId("agent-card-deny").click();
    const dialog = sam.page.getByTestId("agent-card-confirm");
    await expect(dialog).toContainText("Deny this action?");
    await expect(dialog.getByTestId("agent-card-note-input")).toHaveAttribute("placeholder", "Tell them why");
    await dialog.getByTestId("agent-card-note-input").fill("Too long, split it");
    await dialog.getByTestId("agent-card-confirm-submit").click();
    await expect(toast(sam.page, `Denied. ${BOT} won't run it.`)).toBeVisible({ timeout: 15_000 });
    await expect(card.getByTestId("agent-card-status")).toHaveText("Denied");
    await expect(card.getByTestId("agent-card-note")).toHaveText("“Too long, split it”");
  } finally {
    await sam.context.close();
  }
});

test("after outside content in the same turn the card warns, and a hidden character shows as a chip", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const project = info.project.name;
  const w = widthOf(project);
  await freshBotAndDm();
  await setApprovalPolicy(admin, {
    scopeUnitId: null,
    toolPattern: writeNote(),
    mode: "always",
    approverKind: "requester",
  });
  const sam = await openAs(browser, SAM, project);
  try {
    await sam.page.goto(`${BASE_URL}/chat/dm/${dmId}`);
    // The model wrote an invisible right-to-left override in the address (JSON "‮" in the call).
    const call = '{"to":"billing\\u202e@globex.example","text":"Pay the September invoice."}';
    await ask(
      sam.page,
      `Read the supplier page and file it [[call web_fetch {"url":"https://example.org/supplier"}]] [[call write_note ${call}]]`,
      `Tool ${writeNote()}: approval_required`,
    );
    const card = cardWith(sam.page, "approval", "Run write_note on Acme CRM");
    await expect(card).toBeVisible({ timeout: 15_000 });
    const taint = card.getByTestId("agent-card-warning").filter({ hasText: "outside content" });
    await expect(taint).toHaveText(`${BOT} read outside content earlier in this turn. Check the values.`);
    await expect(taint).toHaveClass(/bg-amber-50/);
    const chip = card.getByTestId("agent-card-value-field-to").getByTestId("hidden-character");
    await expect(chip).toHaveText("⟨U+202E⟩");
    await expect(chip).toHaveAttribute("aria-label", "hidden character U+202E");
    await expect(card.getByTestId("agent-card-warning").filter({ hasText: "hidden characters" })).toHaveText(
      "Contains hidden characters, shown as ⟨U+…⟩.",
    );
    await invariants(sam.page, `tainted card ${w}`, card);
    await reveal(card);
    if (w === "1440") await captureReview(sam.page, "approval-card-dm-tainted-1440");
  } finally {
    await sam.context.close();
  }
});

test("every state reads at a glance: Approved, Used, Denied with the note, Expired", async ({
  browser,
}, info) => {
  test.setTimeout(300_000);
  const project = info.project.name;
  const w = widthOf(project);
  await freshBotAndDm();
  await setApprovalPolicy(admin, {
    scopeUnitId: null,
    toolPattern: writeNote(),
    mode: "always",
    approverKind: "requester",
  });
  const sam = await openAs(browser, SAM, project);
  try {
    await sam.page.goto(`${BASE_URL}/chat/dm/${dmId}`);
    const asked: Record<string, { id: string; actionHash: string }> = {};
    for (const [key, to] of [
      ["approved", "ana@globex.example"],
      ["used", "luis@globex.example"],
      ["denied", "marta@globex.example"],
      ["expired", "eve@globex.example"],
    ] as const) {
      await ask(
        sam.page,
        `Note for ${to} [[call write_note ${JSON.stringify({ to, text: `Follow up with ${to.split("@")[0]}` })}]]`,
        `Tool ${writeNote()}: approval_required`,
      );
      asked[key] = await newestCall(samApi);
    }
    const card = (to: string) => cardWith(sam.page, "approval", to);

    // ---- Used: approved while the bot listens, so its re-run uses the grant at once
    const used = asked.used as { id: string; actionHash: string };
    await decide(samApi, used.id, used.actionHash, "approved");
    await expect(card("luis@globex.example").getByTestId("agent-card-status")).toHaveText("Used", {
      timeout: 30_000,
    });
    // ---- Denied with a note
    const denied = asked.denied as { id: string; actionHash: string };
    await decide(samApi, denied.id, denied.actionHash, "denied", "Wrong customer");
    // ---- Expired: 24 h passed with no decision (moved by the superuser helper, isolated database only)
    const expired = asked.expired as { id: string; actionHash: string };
    const moved = await asSuperuser(
      "update app.approval_requests set expires_at = now() - interval '1 minute' where id = $1",
      [expired.id],
    );
    expect(moved.rowCount).toBe(1);
    // ---- Approved, not used yet: decided while the bot is away (it comes back live, without this card action)
    const approved = asked.approved as { id: string; actionHash: string };
    await cell.stop();
    await decide(samApi, approved.id, approved.actionHash, "approved");
    cell = new FakeCellPlugin(cellOptions());
    await cell.start();

    await sam.page.reload();
    await expect(sam.page.getByTestId("dm-view")).toBeVisible();
    const a = card("ana@globex.example");
    await expect(a.getByTestId("agent-card-status")).toHaveText("Approved", { timeout: 15_000 });
    await expect(a.getByTestId("agent-card-state-line")).toHaveText(
      new RegExp(`^${BOT} runs it once, before \\d{1,2}:\\d{2}\\s?[AP]M\\.$`),
    );
    await expect(a.getByTestId("agent-card-decision")).toContainText("Approved by Sam Lee");
    const u = card("luis@globex.example");
    await expect(u.getByTestId("agent-card-status")).toHaveText("Used");
    await expect(u.getByTestId("agent-card-state-line")).toHaveText(/^Ran once at \d{1,2}:\d{2}\s?[AP]M\.$/);
    const d = card("marta@globex.example");
    await expect(d.getByTestId("agent-card-status")).toHaveText("Denied");
    await expect(d.getByTestId("agent-card-decision")).toContainText("Denied by Sam Lee");
    await expect(d.getByTestId("agent-card-note")).toHaveText("“Wrong customer”");
    const e = card("eve@globex.example");
    await expect(e.getByTestId("agent-card-status")).toHaveText("Expired", { timeout: 15_000 });
    await expect(e.getByTestId("agent-card-state-line")).toHaveText(
      "No one decided within 24 hours. Nothing was run.",
    );
    for (const c of [a, u, d, e]) {
      await expect(c.getByTestId("agent-card-approve")).toHaveCount(0);
      await expect(c.getByTestId("agent-card-status").locator(".animate-ping")).toHaveCount(0);
    }
    for (const c of [a, e]) await invariants(sam.page, `states ${w}`, c);
    if (w === "1440") {
      // The four cards stacked in one conversation: a taller window so all of them are in the capture.
      await sam.page.setViewportSize({ width: 1440, height: 2200 });
      await a.scrollIntoViewIfNeeded();
      await captureReview(sam.page, "approval-card-states-1440");
      await sam.page.setViewportSize({ width: 1440, height: 900 });
    }
  } finally {
    await sam.context.close();
  }
});

test("a card with twelve 500-character fields stays inside the message column with every block clamped", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const project = info.project.name;
  await freshBotAndDm();
  await setApprovalPolicy(admin, {
    scopeUnitId: null,
    toolPattern: writeNote(),
    mode: "always",
    approverKind: "requester",
  });
  const long = (k: number) =>
    `Field ${k}: ${"supplier terms and delivery notes for the next quarter, ".repeat(9)}`
      .slice(0, 500)
      .trim();
  const args: Record<string, unknown> = { text: long(0) };
  for (let k = 1; k <= 9; k++) args[`detail_${String.fromCharCode(96 + k)}`] = long(k);
  personaCalls = [{ tool: "write_note", args }];
  const sam = await openAs(browser, SAM, project);
  try {
    await sam.page.goto(`${BASE_URL}/chat/dm/${dmId}`);
    await ask(sam.page, "File every detail [[persona]]", `Tool ${writeNote()}: approval_required`);
    const card = cardWith(sam.page, "approval", "Run write_note on Acme CRM");
    await expect(card).toBeVisible({ timeout: 15_000 });
    const blocks = card.getByTestId("agent-card-block-value");
    await expect(blocks).toHaveCount(10);
    const view = sam.page.viewportSize()?.width ?? 1440;
    const box = await card.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(view);
    for (const b of await blocks.all()) {
      const clamped = await b
        .locator("span[id]")
        .first()
        .evaluate((el) => el.scrollHeight > el.clientHeight);
      expect(clamped, "each 500-character block is clamped").toBe(true);
    }
    await expectNoSidewaysScroll(sam.page, `twelve fields ${widthOf(project)}`);
    await expectTouchTargets(sam.page, card);
  } finally {
    await sam.context.close();
  }
});

test("a Work Zone proposal card: Sam starts it from the card, and the session credits the bot", async ({
  browser,
}, info) => {
  test.setTimeout(300_000);
  const project = info.project.name;
  const w = widthOf(project);
  const mobile = project === "mobile";
  if (!device) throw new Error("no device");
  const prompt = `Fix the rounding error in invoice totals (${w}). Totals for currencies with 3 decimals are off by one unit. Add a test with KWD and keep the public API unchanged.`;
  const sam = await openAs(browser, SAM, project);
  try {
    await sam.page.goto(`${BASE_URL}/chat/dm/${dmId}`);
    await expect(sam.page.getByTestId("dm-view")).toBeVisible();
    await proposeWorkZoneFromDm(sam.page, cell, {
      projectId: device.projectId,
      deviceId: device.deviceId,
      prompt,
    });
    const card = cardWith(sam.page, "work_zone", `(${w})`);
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByTestId("agent-card-kind")).toHaveText("Work Zone");
    await expect(card.getByTestId("agent-card-workspace")).toBeVisible();
    await expect(card.getByTestId("agent-card-status")).toHaveText("Proposed");
    await expect(card.getByTestId("agent-card-title")).toHaveText(`Start a session in ${PROJECT}`);
    await expect(card.getByTestId("agent-card-wz-project")).toHaveText(PROJECT);
    await expect(card.getByTestId("agent-card-wz-device")).toContainText(DEVICE);
    await expect(card.getByTestId("agent-card-wz-device").getByTestId("device-state")).toHaveText("Online");
    await expect(card.getByTestId("agent-card-wz-runtime")).toHaveText("Claude Code");
    await expect(card.getByTestId("agent-card-wz-mode")).toHaveText("Supervised");
    await expect(card.getByTestId("agent-card-wz-for")).toHaveText(`Sam Lee · proposed by ${BOT}`);
    await expect(card.getByTestId("agent-card-wz-prompt")).toContainText("Fix the rounding error");
    await expect(card.getByTestId("agent-card-wz-mode-line")).toHaveText(
      "Asks before edits and commands. Bots never choose Full access.",
    );
    await expect(card).not.toContainText("Full access is");
    await expect(card.getByTestId("agent-card-open")).toBeVisible();
    await expect(card.getByTestId("agent-card-start")).toHaveText("Start session");
    await expect(card.getByTestId("agent-card-start")).not.toHaveAttribute("aria-disabled", "true");
    await expect(card.getByTestId("agent-card-dismiss")).toHaveText("Dismiss");
    if (mobile) {
      const review = await card.getByTestId("agent-card-open").boundingBox();
      const start = await card.getByTestId("agent-card-start").boundingBox();
      const dismiss = await card.getByTestId("agent-card-dismiss").boundingBox();
      expect((start?.y ?? 0) > (review?.y ?? 0), "Review on its own row").toBe(true);
      expect(Math.round(start?.y ?? 0)).toBe(Math.round(dismiss?.y ?? 1));
      for (const b of [review, start, dismiss]) expect(b?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await invariants(sam.page, `work zone card ${w}`, card);
    await reveal(card);
    await captureReview(sam.page, `work-zone-proposal-card-${w}`);

    // ---- Start from the card: confirm first, Cancel focused
    await card.getByTestId("agent-card-start").click();
    const dialog = sam.page.getByTestId("agent-card-confirm");
    await expect(dialog).toContainText("Start this session?");
    await expect(dialog).toContainText(
      `Claude Code runs ${BOT}'s prompt in ${PROJECT} on ${DEVICE}, as you. It starts in Supervised mode: it asks before edits and commands.`,
    );
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await expect(dialog.getByTestId("agent-card-note-input")).toHaveCount(0);
    await dialog.getByTestId("agent-card-confirm-submit").click();
    await expect(toast(sam.page, `Session started on ${DEVICE}`)).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId("agent-card-status")).toHaveText("Started");
    await expect(card.getByTestId("agent-card-decision")).toContainText("Started by Sam Lee");
    await expect(card.getByTestId("agent-card-start")).toHaveCount(0);
    const open = card.getByTestId("agent-card-open-session");
    await expect(open).toHaveAttribute("href", /^\/work-zone\/[0-9a-f-]{36}$/);
    await invariants(sam.page, `started card ${w}`, card);
    await reveal(card);
    if (w === "1440") await captureReview(sam.page, "work-zone-proposal-started-1440");

    // ---- the session: the bot's prompt reads "Sam Lee · proposed by Tally" in the stream and the queue
    await open.click();
    await expect(sam.page).toHaveURL(/\/work-zone\/[0-9a-f-]{36}$/);
    const bubble = sam.page.getByTestId("prompt-bubble").filter({ hasText: "Fix the rounding error" });
    await expect(bubble).toBeVisible({ timeout: 30_000 });
    const meta = bubble.locator("p").first();
    await expect(meta.getByTestId("proposed-by")).toBeVisible();
    // The author's avatar follows the line (its initials are the existing meta, unchanged).
    expect(await visibleText(meta)).toContain(`Sam Lee · proposed by ${BOT}`);
    expect(await spokenText(meta)).toContain(`Sam Lee, proposed by ${BOT}`);

    // The runtime asks before writing (Supervised), so the bot's prompt is still running when Sam adds one.
    await sam.page.getByTestId("composer").fill("Also add a CHANGELOG entry");
    await sam.page.getByTestId("send-prompt").click();
    await sam.page.getByTestId(mobile ? "open-queue" : "tab-queue").click();
    const queue = sam.page.getByTestId("queue-panel");
    await expect(queue).toBeVisible();
    const running = queue.locator("div").filter({ hasText: "Running now" }).first();
    await expect(running.getByTestId("proposed-by")).toContainText(`proposed by ${BOT}`, { timeout: 30_000 });
    const queued = queue.getByTestId("queued-prompt").filter({ hasText: "Also add a CHANGELOG entry" });
    await expect(queued).toBeVisible({ timeout: 30_000 });
    await expect(queued).toContainText("Sam Lee");
    await expect(queued.getByTestId("proposed-by")).toHaveCount(0);
    expect(await unnamedControls(sam.page)).toEqual([]);
    await expectNoSidewaysScroll(sam.page, `proposed by ${w}`);
    await expectNoSeriousA11y(sam.page, '[data-testid="queue-panel"]');
    if (w === "1440") await captureReview(sam.page, "work-zone-proposed-by-1440");
  } finally {
    await sam.context.close();
  }
});

test("a Work Zone proposal in a channel: read-only for others; Start waits for an offline device", async ({
  browser,
}, info) => {
  test.setTimeout(300_000);
  const project = info.project.name;
  const w = widthOf(project);
  if (!device) throw new Error("no device");
  const channel = await freshChannel(admin, [samApi, luisApi], "build");
  const added = await admin.post(`/api/v1/channels/${channel.id}/members`, {
    data: { kind: "agent", id: botId },
  });
  expect(added.ok(), `add ${BOT} to #${channel.name}`).toBe(true);
  const args = {
    projectId: device.projectId,
    deviceId: device.deviceId,
    prompt: `Bump the API client to v3 (${w}) and fix the type errors it causes.`,
  };
  await postAs(
    samApi,
    channel.id,
    `@${BOT} can you take this? [[call ocw_start_work_zone ${JSON.stringify(args)}]]`,
    {
      mentions: [{ kind: "agent", id: botId }],
    },
  );

  let luis: { context: BrowserContext; page: Page } | null = null;
  let sam: { context: BrowserContext; page: Page } | null = null;
  try {
    // ---- Luis reads the same card, with no button: only Sam can start it
    luis = await openAs(browser, LUIS, project);
    await luis.page.goto(`${BASE_URL}/chat/${channel.id}`);
    const card = cardWith(luis.page, "work_zone", `(${w})`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId("agent-card-status")).toHaveText("Proposed");
    await expect(card.getByTestId("agent-card-wz-device")).toContainText(`${DEVICE}`);
    await expect(card.getByTestId("agent-card-wz-device")).toContainText("Online");
    await expect(card.getByTestId("agent-card-wz-readonly")).toHaveText(
      "Only Sam Lee can start this session.",
    );
    await expect(card.getByRole("button")).toHaveCount(0);
    await expect(card.getByRole("link")).toHaveCount(0);
    await invariants(luis.page, `read-only work zone card ${w}`, card);
    await reveal(card);
    if (w === "1440") await captureReview(luis.page, "work-zone-proposal-card-readonly-1440");

    // ---- Sam, the requester: Start, then disabled with the reason while the device is offline, and back
    sam = await openAs(browser, SAM, project);
    await sam.page.goto(`${BASE_URL}/chat/${channel.id}`);
    const mine = cardWith(sam.page, "work_zone", `(${w})`);
    const start = mine.getByTestId("agent-card-start");
    await expect(start).toBeVisible({ timeout: 30_000 });
    await expect(start).not.toHaveAttribute("aria-disabled", "true");
    await device.shutdown();
    const reason = mine.getByTestId("agent-card-wz-blocked");
    await expect(reason).toHaveText(`${DEVICE} is offline. You can start it when the device is back.`, {
      timeout: 30_000,
    });
    await expect(start).toHaveAttribute("aria-disabled", "true");
    await expect(start).toHaveAttribute("aria-describedby", (await reason.getAttribute("id")) ?? "missing");
    await expect(mine.getByTestId("agent-card-wz-device").getByTestId("device-state")).toHaveText("Offline");
    // aria-disabled keeps it focusable; Playwright treats it as disabled, so the click is forced: nothing opens.
    await start.click({ force: true });
    await expect(sam.page.getByTestId("agent-card-confirm")).toHaveCount(0);
    await expect(mine.getByTestId("agent-card-dismiss")).toBeEnabled();
    await invariants(sam.page, `offline work zone card ${w}`, mine);
    await device.restart();
    await expect(start).not.toHaveAttribute("aria-disabled", "true", { timeout: 30_000 });
    await expect(reason).toHaveCount(0);

    // ---- Dismiss with a note: the card says who dismissed it, for everyone
    await mine.getByTestId("agent-card-dismiss").click();
    const dialog = sam.page.getByTestId("agent-card-confirm");
    await expect(dialog).toContainText("Dismiss this proposal?");
    await expect(dialog).toContainText(`No session starts. ${BOT} is told you dismissed it.`);
    await dialog.getByTestId("agent-card-note-input").fill("Next sprint");
    await dialog.getByTestId("agent-card-confirm-submit").click();
    await expect(mine.getByTestId("agent-card-status")).toHaveText("Dismissed", { timeout: 15_000 });
    await expect(card.getByTestId("agent-card-status")).toHaveText("Dismissed", { timeout: 15_000 });
    await expect(card.getByTestId("agent-card-decision")).toContainText("Dismissed by Sam Lee");
    await expect(card.getByTestId("agent-card-note")).toHaveText("“Next sprint”");
  } finally {
    await luis?.context.close();
    await sam?.context.close();
  }
});
