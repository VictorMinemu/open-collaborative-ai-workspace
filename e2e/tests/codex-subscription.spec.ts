import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { FakeCellPlugin } from "../support/fake-cell-plugin";
import { startFakeDeviceAuthServer } from "../support/fake-device-auth-server";
import { ADMIN, API_URL, shot } from "./env";

/**
 * ChatGPT subscription (Codex) in Settings › Models, with a FAKE OpenClaw cell (e2e/support/fake-cell-plugin)
 * and a FAKE OAuth device-authorization server (e2e/support/fake-device-auth-server): offline → connect →
 * code + URL + countdown → denied → retry → approved on the verification page → connected as <email> ·
 * plan → a one-click bot on a ChatGPT model goes ready and answers → disconnect. No real account, no
 * metered call. Review shots are taken in dark mode (codex-*.png).
 *
 * Needs no other cell connected (the fake one must own the sign-in): `docker stop ocw-demo-openclaw` first
 * when running against the demo stack.
 */

const ACCOUNT = { email: "owner@autofylabs.test", planType: "pro" };

function cellToken(): string {
  if (process.env.OCW_CELL_TOKEN) return process.env.OCW_CELL_TOKEN;
  const file = join(import.meta.dirname, "..", "..", ".env");
  const line = existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .find((l) => l.startsWith("OCW_CELL_TOKEN="))
    : undefined;
  return line?.slice("OCW_CELL_TOKEN=".length).trim() ?? "";
}

async function login(page: Page, next: string) {
  await page.goto(next);
  await expect(page.getByTestId("login-form")).toBeVisible();
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
  await page
    .getByTestId("login-form")
    .getByRole("button", { name: /sign in|log in/i })
    .click();
  await expect(page.getByTestId("app-shell")).toBeVisible();
}

/** Types the code on the (fake) verification page, like the owner does in their browser. */
async function decide(verify: Page, url: string, code: string, decision: "approve" | "deny") {
  await verify.goto(url);
  await verify.getByTestId("fake-device-code").fill(code);
  await verify.getByTestId(`fake-device-${decision}`).click();
  await expect(verify.getByText(decision === "approve" ? "Approved" : "Denied")).toBeVisible();
}

test("ChatGPT subscription: device-code sign-in in the cell → bots on ChatGPT models", async ({
  page,
  context,
}, info) => {
  const tag = info.project.name === "mobile" ? "390" : "1440";
  const token = cellToken();
  test.skip(!token, "OCW_CELL_TOKEN is not configured");
  const device = await startFakeDeviceAuthServer(ACCOUNT);
  const plugin = new FakeCellPlugin({
    apiUrl: API_URL,
    token,
    autoAck: true,
    autoReply: true,
    deviceAuth: { serverUrl: device.url, pollMs: 150 },
  });
  const verify = await context.newPage();
  await page.emulateMedia({ colorScheme: "dark" });

  try {
    await login(page, "/settings/models");
    const cell = (await (await page.request.get(`${API_URL}/api/v1/agent-cell`)).json()) as {
      connected: boolean;
    };
    test.skip(
      cell.connected,
      "another OpenClaw cell is connected; stop it for this spec (docker stop ocw-demo-openclaw)",
    );

    // Re-runnable: drop any connection / flow left by a previous run.
    await page.request.delete(`${API_URL}/api/v1/model-providers/openai-codex/auth`);
    await page.request.delete(`${API_URL}/api/v1/model-providers/openai-codex`);
    await page.reload();

    // ---- Offline cell: the card explains why Connect is disabled
    const card = page.getByTestId("provider-openai-codex");
    await expect(card).toBeVisible();
    await expect(card.getByText("Not connected")).toBeVisible();
    await expect(card.getByText("Your bot runtime is offline.")).toBeVisible();
    await expect(page.getByTestId("connect-openai-codex")).toBeDisabled();
    await shot(page, `codex-offline-${tag}`);

    // ---- The cell comes online: live, no reload
    await plugin.start();
    await expect(page.getByTestId("connect-openai-codex")).toBeEnabled({ timeout: 15_000 });
    await expect(card.getByText("Your bot runtime is offline.")).toHaveCount(0);
    await shot(page, `codex-idle-${tag}`);

    // ---- Connect: the cell runs the device-code flow; URL + code + countdown appear live
    await page.getByTestId("connect-openai-codex").click();
    await expect(page.getByTestId("codex-auth-pending")).toBeVisible({ timeout: 15_000 });
    const url = (await page.getByTestId("codex-verification-url").getAttribute("href")) ?? "";
    expect(url).toBe(`${device.url}/codex/device`);
    const code1 = (await page.getByTestId("codex-user-code").textContent())?.trim() ?? "";
    expect(code1).toMatch(/^[0-9A-F]{4}-[0-9A-F]{6}$/);
    await expect(page.getByTestId("codex-countdown")).toContainText(/Expires in 1[45]:\d\d/);
    await expect(card).toHaveAttribute("data-auth-state", "pending");
    await shot(page, `codex-pending-${tag}`);

    // ---- Denied in the browser → clear error, retry available
    await decide(verify, url, code1, "deny");
    const error = page.getByTestId("codex-auth-error");
    await expect(error).toHaveAttribute("data-code", "denied", { timeout: 15_000 });
    await expect(error).toContainText("denied");
    await expect(page.getByTestId("codex-user-code")).toHaveCount(0);
    await shot(page, `codex-error-${tag}`);

    // ---- Try again → approved → connected as <email> · plan
    await page.getByTestId("retry-codex-auth").click();
    await expect(page.getByTestId("codex-auth-pending")).toBeVisible({ timeout: 15_000 });
    const code2 = (await page.getByTestId("codex-user-code").textContent())?.trim() ?? "";
    expect(code2).not.toBe(code1);
    await decide(verify, url, code2, "approve");
    await expect(page.getByTestId("codex-account")).toContainText(ACCOUNT.email, { timeout: 15_000 });
    await expect(card.getByText("ChatGPT Pro")).toBeVisible();
    await expect(card.getByText("Connected", { exact: true })).toBeVisible();
    await expect(page.getByTestId("allow-gpt-6-astra")).toBeChecked();
    await shot(page, `codex-connected-${tag}`);
    expect(plugin.credentials.get("openai-codex")).toEqual(ACCOUNT);

    // ---- One-click bot on a ChatGPT model
    const name = tag === "390" ? "Juno" : "Orion";
    const existing = (await (await page.request.get(`${API_URL}/api/v1/agents`)).json()) as {
      agents: Array<{ id: string; name: string }>;
    };
    for (const a of existing.agents.filter((x) => x.name === name)) {
      await page.request.delete(`${API_URL}/api/v1/agents/${a.id}`);
    }
    await page.goto("/bots");
    await page.getByTestId("new-bot").click();
    const sheet = page.getByTestId("new-bot-sheet");
    await sheet.getByTestId("preset-product-manager").click();
    await sheet.getByTestId("bot-name").fill(name);
    await sheet.getByTestId("bot-model").click();
    const option = page.getByRole("option", { name: /GPT-6 Astra.*ChatGPT subscription/ });
    await expect(option).toBeVisible();
    await shot(page, `codex-bot-model-${tag}`);
    await option.click();
    await sheet.getByTestId("create-bot").click();
    await expect(sheet).toBeHidden();
    const botCard = page.getByTestId("bot-card").filter({ hasText: name }).first();
    await expect(botCard).toContainText("GPT-6 Astra");
    await expect(botCard.getByTestId("bot-status"))
      .toHaveAttribute("data-status", "ready", { timeout: 15_000 })
      .catch(async (error) => {
        const cellNow = await plugin.fetchCell().catch((e) => ({ error: String(e) }));
        console.error("codex e2e debug", JSON.stringify({ plugin: plugin.debugState(), cell: cellNow }));
        throw error;
      });
    const snapshot = await plugin.fetchCell();
    const agent = snapshot.agents.find((a) => a.displayName === name);
    expect(agent?.modelRef).toBe("openai-codex/gpt-6-astra");
    expect(snapshot.subscriptions?.map((s) => s.id)).toEqual(["openai-codex"]);

    // ---- Mention → the (fake) cell answers in the thread
    const hasChat = (await page.request.get(`${API_URL}/api/v1/channels`)).status() === 200;
    if (hasChat && agent) {
      const channel = (await (
        await page.request.post(`${API_URL}/api/v1/channels`, {
          data: { name: `codex-e2e-${tag}-${Date.now().toString(36)}` },
        })
      ).json()) as { id: string };
      await page.request.post(`${API_URL}/api/v1/channels/${channel.id}/members`, {
        data: { kind: "agent", id: agent.id },
      });
      const posted = await page.request.post(`${API_URL}/api/v1/conversations/${channel.id}/messages`, {
        data: {
          body: `@${agent.handle} what should we ship first?`,
          mentions: [{ kind: "agent", id: agent.id }],
        },
      });
      expect(posted.ok()).toBe(true);
      await plugin.waitUntil(() => plugin.replies.some((r) => r.mention.agent.id === agent.id), 15_000);
    }

    // ---- Disconnect: the cell drops its sign-in; bots lose the ChatGPT models
    await page.goto("/settings/models");
    await page.getByTestId("disconnect-openai-codex").click();
    await page.getByTestId("disconnect-openai-codex").click(); // confirm
    await expect(card.getByText("Not connected")).toBeVisible({ timeout: 15_000 });
    await plugin.waitUntil(() => plugin.revoked.includes("openai-codex"), 15_000);
    expect(plugin.credentials.has("openai-codex")).toBe(false);
  } finally {
    await verify.close();
    await plugin.stop();
    await device.close();
  }
});
