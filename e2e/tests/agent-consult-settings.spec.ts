import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { ADMIN, API_URL } from "./env";

/**
 * Consulting other bots (07.7-08; A2A-02, D-04, P-03, P-04, C-03) against the real API (07.7-03's routes) on the
 * isolated stack. An admin turns "Bots may consult each other" on and off in Settings › Bot policy (off by default, the
 * state comes back from the API on reload), and sets each team bot's consult rules in its sheet: who it can ask, whom it
 * must never ask and whether other bots can ask it, with the API's "Right now" line after every change. "Only these
 * bots" is disabled with its reason while the switch is on. A standard member and every personal bot's sheet never show
 * the section. The spec leaves the organization switch off and deletes the bots it created.
 */

test.describe.configure({ mode: "serial" });

let admin: APIRequestContext;
const open: BrowserContext[] = [];
const created: string[] = [];

interface Bot {
  id: string;
  name: string;
  username: string;
}

async function setSwitch(enabled: boolean): Promise<void> {
  const res = await admin.put("/api/v1/agent-messaging", { data: { enabled } });
  expect(res.ok(), `PUT /agent-messaging ${enabled}: ${res.status()}`).toBe(true);
}

test.beforeAll(async () => {
  admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  await setSwitch(false);
});

test.afterAll(async () => {
  for (const c of open.splice(0)) await c.close();
  if (!admin) return;
  await setSwitch(false);
  for (const id of created.splice(0)) await admin.delete(`/api/v1/agents/${id}`);
  await admin.dispose();
});

async function signIn(browser: Parameters<typeof openAs>[0], project: string, who: Actor = ADMIN) {
  const s = await openAs(browser, who, project);
  open.push(s.context);
  return s.page;
}

async function openBotPolicy(page: Page) {
  await page.goto(`${BASE_URL}/settings/bot-policy`);
  await expect(page.getByTestId("agent-consult-settings")).toBeVisible({ timeout: 15_000 });
}

/** A fresh organization bot named `name` (an older one of the same name is deleted first). */
async function freshTeamBot(name: string): Promise<Bot> {
  const listed = (await (await admin.get("/api/v1/agents")).json()) as { agents: Bot[] };
  for (const a of listed.agents.filter((x) => x.name === name)) {
    expect((await admin.delete(`/api/v1/agents/${a.id}`)).ok(), `delete ${name}`).toBe(true);
  }
  const res = await admin.post("/api/v1/agents", {
    data: {
      name,
      description: "Answers questions for the team.",
      instructions: "Answer briefly.",
      modelProvider: "mock",
      modelId: "mock-1",
    },
  });
  expect(res.ok(), `create team bot ${name}: ${res.status()}`).toBe(true);
  const bot = (await res.json()) as Bot;
  created.push(bot.id);
  return bot;
}

interface MessagingView {
  outbound: { mode: string; allow: Array<{ id: string }>; deny: Array<{ id: string }> };
  inbound: { consultable: boolean };
  effective: { kind: string; targets: Array<{ id: string; handle: string }> };
}

async function viewOf(bot: Bot): Promise<MessagingView> {
  const res = await admin.get(`/api/v1/agents/${bot.id}/messaging`);
  expect(res.ok(), `GET /agents/${bot.name}/messaging: ${res.status()}`).toBe(true);
  return (await res.json()) as MessagingView;
}

/** Bots page → the bot's card → its sheet. */
async function openBotSheet(page: Page, name: string) {
  await page.goto(`${BASE_URL}/bots`);
  const card = page.getByTestId("bot-card").filter({ hasText: name }).first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole("button", { name }).first().click();
  const sheet = page.getByTestId("bot-detail-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name, exact: true })).toBeVisible();
  return sheet;
}

/** Picks the option named `label` in the Select behind `trigger`. */
async function pick(page: Page, trigger: Locator, label: string) {
  await trigger.click();
  await page.getByRole("option", { name: label, exact: true }).click();
}

/** `GET /agent-messaging` through the page's own session (the browser's cookie, the web origin). */
async function switchSeenByPage(page: Page): Promise<boolean> {
  return page.evaluate(async (api) => {
    const res = await fetch(`${api}/api/v1/agent-messaging`, { credentials: "include" });
    if (!res.ok) throw new Error(`GET /agent-messaging: ${res.status}`);
    return ((await res.json()) as { enabled: boolean }).enabled;
  }, API_URL);
}

// ---------------------------------------------------------------- Task 1: the organization switch (tracer)

test("an admin turns consulting on and off in Settings › Bot policy; it starts off and survives a reload", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "the tracer runs at 1440; 390 is proven below");
  const page = await signIn(browser, info.project.name);
  await openBotPolicy(page);

  // Between the policy form and the personal bots table.
  const order = await page
    .locator(
      '[data-testid="bot-policy-settings"], [data-testid="agent-consult-settings"], [data-testid="personal-bots-table"]',
    )
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(order).toEqual(["bot-policy-settings", "agent-consult-settings", "personal-bots-table"]);

  const section = page.getByTestId("agent-consult-settings");
  await expect(section.getByRole("heading", { level: 2, name: "Consulting other bots" })).toBeVisible();
  await expect(
    section.getByText(
      "Let a bot ask another bot in the same channel for help. Every question and answer shows in the thread.",
    ),
  ).toBeVisible();
  const toggle = page.getByTestId("agent-consult-switch");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle).toHaveAccessibleName("Bots may consult each other");
  await expect(toggle).toHaveAccessibleDescription(/^Off by default\. Up to 2 levels deep/u);

  // On → toast; the API holds it across a reload.
  await toggle.click();
  await expect(page.getByText("Bots can now consult each other")).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.reload();
  await expect(page.getByTestId("agent-consult-switch")).toHaveAttribute("aria-checked", "true");
  expect(await switchSeenByPage(page)).toBe(true);

  // Off again → off after a reload.
  await page.getByTestId("agent-consult-switch").click();
  await expect(page.getByText("Bots can no longer consult each other")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("agent-consult-switch")).toHaveAttribute("aria-checked", "false");
  expect(await switchSeenByPage(page)).toBe(false);
});

// ---------------------------------------------------------------- Task 2: per-bot consult rules in the bot sheet

test("an admin sets a team bot's consult rules in its sheet and always sees what is true right now", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "the rules flow runs at 1440; 390 is proven below");
  test.setTimeout(120_000);
  const archie = await freshTeamBot("Archie");
  const bea = await freshTeamBot("Bea");
  const carl = await freshTeamBot("Carl");
  const page = await signIn(browser, info.project.name);

  let sheet = await openBotSheet(page, "Archie");
  let section = sheet.getByTestId("agent-messaging-section");
  await expect(sheet.getByRole("heading", { name: "Consulting other bots" })).toBeVisible();
  // Right after Capabilities.
  const headings = await sheet.locator("h3").allTextContents();
  expect(headings.indexOf("Consulting other bots")).toBe(headings.indexOf("Capabilities") + 1);
  const line = section.getByTestId("agent-messaging-effective-line");
  await expect(line).toHaveText("Archie can't ask other bots.");
  await expect(section.getByText("People also need to see the bot being asked.")).toBeVisible();
  const mode = section.getByTestId("agent-messaging-mode");
  await expect(mode).toHaveText("Organization default (Off)");
  await expect(section.getByTestId("agent-messaging-allow")).toHaveCount(0);
  await expect(section.getByTestId("agent-messaging-deny-empty")).toHaveText("Nobody excluded.");

  // Only these bots: nothing is saved until a bot is picked; then Right now names it.
  await pick(page, mode, "Only these bots");
  await expect(section.getByTestId("agent-messaging-allow-empty")).toHaveText("Pick at least one bot.");
  expect((await viewOf(archie)).outbound.mode).toBe("default");
  await pick(page, section.getByTestId("agent-messaging-add-allow"), `Bea · @${bea.username}`);
  await expect(line).toHaveText(`Archie can ask @${bea.username}.`);
  await expect(section.getByRole("list", { name: "Only these bots" }).getByRole("listitem")).toHaveText([
    `@${bea.username}`,
  ]);
  // The last bot of the list stays until "Can ask" changes (the API needs one).
  await expect(section.getByRole("button", { name: `Remove @${bea.username}` })).toBeDisabled();

  // Any bot, with Carl on Never ask: the line names other bots, never Carl.
  await pick(page, mode, "Any bot");
  await expect(section.getByTestId("agent-messaging-allow")).toHaveCount(0);
  await pick(page, section.getByTestId("agent-messaging-add-deny"), `Carl · @${carl.username}`);
  await expect(section.getByRole("list", { name: "Never ask" }).getByRole("listitem")).toHaveText([
    `@${carl.username}`,
  ]);
  await expect(line).not.toContainText(`@${carl.username}`);
  await expect(line).toHaveText(/^Archie can ask @/u);
  const afterAny = await viewOf(archie);
  expect(afterAny.outbound.mode).toBe("any");
  expect(afterAny.effective.kind).toBe("some");
  const targetIds = afterAny.effective.targets.map((t) => t.id);
  expect(targetIds).toContain(bea.id);
  expect(targetIds).not.toContain(carl.id);
  expect(targetIds).not.toContain(archie.id);

  // Other bots can ask Archie: off.
  const inbound = section.getByTestId("agent-messaging-inbound-switch");
  await expect(inbound).toHaveAccessibleName("Other bots can ask Archie");
  await expect(inbound).toHaveAttribute("aria-checked", "true");
  await inbound.click();
  await expect(inbound).toHaveAttribute("aria-checked", "false");
  await expect.poll(async () => (await viewOf(archie)).inbound.consultable).toBe(false);

  // A reload shows the same state.
  await page.reload();
  sheet = await openBotSheet(page, "Archie");
  section = sheet.getByTestId("agent-messaging-section");
  await expect(section.getByTestId("agent-messaging-mode")).toHaveText("Any bot");
  await expect(section.getByRole("list", { name: "Never ask" }).getByRole("listitem")).toHaveText([
    `@${carl.username}`,
  ]);
  await expect(section.getByTestId("agent-messaging-inbound-switch")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(section.getByTestId("agent-messaging-effective-line")).not.toContainText(`@${carl.username}`);

  // The organization switch on: "Only these bots" can't narrow it, and says why.
  await openBotPolicy(page);
  await page.getByTestId("agent-consult-switch").click();
  await expect(page.getByTestId("agent-consult-switch")).toHaveAttribute("aria-checked", "true");
  sheet = await openBotSheet(page, "Archie");
  section = sheet.getByTestId("agent-messaging-section");
  const reason = section.getByTestId("agent-messaging-only-reason");
  await expect(reason).toHaveText(
    "Every bot may ask any bot in this organization, so a list can't narrow it. Use “Never ask” instead.",
  );
  await expect(section.getByTestId("agent-messaging-mode")).toHaveAccessibleDescription(
    await reason.innerText(),
  );
  await section.getByTestId("agent-messaging-mode").click();
  await expect(page.getByRole("option", { name: "Organization default (On)" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Only these bots" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.keyboard.press("Escape");
  await setSwitch(false);
});

test("a standard member never sees consult rules, and no personal bot's sheet shows them", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "gating is viewport-independent");
  test.setTimeout(90_000);
  await freshTeamBot("Archie");
  // The admin's own personal bot: its sheet has no consult section (personal bots are out of v1).
  const res = await admin.post("/api/v1/agents/personal", {
    data: { instructions: "Answer briefly.", modelProvider: "mock", modelId: "mock-1" },
  });
  expect(res.ok(), `create the admin's personal bot: ${res.status()}`).toBe(true);
  const personal = ((await res.json()) as { agent: Bot }).agent;
  created.push(personal.id);

  const page = await signIn(browser, info.project.name);
  const own = await openBotSheet(page, personal.name);
  await expect(own.getByRole("heading", { name: "Capabilities" })).toBeVisible();
  await expect(own.getByTestId("agent-messaging-section")).toHaveCount(0);
  await expect(own.getByText("Consulting other bots")).toHaveCount(0);

  const sam = await signIn(browser, info.project.name, SAM);
  const sheet = await openBotSheet(sam, "Archie");
  await expect(sheet.getByTestId("agent-messaging-section")).toHaveCount(0);
  await expect(sheet.getByText("Consulting other bots")).toHaveCount(0);
  // Settings › Bot policy has no switch for Sam either.
  await sam.goto(`${BASE_URL}/settings/bot-policy`);
  await expect(sam.getByText("Only workspace admins can manage the bot policy.")).toBeVisible();
  await expect(sam.getByTestId("agent-consult-settings")).toHaveCount(0);
});
