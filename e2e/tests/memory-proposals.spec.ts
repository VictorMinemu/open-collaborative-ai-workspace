import { createRequire } from "node:module";
import { join } from "node:path";
import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { cellToken } from "../support/cell-token";
import { FakeCellPlugin } from "../support/fake-cell-plugin";
import { type MemorySeed, putMemoryFile, seedMemory } from "../support/memory";
import { ADMIN, API_URL, shot } from "./env";

/**
 * 07.2-13 (MEM-04, MEM-05, MEM-06, D-08, UI-SPEC "Proposals inbox and review", R4/R5/R7/R11): the reviewer side of
 * governed promotion. Sam's bot proposes a client note for the Ventas team memory from Sam's DM (the fake cell's
 * `ocw_memory_propose`); Lena, the Ventas lead, finds it in Memory → Proposals even though she cannot read that DM,
 * reviews the reader count, the findings with masked samples, the highlighted diff, approves it, and the team file
 * changes with "Approved by Lena Ortiz" in its history. Then: notes, live counts and decisions, a changed or
 * already-decided proposal, a requester without the decision right, a phone denial with a note, a stale rewrite, a refused secret, an admin who
 * never sees a personal proposal, and the extended-scan warning (`OCW_PRESIDIO_URL` set: a non-answering Presidio, so
 * every proposal carries "Extended scan unavailable"; unset: never). Every run uses the fake cell (no model, no
 * provider). Review screenshots: review-memory-proposal(s)-*-<1440|390>(-dark).
 */

test.describe.configure({ mode: "serial" });

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

/** The Ventas lead (a Team Lead in the organization; same account as admin-org.spec). */
const LENA: Actor = { name: "Lena Ortiz", email: "lena@ocw.test", password: "lena-e2e-password-123" };

const SCAN_WARNING = "Extended scan unavailable — review the text yourself";
/** The e2e API got a Presidio URL (scripts/e2e-isolated.sh passes the caller's value, never .env's). */
const PRESIDIO_SET = (process.env.OCW_PRESIDIO_URL ?? "").trim() !== "";

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

/** Lena leads Ventas (memory.promote there): added as a lead, or promoted when she is a plain member. */
async function ensureLead(admin: APIRequestContext, unitId: string, userId: string) {
  const { members } = (await (await admin.get(`/api/v1/units/${unitId}/members`)).json()) as {
    members: Array<{ userId: string; role: string }>;
  };
  const current = members.find((m) => m.userId === userId);
  if (current?.role === "lead") return;
  const res = current
    ? await admin.patch(`/api/v1/units/${unitId}/members/${userId}`, { data: { role: "lead" } })
    : await admin.post(`/api/v1/units/${unitId}/members`, { data: { userId, role: "lead" } });
  expect(res.ok(), `Lena leads Ventas: ${res.status()} ${await res.text()}`).toBe(true);
}

/** Sam's only personal bot, fresh (deleting the old ones takes their proposals along), and its private chat. */
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
  await sam.dispose();
  return { id: body.agent.id, name: body.agent.name, dmId: body.dmId };
}

/** Sends `text` in the open DM and returns the bot's new reply that contains `expectText`. */
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

/** The approval id the fake cell's last `ocw_memory_propose` got back (the bot never shows it). */
function lastProposalId(): string {
  const last = [...plugin.memoryRequests].reverse().find((r) => r.route === "/memory/propose");
  const id = (last?.body as { approvalId?: string } | null)?.approvalId;
  expect(id, "the last proposal's approval id").toBeTruthy();
  return id as string;
}

/** A proposal through the fake cell in Sam's DM: `[[call ocw_memory_propose …]]`, then its approval id. */
async function propose(page: Page, args: Record<string, unknown>, says = "Keep this"): Promise<string> {
  const reply = await ask(
    page,
    `${says} [[call ocw_memory_propose ${JSON.stringify(args)}]]`,
    "Tool ocw_memory_propose:",
  );
  await expect(reply).toContainText("Tool ocw_memory_propose: proposed");
  return lastProposalId();
}

/** A sonner toast with `text`. */
const toast = (page: Page, text: string) => page.locator("[data-sonner-toast]").filter({ hasText: text });

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
    const selector =
      'button, [role="button"], a[href], [role="menuitem"], [role="option"], [role="switch"], [role="tab"]';
    return [...document.querySelectorAll(selector)]
      .filter((el) => !el.closest('[aria-hidden="true"], [inert]') && visible(el) && !nameOf(el))
      .map((el) => el.outerHTML.slice(0, 200));
  });
}

/** The shell's invariants: named controls, axe on `selector`, and at 390 no sideways scroll and 44 px controls. */
async function invariants(
  page: Page,
  w: string,
  label: string,
  selector = '[data-testid="proposals-shell"]',
) {
  expect(await unnamedControls(page), `${label}: controls without an accessible name`).toEqual([]);
  if (w === "390") {
    const sideways = await page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(sideways, `${label}: sideways scroll at 390`).toBeLessThanOrEqual(0);
    const controls = page.locator(
      '[data-testid="proposals-shell"] [data-testid="proposal-footer"] button, [data-testid="proposals-shell"] [role="tab"], [data-testid="proposals-shell"] button[aria-label^="Back"]',
    );
    for (const control of await controls.all()) {
      if (!(await control.isVisible())) continue;
      const box = await control.boundingBox();
      expect(box?.height ?? 0, `${label}: 44 px control at 390`).toBeGreaterThanOrEqual(44);
    }
  }
  await expectNoSeriousA11y(page, selector);
}

/** Light and dark review screenshots, each after the invariants. */
async function review(page: Page, name: string, w: string, selector?: string) {
  // Toasts are transient: the review shot shows the screen, not the last confirmation.
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
  const viewport = page.viewportSize();
  if (viewport) await page.mouse.move(viewport.width - 4, 4);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await invariants(page, w, `${name} (${theme})`, selector);
    // A run with a Presidio URL only refreshes the extended-scan shots; every other review shot comes from the
    // normal run (no warning on screen).
    if (PRESIDIO_SET && !name.includes("scan-unavailable")) continue;
    await shot(page, `${name}-${w}${theme === "dark" ? "-dark" : ""}`);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/**
 * Superuser access to the isolated e2e database only (scripts/e2e-isolated.sh exports MIGRATE_SUPERUSER_URL pointing
 * at `ocw_e2e`; anything else is refused).
 */
async function asSuperuser<T>(sql: string, params: unknown[]): Promise<T[]> {
  const url = process.env.MIGRATE_SUPERUSER_URL ?? "";
  expect(
    /\/ocw_e2e(\?|$)/.test(url),
    "MIGRATE_SUPERUSER_URL targets ocw_e2e (run through e2e-isolated.sh)",
  ).toBe(true);
  const requireDb = createRequire(join(import.meta.dirname, "..", "..", "packages", "db", "package.json"));
  const { Client } = requireDb("pg") as {
    Client: new (o: {
      connectionString: string;
    }) => {
      connect(): Promise<void>;
      query(text: string, values: unknown[]): Promise<{ rows: T[] }>;
      end(): Promise<void>;
    };
  };
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows;
  } finally {
    await client.end();
  }
}

/** Opens the inbox the way a person does: Memory → Proposals (the row with its count). */
async function openInbox(page: Page, count: number | null) {
  await page.goto(`${BASE_URL}/memory`);
  const row = page.getByTestId("memory-proposals-row");
  await expect(row).toBeVisible({ timeout: 15_000 });
  if (count !== null) await expect(page.getByTestId("memory-proposals-count")).toHaveText(String(count));
  await row.click();
  await expect(page).toHaveURL(/\/memory\/proposals$/);
  await expect(page.getByTestId("proposals-shell")).toBeVisible();
}

/** The review of `id` on screen (desktop beside the list, phone full screen). */
async function openReview(page: Page, id: string) {
  await page.locator(`[data-testid="proposal-row"][data-id="${id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/memory/proposals/${id}`));
  const view = page.locator('[data-testid="proposal-review"][data-view="memory_proposal"]');
  await expect(view).toBeVisible({ timeout: 15_000 });
  return view;
}

async function detailOf(api: APIRequestContext, id: string) {
  const res = await api.get(`/api/v1/approvals/${id}`);
  expect(res.ok(), `GET approval ${id}: ${res.status()}`).toBe(true);
  return (await res.json()) as {
    status: string;
    actionHash: string;
    viewerCan: string[];
    view: { type: string; proposal: { readerCount: number; currentVersion: number | null } };
  };
}

/** Denies whatever still waits for `api` (an earlier test's or run's proposals), so counts start at zero. */
async function clearPending(api: APIRequestContext) {
  const res = await api.get("/api/v1/approvals?role=decider&status=pending");
  expect(res.ok(), "list pending").toBe(true);
  for (const item of ((await res.json()) as { items: Array<{ id: string; actionHash: string }> }).items) {
    const denied = await api.post(`/api/v1/approvals/${item.id}/decision`, {
      data: { outcome: "denied", actionHash: item.actionHash },
    });
    expect(denied.ok(), `clear ${item.id}: ${denied.status()}`).toBe(true);
  }
}

const fileOf = async (api: APIRequestContext, scopeId: string, path: string) =>
  (await (
    await api.get(`/api/v1/memory/scopes/${scopeId}/file?path=${encodeURIComponent(path)}`)
  ).json()) as {
    id: string;
    version: number;
    content: string;
  };

let admin: APIRequestContext;
let plugin: FakeCellPlugin;
let seed: MemorySeed;
let samId: string;
let lenaId: string;

test.beforeAll(async () => {
  const token = cellToken();
  expect(token, "OCW_CELL_TOKEN is configured").not.toBe("");
  admin = await apiAs(ADMIN);
  samId = await ensureMember(admin, SAM, "developer");
  lenaId = await ensureMember(admin, LENA, "lead");
  seed = await seedMemory(admin);
  await ensureLead(admin, seed.ventasUnitId, lenaId);
  await resetPolicy(admin);
  plugin = new FakeCellPlugin({ apiUrl: API_URL, token, autoAck: true, autoReply: true });
  await plugin.start();
});

test.afterAll(async () => {
  await plugin?.stop();
  await admin?.dispose();
});

const IBAN = "ES91 2100 0418 4502 0005 1332";

test("a bot's team-memory proposal reaches the lead's inbox; she reviews and approves it and the team file changes", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const project = info.project.name;
  const w = widthOf(project);
  const mobile = project === "mobile";
  const path = `clients/acme-${w}.md`;
  await putMemoryFile(
    admin,
    seed.ventasScopeId,
    path,
    "# Acme Corp\n\n## Contacts\n\n- Marta Gil — purchasing\n",
  );
  const bot = await freshPersonalBot(samId);
  const sam = await openAs(browser, SAM, project);
  const lena = await openAs(browser, LENA, project);
  const lenaApi = await apiAs(LENA);
  await clearPending(lenaApi);
  try {
    // ---- the bot proposes from Sam's DM (Lena cannot read it)
    await sam.page.goto(`${BASE_URL}/chat/dm/${bot.dmId}`);
    await expect(sam.page.getByTestId("dm-view")).toBeVisible();
    const id = await propose(
      sam.page,
      {
        scope: seed.ventasScopeId,
        path,
        op: "append",
        content: `\n- Contact: ana@acme.com, IBAN ${IBAN}`,
        reason: "Sam asked to keep the contact",
      },
      "Save this for the team",
    );
    expect(
      (await lenaApi.get(`/api/v1/conversations/${bot.dmId}/messages`)).ok(),
      "Lena can't read the DM",
    ).toBe(false);
    const api = await detailOf(lenaApi, id);
    expect(api.viewerCan).toEqual(["decide"]);
    const readers = api.view.proposal.readerCount;
    expect(readers).toBeGreaterThanOrEqual(3);

    // ---- the nav entry counts it (desktop rail)
    await lena.page.goto(`${BASE_URL}/memory`);
    if (!mobile) {
      await expect(lena.page.getByTestId("nav-memory")).toHaveAccessibleName("Memory, 1 proposal to review");
      await expect(lena.page.getByTestId("nav-memory-count")).toHaveText("1");
    }

    // ---- Memory → Proposals → To review
    await openInbox(lena.page, 1);
    await expect(lena.page.getByTestId("proposals-tab-review")).toHaveAttribute("aria-selected", "true");
    await expect(lena.page.getByTestId("proposals-count")).toHaveText("1");
    const row = lena.page.locator(`[data-testid="proposal-row"][data-id="${id}"]`);
    await expect(row.getByTestId("proposal-row-title")).toHaveText(`Append to ${path}`);
    await expect(row).toContainText("Ventas · Team");
    await expect(row).toContainText(`${bot.name} for Sam Lee`);
    await expect(row.getByTestId("proposal-row-tag")).toHaveText(["IBAN", "Email"]);
    if (!mobile) {
      // Desktop: the first proposal is already open beside the list.
      await expect(lena.page.getByTestId("proposal-title")).toHaveText(`Append to ${path}`);
    }
    await review(lena.page, "review-memory-proposals", w);

    // ---- the review
    const view = await openReview(lena.page, id);
    await expect(view.getByTestId("proposal-title")).toHaveText(`Append to ${path}`);
    await expect(view.getByTestId("proposal-status")).toHaveText("Pending");
    await expect(view.getByTestId("proposal-meta")).toContainText("Ventas · Team");
    await expect(view.getByTestId("proposal-requester")).toHaveText(`${bot.name} for Sam Lee`);
    await expect(view.getByTestId("proposal-meta")).toContainText("Expires in 13 days");
    await expect(view.getByTestId("proposal-readers")).toContainText(`${readers}people will see this`);
    await expect(view.getByTestId("proposal-found")).toContainText("2 findings");
    await expect(view.getByTestId("proposal-reason")).toHaveText("Sam asked to keep the contact");
    const findings = view.getByRole("list", { name: "Sensitive data" });
    await expect(findings.getByTestId("finding")).toHaveCount(2);
    await expect(findings).toContainText("ES91 •••• 1332");
    await expect(findings).toContainText("a•••@acme.com");
    await expect(findings.locator('[data-kind="iban"]')).toContainText("Check");
    await expect(findings.locator('[data-kind="iban"]')).toContainText("1 found");
    if (!PRESIDIO_SET) await expect(view).not.toContainText("Extended scan");
    // The raw IBAN appears only in the diff, where it is highlighted as a sensitive span (UI-SPEC R5).
    const diff = view.getByTestId("memory-diff");
    await expect(diff).toContainText("Contact: ana@acme.com");
    const marked = diff.locator(".cm-sensitiveSpan");
    await expect(marked.first()).toBeVisible();
    expect((await marked.allTextContents()).join("")).toContain("ana@acme.com");
    expect((await marked.allTextContents()).join("").replace(/\s/g, "")).toContain(IBAN.replace(/\s/g, ""));
    await expect(diff).toHaveAttribute("data-layout", mobile ? "unified" : "split");
    await review(lena.page, "review-memory-proposal", w);
    if (mobile) {
      // The phone review scrolls: an extra shot of the unified diff with its highlighted spans above the bottom bar.
      await diff.scrollIntoViewIfNeeded();
      await review(lena.page, "review-memory-proposal-diff", w);
    }
    // A finding row jumps to its spans in the diff.
    await findings.locator('[data-kind="email"] button').click();
    await expect(diff.locator(".cm-sensitiveFocus")).toHaveText("ana@acme.com");

    // ---- Approve…: the confirmation names the file, the memory, the version and the readers; Cancel is focused
    await view.getByTestId("proposal-approve").click();
    const dialog = lena.page.getByTestId("proposal-confirm");
    await expect(dialog.getByRole("heading", { name: "Approve and apply?" })).toBeVisible();
    const version = (api.view.proposal.currentVersion ?? 0) + 1;
    await expect(dialog).toContainText(
      `“Append to ${path}” is saved to Ventas memory as version ${version}. ${readers} people will see this.`,
    );
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    const decided = lena.page.waitForResponse((r) => r.url().endsWith(`/approvals/${id}/decision`));
    await dialog.getByTestId("proposal-confirm-submit").click();
    const sent = (await decided).request().postDataJSON() as Record<string, unknown>;
    expect(sent).toEqual({ outcome: "approved", actionHash: api.actionHash });
    await expect(toast(lena.page, `Applied to ${path}`)).toBeVisible();
    await expect(view.getByTestId("proposal-status")).toHaveText("Applied");
    await expect(view.getByTestId("proposal-title")).toBeFocused();
    await expect(view.getByTestId("proposal-decision")).toContainText(`Approved by ${LENA.name}`);
    await expect(view.getByTestId("proposal-decision")).toContainText(`Applied as version ${version}`);
    await expect(view.getByTestId("proposal-approve")).toHaveCount(0);
    // The count dropped live (the row and the nav).
    if (!mobile) await expect(lena.page.getByTestId("nav-memory-count")).toHaveCount(0);

    // ---- the team file holds the contact, and its history names the approver
    const file = await fileOf(lenaApi, seed.ventasScopeId, path);
    expect(file.content).toContain(`- Contact: ana@acme.com, IBAN ${IBAN}`);
    await view.getByTestId("proposal-open-file").click();
    await expect(lena.page).toHaveURL(new RegExp(`/memory/${seed.ventasScopeId}/clients/acme-${w}\\.md`));
    await lena.page.goto(`${BASE_URL}/memory/${seed.ventasScopeId}/clients/acme-${w}.md?tab=history`);
    await expect(lena.page.getByTestId("memory-revision-approval").first()).toContainText(
      `Approved by ${LENA.name}`,
    );

    // ---- Sam: Requested by you lists it as Applied
    await sam.page.goto(`${BASE_URL}/memory/proposals?box=requested`);
    const mine = sam.page.locator(`[data-testid="proposal-row"][data-id="${id}"]`);
    await expect(mine).toHaveAttribute("data-status", "applied");
    await expect(mine.getByTestId("proposal-status")).toHaveText("Applied");
  } finally {
    await sam.context.close();
    await lena.context.close();
    await lenaApi.dispose();
  }
});

test("notes, live updates and races: a denial with a note, a changed proposal, one decided by someone else", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const project = info.project.name;
  const w = widthOf(project);
  const mobile = project === "mobile";
  const bot = await freshPersonalBot(samId);
  const sam = await openAs(browser, SAM, project);
  const lena = await openAs(browser, LENA, project);
  const lenaApi = await apiAs(LENA);
  await clearPending(lenaApi);
  await lenaApi.dispose();
  try {
    await sam.page.goto(`${BASE_URL}/chat/dm/${bot.dmId}`);
    await expect(sam.page.getByTestId("dm-view")).toBeVisible();
    const first = await propose(sam.page, {
      scope: seed.ventasScopeId,
      path: `clients/initech-${w}.md`,
      op: "create",
      content: "# Initech\n\nPilot in two plants.\n",
      reason: "Sam asked to keep the account",
    });

    // ---- Lena has the review open; the count is live
    await lena.page.goto(`${BASE_URL}/memory/proposals/${first}`);
    const view = lena.page.locator('[data-testid="proposal-review"][data-view="memory_proposal"]');
    await expect(view.getByTestId("proposal-title")).toHaveText(`Create clients/initech-${w}.md`);
    await expect(view.getByTestId("proposal-found")).toContainText("Nothing found");
    await expect(view.getByTestId("findings-none")).toHaveText("No sensitive data found");
    await expect(view.getByTestId("memory-diff")).toHaveAttribute("data-layout", "unified");
    if (!mobile) await expect(lena.page.getByTestId("proposals-count")).toHaveText("1");

    // ---- a second proposal arrives while she looks: the count follows without a reload
    const second = await propose(sam.page, {
      scope: seed.ventasScopeId,
      path: `clients/hooli-${w}.md`,
      op: "create",
      content: "# Hooli\n\nTrial ends in May.\n",
    });
    if (!mobile) {
      await expect(lena.page.getByTestId("proposals-count")).toHaveText("2", { timeout: 15_000 });
      await expect(lena.page.locator(`[data-testid="proposal-row"][data-id="${second}"]`)).toBeVisible();
    }

    // ---- a changed proposal: the hash she saw no longer matches (simulated in transit); Reload, never auto-decided
    await lena.page.route(`**/api/v1/approvals/${first}/decision`, async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      await route.continue({ postData: JSON.stringify({ ...body, actionHash: "f".repeat(64) }) });
    });
    await view.getByTestId("proposal-approve").click();
    await lena.page.getByTestId("proposal-confirm-submit").click();
    const notice = view.getByTestId("proposal-notice");
    await expect(notice).toHaveAttribute("data-kind", "changed");
    await expect(notice).toHaveText(/This proposal changed while you were reviewing it\./);
    await expect(view.getByTestId("proposal-status")).toHaveText("Pending");
    await lena.page.unroute(`**/api/v1/approvals/${first}/decision`);
    await notice.getByTestId("proposal-reload").click();
    await expect(notice).toHaveCount(0);

    // ---- Deny with a note: hint, counter from 200, at most 280 characters
    await view.getByTestId("proposal-deny").click();
    const dialog = lena.page.getByTestId("proposal-confirm");
    await expect(dialog.getByRole("heading", { name: "Deny this proposal?" })).toBeVisible();
    await expect(dialog).toContainText(
      `Nothing changes in Ventas memory. ${bot.name} and Sam Lee see that you denied it.`,
    );
    const note = dialog.getByRole("textbox", { name: "Note (optional)" });
    await expect(note).toHaveAttribute("placeholder", "Tell them why");
    await expect(note).toHaveAttribute("maxlength", "280");
    await note.fill("x".repeat(199));
    await expect(dialog.getByTestId("proposal-note-count")).toHaveCount(0);
    await note.fill("x".repeat(200));
    await expect(dialog.getByTestId("proposal-note-count")).toHaveText("200/280");
    await note.fill("x".repeat(280));
    await note.press("End");
    await note.pressSequentially("y");
    await expect(note).toHaveValue("x".repeat(280));
    await note.fill("Duplicate of the CRM entry");
    await dialog.getByTestId("proposal-confirm-submit").click();
    await expect(toast(lena.page, "Proposal denied")).toBeVisible();
    await expect(view.getByTestId("proposal-status")).toHaveText("Denied");
    await expect(view.getByTestId("proposal-decision")).toContainText(`Denied by ${LENA.name}`);
    await expect(view.getByTestId("proposal-decision-note")).toHaveText("“Duplicate of the CRM entry”");
    expect(
      await (
        await admin.get(`/api/v1/memory/scopes/${seed.ventasScopeId}/file?path=clients/initech-${w}.md`)
      ).status(),
    ).toBe(404);

    // ---- decided by someone else while her dialog is open: the truth, live, and the race explained
    await lena.page.goto(`${BASE_URL}/memory/proposals/${second}`);
    await expect(view.getByTestId("proposal-title")).toHaveText(`Create clients/hooli-${w}.md`);
    await view.getByTestId("proposal-approve").click();
    await expect(dialog).toBeVisible();
    const d = await detailOf(admin, second);
    const byAdmin = await admin.post(`/api/v1/approvals/${second}/decision`, {
      data: { outcome: "denied", actionHash: d.actionHash, note: "Not for the team file" },
    });
    expect(byAdmin.ok(), `admin denies: ${byAdmin.status()}`).toBe(true);
    await expect(view.getByTestId("proposal-status")).toHaveText("Denied", { timeout: 15_000 });
    await expect(lena.page.getByTestId("proposals-live")).toHaveText(`Denied by ${ADMIN.name}.`);
    await dialog.getByTestId("proposal-confirm-submit").click();
    await expect(view.getByTestId("proposal-notice")).toHaveText(/Someone already decided this proposal\./);
    await expect(view.getByTestId("proposal-decision")).toContainText(`Denied by ${ADMIN.name}`);
    await expect(view.getByTestId("proposal-decision-note")).toHaveText("“Not for the team file”");
    if (!mobile) await expect(lena.page.getByTestId("proposals-count")).toHaveCount(0);

    // ---- Decided lists both
    await lena.page.goto(`${BASE_URL}/memory/proposals?box=decided`);
    for (const id of [first, second]) {
      await expect(lena.page.locator(`[data-testid="proposal-row"][data-id="${id}"]`)).toHaveAttribute(
        "data-status",
        "denied",
      );
    }
    await invariants(lena.page, w, "decided tab");
  } finally {
    await sam.context.close();
    await lena.context.close();
  }
});

test("a requester without the decision right, a stale rewrite, a refused secret and the phone denial", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const project = info.project.name;
  const w = widthOf(project);
  const mobile = project === "mobile";
  const path = `clients/globex-${w}.md`;
  await putMemoryFile(admin, seed.ventasScopeId, path, "# Globex\n\nPilot with one plant since March.\n");
  const bot = await freshPersonalBot(samId);
  const sam = await openAs(browser, SAM, project);
  const lena = await openAs(browser, LENA, project);
  const samApi = await apiAs(SAM);
  const lenaApi = await apiAs(LENA);
  await clearPending(lenaApi);
  try {
    await sam.page.goto(`${BASE_URL}/chat/dm/${bot.dmId}`);
    await expect(sam.page.getByTestId("dm-view")).toBeVisible();

    // ---- a secret is refused before anything reaches an inbox
    const secret = await ask(
      sam.page,
      `Keep my key [[call ocw_memory_propose ${JSON.stringify({
        scope: seed.ventasScopeId,
        path: `clients/keys-${w}.md`,
        op: "create",
        content: `# Keys\n\nsk-ant-api03-${"A1b2C3d4E5f6".repeat(4)}\n`,
      })}]]`,
      "Tool ocw_memory_propose:",
    );
    await expect(secret).toContainText("Tool ocw_memory_propose: refused (secret_detected)");
    const listed = async (api: APIRequestContext, role: string) =>
      (
        (await (await api.get(`/api/v1/approvals?role=${role}`)).json()) as {
          items: Array<{ headline?: { title: string } }>;
        }
      ).items.map((i) => i.headline?.title ?? "");
    for (const [api, role] of [
      [lenaApi, "decider"],
      [admin, "decider"],
      [samApi, "requester"],
    ] as const) {
      expect(await listed(api, role), `no secret proposal for ${role}`).not.toContain(
        `Create clients/keys-${w}.md`,
      );
    }

    // ---- no decision right: Sam opens his own team proposal: no Approve, the waiting line; a direct POST is 403
    const base = await fileOf(samApi, seed.ventasScopeId, path);
    const stale = await propose(sam.page, {
      scope: seed.ventasScopeId,
      path,
      op: "replace",
      content: "# Globex\n\nPilot with two plants since May.\n",
      baseVersion: base.version,
      reason: "The pilot grew",
    });
    await sam.page.goto(`${BASE_URL}/memory/proposals/${stale}?box=requested`);
    const samView = sam.page.locator('[data-testid="proposal-review"][data-view="memory_proposal"]');
    await expect(samView.getByTestId("proposal-waiting")).toHaveText("Waiting for a reviewer");
    await expect(samView.getByTestId("proposal-approve")).toHaveCount(0);
    await expect(samView.getByTestId("proposal-deny")).toHaveCount(0);
    const own = await detailOf(samApi, stale);
    const self = await samApi.post(`/api/v1/approvals/${stale}/decision`, {
      data: { outcome: "approved", actionHash: own.actionHash },
    });
    expect(self.status(), "Sam holds no memory.promote on Ventas").toBe(403);

    if (mobile) {
      // ---- phone: Lena denies it from the list with a note (the bottom bar, the bottom-sheet dialog)
      await openInbox(lena.page, 1);
      const view = await openReview(lena.page, stale);
      await expect(lena.page.getByRole("button", { name: "Back to proposals" })).toBeVisible();
      const facts = await view.getByTestId("proposal-facts").boundingBox();
      const readersBox = await view.getByTestId("proposal-readers").boundingBox();
      expect(Math.round(readersBox?.width ?? 0), "fact cells stack at 390").toBeGreaterThanOrEqual(
        Math.round((facts?.width ?? 0) - 1),
      );
      for (const b of ["proposal-deny", "proposal-approve"]) {
        const box = await view.getByTestId(b).boundingBox();
        expect(box?.height ?? 0, `${b} is 44 px`).toBeGreaterThanOrEqual(44);
      }
      await invariants(lena.page, "390", "phone review");
      await view.getByTestId("proposal-deny").click();
      const dialog = lena.page.getByTestId("proposal-confirm");
      await dialog.getByRole("textbox", { name: "Note (optional)" }).fill("Duplicate of the CRM entry");
      for (const theme of ["light", "dark"] as const) {
        await lena.page.emulateMedia({ colorScheme: theme });
        expect(await unnamedControls(lena.page), `deny dialog (${theme})`).toEqual([]);
        for (const b of await dialog.getByRole("button", { name: /^(Cancel|Deny)$/ }).all()) {
          expect((await b.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
        }
        // The shared Dialog's close X is a 44 px touch target below 1024 (WINDOWS 161).
        const close = await dialog.getByRole("button", { name: "Close", exact: true }).boundingBox();
        expect(close?.width ?? 0, "dialog close is 44 px wide").toBeGreaterThanOrEqual(44);
        expect(close?.height ?? 0, "dialog close is 44 px tall").toBeGreaterThanOrEqual(44);
        await expectNoSeriousA11y(lena.page, '[data-testid="proposal-confirm"]');
        if (!PRESIDIO_SET)
          await shot(lena.page, `review-memory-proposal-deny-390${theme === "dark" ? "-dark" : ""}`);
      }
      await lena.page.emulateMedia({ colorScheme: "light" });
      await dialog.getByTestId("proposal-confirm-submit").click();
      await expect(view.getByTestId("proposal-status")).toHaveText("Denied");
      await lena.page.getByRole("button", { name: "Back to proposals" }).click();
      await lena.page.getByTestId("proposals-tab-decided").click();
      await expect(lena.page.locator(`[data-testid="proposal-row"][data-id="${stale}"]`)).toHaveAttribute(
        "data-status",
        "denied",
      );
      expect((await fileOf(lenaApi, seed.ventasScopeId, path)).content).toBe(base.content);
    } else {
      // ---- desktop: the file changes first, then Lena approves: Failed with the reason, nothing overwritten
      const edited = await lenaApi.put(`/api/v1/memory/files/${base.id}`, {
        data: { content: "# Globex\n\nEdited by Lena.\n", expectedVersion: base.version },
      });
      expect(edited.ok(), `Lena edits ${path}: ${edited.status()}`).toBe(true);
      await lena.page.goto(`${BASE_URL}/memory/proposals/${stale}`);
      const view = lena.page.locator('[data-testid="proposal-review"][data-view="memory_proposal"]');
      await expect(view.getByTestId("proposal-title")).toHaveText(`Rewrite ${path}`);
      await view.getByTestId("proposal-approve").click();
      await lena.page.getByTestId("proposal-confirm-submit").click();
      await expect(view.getByTestId("proposal-status")).toHaveText("Failed");
      await expect(view.getByTestId("proposal-failed-reason")).toHaveText(
        `The file changed since this proposal. Ask ${bot.name} to propose again.`,
      );
      await expect(view.getByTestId("proposal-decision")).toContainText(`Approved by ${LENA.name}`);
      expect((await fileOf(lenaApi, seed.ventasScopeId, path)).content).toBe("# Globex\n\nEdited by Lena.\n");
      await review(lena.page, "review-memory-proposal-failed", "1440");
    }
  } finally {
    await sam.context.close();
    await lena.context.close();
    await samApi.dispose();
    await lenaApi.dispose();
  }
});

test("personal proposals stay private: the owner decides them, an admin never lists or opens them", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const w = widthOf(project);
  const bot = await freshPersonalBot(samId);
  const sam = await openAs(browser, SAM, project);
  const adminPage = await openAs(browser, ADMIN, project);
  try {
    await sam.page.goto(`${BASE_URL}/chat/dm/${bot.dmId}`);
    await expect(sam.page.getByTestId("dm-view")).toBeVisible();
    const id = await propose(sam.page, {
      scope: "personal",
      path: "MEMORY.md",
      op: "append",
      content: "\n- Prefers calls after 10",
    });
    // The owner reviews it in his own inbox (To review: his private memory is his to decide).
    await sam.page.goto(`${BASE_URL}/memory/proposals/${id}`);
    const samView = sam.page.locator('[data-testid="proposal-review"][data-view="memory_proposal"]');
    await expect(samView.getByTestId("proposal-readers")).toContainText("Only you");
    await expect(samView.getByTestId("proposal-approve")).toBeVisible();

    // The admin: not in any list, and the review is the shared not-found state.
    for (const role of ["decider", "requester"]) {
      const res = (await (await admin.get(`/api/v1/approvals?role=${role}`)).json()) as {
        items: Array<{ id: string }>;
      };
      expect(res.items.map((i) => i.id)).not.toContain(id);
    }
    expect((await admin.get(`/api/v1/approvals/${id}`)).status()).toBe(404);
    await adminPage.page.goto(`${BASE_URL}/memory/proposals?box=decided`);
    await expect(adminPage.page.getByTestId("proposals-shell")).toBeVisible();
    await expect(adminPage.page.locator(`[data-testid="proposal-row"][data-id="${id}"]`)).toHaveCount(0);
    await adminPage.page.goto(`${BASE_URL}/memory/proposals/${id}`);
    const missing = adminPage.page.locator('[data-testid="proposal-review"][data-state="not-found"]');
    await expect(missing).toContainText("This proposal doesn't exist or you can't open it");
    await expect(missing.getByRole("link", { name: "Back to proposals" })).toBeVisible();
    await expect(adminPage.page.locator("body")).not.toContainText("Prefers calls");
    if (w === "1440") await invariants(adminPage.page, w, "admin not found");
  } finally {
    await sam.context.close();
    await adminPage.context.close();
  }
});

test("extended scan state follows the server: a warning when Presidio does not answer, none when it is off", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const w = widthOf(project);
  const bot = await freshPersonalBot(samId);
  const sam = await openAs(browser, SAM, project);
  const lena = await openAs(browser, LENA, project);
  try {
    await sam.page.goto(`${BASE_URL}/chat/dm/${bot.dmId}`);
    await expect(sam.page.getByTestId("dm-view")).toBeVisible();
    const id = await propose(sam.page, {
      scope: seed.ventasScopeId,
      path: `clients/umbrella-${w}.md`,
      op: "create",
      content: "# Umbrella\n\nMet Carla Núñez at the Madrid fair; she runs procurement.\n",
      reason: "Met at the fair",
    });
    await lena.page.goto(`${BASE_URL}/memory/proposals/${id}`);
    const view = lena.page.locator('[data-testid="proposal-review"][data-view="memory_proposal"]');
    await expect(view.getByTestId("proposal-title")).toHaveText(`Create clients/umbrella-${w}.md`);
    const stored = await asSuperuser<{ findings: Array<{ kind: string }> }>(
      "select p.findings from app.memory_proposals p join app.approval_requests r on r.resource_id = p.id where r.id = $1",
      [id],
    );
    const unavailable = (stored[0]?.findings ?? []).some((f) => f.kind === "extended_scan_unavailable");
    expect(unavailable, "the server marks the scan unavailable exactly when a Presidio URL is set").toBe(
      PRESIDIO_SET,
    );
    if (PRESIDIO_SET) {
      const notice = view.getByRole("status").filter({ hasText: SCAN_WARNING });
      await expect(notice).toBeVisible();
      // Nothing found must not read as an all-clear: only the built-in scan ran (WINDOWS 165).
      await expect(view.getByTestId("findings-none")).toHaveText(
        "No sensitive data found by the built-in scan",
      );
      await expect(view.getByTestId("proposal-found")).toContainText("Built-in scan only");
      if (w === "1440") await review(lena.page, "review-memory-proposal-scan-unavailable", w);
    } else {
      await expect(view.getByTestId("findings")).toBeVisible();
      await expect(view).not.toContainText(SCAN_WARNING);
      await expect(view.getByTestId("extended-scan-notice")).toHaveCount(0);
      await expect(view.getByTestId("findings-none")).toHaveText("No sensitive data found");
    }
  } finally {
    await sam.context.close();
    await lena.context.close();
  }
});
