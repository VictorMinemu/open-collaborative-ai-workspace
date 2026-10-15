import { type APIRequestContext, expect, type Locator, type Page } from "@playwright/test";
import { API_URL } from "../tests/env";
import { type Actor, BASE_URL, ensureMember } from "./actors";
import {
  cellToken,
  ensurePluginInstalled,
  FAKE_MCP_HOST,
  FAKE_MCP_TOKEN,
  FAKE_URL,
  NOTES,
  PLUGIN_TOOLS,
} from "./bot-tools";
import { FakeCellPlugin } from "./fake-cell-plugin";

/**
 * Helpers for the approval policy specs (07.5-09; reused by the 07.5 journeys). API calls only, on the isolated stack
 * (scripts/e2e-isolated.sh): never the demo. The fake MCP server (`echo` read-only, `write_note` destructive) is
 * registered as "Northwind CRM" and probed by a simulated cell, so the policy catalog lists its two tools.
 */

export const NORTHWIND_CRM = "Northwind CRM";

/** A Sales lead (org role lead, unit lead of Sales) and a standard member: both named as specific approvers. */
export const MARTA: Actor = {
  name: "Marta Gil",
  email: "marta@ocw.test",
  password: "marta-e2e-password-123",
};
export const LUIS: Actor = { name: "Luis Mora", email: "luis@ocw.test", password: "luis-e2e-password-123" };

export type PolicyJson = {
  id: string;
  scopeUnitId: string | null;
  toolPattern: string;
  mode: "never" | "when_tainted" | "always";
  approverKind: "requester" | "users" | "unit_leads" | "admins";
  approverUserIds: string[];
  version: number;
};

type UnitJson = { id: string; name: string; kind: string; parentId: string | null };

/** Creates the rule (201) and returns it. */
export async function setApprovalPolicy(
  api: APIRequestContext,
  body: {
    scopeUnitId: string | null;
    toolPattern: string;
    mode: PolicyJson["mode"];
    approverKind: PolicyJson["approverKind"];
    approverUserIds?: string[];
  },
): Promise<PolicyJson> {
  const res = await api.post("/api/v1/tool-approval-policies", { data: body });
  expect(res.status(), `set policy ${body.toolPattern}: ${await res.text()}`).toBe(201);
  return (await res.json()) as PolicyJson;
}

/** The rules of one scope (`org` or a unit id). */
export async function listApprovalPolicies(api: APIRequestContext, scope: string): Promise<PolicyJson[]> {
  const res = await api.get(`/api/v1/tool-approval-policies?scope=${scope}`);
  expect(res.ok(), `list policies ${scope}`).toBe(true);
  return ((await res.json()) as { policies: PolicyJson[] }).policies;
}

/** Removes every rule the caller manages (the organization's and every unit's, for an admin). */
export async function clearApprovalPolicies(api: APIRequestContext): Promise<void> {
  const res = await api.get("/api/v1/tool-approval-policies/access");
  expect(res.ok(), "policy access").toBe(true);
  const { manageable } = (await res.json()) as { manageable: { organization: boolean; unitIds: string[] } };
  const scopes = [...(manageable.organization ? ["org"] : []), ...manageable.unitIds];
  for (const scope of scopes) {
    for (const p of await listApprovalPolicies(api, scope)) {
      const del = await api.delete(`/api/v1/tool-approval-policies/${p.id}?expectedVersion=${p.version}`);
      expect(del.status(), `remove policy ${p.toolPattern}`).toBe(204);
    }
  }
}

function newCell(token: string) {
  return new FakeCellPlugin({
    apiUrl: API_URL,
    token,
    autoAck: true,
    autoReply: false,
    hostMap: { [FAKE_MCP_HOST]: FAKE_URL ? new URL(FAKE_URL).host : "" },
    pluginTools: PLUGIN_TOOLS,
    stepMs: 200,
  });
}

/**
 * "Northwind CRM" (the fake MCP: `echo`, `write_note`) registered and probed, plus the notes plugin approved, so the policy
 * catalog has an MCP group, a Plugins group and Web requests. Idempotent across projects and runs.
 */
export async function seedApprovalMcp(
  admin: APIRequestContext,
): Promise<{ serverId: string; safeName: string }> {
  const token = cellToken();
  expect(token, "OCW_CELL_TOKEN is configured").toBeTruthy();
  expect(FAKE_URL, "OCW_E2E_FAKE_URL is set (the fake MCP server runs)").toBeTruthy();
  type ServerJson = {
    id: string;
    name: string;
    safeName: string;
    status: string;
    tools: Array<{ name: string }>;
  };
  const list = async () =>
    ((await (await admin.get("/api/v1/mcp-servers")).json()) as { servers: ServerJson[] }).servers;
  const cell = newCell(token);
  await cell.start();
  try {
    let server = (await list()).find((s) => s.name === NORTHWIND_CRM);
    if (!server) {
      const res = await admin.post("/api/v1/mcp-servers", {
        data: {
          name: NORTHWIND_CRM,
          transport: "streamable-http",
          url: `http://${FAKE_MCP_HOST}/mcp`,
          headers: [{ name: "Authorization", value: `Bearer ${FAKE_MCP_TOKEN}` }],
        },
      });
      expect(res.ok(), `register ${NORTHWIND_CRM}: ${await res.text()}`).toBe(true);
    } else if (server.tools.length < 2) {
      expect((await admin.post(`/api/v1/mcp-servers/${server.id}/probe`)).ok(), "re-probe").toBe(true);
    }
    await expect
      .poll(
        async () => {
          server = (await list()).find((s) => s.name === NORTHWIND_CRM);
          return server?.status === "ready" ? server.tools.length : 0;
        },
        { timeout: 30_000 },
      )
      .toBe(2);
    await ensurePluginInstalled(admin, NOTES, "1.0.0");
  } finally {
    await cell.stop();
  }
  const s = (await list()).find((x) => x.name === NORTHWIND_CRM) as ServerJson;
  return { serverId: s.id, safeName: s.safeName };
}

/** A unit with this name (created at the top level, or under `parentId`, when missing). */
export async function ensureUnit(
  admin: APIRequestContext,
  kind: "department" | "team",
  name: string,
  parentId: string | null,
): Promise<string> {
  const units = ((await (await admin.get("/api/v1/units")).json()) as { units: UnitJson[] }).units;
  const found = units.find((u) => u.name === name && u.parentId === parentId);
  if (found) return found.id;
  const res = await admin.post("/api/v1/units", { data: { kind, name, parentId } });
  expect(res.ok(), `create unit ${name}: ${await res.text()}`).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

/** `userId` holds `role` in the unit (added, or changed when already a member). */
export async function ensureUnitRole(
  admin: APIRequestContext,
  unitId: string,
  userId: string,
  role: "member" | "lead",
): Promise<void> {
  const { members } = (await (await admin.get(`/api/v1/units/${unitId}/members`)).json()) as {
    members: Array<{ userId: string; role: string }>;
  };
  const current = members.find((m) => m.userId === userId);
  if (current?.role === role) return;
  const res = current
    ? await admin.patch(`/api/v1/units/${unitId}/members/${userId}`, { data: { role } })
    : await admin.post(`/api/v1/units/${unitId}/members`, { data: { userId, role } });
  expect(res.ok(), `unit role ${role}: ${res.status()} ${await res.text()}`).toBe(true);
}

/** Sales (Marta leads it) with its Sales East team, and Luis as a standard member outside it. */
export async function seedApprovalPeople(admin: APIRequestContext) {
  const martaId = await ensureMember(admin, MARTA, "lead");
  const luisId = await ensureMember(admin, LUIS, "standard");
  const salesId = await ensureUnit(admin, "department", "Sales", null);
  const salesEastId = await ensureUnit(admin, "team", "Sales East", salesId);
  await ensureUnitRole(admin, salesId, martaId, "lead");
  return { martaId, luisId, salesId, salesEastId };
}

// ---------------------------------------------------------------- the /approvals inbox (07.5-12)

/** The `/approvals` kinds and the memory inbox's kind (UI-SPEC R1: two disjoint inboxes). */
export const ACTION_KINDS = "tool.call,work_zone.start";
export const MEMORY_KIND = "memory.write";

/**
 * The bot proposes a Work Zone session from the open DM: `[[call ocw_start_work_zone {projectId, deviceId, prompt}]]`
 * through the fake cell (`cell`, autoReply on), the reply says `Tool ocw_start_work_zone: proposed`, and the approval
 * id the API answered the cell is returned (the bot never shows it). `dmId` opens the DM first when given.
 */
export async function proposeWorkZoneFromDm(
  page: Page,
  cell: FakeCellPlugin,
  input: { dmId?: string; projectId: string; deviceId: string; prompt: string; says?: string },
): Promise<string> {
  if (input.dmId) {
    await page.goto(`${BASE_URL}/chat/dm/${input.dmId}`);
    await expect(page.getByTestId("dm-view")).toBeVisible();
  }
  const reply = page
    .locator('[data-testid="message"][data-author-kind="agent"]')
    .filter({ hasText: "Tool ocw_start_work_zone:" });
  const before = await reply.count();
  const args = { projectId: input.projectId, deviceId: input.deviceId, prompt: input.prompt };
  const box = page.getByTestId("composer");
  await box.click();
  await box.fill(
    `${input.says ?? "Fix the rounding bug"} [[call ocw_start_work_zone ${JSON.stringify(args)}]]`,
  );
  await box.press("Enter");
  await expect(reply).toHaveCount(before + 1, { timeout: 30_000 });
  await expect(reply.last()).toContainText("Tool ocw_start_work_zone: proposed");
  const last = [...cell.workZoneRequests].reverse().find((r) => r.route === "/work-zone/proposals");
  const id = (last?.body as { approvalId?: string } | null)?.approvalId;
  expect(id, "the proposal's approval id").toBeTruthy();
  return id as string;
}

/** Opens `/approvals` the way a person does: the Approvals nav entry (the drawer on a phone). */
export async function openApprovals(page: Page): Promise<void> {
  const mobile = (page.viewportSize()?.width ?? 1440) < 768;
  if (mobile) await page.getByTestId("mobile-nav-trigger").click();
  await page.getByTestId("nav-approvals").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/approvals(\?|$)/);
  await expect(page.getByTestId("approvals-inbox")).toBeVisible();
}

/** The approval id an inbox row stands for (`data-id`). */
export async function approvalIdFromRow(row: Locator): Promise<string> {
  const id = await row.getAttribute("data-id");
  expect(id, "the row's approval id").toBeTruthy();
  return id as string;
}

/** Denies (dismisses) everything pending that `api` may decide, optionally of some kinds only, so counts start at 0. */
export async function clearPendingApprovals(api: APIRequestContext, kinds?: string): Promise<void> {
  const res = await api.get(`/api/v1/approvals?role=decider&status=pending${kinds ? `&kinds=${kinds}` : ""}`);
  expect(res.ok(), `list pending: ${res.status()}`).toBe(true);
  for (const item of ((await res.json()) as { items: Array<{ id: string; actionHash: string }> }).items) {
    const denied = await api.post(`/api/v1/approvals/${item.id}/decision`, {
      data: { outcome: "denied", actionHash: item.actionHash },
    });
    expect(denied.ok(), `clear ${item.id}: ${denied.status()}`).toBe(true);
  }
}
