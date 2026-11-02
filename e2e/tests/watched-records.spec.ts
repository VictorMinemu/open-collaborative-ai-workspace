import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { addBot, waitBotReady } from "../support/automations";
import { cardTile, createCard } from "../support/board";
import { freshTeamBot } from "../support/bot-tools";
import { cellToken } from "../support/cell-token";
import { ALEX, postAs } from "../support/chat";
import { FakeCellPlugin, type MentionPayload } from "../support/fake-cell-plugin";
import {
  captureReview,
  expectNoSidewaysScroll,
  expectTouchTargets,
  unnamedControls,
} from "../support/layout";
import {
  connectErp,
  grantErp,
  linkWatch,
  mutateErp,
  readErp,
  recordErpTools,
  registerFakeErp,
  removeConnector,
  resetErp,
  waitChecked,
  watchesOf,
} from "../support/watched";
import { ADMIN, API_URL } from "./env";

/**
 * 07.6-17 (AUTO-04, D-04, D-07, UI-SPEC Surface 7, 8c, R9, R11): watched records in the browser. Víctor links board
 * card EXP-0042 to sales order SO-10442 in the fake ERP from the card menu (connector, Find, fields, interval, bot),
 * the ERP changes "elsewhere", Check now reports it: the tile says Changed and the change card is in the thread. Then
 * every case of the dialog (a member-account connector without a share, one not connected, an unknown id, Advanced,
 * edit, stop), a viewer who cannot post, a bot update refused by compare-and-set (Not saved), a paused per-member
 * watch, and the visual contract at 1440 and 390 in light and dark. The simulated cell answers nothing on its own:
 * the spec drives the one bot call (`ocw_record_update`) itself.
 */

test.describe.configure({ mode: "serial" });

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

let admin: APIRequestContext;
let sam: APIRequestContext;
let plugin: FakeCellPlugin;
let opsId: string;
let erp: { id: string; name: string; safeName: string };

/** A fresh board `orders-xxxx` with Ops helper and Sam, and one card. */
async function freshBoard(title: string): Promise<{ id: string; name: string; cardId: string }> {
  const name = `orders-${Math.random().toString(36).slice(2, 6)}`;
  const res = await admin.post("/api/v1/channels", { data: { name, visibility: "public", layout: "board" } });
  expect(res.ok(), `create ${name}: ${await res.text()}`).toBe(true);
  const { id } = (await res.json()) as { id: string };
  expect((await sam.post(`/api/v1/channels/${id}/join`)).ok()).toBe(true);
  await addBot(admin, id, opsId);
  const card = await createCard(admin, id, { title });
  return { id, name, cardId: card.messageId };
}

async function openBoardPage(page: Page, boardId: string): Promise<Locator> {
  await page.goto(`${BASE_URL}/chat/${boardId}`);
  const board = page.getByTestId("board-view");
  await expect(board).toBeVisible({ timeout: 20_000 });
  await expect(board.getByText("Loading board")).toHaveCount(0);
  return board;
}

async function openThread(page: Page, cardId: string): Promise<Locator> {
  await cardTile(page, cardId).locator('[data-slot="card-open"]').click();
  const strip = page.getByTestId("card-strip");
  await expect(strip).toBeVisible();
  return strip;
}

/** Picks `option` from the Base UI select `trigger`. */
async function pick(page: Page, trigger: Locator, option: string | RegExp): Promise<void> {
  await trigger.click();
  await page.getByRole("option", { name: option, exact: typeof option === "string" }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

const dialog = (page: Page) => page.getByTestId("watch-record-dialog");

/** Opens the card menu of a tile and returns its visible item names in order. */
async function menuItems(page: Page, cardId: string): Promise<string[]> {
  await cardTile(page, cardId).getByTestId("card-menu").click();
  const content = page.getByTestId("card-menu-content");
  await expect(content).toBeVisible();
  return (await content.getByRole("menuitem").allInnerTexts()).map((t) => t.trim());
}

/** Named controls, no sideways scroll, 44 px targets below 768 and no serious axe finding on `selector`, in both themes. */
async function invariants(page: Page, selector: string, label: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expectNoSeriousA11y(page, selector);
    expect(await unnamedControls(page), `${label} (${theme}): unnamed controls`).toEqual([]);
    await expectNoSidewaysScroll(page, `${label} (${theme})`);
    await expectTouchTargets(page, selector);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test.beforeAll(async () => {
  expect(cellToken(), "OCW_CELL_TOKEN is configured").not.toBe("");
  admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  sam = await apiAs(SAM);
  plugin = new FakeCellPlugin({ apiUrl: API_URL, token: cellToken(), autoAck: true });
  await plugin.start();
  opsId = await freshTeamBot(admin, "Ops helper");
  await waitBotReady(admin, opsId);
  for (const name of ["Field ERP", "Legacy ERP"]) await removeConnector(admin, name);
  erp = await registerFakeErp(admin);
  await grantErp(admin, opsId, erp, ["get_record", "update_record", "add_note"]);
  await resetErp();
});

test.afterAll(async () => {
  await plugin?.stop();
  await sam?.dispose();
  await admin?.dispose();
});

// ---------------------------------------------------------------- Task 1 (tracer)

test("Víctor watches SO-10442 from card EXP-0042; the ERP changes and the tile says Changed with the change card in the thread", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const w = widthOf(info.project.name);
  const board = await freshBoard("EXP-0042 · Pump order for Globex");
  const { context, page } = await openAs(browser, ADMIN, info.project.name);
  try {
    const view = await openBoardPage(page, board.id);

    // ---- 07.1's menu order, with the new item right after "Waiting on…" (R11)
    expect(await menuItems(page, board.cardId)).toEqual([
      "Open thread",
      "Move to…",
      "Move to top",
      "Move to bottom",
      "Waiting on…",
      "Watch external record…",
      "Edit card…",
      "Delete card…",
    ]);
    await page.getByRole("menuitem", { name: "Watch external record…" }).click();
    const d = dialog(page);
    await expect(d).toBeVisible();
    await expect(d.getByRole("heading", { name: "Watch an external record" })).toBeVisible();
    await expect(
      d.getByText(
        "OCW checks the record and posts what changed in this card's thread. Nothing is overwritten.",
      ),
    ).toBeVisible();

    // ---- the workspace's ERP, its info line; Find SO-10442
    await expect(d.getByTestId("watch-connector")).toHaveText(/ERP · workspace access/);
    await expect(
      d.getByText(`Read with the workspace's ERP access. Everyone in #${board.name} sees the values.`),
    ).toBeVisible();
    await d.getByTestId("watch-record-id").fill("SO-10442");
    await d.getByTestId("watch-find").click();
    const found = d.getByTestId("watch-found");
    await expect(found).toBeVisible();
    await expect(found).toContainText("Found:");
    for (const [label, value] of [
      ["Status", "Confirmed"],
      ["Delivery date", "2026-10-14"],
      ["Total", "1250.00"],
    ] as const) {
      const row = found.getByTestId("watch-field").filter({ hasText: label }).first();
      await expect(row).toContainText(value);
      await row.getByRole("checkbox").check();
    }
    await expect(d.getByTestId("watch-interval")).toHaveText(/1 hour/);
    await expect(d.getByTestId("watch-bot")).toHaveText(/Ops helper/);
    await expect(d.getByTestId("watch-submit")).not.toHaveAttribute("aria-disabled", "true");
    if (w === "390") {
      // Full screen at 390.
      const box = await d.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(389);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(840);
    }
    await invariants(page, '[data-testid="watch-record-dialog"]', "watch dialog");
    await captureReview(page, `watch-dialog-${w}`);

    // ---- Start watching: toast, the tile's indicator
    await d.getByTestId("watch-submit").click();
    await expect(page.getByText("Watching SO-10442.")).toBeVisible();
    await expect(d).toHaveCount(0);
    const indicator = cardTile(page, board.cardId).getByTestId("watched-indicator");
    await expect(indicator).toHaveAttribute("data-state", "watching");
    // The tile's description sentence carries the state (the icon is aria-hidden).
    const describedBy = await cardTile(page, board.cardId)
      .locator('[data-slot="card-open"]')
      .getAttribute("aria-describedby");
    await expect(page.locator(`[id="${describedBy}"]`)).toContainText("Watching ERP record SO-10442.");

    // ---- the baseline is silent; the thread's strip says what is watched
    const base = await waitChecked(admin, board.id, board.cardId);
    const strip = await openThread(page, board.cardId);
    const row = strip.getByTestId("watch-strip-row");
    await expect(row.getByTestId("watch-line")).toHaveText("Watching ERP · SO-10442 · checked just now");

    // ---- changed elsewhere; Check now reports it in the thread and on the tile
    await mutateErp("SO-10442", { status: "Shipped" });
    await row.getByTestId("watch-check-now").click();
    await expect(row.getByTestId("watch-check-now")).toHaveText(/Checked just now/);
    await expect(row.getByTestId("watch-check-now")).toBeDisabled();
    const change = page.getByTestId("thread-panel").getByTestId("agent-card").filter({
      hasText: "SO-10442 changed in ERP",
    });
    await expect(change).toBeVisible({ timeout: 30_000 });
    await expect(change).toContainText("Status");
    await expect(change).toContainText("Confirmed → Shipped");
    await expect(change.getByTestId("agent-card-status")).toHaveText(/Changed/);
    await expect(row).toHaveAttribute("data-state", "changed");
    await expect(row.getByTestId("watch-line")).toContainText("Changed in ERP");
    const after = await waitChecked(admin, board.id, board.cardId, base.checkedAt);
    expect(after.lastChangedAt).not.toBeNull();

    if (w === "1440") {
      await expect(cardTile(view, board.cardId).getByTestId("watched-indicator")).toHaveAttribute(
        "data-state",
        "changed",
      );
      await expect(cardTile(view, board.cardId).getByTestId("watched-indicator")).toHaveText("Changed");
      await invariants(page, '[data-testid="board-view"]', "board with a watched card");
    }
    await invariants(page, '[data-testid="watch-strip-row"]', "watch strip row");
    await captureReview(page, `watch-tile-strip-${w}`);

    await change.scrollIntoViewIfNeeded();
    await invariants(page, '[data-testid="agent-card"]', "change card");
    await captureReview(page, `watch-change-card-${w}`);

    if (w === "390") {
      // The board at 390: the tile with its Changed indicator.
      await page.goto(`${BASE_URL}/chat/${board.id}`);
      const tile = cardTile(page, board.cardId);
      await expect(tile.getByTestId("watched-indicator")).toHaveAttribute("data-state", "changed");
      await invariants(page, '[data-testid="board-view"]', "board with a watched card (390)");
      await captureReview(page, "watch-tile-390");
    }
  } finally {
    await resetErp();
    await context.close();
  }
});

// ---------------------------------------------------------------- Task 2: every case of the dialog

test("the dialog explains every refusal: share notice, not connected, unknown id, Advanced, edit and stop", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const w = widthOf(info.project.name);
  const board = await freshBoard("EXP-0043 · Valve order for Initech");
  // Field ERP reads with each member's own account: Víctor connected his key, but shares it nowhere yet.
  const field = await registerFakeErp(admin, { name: "Field ERP", perMember: true });
  await connectErp(admin, field.id);
  await grantErp(admin, opsId, field, ["get_record"]);
  // Legacy ERP is per member too; nobody here connected it (its tools are recorded as an earlier probe did).
  const legacy = await registerFakeErp(admin, { name: "Legacy ERP", perMember: true });
  await recordErpTools(legacy);
  await grantErp(admin, opsId, legacy, ["get_record"]);

  const { context, page } = await openAs(browser, ADMIN, info.project.name);
  try {
    await openBoardPage(page, board.id);
    // ---- the strip's own entry point: "Watch record"
    const strip = await openThread(page, board.cardId);
    await strip.getByTestId("watch-record-button").click();
    const d = dialog(page);
    await expect(d).toBeVisible();

    // ---- not connected: a disabled option and a Connect link
    await d.getByTestId("watch-connector").click();
    const legacyOption = page.getByRole("option", { name: "Legacy ERP · your account · connect it first" });
    await expect(legacyOption).toBeVisible();
    await expect(legacyOption).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("option", { name: "Field ERP · your account", exact: true }).click();
    await expect(page.getByRole("listbox")).toHaveCount(0);
    const connect = d.getByTestId("watch-connect-rows");
    await expect(connect).toContainText("Legacy ERP isn't connected.");
    await expect(connect.getByRole("link", { name: "Connect in Settings" })).toHaveAttribute(
      "href",
      `/settings/connections?connector=${legacy.id}`,
    );

    // ---- a member-account connector without a share: the notice, the Allow link, Start aria-disabled
    const notice = d.getByTestId("watch-share-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute("role", "note");
    await expect(notice).toContainText(
      new RegExp(
        `Field ERP uses your own account, so everyone in #${board.name} \\(\\d+ people\\) would see what it reads\\. Allow Field ERP in #${board.name} first\\.`,
      ),
    );
    await expect(notice.getByRole("link", { name: `Allow Field ERP in #${board.name}` })).toHaveAttribute(
      "href",
      `/settings/connections?share=${board.id}&connector=${field.id}`,
    );
    const start = d.getByTestId("watch-submit");
    await expect(start).toHaveAttribute("aria-disabled", "true");
    const noteId = await notice.getAttribute("id");
    await expect(start).toHaveAttribute("aria-describedby", noteId ?? "missing");
    await expect(d.getByTestId("watch-find")).toBeDisabled();
    await invariants(page, '[data-testid="watch-record-dialog"]', "watch dialog (share)");
    await captureReview(page, `watch-dialog-share-${w}`);

    // ---- an unknown id on the workspace's ERP
    await pick(page, d.getByTestId("watch-connector"), "ERP · workspace access");
    await expect(d.getByTestId("watch-share-notice")).toHaveCount(0);
    await d.getByTestId("watch-record-id").fill("SO-99999");
    await d.getByTestId("watch-find").click();
    await expect(d.getByText("No record SO-99999 in ERP.")).toBeVisible();
    await expect(d.getByTestId("watch-found")).toHaveCount(0);

    // ---- Advanced: the tools and the id argument
    await d.getByTestId("watch-advanced").click();
    const advanced = d.getByTestId("watch-advanced-section");
    for (const label of [
      "Read with",
      "Record ID argument",
      "Update with (optional)",
      "Add notes with (optional)",
    ]) {
      await expect(advanced.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(advanced.getByTestId("watch-read-tool")).toHaveText(/get_record/);
    await expect(advanced.getByTestId("watch-id-arg")).toHaveValue("id");
    await expect(
      advanced.getByText(
        "Bots change the record only through the update tool, and only if it hasn't changed since the last check.",
      ),
    ).toBeVisible();
    await pick(page, advanced.getByTestId("watch-write-tool"), "update_record");

    // ---- found → at least one field → Start
    await d.getByTestId("watch-record-id").fill("SO-10443");
    await d.getByTestId("watch-find").click();
    await expect(d.getByTestId("watch-found")).toBeVisible();
    await start.click();
    await expect(d.getByText("Pick at least one field")).toBeVisible();
    await d.getByTestId("watch-field").filter({ hasText: "Status" }).first().getByRole("checkbox").check();
    await start.click();
    await expect(page.getByText("Watching SO-10443.")).toBeVisible();
    const row = strip.getByTestId("watch-strip-row");
    await expect(row).toHaveAttribute("data-state", /watching|changed/);
    const linked = (await watchesOf(admin, board.id)).find((x) => x.cardMessageId === board.cardId);
    expect(linked?.checkIntervalMinutes).toBe(60);

    // ---- Edit watch…: the interval
    await row.getByTestId("watch-strip-menu").click();
    await page.getByRole("menuitem", { name: "Edit watch…" }).click();
    await expect(d.getByRole("heading", { name: "Edit watch" })).toBeVisible();
    await expect(d.getByTestId("watch-record-id")).toHaveValue("SO-10443");
    await expect(d.getByTestId("watch-record-id")).toHaveAttribute("readonly", "");
    await pick(page, d.getByTestId("watch-interval"), "4 hours");
    await d.getByTestId("watch-submit").click();
    await expect(page.getByText("Watch updated.")).toBeVisible();
    await expect
      .poll(
        async () =>
          (await watchesOf(admin, board.id)).find((x) => x.cardMessageId === board.cardId)
            ?.checkIntervalMinutes,
      )
      .toBe(240);

    // ---- Stop watching…: the confirmation, the toast, "Watch record" again
    await row.getByTestId("watch-strip-menu").click();
    await page.getByRole("menuitem", { name: "Stop watching…" }).click();
    const stop = page.getByTestId("watch-stop-dialog");
    await expect(stop.getByRole("heading", { name: "Stop watching SO-10443?" })).toBeVisible();
    await expect(
      stop.getByText("OCW stops checking it. Past change reports stay in the thread."),
    ).toBeVisible();
    await expect(stop.getByRole("button", { name: "Cancel" })).toBeFocused();
    await stop.getByRole("button", { name: "Stop watching" }).click();
    await expect(page.getByText("Stopped watching SO-10443.")).toBeVisible();
    await expect(strip.getByTestId("watch-record-button")).toBeVisible();
    expect((await watchesOf(admin, board.id)).length).toBe(0);
  } finally {
    await context.close();
  }

  // ---- a viewer who cannot post (Alex reads the public board, not a member): the line only
  await ensureMember(admin, ALEX, "developer");
  await linkWatch(admin, { cardMessageId: board.cardId, serverId: erp.id, agentId: opsId });
  const alex = await openAs(browser, ALEX, info.project.name);
  try {
    await openBoardPage(alex.page, board.id);
    expect(await menuItems(alex.page, board.cardId)).toEqual(["Open thread"]);
    await alex.page.keyboard.press("Escape");
    const strip = await openThread(alex.page, board.cardId);
    const row = strip.getByTestId("watch-strip-row");
    await expect(row.getByTestId("watch-line")).toContainText("ERP · SO-10442");
    await expect(row.getByTestId("watch-check-now")).toHaveCount(0);
    await expect(row.getByTestId("watch-strip-menu")).toHaveCount(0);
  } finally {
    await alex.context.close();
  }
});

// ---------------------------------------------------------------- Task 3: conflict, reconnect

test("a bot update refused by compare-and-set shows Not saved; the ERP keeps the outside value", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const w = widthOf(info.project.name);
  const board = await freshBoard("EXP-0044 · Pump order for Globex");
  const watch = await linkWatch(admin, { cardMessageId: board.cardId, serverId: erp.id, agentId: opsId });
  const base = await waitChecked(admin, board.id, board.cardId);
  expect(watch.id).toBeTruthy();

  // Víctor asks Ops helper in the card's thread; his post also checks the record (P-13).
  const handle = ((await (await admin.get(`/api/v1/agents/${opsId}`)).json()) as { username: string })
    .username;
  const asked = await postAs(admin, board.id, `@${handle} set the status to Cancelled`, {
    threadRootId: board.cardId,
    mentions: [{ kind: "agent", id: opsId }],
  });
  const ev = await plugin.waitFor(
    (e) => e.type === "agent.mention.v1" && (e.data as unknown as MentionPayload).message.id === asked.id,
    20_000,
  );
  const m = ev.data as unknown as MentionPayload;
  expect(m.turn?.tools ?? []).toContain("ocw_record_update");
  await waitChecked(admin, board.id, board.cardId, base.checkedAt);

  // Someone changes it in the ERP before the bot writes; the bot's update is refused and nothing is overwritten.
  await mutateErp("SO-10442", { status: "Shipped" });
  const res = await plugin.request<{ ok: boolean; code: string | null; sentence: string }>(
    "POST",
    "/records/update",
    { eventId: m.eventId, agentId: opsId, changes: { "/status": "Cancelled" } },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(409);
  expect(res.body.code).toBe("record_changed");
  await plugin.reply(m, res.body.sentence);
  expect((await readErp("SO-10442")).status).toBe("Shipped");

  const { context, page } = await openAs(browser, ADMIN, info.project.name);
  try {
    await page.goto(`${BASE_URL}/chat/${board.id}?thread=${board.cardId}`);
    const conflict = page.getByTestId("thread-panel").getByTestId("agent-card").filter({
      hasText: "update wasn't saved",
    });
    await expect(conflict).toBeVisible({ timeout: 20_000 });
    await expect(conflict).toContainText("SO-10442 changed in ERP, so Ops helper's update wasn't saved");
    await expect(conflict.getByTestId("agent-card-status")).toHaveText(/Not saved/);
    await expect(conflict).toContainText(
      "Someone changed it in ERP after the last check. Nothing was overwritten.",
    );
    await expect(conflict).toContainText("Confirmed → Shipped");
    await expect(conflict).toContainText("Ask Ops helper again with the new values.");
    await conflict.scrollIntoViewIfNeeded();
    await invariants(page, '[data-testid="thread-panel"] [data-testid="agent-card"]', "conflict card");
    await captureReview(page, `watch-conflict-card-${w}`);
  } finally {
    await resetErp();
    await context.close();
  }
});

test("a per-member watch whose linker disconnected is paused: the strip says who must reconnect, the tile shows the off eye", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const w = widthOf(info.project.name);
  const board = await freshBoard("EXP-0045 · Order read with Víctor's account");
  const field = await registerFakeErp(admin, { name: "Field ERP", perMember: true });
  await connectErp(admin, field.id);
  await grantErp(admin, opsId, field, ["get_record", "update_record"]);
  const shared = await admin.post("/api/v1/member-account-shares", {
    data: { conversationId: board.id, resourceKind: "connector", resourceId: field.id },
  });
  expect(shared.status(), await shared.text()).toBe(201);
  const watch = await linkWatch(admin, { cardMessageId: board.cardId, serverId: field.id, agentId: opsId });
  const base = await waitChecked(admin, board.id, board.cardId);
  expect(base.lastStatus).toBe("ok");

  // Víctor disconnects his ERP account; the next check cannot read it.
  expect((await admin.delete(`/api/v1/connectors/${field.id}/connection`)).ok()).toBe(true);
  expect(
    (await admin.post(`/api/v1/watched-records/${watch.id}/check`, { data: { source: "manual" } })).status(),
  ).toBe(202);
  await expect
    .poll(async () => (await watchesOf(admin, board.id)).find((x) => x.id === watch.id)?.lastStatus, {
      timeout: 30_000,
    })
    .toBe("not_connected");

  const { context, page } = await openAs(browser, ADMIN, info.project.name);
  try {
    const view = await openBoardPage(page, board.id);
    await expect(cardTile(view, board.cardId).getByTestId("watched-indicator")).toHaveAttribute(
      "data-state",
      "paused",
    );
    const strip = await openThread(page, board.cardId);
    const row = strip.getByTestId("watch-strip-row");
    await expect(row).toHaveAttribute("data-state", "paused");
    await expect(row.getByTestId("watch-line")).toHaveText(
      `Paused: ${ADMIN.name} needs to reconnect Field ERP.`,
    );
    await invariants(page, '[data-testid="watch-strip-row"]', "paused strip row");
    if (w === "390") await captureReview(page, "watch-reconnect-390");
  } finally {
    await context.close();
    await removeConnector(admin, "Field ERP");
  }
});
