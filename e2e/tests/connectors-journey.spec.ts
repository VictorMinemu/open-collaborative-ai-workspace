import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { apiAs, BASE_URL, createChannel, ensureMember, openAs, SAM, userIdOf } from "../support/actors";
import { FAKE_MCP_HOST, FAKE_URL } from "../support/bot-tools";
import { cellToken } from "../support/cell-token";
import { FakeCellPlugin, type MentionPayload } from "../support/fake-cell-plugin";
import { asSuperuser } from "../support/superuser";
import { ADMIN, API_URL, shot } from "./env";

/**
 * Phase 07.4 end to end (07.4-14; SC1 … SC3, CONN-01 … CONN-05; UI-SPEC § 2, § 3, § 5, R7, R8). One shared team bot,
 * Relay, answers through the simulated cell (`FakeCellPlugin`, which calls the Agent Channel connector and keychain
 * routes exactly like apps/openclaw-channel). No model and no real provider: the connector is the fake OAuth MCP server
 * (`infra/fake-model/fake-mcp-oauth.mjs`), registered as http://fake-mcp:4291/mcp-oauth/mcp, the name the API reaches
 * through its egress guard (`OCW_EGRESS_TEST_HOSTS`, scripts/e2e-isolated.sh) and the browser through Chromium's host
 * resolver rules, so both sides see one issuer.
 *
 * 1. The connect card: Víctor asks Relay in their DM, gets the "Connect your Pipeline CRM account" card, connects at
 *    the provider, comes back with Back to chat, asks again and Relay answers with HIS subject. Sam asks the same bot:
 *    his own card, never Víctor's account; once connected, his own subject.
 * 2. A shared conversation: in a private #ops the member-account tool is withheld and Relay's reply links to "Allow
 *    Pipeline CRM in #ops"; the dialog says who reads results, the next call works, and after Revoke it is refused.
 * 3. The keychain: Víctor's personal key is used by handle from his personal bot's DM; the fake receives the key, the
 *    bot and the page never see it, Keychain shows "last used just now" and the audit row carries no value.
 */

test.use({ launchOptions: { args: ["--host-resolver-rules=MAP fake-mcp 127.0.0.1"] } });
test.describe.configure({ mode: "serial" });

const FAKE_HOST = FAKE_MCP_HOST;
const OAUTH_MCP_URL = `http://${FAKE_HOST}/mcp-oauth/mcp`;
const ISSUER = `http://${FAKE_HOST}/mcp-oauth`;
/** The fake's pre-registered public client (redirect http://127.0.0.1:4290/api/v1/connectors/oauth/callback). */
const CLIENT_ID = "ocw-e2e";
const CONNECTOR = "Pipeline CRM";
const BOT = "Relay";
/** The bearer the fake's `/kc/whoami` accepts (infra/fake-model/fake-mcp-oauth.mjs DEFAULT_KC_TOKEN). */
const KC_TOKEN = "fake-kc-token";
const SUBJECT = /"subject":"(sub_[A-Za-z0-9_-]+)"/u;

let admin: APIRequestContext;
let plugin: FakeCellPlugin;
let relayId = "";
let serverId = "";
let safeName = "";
let samId = "";
/** Víctor's personal bot and the handle of his key (test 3). */
let personalBotId = "";
let keyHandle = "";
/** Víctor's subject at the fake provider (test 1), reused in test 2. */
let victorSubject = "";

async function bothThemes(page: Page, name: string) {
  await page.mouse.move(0, 0);
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** Toasts fade out on their own; screenshots wait for them so nothing covers the screen under review. */
async function noToasts(page: Page) {
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
}

/** The team bot Relay on the never-metered mock model (created once; both projects share it). */
async function ensureRelay(api: APIRequestContext): Promise<string> {
  const listed = (await (await api.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; name: string }>;
  };
  const found = listed.agents.find((a) => a.name === BOT);
  if (found) return found.id;
  const res = await api.post("/api/v1/agents", {
    data: {
      name: BOT,
      username: "relay",
      description: "Looks things up in the pipeline.",
      instructions: "You are Relay.",
      modelProvider: "mock",
      modelId: "mock-1",
    },
  });
  expect(res.ok(), `create Relay: ${res.status()}`).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

/**
 * A fresh `per_member_oauth` connector on the fake with its pre-registered client (every member starts disconnected,
 * in each project), its `whoami` in the catalog a first member's probe would fill, granted to Relay.
 */
async function freshConnector(api: APIRequestContext): Promise<void> {
  const list = (await (await api.get("/api/v1/mcp-servers")).json()) as {
    servers: Array<{ id: string; name: string }>;
  };
  for (const s of list.servers.filter((x) => x.name === CONNECTOR)) {
    expect((await api.delete(`/api/v1/mcp-servers/${s.id}?clearConnections=true`)).ok()).toBe(true);
  }
  const res = await api.post("/api/v1/mcp-servers", {
    data: {
      name: CONNECTOR,
      transport: "streamable-http",
      url: OAUTH_MCP_URL,
      authMode: "per_member_oauth",
      oauthClient: { issuer: ISSUER, clientId: CLIENT_ID },
    },
  });
  expect(res.ok(), `create ${CONNECTOR}: ${await res.text()}`).toBe(true);
  const server = (await res.json()) as { id: string; safeName: string };
  serverId = server.id;
  safeName = server.safeName;
  await asSuperuser(
    `insert into app.mcp_server_tools (organization_id, server_id, name, openclaw_name, read_only, description)
     select organization_id, id, 'whoami', $2, true, 'Who you are in the CRM' from app.mcp_servers where id = $1`,
    [serverId, `${safeName}__whoami`],
  );
  await asSuperuser("update app.mcp_servers set status = 'ready' where id = $1", [serverId]);
  const granted = await api.patch(`/api/v1/agents/${relayId}/capabilities`, {
    data: { tools: [{ sourceKind: "mcp", sourceId: serverId, tool: `${safeName}__whoami` }] },
  });
  expect(granted.ok(), `grant whoami to Relay: ${granted.status()}`).toBe(true);
}

/**
 * The persona's decisions, as the real model would make them: Relay calls the CRM's `whoami` when asked about the CRM;
 * Víctor's personal bot calls the fake's `/kc/whoami` with his key's handle when asked about the key.
 */
function toolCallsFor(m: MentionPayload): Array<{ tool: string; args: Record<string, unknown> }> {
  if (m.agent.id === relayId && /crm/iu.test(m.message.text)) {
    return [{ tool: "ocw_connector_call", args: { connector: safeName, tool: "whoami", arguments: {} } }];
  }
  if (personalBotId && m.agent.id === personalBotId && /key/iu.test(m.message.text)) {
    return [
      {
        tool: "ocw_http_request",
        args: { handle: keyHandle, method: "GET", url: `http://${FAKE_HOST}/kc/whoami` },
      },
    ];
  }
  return [];
}

/** Sends `text` from the open DM's composer and returns the bot's reply to it (the fake cell's next reply). */
async function askInBrowser(page: Page, text: string): Promise<Locator> {
  const before = plugin.replies.length;
  const box = page.getByTestId("composer");
  await box.click();
  await box.fill(text);
  await box.press("Enter");
  await plugin.waitUntil(() => plugin.replies.length > before, 20_000);
  const reply = page.locator(
    `[data-testid="message"][data-message-id="${plugin.replies.at(-1)?.messageId ?? ""}"]`,
  );
  await expect(reply).toBeVisible({ timeout: 15_000 });
  return reply;
}

/** The newest connect card in the open conversation for this connector. */
function connectCard(page: Page): Locator {
  return page
    .getByTestId("agent-card")
    .filter({ hasText: `Connect your ${CONNECTOR} account` })
    .last();
}

/** Card → Settings › Connections (row highlighted) → the fake provider → back Connected → Back to chat. */
async function connectFromCard(page: Page, dmId: string) {
  const card = connectCard(page);
  await card.getByTestId("agent-card-open").click();
  await expect(page).toHaveURL(new RegExp(`/settings/connections\\?connector=${serverId}&return=`));
  const row = page.getByTestId(`connector-row-${serverId}`);
  await expect(row).toHaveAttribute("data-highlighted", "true");
  await expect(row).toHaveAttribute("data-status", "not_connected");
  await page.getByTestId(`connector-connect-${serverId}`).click();
  await expect(page.getByTestId("connections-toast-text")).toHaveText(
    `${CONNECTOR} connected. Ask your bot again.`,
    { timeout: 30_000 },
  );
  await expect(row).toHaveAttribute("data-status", "connected");
  await page.getByTestId("connections-back-to-chat").click();
  await expect(page).toHaveURL(new RegExp(`/chat/dm/${dmId}`));
}

async function dmWith(api: APIRequestContext, agentId: string): Promise<string> {
  const res = await api.post("/api/v1/dms", { data: { participants: [{ kind: "agent", id: agentId }] } });
  expect(res.ok(), `DM with ${agentId}: ${res.status()}`).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

test.beforeAll(async () => {
  const token = cellToken();
  test.skip(!token, "OCW_CELL_TOKEN is not configured");
  expect(FAKE_URL, "OCW_E2E_FAKE_URL (the fake OAuth MCP server) is set by scripts/e2e-isolated.sh").not.toBe(
    "",
  );
  admin = await apiAs(ADMIN);
  samId = await ensureMember(admin, SAM, "developer");
  relayId = await ensureRelay(admin);
  await freshConnector(admin);
  plugin = new FakeCellPlugin({ apiUrl: API_URL, token, autoAck: true, autoReply: true, toolCallsFor });
  await plugin.start();
});

test.afterAll(async () => {
  await plugin?.stop();
  // Leave no member connection behind: other specs clear MCP servers without disconnecting members.
  if (admin && serverId) await admin.delete(`/api/v1/mcp-servers/${serverId}?clearConnections=true`);
  await admin?.dispose();
});

test("the connect card leads each member to their own account and back; the same bot then answers with it", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const w = info.project.name === "mobile" ? "390" : "1440";
  const victorDm = await dmWith(admin, relayId);

  const me = await openAs(browser, ADMIN, info.project.name);
  try {
    const page = me.page;
    await page.goto(`${BASE_URL}/chat/dm/${victorDm}`);
    // ---- not connected: the API refuses the call and posts the platform's card in this DM (CONN-04)
    const refused = await askInBrowser(page, "What does the CRM say about me?");
    await expect(refused).toContainText("Tool ocw_connector_call: refused (not_connected)");
    const card = connectCard(page);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toHaveAttribute("data-kind", "generic");
    await expect(card.getByRole("status", { name: "Status: Info" })).toBeVisible();
    await expect(card.getByTestId("agent-card-fields")).toContainText("How it works");
    await expect(card.getByTestId("agent-card-open")).toContainText("Connect");
    await card.scrollIntoViewIfNeeded();
    await bothThemes(page, `journey-connect-card-${w}`);
    await expectNoSeriousA11y(page, '[data-testid="agent-card"]');

    // ---- Connect → the provider → back (R8) → the same DM
    await connectFromCard(page, victorDm);

    // ---- asked again, the bot answers with Víctor's own account (CONN-03)
    const answered = await askInBrowser(page, "And now, who am I in the CRM?");
    await expect(answered).toContainText("Tool ocw_connector_call:");
    victorSubject = SUBJECT.exec((await answered.textContent()) ?? "")?.[1] ?? "";
    expect(victorSubject, "Víctor's subject").toMatch(/^sub_/);
    await page.goto(`${BASE_URL}/settings/connections`);
    await expect(page.getByTestId(`connector-meta-${serverId}`)).toContainText(
      `as ${victorSubject}@fake-mcp.test`,
    );
    await expect(page.getByTestId(`connector-meta-${serverId}`)).toContainText("last used just now");
  } finally {
    await me.context.close();
  }

  // ---- Sam asks the same bot: his own card, never Víctor's account; then his own subject
  const samApi = await apiAs(SAM);
  const samDm = await dmWith(samApi, relayId);
  await samApi.dispose();
  const sam = await openAs(browser, SAM, info.project.name);
  try {
    const page = sam.page;
    await page.goto(`${BASE_URL}/chat/dm/${samDm}`);
    const refused = await askInBrowser(page, "Who am I in the CRM?");
    await expect(refused).toContainText("Tool ocw_connector_call: refused (not_connected)");
    await expect(refused).not.toContainText(victorSubject);
    await expect(connectCard(page)).toBeVisible({ timeout: 10_000 });
    await connectFromCard(page, samDm);
    const answered = await askInBrowser(page, "And now, who am I in the CRM?");
    const samSubject = SUBJECT.exec((await answered.textContent()) ?? "")?.[1] ?? "";
    expect(samSubject, "Sam's subject").toMatch(/^sub_/);
    expect(samSubject).not.toBe(victorSubject);
  } finally {
    await sam.context.close();
  }
});

test("a shared channel: withheld with an allow link, allowed for its readers, refused again after Revoke", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const mobile = info.project.name === "mobile";
  const w = mobile ? "390" : "1440";
  expect(victorSubject, "the DM journey connected Víctor").not.toBe("");
  const ops = `ops-${w}-${Date.now().toString(36)}`;
  const opsId = await createChannel(admin, ops, "private");
  for (const member of [
    { kind: "user", id: samId },
    { kind: "agent", id: relayId },
  ]) {
    const added = await admin.post(`/api/v1/channels/${opsId}/members`, { data: member });
    expect(added.ok(), `add ${member.kind} to #${ops}`).toBe(true);
  }
  /** Víctor mentions Relay in #ops; returns the bot's reply (in the thread of his message). */
  const mention = async (text: string) => {
    const before = plugin.replies.length;
    const posted = await admin.post(`/api/v1/conversations/${opsId}/messages`, {
      data: { body: `@relay ${text}`, mentions: [{ kind: "agent", id: relayId }] },
    });
    expect(posted.ok(), `mention Relay: ${posted.status()}`).toBe(true);
    await plugin.waitUntil(() => plugin.replies.length > before, 20_000);
    return {
      root: ((await posted.json()) as { id: string }).id,
      reply: plugin.replies.at(-1)?.messageId ?? "",
    };
  };

  const me = await openAs(browser, ADMIN, info.project.name);
  try {
    const page = me.page;
    // ---- withheld here (D-03): the reply explains it and links to the share page (R7); no call was made
    const first = await mention("what does the CRM say about me?");
    const ev = plugin.replies.at(-1)?.mention;
    expect(ev?.turn?.withheld).toEqual(
      expect.arrayContaining([
        {
          tool: `${safeName}__whoami`,
          reason: "member_account",
          resource: { kind: "connector", id: serverId, name: CONNECTOR },
        },
      ]),
    );
    await page.goto(`${BASE_URL}/chat/${opsId}?thread=${first.root}&m=${first.reply}`);
    const reply = page
      .getByTestId("thread-panel")
      .locator(`[data-testid="message"][data-message-id="${first.reply}"]`);
    await expect(reply).toBeVisible({ timeout: 15_000 });
    await expect(reply).toContainText("Tool ocw_connector_call: refused (member_account)");
    const allow = reply.getByRole("link", { name: `Allow ${CONNECTOR} in #${ops}` });
    await expect(allow).toBeVisible();
    await reply.scrollIntoViewIfNeeded();
    await bothThemes(page, `journey-share-${w}`);

    // ---- the link opens the shared-use dialog (chat Markdown opens links in a new tab, ADR-0016): who reads results
    // here, before Allow
    expect(await allow.getAttribute("href")).toBe(
      `/settings/connections?share=${opsId}&connector=${serverId}`,
    );
    const [settings] = await Promise.all([page.context().waitForEvent("page"), allow.click()]);
    await expect(settings).toHaveURL(/\/settings\/connections\?share=/);
    const dialog = settings.getByTestId("shared-use-dialog");
    await expect(dialog).toContainText(`Use your ${CONNECTOR} account in #${ops}?`);
    await expect(dialog.getByTestId("shared-use-readers")).toHaveText("2 people can read results here");
    await expect(dialog.getByTestId("shared-use-confirm")).toBeEnabled();
    await noToasts(settings);
    await bothThemes(settings, `journey-share-dialog-${w}`);
    await expectNoSeriousA11y(settings, '[data-testid="shared-use-dialog"]');
    await dialog.getByTestId("shared-use-confirm").click();
    await expect(dialog).toBeHidden();
    const list = settings.getByTestId("shares-list");
    await expect(list).toContainText(`${CONNECTOR} in #${ops}`);
    await expect(list).toContainText("2 people could read · allowed today");

    // ---- allowed: the next mention in #ops uses Víctor's account
    const second = await mention("and now, who am I in the CRM?");
    await page.goto(`${BASE_URL}/chat/${opsId}?thread=${second.root}&m=${second.reply}`);
    const allowed = page
      .getByTestId("thread-panel")
      .locator(`[data-testid="message"][data-message-id="${second.reply}"]`);
    await expect(allowed).toContainText(`"subject":"${victorSubject}"`, { timeout: 15_000 });

    // ---- Revoke in Settings: the next call is refused again (withheld at delivery)
    await settings.goto(`${BASE_URL}/settings/connections`);
    const shares = (await (await admin.get("/api/v1/member-account-shares")).json()) as {
      shares: Array<{ id: string; conversationId: string }>;
    };
    const share = shares.shares.find((s) => s.conversationId === opsId);
    expect(share, "the #ops share").toBeTruthy();
    await settings.getByTestId(`share-revoke-${share?.id}`).click();
    await expect(settings.getByTestId(`share-row-${share?.id}`)).toHaveCount(0);
    const third = await mention("once more, who am I in the CRM?");
    await page.goto(`${BASE_URL}/chat/${opsId}?thread=${third.root}&m=${third.reply}`);
    const again = page
      .getByTestId("thread-panel")
      .locator(`[data-testid="message"][data-message-id="${third.reply}"]`);
    await expect(again).toContainText("Tool ocw_connector_call: refused (member_account)", {
      timeout: 15_000,
    });
    await expect(again).not.toContainText(victorSubject);
  } finally {
    await me.context.close();
  }
});

test("a personal key used by handle: the provider gets it, the bot and the page never do; Keychain shows the use", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const w = info.project.name === "mobile" ? "390" : "1440";
  const victorId = await userIdOf(admin);
  // Víctor's personal bot (created once; both projects reuse it) and his own DM with it.
  const listed = (await (await admin.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; scope: string; ownerUserId: string | null }>;
  };
  personalBotId =
    listed.agents.find((a) => a.scope === "personal" && a.ownerUserId === victorId)?.id ??
    (
      (await (
        await admin.post("/api/v1/agents/personal", { data: { modelProvider: "mock", modelId: "mock-1" } })
      ).json()) as { agent: { id: string } }
    ).agent.id;
  expect(personalBotId).not.toBe("");
  await plugin.ackAll();
  // A fresh personal key for the fake's host, granted to that bot only.
  const keys = (await (await admin.get("/api/v1/keychain")).json()) as {
    personal: Array<{ id: string; name: string }>;
  };
  for (const k of keys.personal.filter((x) => x.name === "Pipeline API")) {
    expect((await admin.delete(`/api/v1/keychain/${k.id}`)).ok()).toBe(true);
  }
  const created = await admin.post("/api/v1/keychain", {
    data: {
      kind: "api_key",
      scope: "personal",
      name: "Pipeline API",
      value: KC_TOKEN,
      allowedHosts: [FAKE_HOST],
    },
  });
  expect(created.ok(), `create the key: ${await created.text()}`).toBe(true);
  const key = (await created.json()) as { id: string; handle: string };
  keyHandle = key.handle;
  const grant = await admin.put(`/api/v1/keychain/${key.id}/agents`, { data: { agentIds: [personalBotId] } });
  expect(grant.ok(), `grant the key: ${grant.status()}`).toBe(true);
  const dm = await dmWith(admin, personalBotId);

  const me = await openAs(browser, ADMIN, info.project.name);
  try {
    const page = me.page;
    const bodies: Array<Promise<string>> = [];
    page.on("response", (r) => {
      if (r.url().includes("/api/v1/")) bodies.push(r.text().catch(() => ""));
    });
    await page.goto(`${BASE_URL}/chat/dm/${dm}`);
    const reply = await askInBrowser(page, "Check my key against the pipeline.");
    // The provider authorized the call: it received the key, which the API injected server-side (SC3, CONN-05).
    await expect(reply).toContainText('Tool ocw_http_request: 200 {"authorized":true,"method":"bearer"}');
    await expect(reply).not.toContainText(KC_TOKEN);
    // The cell got only the handle; no event, reply or page response carries the key.
    const mention = plugin.replies.at(-1)?.mention;
    expect(mention?.turn?.tools).toContain("ocw_http_request");
    expect(JSON.stringify(plugin.events)).not.toContain(KC_TOKEN);
    expect(JSON.stringify(plugin.connectorRequests)).not.toContain(KC_TOKEN);

    // The chat page's bodies are read while that page is still loaded: a body still arriving when `goto` tears the
    // document down never finishes, and its read would wait forever (07.5-15 full gate: a 180 s timeout here).
    expect((await Promise.all(bodies.splice(0))).join("\n")).not.toContain(KC_TOKEN);

    // ---- Settings › Keychain: the row shows the use, never the value
    await page.goto(`${BASE_URL}/settings/keychain`);
    const row = page.getByTestId(`vault-row-${key.id}`);
    await expect(row.getByTestId("vault-handle")).toHaveText(keyHandle);
    await expect(row.getByTestId("vault-last-used")).toHaveText("last used just now");
    await expect(row.getByTestId("vault-bots")).toHaveText("1 bot");
    await row.scrollIntoViewIfNeeded();
    await noToasts(page);
    await bothThemes(page, `journey-keychain-${w}`);
    await expectNoSeriousA11y(page, '[data-testid="keychain-personal"]');
    expect(await page.content()).not.toContain(KC_TOKEN);
    expect((await Promise.all(bodies)).join("\n")).not.toContain(KC_TOKEN);
  } finally {
    await me.context.close();
  }

  // ---- the audit: secret.used with the host and the method, never the value (a stored column, read directly)
  const { rows: audits } = await asSuperuser<{ metadata: Record<string, unknown>; result: string }>(
    "select metadata, result from app.audit_events where action = 'secret.used' and resource_id = $1 order by occurred_at desc limit 1",
    [key.id],
  );
  expect(audits[0]).toMatchObject({
    result: "success",
    metadata: { handle: keyHandle, host: FAKE_HOST, method: "GET", status: 200 },
  });
  expect(JSON.stringify(audits)).not.toContain(KC_TOKEN);
});
