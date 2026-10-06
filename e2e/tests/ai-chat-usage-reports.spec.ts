import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { seedPlan } from "../support/ai-chat";
import { ADMIN, shot } from "./env";

/**
 * Usage reports in the browser (05-09, AICHAT-07, D-06): an admin reads the organization's AI chat usage in
 * Settings › Models › Usage, by member (Sam's answers, tokens and cost) and by model (Claude Sonnet 5.5 METERED, the
 * member's ChatGPT plan "Not billed"), over 30 then 7 days. Answers are produced through the API against the harness
 * fake; no real provider is ever called.
 */

test.describe.configure({ mode: "serial" });

const FAKE_URL = process.env.OCW_E2E_FAKE_URL ?? "";
const FAKE_ANTHROPIC_KEY = "sk-ant-e2e-fake-key-not-real-0000";
const SONNET = { backend: "org_key", provider: "anthropic", modelId: "claude-sonnet-5-5" } as const;
const PLAN = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;
const COST = /^~?\$\d/u;

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

let admin: APIRequestContext;
let sam: APIRequestContext;

/** One answer in a fresh AI chat, through the API, settled. */
async function answer(api: APIRequestContext, body: string, model: typeof SONNET | typeof PLAN) {
  const res = await api.post("/api/v1/ai-chats", {
    data: { clientMessageId: `cm-${randomUUID()}`, body, model },
  });
  expect(res.status(), `create AI chat: ${await res.text()}`).toBe(201);
  const created = (await res.json()) as { chat: { id: string }; assistantMessage: { id: string } };
  await expect
    .poll(
      async () => {
        const snap = (await (await api.get(`/api/v1/ai-chats/${created.chat.id}`)).json()) as {
          messages: Array<{ id: string; generation?: { status: string } | null }>;
        };
        return snap.messages.find((m) => m.id === created.assistantMessage.id)?.generation?.status;
      },
      { timeout: 20_000 },
    )
    .toBe("completed");
}

/** Settings › Models, scrolled to the usage report. */
async function openReport(page: Page): Promise<Locator> {
  await page.goto(`${BASE_URL}/settings/models`);
  const report = page.getByTestId("ai-usage-report");
  await expect(report.getByRole("heading", { name: "Usage" })).toBeVisible();
  await report
    .getByRole("heading", { name: "Usage" })
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  return report;
}

const rowOf = (report: Locator, label: string) =>
  report.locator(`[data-testid="ai-usage-row"][data-label="${label}"]`).filter({ visible: true });

test.beforeAll(async () => {
  test.skip(!FAKE_URL, "OCW_E2E_FAKE_URL is not set (the fake model is not running)");
  admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  sam = await apiAs(SAM);
  await seedPlan(sam);
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
  // The one-time ChatGPT welcome (05-07) is not what these tests look at.
  const seen = await sam.post("/api/v1/me/model-credentials/chatgpt/welcome-seen", { data: {} });
  expect(seen.ok(), `welcome-seen: ${seen.status()}`).toBe(true);
  await answer(sam, "Summarise the quarterly numbers", SONNET);
  await answer(sam, "And on my own plan?", PLAN);
});

test.afterAll(async () => {
  await sam?.dispose();
  await admin?.dispose();
});

test("an admin sees AI chat usage by member and by model over 30 and 7 days", async ({ browser }, info) => {
  const project = info.project.name;
  const w = widthOf(project);
  const { context, page } = await openAs(browser, ADMIN, project);
  const report = await openReport(page);

  // By member, last 30 days (the defaults): Sam's row has answers, tokens and a cost.
  await expect(
    report.getByTestId("ai-usage-groupBy").getByRole("radio", { name: "By member" }),
  ).toBeChecked();
  await expect(report.getByTestId("ai-usage-days").getByRole("radio", { name: "30 days" })).toBeChecked();
  const samRow = rowOf(report, SAM.name);
  await expect(samRow).toHaveCount(1);
  await expect(samRow.getByTestId("ai-usage-answers")).toHaveText(/^[1-9]\d*( answers?)?$/u);
  if (project === "mobile") await expect(samRow).toContainText(/[1-9][\d.]*k? in · \d[\d.]*k? out/u);
  else await expect(samRow.getByTestId("ai-usage-input")).toHaveText(/^[1-9][\d.]*k?$/u);
  await expect(samRow.getByTestId("ai-usage-cost")).toHaveText(COST);
  await expect(report.getByTestId("ai-usage-total").filter({ visible: true })).toContainText("Total");
  await expect(report.getByTestId("ai-usage-summary")).toContainText("Organization cost");
  await bothThemes(page, `settings-ai-usage-${w}`);

  // By model: Claude Sonnet 5.5 is METERED with a cost; the member's plan is counted but not billed.
  await report.getByTestId("ai-usage-groupBy").getByRole("radio", { name: "By model" }).click();
  const sonnet = rowOf(report, "Claude Sonnet 5.5");
  await expect(sonnet).toHaveCount(1);
  await expect(sonnet.getByTestId("provider-metered")).toBeVisible();
  await expect(sonnet.getByTestId("ai-usage-cost")).toHaveText(COST);
  const plan = rowOf(report, "GPT-6 Astra");
  await expect(plan).toHaveCount(1);
  await expect(plan.getByTestId("ai-usage-cost")).toHaveText("Not billed");
  await expect(plan).toContainText("ChatGPT plan");
  await expect(rowOf(report, SAM.name)).toHaveCount(0);
  await shot(page, `settings-ai-usage-models-${w}`);

  // 7 days: today's answers are still there.
  await report.getByTestId("ai-usage-days").getByRole("radio", { name: "7 days" }).click();
  await expect(report.getByTestId("ai-usage-days").getByRole("radio", { name: "7 days" })).toBeChecked();
  await expect(report.getByTestId("ai-usage-summary")).toBeVisible();
  await expect(rowOf(report, "Claude Sonnet 5.5")).toHaveCount(1);
  await report.getByTestId("ai-usage-groupBy").getByRole("radio", { name: "By member" }).click();
  await expect(rowOf(report, SAM.name).getByTestId("ai-usage-cost")).toHaveText(COST);

  await context.close();
});

test("a member sees their own usage today against the limits and over the last 30 days by model", async ({
  browser,
}, info) => {
  const project = info.project.name;
  const w = widthOf(project);
  const { context, page } = await openAs(browser, SAM, project);
  await page.goto(`${BASE_URL}/settings/ai-chat`);
  const card = page.getByTestId("usage-card");
  await expect(card.getByRole("heading", { name: "Usage" })).toBeVisible();

  // Today: organization models against the daily limit, with tokens and what the organization pays.
  const org = card.getByTestId("usage-today-org");
  await expect(org.getByTestId("provider-metered")).toBeVisible();
  await expect(org.getByTestId("usage-today-org-answers")).toHaveText(/^[1-9]\d* of 200 answers$/u);
  await expect(org.getByRole("progressbar")).toBeVisible();
  await expect(org.getByTestId("usage-today-org-detail")).toHaveText(
    /^\d[\d.k]* in · \d[\d.k]* out · ~?\$\d[\d.]* billed to your organization$/u,
  );
  // Their own ChatGPT plan: counted, never billed.
  const plan = card.getByTestId("usage-today-plan");
  await expect(plan.getByTestId("usage-today-plan-answers")).toHaveText(/^[1-9]\d* answers?$/u);
  await expect(plan).toContainText("Counted against your plan, not billed to your organization");
  await expect(plan).not.toContainText("$");
  await expect(card).toContainText(/Resets at \d{1,2}:\d{2}/u);

  // Last 30 days, by model.
  const rows = card.getByTestId("usage-30d-row");
  await expect(rows.filter({ hasText: "Claude Sonnet 5.5" }).getByTestId("usage-30d-cost")).toHaveText(COST);
  await expect(rows.filter({ hasText: "GPT-6 Astra" }).getByTestId("usage-30d-cost")).toHaveText(
    "Not billed",
  );
  await expect(card.getByTestId("usage-30d-total")).toContainText("to your organization");

  await card.evaluate((el) => {
    const pane = el.closest(".overflow-y-auto");
    if (pane) pane.scrollTop = pane.scrollHeight;
  });
  await bothThemes(page, `settings-ai-chat-usage-${w}`);
  await context.close();
});
