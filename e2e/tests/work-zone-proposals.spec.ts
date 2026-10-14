import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs, SAM, userIdOf } from "../support/actors";
import {
  ACTION_KINDS,
  approvalIdFromRow,
  clearPendingApprovals,
  MARTA,
  MEMORY_KIND,
  openApprovals,
  proposeWorkZoneFromDm,
} from "../support/approvals";
import { cellToken } from "../support/cell-token";
import { FakeCellPlugin, type MentionPayload } from "../support/fake-cell-plugin";
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
 * 07.5-12 (APPROVE-02, APPROVE-03, D-03, D-04, UI-SPEC Surface 2, R1, R8, R9, R11): the `/approvals` inbox and the Work
 * Zone proposal review, end to end with the fake cell (no model, no provider) and a REAL local-runtime daemon in
 * fake-runtime mode. Sam asks his bot to fix a bug; the bot proposes a session; the Approvals badge shows 1; Sam opens
 * the review, presses Start session, confirms, and lands on the running session with the bot's prompt. Then: tabs and
 * the kind filter as URL state, disjoint badges and inboxes (the memory inbox never lists a Work Zone proposal), live
 * updates in a second tab, offline and failed starts, the shared not-found state, the empty inbox, phone, dark, axe and
 * the reviewed screenshots (work-zone-proposal-*, approvals-inbox-empty-390, approval-review-notfound-1440).
 */

test.describe.configure({ mode: "serial" });

const PROMPT = "Fix the rounding error in invoice totals. Add a test with KWD.";
const PROJECT = "billing-api";
const DEVICE = "MacBook Pro";

/** A member of a second organization (moved there by the superuser, like the API's org B fixtures). */
const EVE: Actor = { name: "Eve Black", email: "eve-0712@ocw.test", password: "eve-e2e-password-123" };

let admin: APIRequestContext;
let samApi: APIRequestContext;
let samId: string;
let cell: FakeCellPlugin;
let device: FakeDeviceHandle | null = null;

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

/** Sam's only personal bot, fresh (deleting the old ones closes their proposals), its name and its private chat. */
async function freshBot(): Promise<{ id: string; name: string; dmId: string }> {
  const listed = (await (await samApi.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; scope: string; ownerUserId: string | null }>;
  };
  for (const a of listed.agents.filter((x) => x.scope === "personal" && x.ownerUserId === samId)) {
    expect((await samApi.delete(`/api/v1/agents/${a.id}`)).ok()).toBe(true);
  }
  const res = await samApi.post("/api/v1/agents/personal", {
    data: { instructions: "Answer briefly.", modelProvider: "mock", modelId: "mock-1" },
  });
  expect(res.ok(), "create Sam's personal bot").toBe(true);
  const body = (await res.json()) as { agent: { id: string; name: string }; dmId: string };
  return { id: body.agent.id, name: body.agent.name, dmId: body.dmId };
}

async function detailOf(api: APIRequestContext, id: string) {
  const res = await api.get(`/api/v1/approvals/${id}`);
  expect(res.ok(), `GET approval ${id}: ${res.status()}`).toBe(true);
  return (await res.json()) as {
    kind: string;
    status: string;
    actionHash: string;
    view: { workSessionId: string | null; startBlocked: string | null };
  };
}

/** A sonner toast with `text`. */
const toast = (page: Page, text: string) => page.locator("[data-sonner-toast]").filter({ hasText: text });

/** The screen's invariants: named controls, no sideways scroll, 44 px targets below 1024, axe in light and dark. */
async function invariants(page: Page, label: string, selector: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    expect(await unnamedControls(page), `${label} (${theme}): controls without a name`).toEqual([]);
    await expectNoSidewaysScroll(page, `${label} (${theme})`);
    await expectTouchTargets(page, '[data-testid="approvals-shell"]');
    await expectNoSeriousA11y(page, selector);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/** The review of `id`, opened from its inbox row (desktop: beside the list; phone: its own screen). */
async function openReview(page: Page, id: string) {
  const row = page.getByTestId(`approval-row-${id}`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  expect(await approvalIdFromRow(row)).toBe(id);
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/approvals/${id}`));
  const view = page.getByTestId("work-zone-proposal-view");
  await expect(view).toBeVisible({ timeout: 15_000 });
  return view;
}

/** A member of a second organization: invited here first, then moved into her own organization. Idempotent. */
async function ensureOrgBMember(): Promise<void> {
  const res = await admin.get("/api/v1/members");
  const members = ((await res.json()) as { members: Array<{ email: string | null }> }).members;
  const { rows } = await asSuperuser<{ id: string }>("select id from auth.user where email = $1", [
    EVE.email,
  ]);
  if (rows.length > 0 && !members.some((m) => m.email === EVE.email)) return; // already in org B
  const eveId = await ensureMember(admin, EVE, "standard");
  const orgB = crypto.randomUUID();
  await asSuperuser("insert into auth.organization (id, name, slug) values ($1, 'Elsewhere', $2)", [
    orgB,
    `elsewhere-${orgB}`,
  ]);
  await asSuperuser("delete from auth.member where user_id = $1", [eveId]);
  await asSuperuser("delete from app.org_members where user_id = $1", [eveId]);
  await asSuperuser("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    orgB,
    eveId,
  ]);
  await asSuperuser(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve Black', 'admin')",
    [orgB, eveId],
  );
  await asSuperuser("delete from auth.session where user_id = $1", [eveId]);
}

/** Signs in through the form and waits for the workspace (org B has no channels, so no `/chat/<id>` redirect). */
async function signIn(browser: Browser, user: Actor, project: string) {
  const mobile = project === "mobile";
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/login`);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page
    .getByTestId("login-form")
    .getByRole("button", { name: /sign in|log in/i })
    .click();
  await expect(page).toHaveURL(/\/chat/);
  return { context, page };
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const token = cellToken();
  expect(token, "OCW_CELL_TOKEN is configured").not.toBe("");
  admin = await apiAs(ADMIN);
  samId = await ensureMember(admin, SAM, "developer");
  samApi = await apiAs(SAM);
  expect(await userIdOf(samApi)).toBe(samId);
  cell = new FakeCellPlugin({ apiUrl: API_URL, token, autoAck: true, autoReply: true });
  await cell.start();
  // A device an earlier, interrupted run left behind would share the name: revoke it first.
  const listed = (await (await samApi.get("/api/v1/devices")).json()) as {
    devices: Array<{ id: string; name: string; ownerUserId: string }>;
  };
  for (const d of listed.devices.filter((x) => x.name === DEVICE && x.ownerUserId === samId)) {
    await samApi.delete(`/api/v1/devices/${d.id}`);
  }
  device = await startFakeDevice(samApi, { name: DEVICE, projectName: PROJECT });
});

test.afterAll(async () => {
  await device?.stop();
  device = null;
  await cell?.stop();
  await samApi?.dispose();
  await admin?.dispose();
});

test("the fake cell sends a call's arguments only for a tool flagged for approval", async () => {
  // A capturing double of the Agent Channel: no API, only the bodies the gate would receive.
  class Capturing extends FakeCellPlugin {
    readonly bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
    override async request<T = unknown>(_method: string, path: string, body?: unknown) {
      this.bodies.push({ path, body: body as Record<string, unknown> });
      return { status: 200, body: { callId: crypto.randomUUID(), allowed: true, reason: null } as T };
    }
  }
  const fake = new Capturing({ apiUrl: API_URL, token: "unused" });
  const m = {
    eventId: crypto.randomUUID(),
    agent: { id: crypto.randomUUID() },
    turn: {
      tools: ["m1__write_note", "m1__echo"],
      toolFlags: {
        m1__write_note: { untrustedOutput: false, sideEffecting: true, approval: "always" },
        m1__echo: { untrustedOutput: false, sideEffecting: false },
      },
    },
  } as unknown as MentionPayload;
  const lines = await fake.simulateToolCalls(m, [
    { tool: "write_note", args: { text: "hello", to: "ana@acme.example" } },
    { tool: "echo", args: { text: "hi" } },
  ]);
  expect(lines).toEqual(["Tool m1__write_note: allowed", "Tool m1__echo: allowed"]);
  const calls = fake.bodies.filter((b) => b.path === "/tool-calls");
  expect(calls[0]?.body.arguments).toEqual({ text: "hello", to: "ana@acme.example" });
  expect(calls[1]?.body).not.toHaveProperty("arguments");
  // A proposal carries the turn and its four fields only: never a user id or a mode.
  const wz = new Capturing({ apiUrl: API_URL, token: "unused" });
  await wz.simulateToolCalls(
    { ...m, turn: { tools: ["ocw_start_work_zone"] } } as unknown as MentionPayload,
    [
      {
        tool: "ocw_start_work_zone",
        args: { projectId: "p", deviceId: "d", prompt: "x", permissionMode: "fullAccess", userId: "u" },
      },
    ],
  );
  expect(wz.bodies[0]).toEqual({
    path: "/work-zone/proposals",
    body: { eventId: m.eventId, agentId: m.agent.id, projectId: "p", deviceId: "d", prompt: "x" },
  });
});

test("a bot proposes a session and Sam starts it from the Approvals inbox", async ({ browser }, info) => {
  test.setTimeout(240_000);
  const project = info.project.name;
  const w = widthOf(project);
  const mobile = project === "mobile";
  if (!device) throw new Error("no device");
  await clearPendingApprovals(samApi);
  const bot = await freshBot();
  const sam = await openAs(browser, SAM, project);
  try {
    const id = await proposeWorkZoneFromDm(sam.page, cell, {
      dmId: bot.dmId,
      projectId: device.projectId,
      deviceId: device.deviceId,
      prompt: PROMPT,
    });

    // ---- the nav badge: Approvals 1 (never on Memory)
    if (mobile) await sam.page.getByTestId("mobile-nav-trigger").click();
    const nav = sam.page.getByTestId("nav-approvals").filter({ visible: true }).first();
    await expect(nav).toHaveAccessibleName("Approvals, 1 to review", { timeout: 15_000 });
    await expect(nav.getByTestId("nav-approvals-count")).toHaveText("1");
    await expect(sam.page.getByTestId("nav-memory-count").filter({ visible: true })).toHaveCount(0);
    await nav.click();
    await expect(sam.page).toHaveURL(/\/approvals$/);

    // ---- the row
    const row = sam.page.getByTestId(`approval-row-${id}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText(`Start a session in ${PROJECT}`);
    await expect(row).toContainText(`${bot.name} for you`);
    await expect(row).toContainText("DM");
    await expect(row.getByTestId("approval-row-device")).toContainText(`${DEVICE} · Online`);
    await expect(row).toHaveAccessibleName(
      new RegExp(`^Start a session in ${PROJECT}, ${bot.name} for you, in DM, .+, ${DEVICE}, Online$`),
    );
    await expect(sam.page.getByTestId("approvals-review-count")).toHaveText("1");

    // ---- the review
    const view = await openReview(sam.page, id);
    await expect(view.getByTestId("approval-title")).toHaveText(`Start a session in ${PROJECT}`);
    await expect(view.getByTestId("approval-status")).toHaveText("Proposed");
    await expect(view.getByTestId("approval-meta")).toContainText(`${bot.name} for you`);
    await expect(view.getByTestId("approval-meta")).toContainText(`DM with ${bot.name}`);
    await expect(view.getByTestId("work-zone-fact-project")).toContainText(PROJECT);
    await expect(view.getByTestId("work-zone-fact-device")).toContainText(DEVICE);
    await expect(view.getByTestId("device-state")).toHaveText("Online");
    await expect(view.getByTestId("work-zone-fact-runtime")).toContainText("Claude Code");
    await expect(view.getByTestId("work-zone-fact-runtime")).toContainText("signed in");
    await expect(view.getByTestId("work-zone-fact-mode")).toContainText("Supervised");
    await expect(view.getByTestId("work-zone-fact-mode")).toContainText("asks before edits and commands");
    await expect(view.getByTestId("work-zone-prompt")).toHaveText(PROMPT);
    await expect(view).toContainText(
      `Written by ${bot.name}. Read it before starting: it runs on your device, as you.`,
    );
    await expect(view).toContainText(
      "Bots never choose Full access. You can change the mode after the session starts.",
    );
    await expect(view.getByTestId("work-zone-fact-mode")).not.toContainText("Full access");
    await expect(view.getByTestId("work-zone-start")).not.toHaveAttribute("aria-disabled", "true");

    await invariants(sam.page, `review ${w}`, '[data-testid="work-zone-proposal-view"]');
    await invariants(
      sam.page,
      `inbox ${w}`,
      mobile ? '[data-testid="approvals-shell"]' : '[data-testid="approvals-inbox"]',
    );
    await captureReview(sam.page, `work-zone-proposal-review-${w}`);

    // ---- Start session: confirm first, Cancel focused
    await view.getByTestId("work-zone-start").click();
    const dialog = sam.page.getByTestId("approval-confirm");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Start this session?");
    await expect(dialog).toContainText(
      `Claude Code runs ${bot.name}'s prompt in ${PROJECT} on ${DEVICE}, as you. It starts in Supervised mode: it asks before edits and commands.`,
    );
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await dialog.getByTestId("approval-confirm-submit").click();
    await expect(toast(sam.page, `Session started on ${DEVICE}`)).toBeVisible({ timeout: 30_000 });
    await expect(view.getByTestId("approval-status")).toHaveText("Started");
    await expect(view.getByTestId("approval-decision-line")).toContainText("Started by you");
    const open = view.getByTestId("work-zone-open-session");
    await expect(open).toBeVisible();
    await expect(open).toBeFocused();
    if (mobile) await sam.page.getByTestId("mobile-nav-trigger").click();
    await expect(sam.page.getByTestId("nav-approvals-count").filter({ visible: true })).toHaveCount(0);
    if (mobile) await sam.page.keyboard.press("Escape");

    // ---- the session the proposal started, with the bot's prompt
    const sessionId = (await detailOf(samApi, id)).view.workSessionId;
    expect(sessionId, "the started session").toBeTruthy();
    await open.click();
    await expect(sam.page).toHaveURL(new RegExp(`/work-zone/${sessionId}$`));
    await expect(sam.page.getByTestId("prompt-bubble").first()).toContainText(PROMPT, { timeout: 30_000 });
  } finally {
    await sam.context.close();
  }
});

test("tabs and the kind filter are URL state; the started proposal is Decided and Requested", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const sam = await openAs(browser, SAM, project);
  try {
    const decided = (await (
      await samApi.get(`/api/v1/approvals?role=decider&kinds=work_zone.start`)
    ).json()) as { items: Array<{ id: string; status: string }> };
    const started = decided.items.find((i) => i.status === "applied");
    expect(started, "the proposal the previous test started").toBeTruthy();
    const id = started?.id as string;

    await sam.page.goto(`${BASE_URL}/approvals`);
    await expect(sam.page.getByTestId("approvals-inbox")).toBeVisible();
    await expect(sam.page.getByTestId(`approval-row-${id}`)).toHaveCount(0);

    await sam.page.getByTestId("approvals-tab-decided").click();
    await expect(sam.page).toHaveURL(/\/approvals\?box=decided$/);
    const row = sam.page.getByTestId(`approval-row-${id}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByTestId("approval-status")).toHaveText("Started");

    await sam.page.getByTestId("approvals-kind-action").click();
    await expect(sam.page).toHaveURL(/\/approvals\?box=decided&kind=action$/);
    await expect(row).toHaveCount(0);
    await expect(sam.page.getByTestId("approvals-inbox")).toContainText("No actions here.");

    await sam.page.getByTestId("approvals-kind-work_zone").click();
    await expect(sam.page).toHaveURL(/kind=work_zone$/);
    await expect(row).toBeVisible();

    await sam.page.getByTestId("approvals-tab-requested").click();
    await expect(sam.page).toHaveURL(/\/approvals\?box=requested&kind=work_zone$/);
    await expect(sam.page.getByTestId(`approval-row-${id}`).getByTestId("approval-status")).toHaveText(
      "Started",
    );

    // The back button restores the earlier tab and filter.
    await sam.page.goBack();
    await expect(sam.page).toHaveURL(/\/approvals\?box=decided&kind=work_zone$/);
    await expect(sam.page.getByTestId("approvals-tab-decided")).toHaveAttribute("aria-selected", "true");
    await expect(sam.page.getByTestId("approvals-kind-work_zone")).toHaveAttribute("aria-selected", "true");
    await sam.page.goBack();
    await expect(sam.page).toHaveURL(/\/approvals\?box=decided&kind=action$/);
    await expect(sam.page.getByTestId("approvals-kind-action")).toHaveAttribute("aria-selected", "true");
  } finally {
    await sam.context.close();
  }
});

test("the two inboxes stay disjoint: memory proposals in Memory, Work Zone proposals in Approvals, counts never double", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  if (!device) throw new Error("no device");
  await clearPendingApprovals(samApi);
  const bot = await freshBot();
  const sam = await openAs(browser, SAM, project);
  try {
    // ---- one memory proposal (Sam's private memory: his to decide) and one Work Zone proposal
    await sam.page.goto(`${BASE_URL}/chat/dm/${bot.dmId}`);
    await expect(sam.page.getByTestId("dm-view")).toBeVisible();
    const memReply = sam.page
      .locator('[data-testid="message"][data-author-kind="agent"]')
      .filter({ hasText: "Tool ocw_memory_propose:" });
    const box = sam.page.getByTestId("composer");
    await box.click();
    await box.fill(
      `Remember this [[call ocw_memory_propose ${JSON.stringify({ scope: "personal", path: "MEMORY.md", op: "append", content: "\n- Prefers calls after 10" })}]]`,
    );
    await box.press("Enter");
    await expect(memReply.last()).toContainText("Tool ocw_memory_propose: proposed", { timeout: 30_000 });
    const memoryId = (
      [...cell.memoryRequests].reverse().find((r) => r.route === "/memory/propose")?.body as {
        approvalId?: string;
      }
    )?.approvalId as string;
    expect(memoryId, "the memory proposal's id").toBeTruthy();
    const wzId = await proposeWorkZoneFromDm(sam.page, cell, {
      projectId: device.projectId,
      deviceId: device.deviceId,
      prompt: PROMPT,
    });

    // ---- nav: Memory 1 and Approvals 1, never 2
    if (mobile) await sam.page.getByTestId("mobile-nav-trigger").click();
    await expect(sam.page.getByTestId("nav-memory-count").filter({ visible: true })).toHaveText("1", {
      timeout: 15_000,
    });
    await expect(sam.page.getByTestId("nav-approvals-count").filter({ visible: true })).toHaveText("1");
    if (mobile) await sam.page.keyboard.press("Escape");

    // ---- /approvals: the pinned Memory proposals row; no memory item in any tab
    await sam.page.goto(`${BASE_URL}/approvals`);
    const memoryLink = sam.page.getByTestId("approvals-memory-link");
    await expect(memoryLink).toBeVisible({ timeout: 15_000 });
    await expect(memoryLink).toHaveAttribute("href", "/memory/proposals");
    await expect(sam.page.getByTestId("approvals-memory-count")).toHaveText("1");
    await expect(sam.page.getByTestId(`approval-row-${wzId}`)).toBeVisible();
    for (const tab of ["review", "requested", "decided"] as const) {
      await sam.page.goto(`${BASE_URL}/approvals${tab === "review" ? "" : `?box=${tab}`}`);
      await expect(sam.page.getByTestId("approvals-inbox")).toBeVisible();
      await expect(sam.page.locator('[data-testid="approvals-loading"]')).toHaveCount(0, { timeout: 15_000 });
      await expect(sam.page.getByTestId(`approval-row-${memoryId}`)).toHaveCount(0);
      await expect(sam.page.locator(`[data-kind="${MEMORY_KIND}"]`)).toHaveCount(0);
    }

    // ---- /memory/proposals (blocker regression): the Work Zone proposal is in none of the three tabs
    const memoryTabs = async (when: string) => {
      for (const tab of ["review", "requested", "decided"] as const) {
        await sam.page.goto(`${BASE_URL}/memory/proposals${tab === "review" ? "" : `?box=${tab}`}`);
        await expect(sam.page.getByTestId("proposals-shell")).toBeVisible();
        await expect(sam.page.locator('[data-testid="proposals-loading"]')).toHaveCount(0, {
          timeout: 15_000,
        });
        await expect(
          sam.page.locator(`[data-testid="proposal-row"][data-id="${wzId}"]`),
          `${when}: no Work Zone proposal in /memory/proposals ${tab}`,
        ).toHaveCount(0);
        if (tab === "review") {
          await expect(sam.page.locator(`[data-testid="proposal-row"][data-id="${memoryId}"]`)).toBeVisible();
        }
      }
    };
    await memoryTabs("before Start");
    // Start it (API, as Sam), then look again.
    const d = await detailOf(samApi, wzId);
    const started = await samApi.post(`/api/v1/approvals/${wzId}/decision`, {
      data: { outcome: "approved", actionHash: d.actionHash },
    });
    expect(started.ok(), `start ${wzId}: ${started.status()}`).toBe(true);
    await memoryTabs("after Start");

    // ---- a Work Zone id opened in Memory goes to /approvals
    await sam.page.goto(`${BASE_URL}/memory/proposals/${wzId}`);
    await expect(sam.page).toHaveURL(new RegExp(`/approvals/${wzId}$`), { timeout: 15_000 });
    await expect(sam.page.getByTestId("work-zone-proposal-view")).toBeVisible();

    // ---- the API side of the same rule
    const memOnly = (await (
      await samApi.get(`/api/v1/approvals?role=decider&kinds=${MEMORY_KIND}`)
    ).json()) as { items: Array<{ id: string; kind: string }> };
    expect(memOnly.items.every((i) => i.kind === MEMORY_KIND)).toBe(true);
    const actions = (await (
      await samApi.get(`/api/v1/approvals?role=decider&kinds=${ACTION_KINDS}`)
    ).json()) as { items: Array<{ id: string; kind: string }> };
    expect(actions.items.map((i) => i.id)).not.toContain(memoryId);
  } finally {
    await clearPendingApprovals(samApi);
    await sam.context.close();
  }
});

test("a second tab updates live when the proposal is started elsewhere", async ({ browser }, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  if (!device) throw new Error("no device");
  await clearPendingApprovals(samApi);
  const bot = await freshBot();
  const one = await openAs(browser, SAM, project);
  const two = await openAs(browser, SAM, project);
  try {
    const id = await proposeWorkZoneFromDm(one.page, cell, {
      dmId: bot.dmId,
      projectId: device.projectId,
      deviceId: device.deviceId,
      prompt: PROMPT,
    });
    await two.page.goto(`${BASE_URL}/approvals`);
    await expect(two.page.getByTestId(`approval-row-${id}`)).toBeVisible({ timeout: 15_000 });
    await expect(two.page.getByTestId("approvals-review-count")).toHaveText("1");

    await one.page.goto(`${BASE_URL}/approvals/${id}`);
    const view = one.page.getByTestId("work-zone-proposal-view");
    await expect(view.getByTestId("work-zone-start")).toBeVisible({ timeout: 15_000 });
    await view.getByTestId("work-zone-start").click();
    await one.page.getByTestId("approval-confirm-submit").click();
    await expect(view.getByTestId("approval-status")).toHaveText("Started", { timeout: 30_000 });

    // The other tab, without a reload: the row leaves To review, the count drops, and it is said politely.
    await expect(two.page.getByTestId(`approval-row-${id}`)).toHaveCount(0, { timeout: 15_000 });
    await expect(two.page.getByTestId("approvals-review-count")).toHaveCount(0);
    await expect(two.page.getByTestId("approvals-live")).toHaveText("Nothing to review.");
    await two.page.getByTestId("approvals-tab-decided").click();
    await expect(two.page.getByTestId(`approval-row-${id}`).getByTestId("approval-status")).toHaveText(
      "Started",
    );
  } finally {
    await one.context.close();
    await two.context.close();
  }
});

test("an offline device disables Start with the reason, and it comes back without a reload", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const w = widthOf(project);
  if (!device) throw new Error("no device");
  await clearPendingApprovals(samApi);
  const bot = await freshBot();
  const sam = await openAs(browser, SAM, project);
  try {
    const id = await proposeWorkZoneFromDm(sam.page, cell, {
      dmId: bot.dmId,
      projectId: device.projectId,
      deviceId: device.deviceId,
      prompt: PROMPT,
    });
    await sam.page.goto(`${BASE_URL}/approvals/${id}`);
    const view = sam.page.getByTestId("work-zone-proposal-view");
    await expect(view.getByTestId("device-state")).toHaveText("Online", { timeout: 15_000 });

    await device.shutdown();
    await expect(view.getByTestId("device-state")).toHaveText("Offline", { timeout: 30_000 });
    const start = view.getByTestId("work-zone-start");
    await expect(start).toHaveAttribute("aria-disabled", "true");
    const reason = view.getByTestId("work-zone-start-blocked");
    await expect(reason).toHaveText(`${DEVICE} is offline. You can start it when the device is back.`);
    const describedBy = await start.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    await expect(reason).toHaveAttribute("id", describedBy as string);
    // A disabled Start opens nothing.
    await start.click({ force: true });
    await expect(sam.page.getByTestId("approval-confirm")).toHaveCount(0);
    await expect(view.getByTestId("work-zone-dismiss")).toBeEnabled();
    // The row beside the review follows the device too (desktop shows both).
    if (w === "1440") {
      await expect(
        sam.page.getByTestId(`approval-row-${id}`).getByTestId("approval-row-device"),
      ).toContainText(`${DEVICE} · Offline`, { timeout: 15_000 });
    }
    await invariants(sam.page, `offline ${w}`, '[data-testid="work-zone-proposal-view"]');
    if (w === "1440") await captureReview(sam.page, "work-zone-proposal-offline-1440");

    await device.restart();
    await expect(view.getByTestId("device-state")).toHaveText("Online", { timeout: 30_000 });
    await expect(start).not.toHaveAttribute("aria-disabled", "true");
    await expect(view.getByTestId("work-zone-start-blocked")).toHaveCount(0);
  } finally {
    await device.restart();
    await clearPendingApprovals(samApi);
    await sam.context.close();
  }
});

test("a reviewer who may not open it and another organization see the shared not-found state", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const w = widthOf(project);
  if (!device) throw new Error("no device");
  await ensureMember(admin, MARTA, "lead");
  await ensureOrgBMember();
  await clearPendingApprovals(samApi);
  const bot = await freshBot();
  const sam = await openAs(browser, SAM, project);
  const marta = await openAs(browser, MARTA, project);
  const eve = await signIn(browser, EVE, project);
  try {
    const id = await proposeWorkZoneFromDm(sam.page, cell, {
      dmId: bot.dmId,
      projectId: device.projectId,
      deviceId: device.deviceId,
      prompt: "Rotate the staging keys. Secret plan Z-0712.",
    });
    for (const [who, page] of [
      ["lead", marta.page],
      ["org B", eve.page],
    ] as const) {
      await page.goto(`${BASE_URL}/approvals/${id}`);
      const missing = page.locator('[data-testid="approval-review"][data-state="not-found"]');
      await expect(missing, `${who}: not found`).toContainText(
        "This approval doesn't exist or you can't open it",
        { timeout: 15_000 },
      );
      await expect(missing.getByRole("link", { name: "Back to approvals" })).toBeVisible();
      await expect(page.locator("body")).not.toContainText("Z-0712");
      await expect(page.getByTestId(`approval-row-${id}`)).toHaveCount(0);
    }
    await invariants(marta.page, `not found ${w}`, '[data-testid="approvals-shell"]');
    if (w === "1440") await captureReview(marta.page, "approval-review-notfound-1440");
  } finally {
    await clearPendingApprovals(samApi);
    await sam.context.close();
    await marta.context.close();
    await eve.context.close();
  }
});

test("an empty inbox says so", async ({ browser }, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const w = widthOf(project);
  await clearPendingApprovals(samApi);
  const sam = await openAs(browser, SAM, project);
  try {
    await openApprovals(sam.page);
    const inbox = sam.page.getByTestId("approvals-inbox");
    await expect(inbox).toContainText("Nothing to review", { timeout: 15_000 });
    await expect(inbox).toContainText(
      "When a bot needs your approval or proposes a Work Zone session, it shows up here.",
    );
    if (w === "1440") {
      await expect(sam.page.getByText("Select an approval")).toBeVisible();
    }
    await invariants(sam.page, `empty ${w}`, '[data-testid="approvals-shell"]');
    if (w === "390") await captureReview(sam.page, "approvals-inbox-empty-390");
  } finally {
    await sam.context.close();
  }
});

test("Start fails when the project was removed: the reason, the Failed pill and what to do next", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const w = widthOf(project);
  if (!device) throw new Error("no device");
  await clearPendingApprovals(samApi);
  const bot = await freshBot();
  const sam = await openAs(browser, SAM, project);
  try {
    const id = await proposeWorkZoneFromDm(sam.page, cell, {
      dmId: bot.dmId,
      projectId: device.projectId,
      deviceId: device.deviceId,
      prompt: PROMPT,
    });
    await sam.page.goto(`${BASE_URL}/approvals/${id}`);
    const view = sam.page.getByTestId("work-zone-proposal-view");
    await expect(view.getByTestId("work-zone-start")).not.toHaveAttribute("aria-disabled", "true", {
      timeout: 15_000,
    });
    // Ask to start, then the project disappears from the device before the confirmation.
    await view.getByTestId("work-zone-start").click();
    await expect(sam.page.getByTestId("approval-confirm")).toBeVisible();
    await device.removeProject();
    await sam.page.getByTestId("approval-confirm-submit").click();

    await expect(view.getByTestId("approval-status")).toHaveText("Failed", { timeout: 30_000 });
    await expect(view.getByTestId("approval-failed-reason")).toHaveText("This project was removed.");
    await expect(view.getByTestId("approval-decision-line")).toHaveText(
      `Ask ${bot.name} again when it's fixed.`,
    );
    await expect(view.getByTestId("work-zone-start")).toHaveCount(0);
    expect((await detailOf(samApi, id)).status).toBe("failed");
    await invariants(sam.page, `failed ${w}`, '[data-testid="work-zone-proposal-view"]');
    if (w === "390") await captureReview(sam.page, "work-zone-proposal-failed-390");
  } finally {
    await sam.context.close();
  }
});
