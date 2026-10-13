import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs, SAM, userIdOf } from "../support/actors";
import { cellToken } from "../support/cell-token";
import { FakeCellPlugin } from "../support/fake-cell-plugin";
import { memoryScopes, seedMemory } from "../support/memory";
import { asSuperuser } from "../support/superuser";
import { ADMIN, API_URL, shot } from "./env";

/**
 * 07.2-17 (MEM-05, MEM-06, D-08, UI-SPEC R4/R6): the chat card is a trustworthy mirror of a memory approval. Sam asks
 * his personal bot to read a web page and keep a summary; the simulated cell runs `web_fetch` (the turn becomes
 * tainted), its `ocw_memory_write` is refused `tainted`, and its `ocw_memory_propose` into Sam's private memory
 * becomes a platform-owned card in the DM: "Created by the workspace", the server's masked preview, the taint line, a
 * Pending pill and Approve / Deny for Sam. Sam approves with a note; the file changes, the decision line quotes the note
 * and the bot hears it. Then every other state and audience: Sam's proposal into Ventas waits for a reviewer (he holds
 * no memory.promote there: no Approve for him) and follows an admin's denial live with the quoted note; the admin's own
 * bot proposes into the organization's MEMORY.md from his DM and he approves it on the card (owner decision
 * 2026-10-13: the decision right, not who asked, decides); a stale rewrite approved after the file changed ends Failed
 * with the reason in words; an expired proposal offers no Approve. Every run uses the fake cell (no model, no
 * provider). Review screenshots: review-memory-proposal-card(-selfapprove)-<1440|390>(-dark).
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

/** `who`'s only personal bot (Sam's by default), fresh, with internet on (memory is on by default), and its DM. */
async function freshPersonalBot(
  userId: string,
  who: Pick<Actor, "email" | "password"> = SAM,
): Promise<{ id: string; name: string; dmId: string }> {
  const api = await apiAs(who);
  const listed = (await (await api.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; scope: string; ownerUserId: string | null }>;
  };
  for (const a of listed.agents.filter((x) => x.scope === "personal" && x.ownerUserId === userId)) {
    expect((await api.delete(`/api/v1/agents/${a.id}`)).ok()).toBe(true);
  }
  const res = await api.post("/api/v1/agents/personal", {
    data: { modelProvider: "mock", modelId: "mock-1" },
  });
  expect(res.ok(), `create ${who.email}'s personal bot`).toBe(true);
  const body = (await res.json()) as { agent: { id: string; name: string }; dmId: string };
  const internet = await api.patch(`/api/v1/agents/${body.agent.id}/capabilities`, {
    data: { internet: true },
  });
  expect(internet.ok(), "internet on").toBe(true);
  await api.dispose();
  return { id: body.agent.id, name: body.agent.name, dmId: body.dmId };
}

/** Sends `text` in the open DM and returns the bot's new reply that contains `expectText` (never an earlier one). */
async function ask(page: Page, text: string, expectText: string): Promise<Locator> {
  const reply = page
    .locator('[data-testid="message"][data-author-kind="agent"]')
    .filter({ hasText: expectText });
  const before = await reply.count();
  const box = page.getByTestId("composer");
  await box.click();
  await box.fill(text);
  await box.press("Enter");
  await expect(reply).toHaveCount(before + 1, { timeout: 20_000 });
  return reply.last();
}

/** The bot a memory scope belongs to (the API lists `agentId`; every Sam's bot has the same name). */
const agentOf = (scope: object) => (scope as { agentId?: string | null }).agentId ?? null;

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

/** The approval id the fake cell's last `ocw_memory_propose` got back (the bot never shows it). */
function lastProposalId(): string {
  const last = [...plugin.memoryRequests].reverse().find((r) => r.route === "/memory/propose");
  const id = (last?.body as { approvalId?: string } | null)?.approvalId;
  expect(id, "the last proposal's approval id").toBeTruthy();
  return id as string;
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
    await expect(dialog).toContainText(
      `“Append to MEMORY.md” is saved to your private memory with ${bot.name}.`,
    );
    await expect(dialog).toContainText("Only you will see this.");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    const note = dialog.getByRole("textbox", { name: "Note (optional)" });
    await expect(note).toHaveAttribute("maxlength", "280");
    await note.fill("Checked the source");
    // The confirmation in both themes: named controls, 44 px buttons at 390, no serious axe finding (extra shot).
    for (const theme of ["light", "dark"] as const) {
      await sam.page.emulateMedia({ colorScheme: theme });
      expect(await unnamedControls(sam.page), `confirm (${theme}): unnamed controls`).toEqual([]);
      if (w === "390") {
        // The footer's two buttons (the shared dialog's close X is the primitive's own size).
        for (const control of await dialog
          .getByRole("button", { name: /^(Cancel|Approve and apply)$/ })
          .all()) {
          const box = await control.boundingBox();
          expect(box?.height ?? 0, `confirm (${theme}): 44 px control at 390`).toBeGreaterThanOrEqual(44);
        }
      }
      await expectNoSeriousA11y(sam.page, '[data-testid="agent-card-confirm"]');
      await shot(sam.page, `review-memory-proposal-card-confirm-${w}${theme === "dark" ? "-dark" : ""}`);
    }
    await sam.page.emulateMedia({ colorScheme: "light" });
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
    const scope = (await memoryScopes(samApi)).find((s) => s.kind === "personal" && agentOf(s) === bot.id);
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

test("a requester without the decision right: Sam's proposal into Ventas waits for a reviewer with no Approve; an admin denies with a note and Sam's card updates live", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const w = widthOf(project);
  const seed = await seedMemory(admin);
  const bot = await freshPersonalBot(samId);
  const sam = await openAs(browser, SAM, project);
  try {
    await sam.page.goto(`${BASE_URL}/chat/dm/${bot.dmId}`);
    await expect(sam.page.getByTestId("dm-view")).toBeVisible();
    const path = `clients/initech-${w}.md`;
    await ask(
      sam.page,
      `Keep this for the team [[call ocw_memory_propose {"scope":"${seed.ventasScopeId}","path":"${path}","op":"create","content":"# Initech\\n\\nPilot in two plants.\\n","reason":"Sam asked to keep the account"}]]`,
      "Tool ocw_memory_propose: proposed",
    );
    const card = linkedCard(sam.page);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByTestId("agent-card-title")).toHaveText(`Create ${path}`);
    await expect(card.getByTestId("agent-card-fields")).toContainText("Ventas · Team");
    await expect(card.getByTestId("agent-card-fields")).toContainText("Bot's note");
    await expect(card.getByTestId("agent-card-waiting")).toHaveText("Waiting for a reviewer");
    await expect(card.getByTestId("agent-card-approve")).toHaveCount(0);
    await expect(card.getByTestId("agent-card-deny")).toHaveCount(0);
    await expect(card.getByTestId("agent-card-open")).toBeVisible();
    await expect(card.getByTestId("agent-card-warning")).toHaveCount(0);

    // ---- an admin (a decider of Ventas) denies through the approvals route with a note
    const id = lastProposalId();
    const detail = (await (await admin.get(`/api/v1/approvals/${id}`)).json()) as {
      actionHash: string;
      viewerCan: string[];
    };
    expect(detail.viewerCan).toEqual(["decide"]);
    const denied = await admin.post(`/api/v1/approvals/${id}/decision`, {
      data: { outcome: "denied", actionHash: detail.actionHash, note: "Duplicate of the CRM entry." },
    });
    expect(denied.ok(), `deny: ${denied.status()}`).toBe(true);

    // ---- Sam's open card follows live: Denied, the decision line and the quoted note
    await expect(card.getByRole("status", { name: "Status: Denied" })).toBeVisible({ timeout: 10_000 });
    await expect(card.getByTestId("agent-card-decision")).toContainText(`Denied by ${ADMIN.name}`);
    await expect(card.getByTestId("agent-card-note")).toHaveText("“Duplicate of the CRM entry.”");
    await expect(card.getByTestId("agent-card-waiting")).toHaveCount(0);
    await invariants(sam.page, card, w, "denied card");
  } finally {
    await sam.context.close();
  }
});

test("self-approval with the decision right: the admin approves his own bot's organization proposal on the chat card; the file changes", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const w = widthOf(project);
  const seed = await seedMemory(admin);
  const adminId = await userIdOf(admin);
  const bot = await freshPersonalBot(adminId, ADMIN);
  const me = await openAs(browser, ADMIN, project);
  try {
    await me.page.goto(`${BASE_URL}/chat/dm/${bot.dmId}`);
    await expect(me.page.getByTestId("dm-view")).toBeVisible();
    const line = `- Autofy Labs ships open collaborative AI workspaces (${w})`;
    await ask(
      me.page,
      `Save this as organization context [[call ocw_memory_propose ${JSON.stringify({
        scope: seed.orgScopeId,
        path: "MEMORY.md",
        op: "append",
        content: `\n${line}`,
      })}]]`,
      "Tool ocw_memory_propose: proposed",
    );

    // ---- his own proposal, a shared scope he may decide: Review changes, Approve and Deny; no waiting line
    const card = linkedCard(me.page);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toHaveAttribute("data-approval-status", "pending");
    await expect(card.getByTestId("agent-card-title")).toHaveText("Append to MEMORY.md");
    await expect(card.getByTestId("agent-card-fields")).toContainText("Organization · Everyone");
    await expect(card.getByRole("status", { name: "Status: Pending" })).toBeVisible();
    await expect(card.getByTestId("agent-card-approve")).toBeVisible();
    await expect(card.getByTestId("agent-card-deny")).toBeVisible();
    await expect(card.getByTestId("agent-card-open")).toHaveText(/Review changes/);
    await expect(card.getByTestId("agent-card-waiting")).toHaveCount(0);
    await review(me.page, card, "review-memory-proposal-card-selfapprove", w);

    // ---- Approve: the same confirmation, naming the organization memory and its readers
    await card.getByTestId("agent-card-approve").click();
    const dialog = me.page.getByTestId("agent-card-confirm");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Approve and apply?" })).toBeVisible();
    await expect(dialog).toContainText("“Append to MEMORY.md” is saved to Organization memory.");
    await expect(dialog).toContainText(/\d+ (person|people) will see this\./);
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await dialog.getByRole("textbox", { name: "Note (optional)" }).fill("Context for every bot");
    const decided = me.page.waitForResponse(
      (r) => r.url().includes("/decision") && r.request().method() === "POST",
    );
    await dialog.getByTestId("agent-card-confirm-submit").click();
    expect((await decided).status(), "self-approval accepted").toBe(200);
    await expect(dialog).toBeHidden();

    // ---- Applied, decided by the admin himself
    await expect(card.getByRole("status", { name: "Status: Applied" })).toBeVisible({ timeout: 10_000 });
    await expect(card.getByTestId("agent-card-decision")).toContainText(`Approved by ${ADMIN.name}`);
    await expect(card.getByTestId("agent-card-note")).toHaveText("“Context for every bot”");
    await expect(card.getByTestId("agent-card-approve")).toHaveCount(0);
    await invariants(me.page, card, w, "self-approved card");

    // ---- the organization's MEMORY.md holds the line, through the API and in the viewer
    const file = (await (
      await admin.get(`/api/v1/memory/scopes/${seed.orgScopeId}/file?path=MEMORY.md`)
    ).json()) as { content: string };
    expect(file.content).toContain(line);
    await me.page.goto(`${BASE_URL}/memory/${seed.orgScopeId}/MEMORY.md`);
    await expect(me.page.getByTestId("memory-file").getByText(line.slice(2))).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await me.context.close();
  }
});

test("a stale rewrite approved after the file changed ends Failed with the reason in words; an expired proposal offers no Approve", async ({
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

    // ---- the bot reads Sam's private MEMORY.md, then proposes a rewrite on the version it read
    await ask(
      sam.page,
      'Look at my notes [[call ocw_memory_read {"scope":"personal","path":"MEMORY.md"}]]',
      "Tool ocw_memory_read: read",
    );
    const scope = (await memoryScopes(samApi)).find((s) => s.kind === "personal" && agentOf(s) === bot.id);
    expect(scope, "Sam's private scope with the bot").toBeTruthy();
    const read = async () =>
      (await (await samApi.get(`/api/v1/memory/scopes/${scope?.id}/file?path=MEMORY.md`)).json()) as {
        id: string;
        version: number;
        content: string;
      };
    const base = await read();
    await ask(
      sam.page,
      `Tidy them [[call ocw_memory_propose {"scope":"personal","path":"MEMORY.md","op":"replace","content":"# Notes\\n\\n- Pumps: 4 plants\\n","baseVersion":${base.version}}]]`,
      "Tool ocw_memory_propose: proposed",
    );
    const stale = linkedCard(sam.page);
    await expect(stale.getByTestId("agent-card-title")).toHaveText("Rewrite MEMORY.md");
    await expect(stale.getByTestId("agent-card-approve")).toBeVisible();

    // ---- Sam edits the file himself, then approves the proposal on the card: nothing is overwritten
    const edited = await samApi.put(`/api/v1/memory/files/${base.id}`, {
      data: { content: "# Notes\n\n- Edited by Sam\n", expectedVersion: base.version },
    });
    expect(edited.ok(), `edit MEMORY.md: ${edited.status()}`).toBe(true);
    await stale.getByTestId("agent-card-approve").click();
    const dialog = sam.page.getByTestId("agent-card-confirm");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("agent-card-confirm-submit").click();
    await expect(dialog).toBeHidden();
    await expect(stale.getByRole("status", { name: "Status: Failed" })).toBeVisible({ timeout: 10_000 });
    await expect(stale.getByTestId("agent-card-failed-reason")).toHaveText(
      `The file changed since this proposal. Ask ${bot.name} to propose again.`,
    );
    await expect(stale.getByTestId("agent-card-decision")).toContainText("Approved by Sam Lee");
    expect((await read()).content).toBe("# Notes\n\n- Edited by Sam\n");
    await invariants(sam.page, stale, w, "failed card");

    // ---- a proposal whose expiry passed: Expired, no Approve, nothing changes
    await ask(
      sam.page,
      'One more [[call ocw_memory_propose {"scope":"personal","path":"MEMORY.md","op":"append","content":"\\n- Expiring line"}]]',
      "Tool ocw_memory_propose: proposed",
    );
    const id = lastProposalId();
    const moved = await asSuperuser(
      "update app.approval_requests set expires_at = now() - interval '1 minute' where id = $1",
      [id],
    );
    expect(moved.rowCount).toBe(1);
    await sam.page.reload();
    await expect(sam.page.getByTestId("dm-view")).toBeVisible();
    const expired = linkedCard(sam.page);
    await expect(expired).toHaveAttribute("data-approval-status", "expired", { timeout: 10_000 });
    await expect(expired.getByRole("status", { name: "Status: Expired" })).toBeVisible();
    await expect(expired.getByTestId("agent-card-approve")).toHaveCount(0);
    await expect(expired.getByTestId("agent-card-waiting")).toHaveCount(0);
    expect((await read()).content).not.toContain("Expiring line");
    await invariants(sam.page, expired, w, "expired card");
  } finally {
    await sam.context.close();
    await samApi.dispose();
  }
});
