import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { apiAs, ensureMember, openAs, SAM } from "../support/actors";
import { ADMIN, shot } from "./env";

/**
 * CHAT-02 (D-08): the chat sidebar grouped by department and team. Channels belong to the organization or to a unit
 * (chosen on create, moved later by the owner or an admin); one collapsible section per department, the member's own
 * first, team channels nested with a sub-label; collapse state survives reloads. Then the views.
 */

type Unit = { id: string; name: string; parentId: string | null };

/** Get-or-create a unit (sibling names are unique, and both projects share one stack). */
async function ensureUnit(
  admin: APIRequestContext,
  kind: "department" | "team",
  name: string,
  parentId: string | null,
): Promise<string> {
  const { units } = (await (await admin.get("/api/v1/units")).json()) as { units: Unit[] };
  const found = units.find((u) => u.name === name && u.parentId === parentId);
  if (found) return found.id;
  const res = await admin.post("/api/v1/units", { data: { kind, name, parentId } });
  expect(res.ok(), `create ${kind} ${name}`).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

async function addToUnit(admin: APIRequestContext, unitId: string, userId: string) {
  const res = await admin.post(`/api/v1/units/${unitId}/members`, { data: { userId, role: "member" } });
  // 409: already a member (both projects share one stack).
  expect(res.ok() || res.status() === 409, `add ${userId} to ${unitId}: ${res.status()}`).toBe(true);
}

async function channelIn(
  api: APIRequestContext,
  name: string,
  unitId: string | null,
  joiners: APIRequestContext[] = [],
): Promise<string> {
  const res = await api.post("/api/v1/channels", { data: { name, visibility: "public", unitId } });
  expect(res.ok(), `create #${name}`).toBe(true);
  const id = ((await res.json()) as { id: string }).id;
  for (const j of joiners) expect((await j.post(`/api/v1/channels/${id}/join`)).ok()).toBe(true);
  return id;
}

/** The sidebar: a column on desktop, the navigation drawer on phones. */
async function openSidebar(page: Page, mobile: boolean): Promise<Locator> {
  if (mobile) await page.getByTestId("mobile-nav-trigger").click();
  const list = page.getByTestId("channel-list").filter({ visible: true }).first();
  await expect(list).toBeVisible();
  return list;
}

const section = (scope: Page | Locator, unitId: string) =>
  scope.locator(`[data-testid="sidebar-section"][data-unit-id="${unitId}"]`).first();
const channelLink = (scope: Page | Locator, name: string) =>
  scope.locator(`[data-testid="channel-link"][data-channel-name="${name}"]`).first();

async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

test.describe.configure({ mode: "serial" });

test("channels are grouped by department; a new Product channel reaches Product members live; collapse persists; the owner moves it", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const size = mobile ? "390" : "1440";
  const tag = `${project}-${Date.now().toString(36)}`;

  const admin = await apiAs(ADMIN);
  const samId = await ensureMember(admin, SAM, "developer");
  const samApi = await apiAs(SAM);
  const product = await ensureUnit(admin, "department", "Product", null);
  const mobileTeam = await ensureUnit(admin, "team", "Mobile", product);
  const finance = await ensureUnit(admin, "department", "Finance", null);
  await addToUnit(admin, product, samId);

  const mobileDev = `mobile-dev-${tag}`;
  const budget = `budget-${tag}`;
  await channelIn(admin, mobileDev, mobileTeam, [samApi]);
  await channelIn(admin, budget, finance, [samApi]);

  // ---- Sam's sidebar: Organization (#general), Product (#mobile-dev with a "Mobile" sub-label), Finance
  const sam = await openAs(browser, SAM, project);
  let list = await openSidebar(sam.page, mobile);
  await expect(section(list, product)).toBeVisible();
  const order = await list
    .locator('[data-testid="sidebar-section"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-unit-id")));
  expect(order.filter((id) => id === "org" || id === product || id === finance)).toEqual([
    "org",
    product,
    finance,
  ]);
  await expect(channelLink(section(list, "org"), "general")).toBeVisible();
  const dev = channelLink(section(list, product), mobileDev);
  await expect(dev).toBeVisible();
  await expect(dev.getByTestId("channel-sublabel")).toHaveText("Mobile");
  await expect(channelLink(section(list, finance), budget)).toBeVisible();
  await bothThemes(sam.page, `sidebar-grouped-${size}`);

  // ---- the admin creates #design in Product through the dialog's "Belongs to"
  const design = `design-${tag}`;
  const a = await openAs(browser, ADMIN, project);
  if (mobile) await a.page.getByTestId("mobile-nav-trigger").click();
  await a.page.getByTestId("create-channel").filter({ visible: true }).first().click();
  const dialog = a.page.getByTestId("create-channel-dialog");
  await dialog.getByLabel("Name").fill(design);
  await dialog.getByTestId("channel-unit-select").click();
  await a.page.getByRole("option", { name: "Product", exact: true }).click();
  await expect(dialog.getByTestId("channel-unit-select")).toHaveText(/^Product$/);
  await bothThemes(a.page, `channel-create-unit-${size}`);
  await dialog.getByTestId("create-channel-submit").click();
  await expect(a.page.getByTestId("channel-title")).toHaveText(design);

  // ---- Sam's Product section shows it within 5 s, without reloading (a suggestion until he joins)
  const live = channelLink(section(list, product), design);
  await expect(live).toBeVisible({ timeout: 5_000 });
  await expect(live).toHaveAttribute("data-joined", "false");

  // ---- collapsing Finance survives a reload
  await section(list, finance).getByTestId("section-toggle").click();
  await expect(section(list, finance)).toHaveAttribute("data-collapsed", "true");
  await expect(channelLink(section(list, finance), budget)).toHaveCount(0);
  await sam.page.reload();
  list = await openSidebar(sam.page, mobile);
  await expect(section(list, finance)).toHaveAttribute("data-collapsed", "true");
  await expect(channelLink(section(list, finance), budget)).toHaveCount(0);
  // The other project's Finance channel is there too (one shared stack).
  await expect(section(list, finance).getByTestId("section-count")).toHaveText(/^[1-9]\d*$/);
  // Expand again so later runs (and screenshots) start from the default state.
  await section(list, finance).getByTestId("section-toggle").click();
  await expect(channelLink(section(list, finance), budget)).toBeVisible();

  // ---- Sam joins #design from his Product section; the owner moves it to Finance with "Move to…"
  await channelLink(section(list, product), design).click();
  await expect(sam.page.getByTestId("channel-title")).toHaveText(design);
  await sam.page.getByTestId("join-channel").click();
  await expect(sam.page.getByTestId("composer")).toBeVisible();
  list = await openSidebar(sam.page, mobile);
  await expect(channelLink(section(list, product), design)).not.toHaveAttribute("data-joined", "false");

  await a.page.getByTestId("channel-menu").click();
  await a.page.getByTestId("move-channel").click();
  const moveDialog = a.page.getByTestId("move-channel-dialog");
  await expect(moveDialog.getByTestId("channel-unit-select")).toHaveText(/^Product$/);
  await moveDialog.getByTestId("channel-unit-select").click();
  await a.page.getByRole("option", { name: "Finance", exact: true }).click();
  await bothThemes(a.page, `channel-move-${size}`);
  await moveDialog.getByTestId("move-channel-submit").click();
  await expect(moveDialog).toBeHidden();

  // Live: out of Product, into Finance, without a reload.
  await expect(channelLink(section(list, finance), design)).toBeVisible({ timeout: 5_000 });
  await expect(channelLink(section(list, product), design)).toHaveCount(0);

  await a.context.close();
  await sam.context.close();
  await samApi.dispose();
  await admin.dispose();
});

/** A team bot on the never-metered mock model (bots left by earlier runs with this name are deleted first). */
async function freshTeamBot(admin: APIRequestContext, name: string): Promise<{ id: string }> {
  const listed = (await (await admin.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; name: string }>;
  };
  for (const a of listed.agents.filter((x) => x.name === name)) {
    expect((await admin.delete(`/api/v1/agents/${a.id}`)).ok()).toBe(true);
  }
  const res = await admin.post("/api/v1/agents", {
    data: {
      name,
      description: "Keeps an eye on the sidebar.",
      instructions: "Answer briefly.",
      modelProvider: "mock",
      modelId: "mock-1",
    },
  });
  expect(res.ok(), "create team bot").toBe(true);
  return (await res.json()) as { id: string };
}

async function postAs(api: APIRequestContext, conv: string, body: string, threadRootId?: string) {
  const res = await api.post(`/api/v1/conversations/${conv}/messages`, {
    data: { body, ...(threadRootId ? { threadRootId } : {}) },
  });
  expect(res.ok(), `post in ${conv}: ${res.status()}`).toBe(true);
  return (await res.json()) as { id: string; seq: number };
}

test("the views: Threads with unread replies, All unread first with previews, AI Chats; a segmented row at 390", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const size = mobile ? "390" : "1440";
  const tag = `${project}-${Date.now().toString(36)}`;

  const admin = await apiAs(ADMIN);
  const samId = await ensureMember(admin, SAM, "developer");
  const samApi = await apiAs(SAM);
  const channel = await channelIn(admin, `views-${tag}`, null, [samApi]);
  const root = await postAs(admin, channel, `Launch checklist for ${tag}: who owns the **release notes**?`);
  await postAs(samApi, channel, "I can take the release notes.", root.id);
  // A bot DM for AI Chats.
  const bot = await freshTeamBot(admin, `Sidebar Scout ${project}`);
  const botDm = await samApi.post("/api/v1/dms", { data: { participants: [{ kind: "agent", id: bot.id }] } });
  expect(botDm.ok(), "bot DM").toBe(true);

  const sam = await openAs(browser, SAM, project);

  // ---- the views sit at the top of the sidebar: rows on desktop, a segmented row above the sections at 390
  const list = await openSidebar(sam.page, mobile);
  const views = sam.page.getByTestId(mobile ? "views-segmented" : "views-list").filter({ visible: true });
  await expect(views).toBeVisible();
  for (const id of ["view-all", "view-mentions", "view-threads", "view-ai", "saved-link"]) {
    await expect(views.getByTestId(id)).toBeVisible();
  }
  await expect(views.locator("a")).toHaveText([/All/, /Mentions/, /Threads/, /AI Chats/, /Saved/]);
  if (mobile) {
    const rowBox = await views.boundingBox();
    const firstSection = await list.locator('[data-testid="sidebar-section"]').first().boundingBox();
    expect((rowBox?.y ?? 0) + (rowBox?.height ?? 0)).toBeLessThanOrEqual(firstSection?.y ?? 0);
    await bothThemes(sam.page, "views-segmented-390");
  }

  // ---- Threads: the thread Sam replied in; the admin's reply arrives live as "1 new reply"
  await views.getByTestId("view-threads").click();
  await expect(sam.page).toHaveURL(/\/chat\/threads$/);
  const card = sam.page.locator(`[data-testid="thread-card"][data-root-id="${root.id}"]`);
  await expect(card).toBeVisible();
  await expect(card.getByTestId("thread-unread")).toHaveCount(0);
  await postAs(admin, channel, `Thanks! Draft due Friday (${tag}).`, root.id);
  await expect(card.getByTestId("thread-unread")).toHaveText("1 new reply", { timeout: 5_000 });
  await expect(card.getByTestId("thread-last-reply").last()).toContainText("Draft due Friday");
  await bothThemes(sam.page, `views-threads-${size}`);

  // ---- opening it in the thread panel reads it
  await card.getByTestId("thread-open").click();
  await expect(sam.page.getByTestId("thread-panel")).toBeVisible();
  await expect(sam.page.getByTestId("thread-panel")).toContainText("Draft due Friday");
  if (mobile) await sam.page.getByTestId("close-thread").click();
  await openSidebar(sam.page, mobile);
  await sam.page.getByTestId("view-threads").filter({ visible: true }).click();
  await expect(card).toBeVisible();
  await expect(card.getByTestId("thread-unread")).toHaveCount(0);

  // ---- All: unread conversations first, each with its preview
  await postAs(admin, channel, `Standup moved to 10:30 (${tag})`);
  const adminDm = await admin.post("/api/v1/dms", { data: { participants: [{ kind: "user", id: samId }] } });
  expect(adminDm.ok()).toBe(true);
  const dmId = ((await adminDm.json()) as { id: string }).id;
  await postAs(admin, dmId, `Quick question about ${tag}`);
  await openSidebar(sam.page, mobile);
  await sam.page.getByTestId("view-all").filter({ visible: true }).click();
  await expect(sam.page).toHaveURL(/\/chat\/all$/);
  const channelRow = sam.page.locator(`[data-testid="all-item"][data-conversation-id="${channel}"]`);
  const dmRow = sam.page.locator(`[data-testid="all-item"][data-conversation-id="${dmId}"]`);
  await expect(channelRow).toHaveAttribute("data-unread", "true");
  await expect(channelRow.getByTestId("conversation-preview")).toHaveText(`Standup moved to 10:30 (${tag})`);
  await expect(dmRow).toHaveAttribute("data-unread", "true");
  await expect(dmRow.getByTestId("conversation-preview")).toHaveText(`Quick question about ${tag}`);
  const flags = await sam.page
    .getByTestId("all-item")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-unread") === "true"));
  const firstRead = flags.indexOf(false);
  expect(firstRead === -1 || flags.slice(firstRead).every((f) => !f)).toBe(true);
  await bothThemes(sam.page, `views-all-${size}`);

  // ---- AI Chats: the bot DMs
  await openSidebar(sam.page, mobile);
  await sam.page.getByTestId("view-ai").filter({ visible: true }).click();
  await expect(sam.page).toHaveURL(/\/chat\/ai$/);
  const botRow = sam.page.getByTestId("ai-chat-item").filter({ hasText: `Sidebar Scout ${project}` });
  await expect(botRow).toBeVisible();
  await expect(botRow).toContainText("Team");
  await expect(sam.page.getByTestId("ai-chat-item").filter({ hasText: "Quick question" })).toHaveCount(0);
  await bothThemes(sam.page, `views-ai-${size}`);

  await sam.context.close();
  await samApi.dispose();
  await admin.dispose();
});

test("a long channel list with unread badges scrolls inside the sidebar; the page itself never scrolls", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "the column sidebar is the desktop layout");
  test.setTimeout(120_000);
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  const sam = await apiAs(SAM);
  // 40 channels Sam joined, each with an unread message from Víctor: far more rows than a 900 px window holds, each
  // with an unread badge whose screen-reader text is absolutely positioned (07.1 gate: that text escaped the sidebar's
  // scroller and made the whole document scrollable, so focusing anything shifted the app up).
  for (let n = 0; n < 40; n++) {
    const tag = `${Date.now().toString(36)}${n}`;
    const id = await channelIn(admin, `long-${tag}`, null, [sam]);
    expect(
      (await admin.post(`/api/v1/conversations/${id}/messages`, { data: { body: "unread" } })).ok(),
    ).toBe(true);
  }
  const s = await openAs(browser, SAM, "desktop");
  await expect(s.page.getByTestId("unread-badge").first()).toBeAttached();
  const overflow = await s.page.evaluate(() => {
    const root = document.scrollingElement as HTMLElement;
    return { scroll: root.scrollHeight, view: window.innerHeight };
  });
  expect(overflow.scroll, "the document is exactly one window tall").toBe(overflow.view);
  // The list itself scrolls.
  const list = s.page.getByTestId("section-sidebar").locator(".overflow-y-auto").first();
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await s.context.close();
  await admin.dispose();
  await sam.dispose();
});
