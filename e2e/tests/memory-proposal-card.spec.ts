import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { cellToken } from "../support/cell-token";
import { FakeCellPlugin } from "../support/fake-cell-plugin";
import { memoryScopes } from "../support/memory";
import { ADMIN, API_URL, shot } from "./env";

/**
 * 07.2-17 (MEM-05, MEM-06, D-08, UI-SPEC R4/R6): the chat card is a trustworthy mirror of a memory approval. Sam asks
 * his personal bot to read a web page and keep a summary; the simulated cell runs `web_fetch` (the turn becomes
 * tainted), its `ocw_memory_write` is refused `tainted`, and its `ocw_memory_propose` into Sam's private memory
 * becomes a platform-owned card in the DM: "Created by the workspace", the server's masked preview, the taint line, a
 * Pending pill and Approve / Deny for Sam. Sam approves with a note; the file changes, the decision line quotes the note
 * and the bot hears it. Every run uses the fake cell (no model, no provider).
 */

test.describe.configure({ mode: "serial" });

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

/** Every capability allowed: what an organization without a policy row gets. */
async function resetPolicy(admin: APIRequestContext) {
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

/** Sam's only personal bot, fresh, with internet on (memory is on by default), and its private chat. */
async function freshPersonalBot(samId: string): Promise<{ id: string; name: string; dmId: string }> {
  const sam = await apiAs(SAM);
  const listed = (await (await sam.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; scope: string; ownerUserId: string | null }>;
  };
  for (const a of listed.agents.filter((x) => x.scope === "personal" && x.ownerUserId === samId)) {
    expect((await sam.delete(`/api/v1/agents/${a.id}`)).ok()).toBe(true);
  }
  const res = await sam.post("/api/v1/agents/personal", {
    data: { modelProvider: "mock", modelId: "mock-1" },
  });
  expect(res.ok(), "create Sam's personal bot").toBe(true);
  const body = (await res.json()) as { agent: { id: string; name: string }; dmId: string };
  const internet = await sam.patch(`/api/v1/agents/${body.agent.id}/capabilities`, {
    data: { internet: true },
  });
  expect(internet.ok(), "internet on").toBe(true);
  await sam.dispose();
  return { id: body.agent.id, name: body.agent.name, dmId: body.dmId };
}

/** Sends `text` in the open DM and returns the bot's reply that contains `expectText`. */
async function ask(page: Page, text: string, expectText: string): Promise<Locator> {
  const box = page.getByTestId("composer");
  await box.click();
  await box.fill(text);
  await box.press("Enter");
  const reply = page
    .locator('[data-testid="message"][data-author-kind="agent"]')
    .filter({ hasText: expectText });
  await expect(reply.last()).toBeVisible({ timeout: 20_000 });
  return reply.last();
}

/** The newest platform-owned card of the open conversation. */
const linkedCard = (page: Page) => page.locator('[data-testid="agent-card"][data-approval-status]').last();

/** Interactive elements without an accessible name (same rule as ai-chat-visual.spec). */
async function unnamedControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const nameOf = (el: Element) => {
      const label = el.getAttribute("aria-label")?.trim();
      if (label) return label;
      const by = el.getAttribute("aria-labelledby");
      if (by) {
        const text = by
          .split(/\s+/u)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
          .trim();
        if (text) return text;
      }
      const text = (el as HTMLElement).innerText?.trim() || el.textContent?.trim();
      if (text) return text;
      if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return "label";
      return el.getAttribute("title")?.trim() ?? "";
    };
    const selector = 'button, [role="button"], a[href], [role="menuitem"], [role="option"], [role="switch"]';
    return [...document.querySelectorAll(selector)]
      .filter((el) => !el.closest('[aria-hidden="true"], [inert]') && visible(el) && !nameOf(el))
      .map((el) => el.outerHTML.slice(0, 200));
  });
}

/**
 * The card's invariants in one theme: named controls, no sideways scroll and 44 px controls at 390, and no serious or
 * critical axe violation on the card.
 */
async function invariants(page: Page, card: Locator, w: string, label: string) {
  expect(await unnamedControls(page), `${label}: controls without an accessible name`).toEqual([]);
  if (w === "390") {
    const sideways = await page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(sideways, `${label}: sideways scroll at 390`).toBeLessThanOrEqual(0);
    for (const control of await card.locator("button, a[href]").all()) {
      const box = await control.boundingBox();
      expect(box?.height ?? 0, `${label}: 44 px control at 390`).toBeGreaterThanOrEqual(44);
    }
  }
  await expectNoSeriousA11y(page, '[data-testid="agent-card"][data-approval-status]');
}

/** Light and dark review screenshots of the card, each after the invariants. */
async function review(page: Page, card: Locator, name: string, w: string) {
  await card.scrollIntoViewIfNeeded();
  const viewport = page.viewportSize();
  if (viewport) await page.mouse.move(viewport.width - 4, 4);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await invariants(page, card, w, `${name} (${theme})`);
    await shot(page, `${name}-${w}${theme === "dark" ? "-dark" : ""}`);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

let admin: APIRequestContext;
let plugin: FakeCellPlugin;
let samId: string;

test.beforeAll(async () => {
  const token = cellToken();
  expect(token, "OCW_CELL_TOKEN is configured").not.toBe("");
  admin = await apiAs(ADMIN);
  samId = await ensureMember(admin, SAM, "developer");
  await resetPolicy(admin);
  plugin = new FakeCellPlugin({ apiUrl: API_URL, token, autoAck: true, autoReply: true });
  await plugin.start();
});

test.afterAll(async () => {
  await plugin?.stop();
  await admin?.dispose();
});

test("Sam approves his bot's private-memory proposal in the DM card with a note; the file changes and the bot hears it", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const w = widthOf(project);
  const bot = await freshPersonalBot(samId);
  const sam = await openAs(browser, SAM, project);
  const samApi = await apiAs(SAM);
  try {
    await sam.page.goto(`${BASE_URL}/chat/dm/${bot.dmId}`);
    await expect(sam.page.getByTestId("dm-view")).toBeVisible();

    // ---- the tainted turn: web read → direct write refused → proposal into Sam's private memory
    const reply = await ask(
      sam.page,
      'Read it and keep a summary [[call web_fetch {"url":"https://example.org/pumps"}]] ' +
        '[[call ocw_memory_write {"scope":"personal","path":"MEMORY.md","mode":"append","content":"- Pumps: 3 plants"}]] ' +
        '[[call ocw_memory_propose {"scope":"personal","path":"MEMORY.md","op":"append","content":"\\n- Pumps: 3 plants"}]]',
      "Tool ocw_memory_propose:",
    );
    await expect(reply).toContainText("Tool web_fetch: allowed");
    await expect(reply).toContainText("Tool ocw_memory_write: refused (tainted)");
    await expect(reply).toContainText("Tool ocw_memory_propose: proposed");

    // ---- the platform-owned card in the DM
    const card = linkedCard(sam.page);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toHaveAttribute("data-approval-status", "pending");
    const badge = card.getByTestId("agent-card-workspace");
    await expect(badge).toHaveText("Created by the workspace");
    await expect(badge).toHaveAccessibleDescription("This card was made by the workspace, not by the bot.");
    await expect(card.getByTestId("agent-card-title")).toHaveText("Append to MEMORY.md");
    const fields = card.getByTestId("agent-card-fields");
    await expect(fields).toContainText("Memory");
    await expect(fields).toContainText("Readers");
    await expect(fields).toContainText("Only you");
    await expect(fields).toContainText("Found");
    await expect(card.getByTestId("agent-card-preview")).toContainText("+ - Pumps: 3 plants");
    await expect(card.getByTestId("agent-card-warning")).toHaveText(
      `${bot.name} read web or tool content in this turn.`,
    );
    await expect(card.getByRole("status", { name: "Status: Pending" })).toBeVisible();
    await expect(card.getByTestId("agent-card-approve")).toBeVisible();
    await expect(card.getByTestId("agent-card-deny")).toBeVisible();
    await expect(card.getByTestId("agent-card-open")).toHaveText(/Review changes/);
    await review(sam.page, card, "review-memory-proposal-card", w);

    // ---- Approve: the confirmation names the file and the readers, with an optional note; Cancel has focus
    await card.getByTestId("agent-card-approve").click();
    const dialog = sam.page.getByTestId("agent-card-confirm");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Approve and apply?" })).toBeVisible();
    await expect(dialog).toContainText("Append to MEMORY.md");
    await expect(dialog).toContainText("Only you will see this.");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    const note = dialog.getByRole("textbox", { name: "Note (optional)" });
    await expect(note).toHaveAttribute("maxlength", "280");
    await note.fill("Checked the source");
    const decided = sam.page.waitForResponse(
      (r) => r.url().includes("/decision") && r.request().method() === "POST",
    );
    await dialog.getByTestId("agent-card-confirm-submit").click();
    const sent = (await decided).request().postDataJSON() as Record<string, unknown>;
    expect(sent).toMatchObject({ outcome: "approved", note: "Checked the source" });
    expect(sent.actionHash).toMatch(/^[0-9a-f]{64}$/);
    await expect(dialog).toBeHidden();

    // ---- Applied, with the decision line and the quoted note
    await expect(card.getByRole("status", { name: "Status: Applied" })).toBeVisible({ timeout: 10_000 });
    await expect(card.getByTestId("agent-card-decision")).toContainText("Approved by Sam Lee");
    await expect(card.getByTestId("agent-card-note")).toHaveText("“Checked the source”");
    await expect(card.getByTestId("agent-card-approve")).toHaveCount(0);

    // ---- the bot hears the decision with the note
    const heard = await plugin.waitFor(
      (e) => e.type === "agent.card_action.v1" && JSON.stringify(e.data).includes("Checked the source"),
      15_000,
    );
    expect(JSON.stringify(heard.data)).toContain("approved");

    // ---- Sam's private MEMORY.md holds the line, through the API and in the viewer
    const scope = (await memoryScopes(samApi)).find(
      (s) => s.kind === "personal" && s.label.includes(bot.name),
    );
    expect(scope, "Sam's private scope with the bot").toBeTruthy();
    const file = (await (
      await samApi.get(`/api/v1/memory/scopes/${scope?.id}/file?path=MEMORY.md`)
    ).json()) as { content: string };
    expect(file.content).toContain("- Pumps: 3 plants");
    await sam.page.goto(`${BASE_URL}/memory/${scope?.id}/MEMORY.md`);
    await expect(sam.page.getByTestId("memory-file").getByText("Pumps: 3 plants")).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await sam.context.close();
    await samApi.dispose();
  }
});
