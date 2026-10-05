import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { shot } from "../tests/env";
import { type Actor, apiAs, BASE_URL } from "./actors";
import type { FakeCellPlugin } from "./fake-cell-plugin";

/**
 * Helpers for the bot-tools specs (03.1-13: marketplace.spec.ts, mcp-servers.spec.ts). The fake model / MCP /
 * ClawHub server runs on loopback (scripts/e2e-isolated.sh and the CI e2e job); the API proxies its ClawHub
 * routes and the simulated cell probes its MCP route through `hostMap`.
 */

/** Base URL of infra/fake-model/server.mjs for this run ("" = not started: the specs skip). */
export const FAKE_URL = process.env.OCW_E2E_FAKE_URL ?? "";
/** Bearer the fake MCP requires (FAKE_MCP_TOKEN of the fake server). */
export const FAKE_MCP_TOKEN = process.env.OCW_E2E_FAKE_MCP_TOKEN ?? "e2e-mcp-token";
/** The host an admin registers (a compose-style service name the API's URL policy accepts). */
export const FAKE_MCP_HOST = "fake-mcp:4291";

export const NOTES = "@ocw-test/notes-plugin";
export const ECHO = "@ocw-test/echo-plugin";
export const SHELL = "@ocw-test/shell-plugin";
export const DUCKDUCKGO = "@openclaw/duckduckgo-plugin";

/** What the simulated executor reports as installed tools, per `package@version` or package. */
export const PLUGIN_TOOLS: Record<string, string[]> = {
  [`${NOTES}@1.0.0`]: ["notes_lookup"],
  [`${NOTES}@1.1.0`]: ["notes_lookup", "notes_search"],
  [ECHO]: ["ocw_echo"],
};

export function cellToken(): string {
  if (process.env.OCW_CELL_TOKEN) return process.env.OCW_CELL_TOKEN;
  const file = join(import.meta.dirname, "..", "..", ".env");
  const line = existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .find((l) => l.startsWith("OCW_CELL_TOKEN="))
    : undefined;
  return line?.slice("OCW_CELL_TOKEN=".length).trim() ?? "";
}

export async function bothThemes(page: Page, name: string) {
  // Toasts would cover the content under review.
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** A team bot with this name, recreated so it has no grants from an earlier run. */
export async function freshTeamBot(admin: APIRequestContext, name: string): Promise<string> {
  const listed = (await (await admin.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; name: string }>;
  };
  for (const a of listed.agents.filter((x) => x.name === name)) {
    expect((await admin.delete(`/api/v1/agents/${a.id}`)).ok()).toBe(true);
  }
  const res = await admin.post("/api/v1/agents", {
    data: {
      name,
      description: "Uses the team's tools.",
      instructions: "Answer briefly.",
      modelProvider: "mock",
      modelId: "mock-1",
    },
  });
  expect(res.ok(), "create team bot").toBe(true);
  return ((await res.json()) as { id: string }).id;
}

/** The actor's only personal bot, recreated, and its private chat. */
export async function freshPersonalBot(user: Actor, userId: string): Promise<{ id: string; dmId: string }> {
  const api = await apiAs(user);
  const listed = (await (await api.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; scope: string; ownerUserId: string | null }>;
  };
  for (const a of listed.agents.filter((x) => x.scope === "personal" && x.ownerUserId === userId)) {
    expect((await api.delete(`/api/v1/agents/${a.id}`)).ok()).toBe(true);
  }
  const res = await api.post("/api/v1/agents/personal", {
    data: { instructions: "Answer briefly.", modelProvider: "mock", modelId: "mock-1" },
  });
  expect(res.ok(), "create personal bot").toBe(true);
  const body = (await res.json()) as { agent: { id: string }; dmId: string };
  await api.dispose();
  return { id: body.agent.id, dmId: body.dmId };
}

/** Sends `text` in the open conversation and waits for the bot's reply containing every `expected` string. */
export async function ask(page: Page, text: string, ...expected: string[]) {
  const box = page.getByTestId("composer");
  await box.click();
  await box.fill(text);
  await box.press("Enter");
  let reply = page.locator('[data-testid="message"][data-author-kind="agent"]');
  for (const e of expected) reply = reply.filter({ hasText: e });
  await expect(reply.last()).toBeVisible({ timeout: 20_000 });
}

export async function openTeamBotSheet(page: Page, name: string) {
  await page.goto(`${BASE_URL}/bots`);
  const card = page.getByTestId("bot-card").filter({ hasText: name }).first();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name }).click();
  const sheet = page.getByTestId("bot-detail-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("tools-section")).toBeVisible();
  return sheet;
}

export async function clearMcpServers(admin: APIRequestContext) {
  const list = (await (await admin.get("/api/v1/mcp-servers")).json()) as { servers: Array<{ id: string }> };
  for (const s of list.servers) expect((await admin.delete(`/api/v1/mcp-servers/${s.id}`)).ok()).toBe(true);
}

type PluginRow = { id: string; packageName: string; status: string; version: string };

export async function listPlugins(admin: APIRequestContext): Promise<PluginRow[]> {
  const res = await admin.get("/api/v1/cell-plugins");
  expect(res.ok(), "list cell plugins").toBe(true);
  return ((await res.json()) as { plugins: PluginRow[] }).plugins;
}

/** Uninstalls every plugin of the org; the simulated cell (running) reports each removal. */
export async function clearPlugins(admin: APIRequestContext, cell: FakeCellPlugin) {
  for (const p of await listPlugins(admin)) {
    expect((await admin.delete(`/api/v1/cell-plugins/${p.id}`)).ok(), `uninstall ${p.packageName}`).toBe(
      true,
    );
  }
  await expect
    .poll(async () => (await listPlugins(admin)).length, { timeout: 20_000, message: `cell ${cell.lastSeq}` })
    .toBe(0);
}

/** Installs `packageName@version` through the API (review → approve) unless it is already installed. */
export async function ensurePluginInstalled(
  admin: APIRequestContext,
  packageName: string,
  version?: string,
): Promise<string> {
  const existing = (await listPlugins(admin)).find((p) => p.packageName === packageName);
  if (!existing) {
    const q = version ? `?version=${encodeURIComponent(version)}` : "";
    const detail = await admin.get(`/api/v1/marketplace/packages/${encodeURIComponent(packageName)}${q}`);
    expect(detail.ok(), `review ${packageName}`).toBe(true);
    const { review } = (await detail.json()) as {
      review: { version: string; reviewToken: string; risk: string };
    };
    const res = await admin.post("/api/v1/marketplace/installs", {
      data: {
        packageName,
        version: review.version,
        reviewToken: review.reviewToken,
        acknowledgeHighRisk: review.risk === "high",
        personalAllowed: false,
      },
    });
    expect(res.ok(), `approve ${packageName}`).toBe(true);
  }
  await expect
    .poll(async () => (await listPlugins(admin)).find((p) => p.packageName === packageName)?.status, {
      timeout: 20_000,
    })
    .toBe("installed");
  return ((await listPlugins(admin)).find((p) => p.packageName === packageName) as PluginRow).id;
}
