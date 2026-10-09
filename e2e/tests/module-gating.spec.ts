import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
// The catalog is code (ADR-0024): the spec turns a module off with exactly the rows the catalog lists.
import { MODULE_CATALOG, type ModuleId } from "../../packages/contracts/src/module-access.ts";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { seedPlan } from "../support/ai-chat";
import { bothThemes } from "../support/files";
import { ADMIN } from "./env";

/**
 * Module access in the web (07.3-03, ACCESS-03, D-03, P-08). An admin turns a module off for Mia with the catalog's
 * ordinary deny rules (`POST /permission-rules`, the module-access API lands in parallel); her open tab loses the
 * module's entries live, and a deep link into it shows the in-place "turned off for you" state, never the page.
 * Loading or a failed `/me/permissions` never hides anything: the API stays the authority. Mia is used by this spec
 * only, so no other spec sees her rules; every rule it creates is deleted.
 */

test.describe.configure({ mode: "serial" });

const MIA: Actor = { name: "Mia Gate", email: "mia@ocw.test", password: "mia-e2e-password-123" };
const FAKE_URL = process.env.OCW_E2E_FAKE_URL ?? "";
const PLAN_MODEL = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;

let admin: APIRequestContext;
let mia: APIRequestContext;
let sam: APIRequestContext;
let miaId = "";
const rules: string[] = [];
const chats: Array<{ api: () => APIRequestContext; id: string }> = [];

const sizeOf = (project: string) => (project === "mobile" ? "390" : "1440");

/** Turns `module` off for Mia: one deny row per catalog pattern, at organization scope. */
async function turnOff(module: ModuleId): Promise<string[]> {
  const ids: string[] = [];
  for (const permission of MODULE_CATALOG[module].patterns) {
    const res = await admin.post("/api/v1/permission-rules", {
      data: { scopeUnitId: null, subjectKind: "user", subjectId: miaId, permission, effect: "deny" },
    });
    expect(res.ok(), `deny ${permission} for Mia: ${res.status()}`).toBe(true);
    ids.push(((await res.json()) as { id: string }).id);
  }
  rules.push(...ids);
  return ids;
}

/** Deletes the rows `turnOff` wrote, so the module is back on. */
async function turnOn(ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    expect((await admin.delete(`/api/v1/permission-rules/${id}`)).ok(), `delete rule ${id}`).toBe(true);
    rules.splice(rules.indexOf(id), 1);
  }
}

/** Waits until the chat's latest answer is no longer streaming. */
async function settled(api: APIRequestContext, chatId: string) {
  await expect
    .poll(
      async () => {
        const snap = (await (await api.get(`/api/v1/ai-chats/${chatId}`)).json()) as {
          messages: Array<{ authorKind: string; status: string }>;
        };
        return snap.messages.filter((m) => m.authorKind === "agent").at(-1)?.status;
      },
      { timeout: 15_000 },
    )
    .toBe("completed");
}

/** A finished one-exchange AI chat of `who` (fake ChatGPT plan only). */
async function aiChatOf(who: "mia" | "sam", body: string): Promise<string> {
  const api = who === "mia" ? mia : sam;
  const res = await api.post("/api/v1/ai-chats", {
    data: { clientMessageId: `cm-${randomUUID()}`, body, model: PLAN_MODEL },
  });
  expect(res.ok(), `create chat: ${res.status()}`).toBe(true);
  const id = ((await res.json()) as { chat: { id: string } }).chat.id;
  chats.push({ api: () => (who === "mia" ? mia : sam), id });
  await settled(api, id);
  return id;
}

/** A fresh team bot on the mock model (bots left by earlier runs are deleted first) and Mia's DM with it. */
async function botDmOf(name: string): Promise<string> {
  const listed = (await (await admin.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; name: string }>;
  };
  for (const a of listed.agents.filter((x) => x.name === name)) {
    expect((await admin.delete(`/api/v1/agents/${a.id}`)).ok()).toBe(true);
  }
  const res = await admin.post("/api/v1/agents", {
    data: {
      name,
      description: "Answers module questions.",
      instructions: "Answer briefly.",
      modelProvider: "mock",
      modelId: "mock-1",
    },
  });
  expect(res.ok(), "create team bot").toBe(true);
  const bot = ((await res.json()) as { id: string }).id;
  const dm = await mia.post("/api/v1/dms", { data: { participants: [{ kind: "agent", id: bot }] } });
  expect(dm.ok(), `Mia's bot DM: ${dm.status()}`).toBe(true);
  return ((await dm.json()) as { id: string }).id;
}

/** The chat sidebar: a column on desktop, the navigation drawer on phones (opened when closed). */
async function sidebar(page: Page, mobile: boolean): Promise<Locator> {
  if (mobile && !(await page.getByTestId("channel-list").filter({ visible: true }).count())) {
    await page.getByTestId("mobile-nav-trigger").click();
  }
  const list = page.getByTestId("channel-list").filter({ visible: true }).first();
  await expect(list).toBeVisible();
  return page.getByTestId(mobile ? "views-segmented" : "views-list").filter({ visible: true });
}

/**
 * Records every watched view that ever rendered in the page (from the first byte of each navigation), so a gate can
 * be proven to never flash the page it guards.
 */
const WATCHED = ["ai-chat-view", "ai-chats-view", "ai-share-view", "dm-view", "module-off"] as const;
async function watchFlashes(page: Page) {
  await page.addInitScript((ids: readonly string[]) => {
    const seen: string[] = [];
    (window as unknown as { __ocwSeen: string[] }).__ocwSeen = seen;
    new MutationObserver(() => {
      for (const id of ids) {
        if (!seen.includes(id) && document.querySelector(`[data-testid="${id}"]`)) seen.push(id);
      }
    }).observe(document, { childList: true, subtree: true });
  }, WATCHED);
}
const seenIn = (page: Page) =>
  page.evaluate(() => (window as unknown as { __ocwSeen?: string[] }).__ocwSeen ?? []);

/** Opens `path` and expects the in-place off state of `module`, never a flash of `page`. */
async function expectOff(page: Page, path: string, module: ModuleId, neverShown: (typeof WATCHED)[number]) {
  await page.goto(`${BASE_URL}${path}`);
  const off = page.getByTestId("module-off");
  await expect(off).toBeVisible();
  await expect(off).toHaveAttribute("data-module", module);
  await expect(off.getByRole("link", { name: "Go to Chat" })).toBeVisible();
  expect(await seenIn(page), `${path} never renders ${neverShown}`).not.toContain(neverShown);
}

test.beforeAll(async () => {
  test.skip(!FAKE_URL, "OCW_E2E_FAKE_URL is not set (the fake model is not running)");
  admin = await apiAs(ADMIN);
  miaId = await ensureMember(admin, MIA, "developer");
  await ensureMember(admin, SAM, "developer");
  mia = await apiAs(MIA);
  sam = await apiAs(SAM);
  for (const api of [mia, sam]) {
    await seedPlan(api);
    await api.post("/api/v1/me/model-credentials/chatgpt/welcome-seen", { data: {} });
  }
});

test.afterAll(async () => {
  // Rules are org-wide data in the e2e database: leave none behind, even after a failure.
  for (const id of [...rules]) await admin?.delete(`/api/v1/permission-rules/${id}`);
  for (const c of chats) await c.api()?.patch(`/api/v1/ai-chats/${c.id}`, { data: { archived: true } });
  await mia?.dispose();
  await sam?.dispose();
  await admin?.dispose();
});

test("AI chats off: the open sidebar loses the section and the view live; deep links show the off state", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const size = sizeOf(project);

  const chatId = await aiChatOf("mia", "Outline a one-page onboarding checklist");
  const samChat = await aiChatOf("sam", "Draft a short team retro agenda");
  const share = await sam.post(`/api/v1/ai-chats/${samChat}/shares`, { data: {} });
  expect(share.status(), "share link").toBe(201);
  const sharePath = ((await share.json()) as { path: string }).path;

  const m = await openAs(browser, MIA, project);
  await watchFlashes(m.page);
  try {
    // ---- on: the section and the AI Chats view are there
    let views = await sidebar(m.page, mobile);
    await expect(m.page.getByTestId("sidebar-ai-chats").filter({ visible: true })).toBeVisible();
    await expect(views.getByTestId("view-ai")).toBeVisible();

    // ---- the admin turns AI chats off for Mia: gone within 5 s, no reload; the other views keep their order
    const off = await turnOff("ai_chats");
    await expect(m.page.getByTestId("sidebar-ai-chats")).toHaveCount(0, { timeout: 5_000 });
    await expect(views.getByTestId("view-ai")).toHaveCount(0, { timeout: 5_000 });
    await expect(views.locator("a")).toHaveText([/All/, /Mentions/, /Threads/, /Saved/]);
    await bothThemes(m.page, `modules-hidden-chat-sidebar-${size}`);

    // ---- deep links: the off state in place (the chat sidebar stays beside it on desktop), never the chat
    await expectOff(m.page, `/chat/ai/${chatId}`, "ai_chats", "ai-chat-view");
    if (!mobile) {
      await expect(m.page.getByTestId("section-sidebar")).toBeVisible();
      await expect(m.page.getByTestId("channel-list")).toBeVisible();
      await expect(m.page.getByTestId("sidebar-ai-chats")).toHaveCount(0);
    }
    await bothThemes(m.page, `module-off-ai-chats-${size}`);
    await expectOff(m.page, "/chat/ai/new", "ai_chats", "ai-chat-view");
    await expectOff(m.page, "/chat/ai", "ai_chats", "ai-chats-view");
    await expectOff(m.page, sharePath, "ai_chats", "ai-share-view");

    // ---- back on: the open off state swaps to the chat and the section returns, live
    await m.page.goto(`${BASE_URL}/chat/ai/${chatId}`);
    await expect(m.page.getByTestId("module-off")).toBeVisible();
    await turnOn(off);
    await expect(m.page.getByTestId("ai-chat-view")).toBeVisible({ timeout: 5_000 });
    await expect(m.page.getByTestId("module-off")).toHaveCount(0);
    views = await sidebar(m.page, mobile);
    await expect(m.page.getByTestId("sidebar-ai-chats").filter({ visible: true })).toBeVisible();
    await expect(views.getByTestId("view-ai")).toBeVisible();
    // A fresh load of a module that is on shows a skeleton, then the page: never a flash of the off state.
    await m.page.goto(`${BASE_URL}/chat/ai/${chatId}`);
    await expect(m.page.getByTestId("ai-chat-view")).toBeVisible();
    expect(await seenIn(m.page)).not.toContain("module-off");
  } finally {
    await m.context.close();
  }
});

test("a failed /me/permissions never hides AI chats or bot DMs (P-08: only `off` hides)", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const chatId = await aiChatOf("mia", "List three quick wins for the week");
  const botName = `Gate Scout ${project}`;
  await botDmOf(botName);

  const m = await openAs(browser, MIA, project);
  try {
    let failures = 0;
    await m.page.route("**/api/v1/me/permissions", (route) => {
      failures += 1;
      return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"internal"}' });
    });
    await m.page.reload();
    const views = await sidebar(m.page, mobile);
    await expect(m.page.getByTestId("sidebar-ai-chats").filter({ visible: true })).toBeVisible();
    await expect(views.getByTestId("view-ai")).toBeVisible();
    await expect(
      m.page.locator(`[data-testid="dm-link"][data-bot-name="${botName}"]`).filter({ visible: true }),
    ).toBeVisible();
    await m.page.goto(`${BASE_URL}/chat/ai/${chatId}`);
    await expect(m.page.getByTestId("ai-chat-view")).toBeVisible({ timeout: 10_000 });
    await expect(m.page.getByTestId("module-off")).toHaveCount(0);
    expect(failures, "the permissions fetch really failed").toBeGreaterThan(0);
  } finally {
    await m.context.close();
  }
});
