import { type APIRequestContext, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { ADMIN, API_URL } from "./env";

/**
 * Consulting other bots (07.7-08; A2A-02, D-04, P-03, P-04, C-03) against the real API (07.7-03's routes) on the
 * isolated stack. An admin turns "Bots may consult each other" on and off in Settings › Bot policy (off by default, the
 * state comes back from the API on reload). The spec leaves the organization switch off, as it found it.
 */

test.describe.configure({ mode: "serial" });

let admin: APIRequestContext;
const open: BrowserContext[] = [];

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
