import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
import { SessionMemorySummary } from "../../packages/contracts/src/work-zone-memory.ts";
import { expectNoSeriousA11y } from "../support/a11y";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs, userIdOf } from "../support/actors";
import { captureReview, expectNoSidewaysScroll, expectTouchTargets } from "../support/layout";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import {
  createTeamProject,
  linkRepo,
  removeTeamProject,
  setAudience,
  shareDevice,
  type TeamProject,
} from "../support/work-zone-projects";
import { ADMIN } from "./env";

/**
 * Work Zone → project memory in the browser (07.6-22, AUTO-06; D-06 as amended by D-10, D-07, D-11; UI-SPEC Surface 9,
 * R7) on the real stack, its fake runtime and the harness's fake model, at 1440 and 390, light and dark:
 * - tracer: Ana's session in the repository linked to Billing (07.9's helpers) ends; she proposes it from the strip
 *   through the confirmation (model, METERED, who pays; focus on Cancel), sees Writing… then Pending live on her own
 *   `user:` stream; Marta (Billing's lead, a reader of the session) sees the Pending line and no buttons;
 * - the `⋯` menu turns automatic proposals on (with its confirmation) and off (at once); the next ended session is
 *   proposed automatically;
 * - Not mapped (D-10): Marta, who may link (lead + Ana's device shared with her), follows `Link it →` to 07.9's Projects
 *   index and links the repository with 07.9's own dialog; Ana's strip then reads Ready; Sam reads "Ask a lead";
 * - audience (D-11): a session set to Only me shows nothing to Marta or Sam (07.9's not found) while Ana's strip still
 *   updates live.
 * Everything the spec makes is removed in `afterAll`.
 */

test.describe.configure({ mode: "serial" });

const FAKE_URL = process.env.OCW_E2E_FAKE_URL ?? "";
const FAKE_ANTHROPIC_KEY = "sk-ant-e2e-fake-key-not-real-0000";

const ANA: Actor = { name: "Ana Ruiz", email: "ana-wzm@ocw.test", password: "ana-e2e-password-123" };
// Her own display name: the approval specs' Marta Gil (marta@ocw.test) shares this stack, and two members with one
// name make the mobile approver picker ambiguous after the desktop run (07.14-14 gate).
const MARTA: Actor = { name: "Marta Vidal", email: "marta-wzm@ocw.test", password: "marta-e2e-password-123" };
const SAM: Actor = { name: "Sam Ortega", email: "sam-wzm@ocw.test", password: "sam-wzm-password-123" };

const BILLING = "Billing";
const READY = `Save what this session learned to ${BILLING} memory.`;
const PENDING = `Proposed to ${BILLING} memory · Pending review`;
const PENDING_AUTO = `Proposed automatically to ${BILLING} memory · Pending review`;
const NOT_MAPPED = "This repository isn't linked to a project's memory.";

let admin: APIRequestContext;
let ana: APIRequestContext;
let tag = "";
let run = "";
let anaId = "";
let martaId = "";
let samId = "";
let billing: TeamProject | null = null;
/** Ana's repository linked to Billing (07.9). */
let linked: FakeDeviceHandle | null = null;
/** Ana's second repository, linked to no team project until Marta links it. */
let unlinked: FakeDeviceHandle | null = null;
let addedProvider = false;
const sessionIds: string[] = [];
const S = { ended: "", auto: "", unmapped: "", private: "" };

const strip = (page: Page) => page.getByTestId("session-memory-strip");

async function memoryOf(api: APIRequestContext, sessionId: string) {
  const res = await api.get(`/api/v1/work-sessions/${sessionId}/memory`);
  expect(res.ok(), `GET memory: ${res.status()}`).toBe(true);
  return SessionMemorySummary.parse(await res.json());
}

/** Ana starts a session with one prompt and waits until the fake runtime answered it (the session has work). */
async function sessionWithWork(projectId: string, title: string): Promise<string> {
  const res = await ana.post("/api/v1/work-sessions", {
    data: { projectId, runtime: "claude-code", permissionMode: "plan", title, prompt: `${title}: fix it` },
  });
  expect(res.ok(), `start ${title}: ${res.status()} ${await res.text()}`).toBe(true);
  const { id } = (await res.json()) as { id: string };
  sessionIds.push(id);
  await expect
    .poll(
      async () => {
        const r = await ana.get(`/api/v1/work-sessions/${id}`);
        if (!r.ok()) return "missing";
        const d = (await r.json()) as { session: { status: string }; prompts: Array<{ status: string }> };
        return d.session.status === "idle" && d.prompts.every((p) => p.status === "completed")
          ? "answered"
          : d.session.status;
      },
      { timeout: 45_000, message: `${title} is answered` },
    )
    .toBe("answered");
  return id;
}

async function statusOf(api: APIRequestContext, id: string): Promise<string> {
  const r = await api.get(`/api/v1/work-sessions/${id}`);
  return r.ok() ? ((await r.json()) as { session: { status: string } }).session.status : `http_${r.status()}`;
}

async function archive(api: APIRequestContext, id: string): Promise<void> {
  const r = await api.post(`/api/v1/work-sessions/${id}/archive`, { data: {} });
  expect(r.ok(), `archive ${id}: ${r.status()}`).toBe(true);
}

async function openSession(page: Page, id: string): Promise<void> {
  await page.goto(`${BASE_URL}/work-zone/${id}`);
  await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 30_000 });
}

/** axe on `selector` in light and dark (serious and critical fail). */
async function axeBothThemes(page: Page, selector: string): Promise<void> {
  await expectNoSeriousA11y(page, selector);
  await page.emulateMedia({ colorScheme: "dark" });
  await expectNoSeriousA11y(page, selector);
  await page.emulateMedia({ colorScheme: "light" });
}

/** At 390 the strip wraps: its action spans the row, every control is ≥ 44 px, nothing scrolls sideways. */
async function checkPhoneStrip(page: Page, action: string | null): Promise<void> {
  await expectTouchTargets(page, '[data-testid="session-memory-strip"]');
  await expectNoSidewaysScroll(page, "session memory strip");
  if (!action) return;
  const row = await strip(page).boundingBox();
  const button = await strip(page).getByTestId(action).boundingBox();
  expect(row && button, "strip and action are laid out").toBeTruthy();
  if (row && button) expect(button.width).toBeGreaterThan(row.width - 64);
}

const open = (browser: Browser, who: Actor, project: string) => openAs(browser, who, project);

test.beforeAll(async () => {
  test.setTimeout(300_000);
  test.skip(!FAKE_URL, "OCW_E2E_FAKE_URL is not set (the fake model is not running)");
  tag = test.info().project.name === "mobile" ? "390" : "1440";
  run = `${tag}-${Date.now().toString(36)}`;
  admin = await apiAs(ADMIN);
  const adminId = await userIdOf(admin);
  anaId = await ensureMember(admin, ANA, "developer");
  martaId = await ensureMember(admin, MARTA, "lead");
  samId = await ensureMember(admin, SAM, "developer");
  ana = await apiAs(ANA);

  // The owner's model is an organization key on the harness fake: METERED, billed to the organization (D-07).
  const providers = (await (await admin.get("/api/v1/model-providers")).json()) as {
    providers: Array<{ provider: string }>;
  };
  if (!providers.providers.some((p) => p.provider === "anthropic")) {
    const res = await admin.post("/api/v1/model-providers", {
      data: {
        provider: "anthropic",
        apiKey: FAKE_ANTHROPIC_KEY,
        baseUrl: FAKE_URL,
        allowedModels: ["claude-sonnet-5-5", "claude-haiku-4-5"],
        enabled: true,
      },
    });
    expect(res.ok(), `configure Anthropic: ${res.status()} ${await res.text()}`).toBe(true);
    addedProvider = true;
  }

  // 07.9's model only (D-10): Marta leads Billing, Ana is in it, Ana's repository is linked to it.
  billing = await createTeamProject(admin, {
    name: BILLING,
    members: [
      { userId: martaId, role: "lead" },
      { userId: anaId, role: "member" },
    ],
  });
  linked = await startFakeDevice(ana, { name: `Ana laptop ${run}`, projectName: `billing-api-${tag}` });
  await shareDevice(ana, linked.deviceId, adminId);
  await linkRepo(admin, billing.unitId, linked.projectId);
});

test.afterAll(async () => {
  for (const id of sessionIds)
    await ana?.post(`/api/v1/work-sessions/${id}/archive`, { data: {} }).catch(() => {});
  await ana?.put("/api/v1/me/preferences", { data: { autoProposeSessionSummaries: false } }).catch(() => {});
  if (billing) await removeTeamProject(admin, billing).catch(() => undefined);
  for (const d of [linked, unlinked]) await d?.stop().catch(() => undefined);
  if (addedProvider) await admin?.delete("/api/v1/model-providers/anthropic").catch(() => undefined);
  await ana?.dispose();
  await admin?.dispose();
});

test("Ana proposes an ended session to Billing memory; it reaches Pending live and Marta reads it", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const mobile = info.project.name === "mobile";
  const device = linked as FakeDeviceHandle;
  S.ended = await sessionWithWork(device.projectId, `Invoice rounding ${run}`);
  // The device stops: its runtime reports the session as ended ("Ended", status completed).
  await device.shutdown();
  await expect.poll(() => statusOf(ana, S.ended), { timeout: 30_000 }).toBe("completed");
  const before = await memoryOf(ana, S.ended);
  expect(before).toMatchObject({ status: "none", canPropose: true, unit: { name: BILLING } });
  expect(before.model?.metered).toBe(true);

  const owner = await open(browser, ANA, info.project.name);
  const marta = await open(browser, MARTA, info.project.name);
  try {
    const { page } = owner;
    await openSession(page, S.ended);
    await expect(strip(page)).toContainText(READY);
    await expect(strip(page)).toHaveAttribute("data-status", "none");
    const propose = strip(page).getByTestId("session-memory-propose");
    await expect(propose).toHaveText("Propose to memory");
    await axeBothThemes(page, '[data-testid="session-memory-strip"]');
    if (mobile) await checkPhoneStrip(page, "session-memory-propose");
    await captureReview(page, `session-memory-strip-ready-${tag}`);

    // The confirmation: the model, METERED, who pays; focus on Cancel; the automatic opt-in unchecked (D-07).
    await propose.click();
    const dialog = page.getByTestId("propose-summary-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`Propose a summary to ${BILLING} memory?`);
    await expect(dialog.getByTestId("propose-summary-model")).toHaveText(before.model?.label ?? "");
    await expect(dialog.getByTestId("provider-metered")).toHaveText("METERED");
    await expect(dialog.getByTestId("propose-summary-notice")).toHaveText(
      "Billed to the organization and counted against your AI chat limits. Only repo-relative paths are sent.",
    );
    await expect(dialog.getByTestId("propose-summary-auto")).not.toBeChecked();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await axeBothThemes(page, '[data-testid="propose-summary-dialog"]');
    if (mobile) {
      // A bottom sheet below 640 with 44 px buttons.
      const box = await dialog.boundingBox();
      const viewport = page.viewportSize();
      expect(box && viewport).toBeTruthy();
      if (box && viewport) {
        expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(viewport.height - 1);
        expect(Math.round(box.width)).toBe(viewport.width);
      }
      await expectTouchTargets(page, '[data-testid="propose-summary-dialog"]');
    }
    await captureReview(page, `session-propose-dialog-${tag}`);

    // Cancel sends nothing; Propose summary sends the one request.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect((await memoryOf(ana, S.ended)).status).toBe("none");
    let proposes = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith(`/work-sessions/${S.ended}/memory/propose`))
        proposes += 1;
    });
    await propose.click();
    await dialog.getByTestId("propose-summary-submit").click();
    await expect(page.getByText(`Summary sent to ${BILLING} memory for review.`)).toBeVisible();
    await expect(strip(page)).toContainText(/Writing a summary…|Proposed to/u);
    // The fake model answers; the change arrives on Ana's own `user:` stream (no reload, no polling).
    await expect(strip(page)).toContainText(PENDING, { timeout: 45_000 });
    expect(proposes).toBe(1);
    const after = await memoryOf(ana, S.ended);
    expect(after.status).toBe("pending");
    await expect(strip(page).getByTestId("session-memory-review")).toHaveAttribute(
      "href",
      `/memory/proposals/${after.proposalId}`,
    );
    await axeBothThemes(page, '[data-testid="session-memory-strip"]');
    if (mobile) await checkPhoneStrip(page, "session-memory-review");
    await captureReview(page, `session-memory-strip-pending-${tag}`);

    // Marta reads the session (Billing's lead, `project` audience): the line, no buttons, no menu.
    await openSession(marta.page, S.ended);
    await expect(strip(marta.page)).toContainText(PENDING);
    await expect(strip(marta.page).getByRole("button")).toHaveCount(0);
    await expect(strip(marta.page).getByRole("link")).toHaveCount(0);
  } finally {
    await owner.context.close();
    await marta.context.close();
  }
});

test("automatic proposals: on from the ⋯ menu with a confirmation, the next ended session is proposed, off at once", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const device = linked as FakeDeviceHandle;
  await device.restart();
  const owner = await open(browser, ANA, info.project.name);
  try {
    const { page } = owner;
    await openSession(page, S.ended);
    await expect(strip(page)).toContainText(PENDING);
    await strip(page).getByTestId("session-memory-menu").click();
    const item = page.getByRole("menuitemcheckbox", { name: "Propose automatically for my sessions" });
    await expect(item).toHaveAttribute("aria-checked", "false");
    await expect(page.getByRole("menuitem", { name: "Memory proposals" })).toHaveAttribute(
      "href",
      "/memory/proposals?box=requested",
    );
    await item.click();
    const dialog = page.getByTestId("propose-summary-dialog");
    await expect(dialog).toHaveAttribute("data-mode", "auto");
    await expect(dialog).toContainText("Propose summaries automatically?");
    await expect(dialog).toContainText("Each summary is one AI request billed to the organization.");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await axeBothThemes(page, '[data-testid="propose-summary-dialog"]');
    await dialog.getByRole("button", { name: "Turn on" }).click();
    await expect(page.getByText("Automatic proposals are on.")).toBeVisible();
    await expect(dialog).toBeHidden();
    const prefs = await (await ana.get("/api/v1/me/preferences")).json();
    expect(prefs).toEqual({ autoProposeSessionSummaries: true });

    // The next session that ends in the linked repository is proposed without a click.
    S.auto = await sessionWithWork(device.projectId, `Tax totals ${run}`);
    await archive(ana, S.auto);
    await openSession(page, S.auto);
    await expect(strip(page)).toContainText(PENDING_AUTO, { timeout: 45_000 });

    // Off is immediate, with its toast and no dialog.
    await strip(page).getByTestId("session-memory-menu").click();
    const checked = page.getByRole("menuitemcheckbox", { name: "Propose automatically for my sessions" });
    await expect(checked).toHaveAttribute("aria-checked", "true");
    await checked.click();
    await expect(page.getByText("Automatic proposals are off.")).toBeVisible();
    await expect(page.getByTestId("propose-summary-dialog")).toHaveCount(0);
    expect(await (await ana.get("/api/v1/me/preferences")).json()).toEqual({
      autoProposeSessionSummaries: false,
    });
  } finally {
    await owner.context.close();
  }
});

test("Not mapped: Marta follows Link it → to 07.9's Projects and links the repository; Sam is told to ask a lead", async ({
  browser,
}, info) => {
  test.setTimeout(300_000);
  const mobile = info.project.name === "mobile";
  const project = billing as TeamProject;
  unlinked = await startFakeDevice(ana, { name: `Ana desktop ${run}`, projectName: `billing-web-${tag}` });
  // Device sharing is how Marta may use (and link) Ana's repository and how Sam reads its personal sessions.
  await shareDevice(ana, unlinked.deviceId, martaId);
  await shareDevice(ana, unlinked.deviceId, samId);
  S.unmapped = await sessionWithWork(unlinked.projectId, `Refund flow ${run}`);
  await archive(ana, S.unmapped);
  expect(await memoryOf(ana, S.unmapped)).toMatchObject({ status: "unmapped", canMap: false });

  const owner = await open(browser, ANA, info.project.name);
  const lead = await open(browser, MARTA, info.project.name);
  const member = await open(browser, SAM, info.project.name);
  try {
    // Sam reads the session but may not link: one line, no link.
    await openSession(member.page, S.unmapped);
    await expect(strip(member.page)).toContainText(NOT_MAPPED);
    await expect(strip(member.page)).toContainText("Ask a lead to link it.");
    await expect(strip(member.page).getByRole("link")).toHaveCount(0);

    // Marta may link (Billing's lead + the device shared with her): Link it → goes to 07.9's Projects index.
    const { page } = lead;
    await openSession(page, S.unmapped);
    await expect(strip(page)).toContainText(NOT_MAPPED);
    const link = strip(page).getByTestId("session-memory-link");
    await expect(link).toHaveAttribute("href", "/work-zone/projects");
    await axeBothThemes(page, '[data-testid="session-memory-strip"]');
    if (mobile) await checkPhoneStrip(page, "session-memory-link");
    await captureReview(page, `session-memory-strip-not-mapped-${tag}`);
    await link.click();
    await expect(page).toHaveURL(/\/work-zone\/projects$/u);
    await expect(page.getByTestId("projects-index")).toBeVisible();

    // 07.9's own flow, unchanged: Billing → Settings → Link a repository.
    await page.getByTestId("projects-index").getByTestId(`project-row-${project.unitId}`).click();
    await expect(page.getByTestId("project-page")).toBeVisible();
    await page.getByTestId("project-tab-settings").click();
    await expect(page.getByTestId("project-settings")).toBeVisible();
    await page.getByTestId("link-repo").click();
    const dialog = page.getByTestId("link-repo-dialog");
    await expect(dialog).toContainText(`Link a repository to ${BILLING}`);
    await dialog.getByTestId(`link-repo-option-${unlinked.projectId}`).click();
    await expect(page.getByText(`billing-web-${tag} linked to ${BILLING}`)).toBeVisible();
    await dialog.getByRole("button", { name: "Done" }).click();

    // Back on the session, Ana's strip offers Ready for Billing (on the next load, UI-SPEC 9c).
    await openSession(owner.page, S.unmapped);
    await expect(strip(owner.page)).toContainText(READY);
    await expect(strip(owner.page).getByTestId("session-memory-propose")).toBeVisible();
  } finally {
    await owner.context.close();
    await lead.context.close();
    await member.context.close();
  }
});

test("audience: a session only Ana sees shows Marta and Sam nothing, and Ana's strip still updates live", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const device = linked as FakeDeviceHandle;
  S.private = await sessionWithWork(device.projectId, `Payroll export ${run}`);
  await archive(ana, S.private);
  await setAudience(ana, S.private, { kind: "owner" });
  // The per-viewer read is the 404 of a missing session for anyone outside the audience (D-11).
  const martaApi = await apiAs(MARTA);
  const samApi = await apiAs(SAM);
  try {
    expect((await martaApi.get(`/api/v1/work-sessions/${S.private}/memory`)).status()).toBe(404);
    expect((await samApi.get(`/api/v1/work-sessions/${S.private}/memory`)).status()).toBe(404);
  } finally {
    await martaApi.dispose();
    await samApi.dispose();
  }

  const owner = await open(browser, ANA, info.project.name);
  const lead = await open(browser, MARTA, info.project.name);
  const member = await open(browser, SAM, info.project.name);
  try {
    for (const other of [lead.page, member.page]) {
      await other.goto(`${BASE_URL}/work-zone/${S.private}`);
      await expect(other.getByText("Session not found")).toBeVisible({ timeout: 30_000 });
      await expect(strip(other)).toHaveCount(0);
    }

    const { page } = owner;
    await openSession(page, S.private);
    await expect(strip(page)).toContainText(READY);
    await strip(page).getByTestId("session-memory-propose").click();
    await page.getByTestId("propose-summary-dialog").getByTestId("propose-summary-submit").click();
    await expect(strip(page)).toContainText(PENDING, { timeout: 45_000 });
    await expect(strip(lead.page)).toHaveCount(0);
  } finally {
    await owner.context.close();
    await lead.context.close();
    await member.context.close();
  }
});
