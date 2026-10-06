import type { RuntimeCatalog, RuntimeModel } from "@ocw/contracts";
import { expect } from "vitest";
import { TestClient, type TestStack } from "./testing";
import { eventually, FakeDevice } from "./testing-device";

/**
 * Shared fixtures for the Work Zone controls integration suites (Phase 03.2): runtime catalogs as a device
 * reports them, member invitations, device pairing and a session brought to `idle` through a FakeDevice.
 */

export const model = (id: string, displayName: string, extra: Partial<RuntimeModel> = {}): RuntimeModel => ({
  id,
  displayName,
  description: null,
  legacy: false,
  isDefault: false,
  badge: null,
  efforts: ["low", "medium", "high", "xhigh", "max"].map((value) => ({ value, description: null })),
  defaultEffort: "medium",
  contextWindows: [],
  defaultContextWindow: 1_000_000,
  fastMode: { supported: false, reason: "model_not_allowed" },
  supportsAutoMode: true,
  ...extra,
});

const now = () => new Date().toISOString();

export const CLAUDE_CATALOG: RuntimeCatalog = {
  runtime: "claude-code",
  runtimeVersion: "2.1.289",
  models: [
    model("opus", "Claude Opus 5.5", { isDefault: true, fastMode: { supported: true, reason: null } }),
    model("sonnet", "Claude Sonnet 5.5"),
    model("haiku", "Claude Haiku 4.5", { efforts: [], defaultEffort: null, supportsAutoMode: false }),
  ],
  permissionModes: ["default", "acceptEdits", "plan", "auto", "fullAccess"],
  fastModeCost: "Uses paid usage credits",
  collectedAt: now(),
};

export const CODEX_CATALOG: RuntimeCatalog = {
  runtime: "codex",
  runtimeVersion: "0.160.0",
  models: [
    model("gpt-6.1-sol", "GPT-6.1 Sol", { isDefault: true, fastMode: { supported: true, reason: null } }),
  ],
  permissionModes: ["default", "acceptEdits", "plan", "fullAccess"],
  fastModeCost: "About 2.5x your subscription limits",
  collectedAt: now(),
};

export const errorCode = (res: { body: Record<string, unknown> | null }) =>
  (res.body?.error as { code?: string } | undefined)?.code;

export async function invite(
  stack: TestStack,
  admin: TestClient,
  email: string,
  name: string,
  role: "standard" | "developer" | "lead" | "admin",
): Promise<{ client: TestClient; userId: string }> {
  const inv = await admin.request("POST", "/api/v1/invitations", { email, role });
  expect(inv.status, JSON.stringify(inv.body)).toBe(200);
  const client = new TestClient(stack.baseUrl);
  const res = await client.request("POST", `/api/v1/invitations/${inv.body!.id as string}/accept`, {
    name,
    password: "yet-another-long-password",
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const me = await client.request("GET", "/api/v1/me");
  expect(me.status, JSON.stringify(me.body)).toBe(200);
  const userId = (me.body!.user as { id: string }).id;
  return { client, userId };
}

export async function pairDevice(stack: TestStack, owner: TestClient, name: string) {
  const code = (await owner.request("POST", "/api/v1/devices/enrollments")).body!.code as string;
  const anon = new TestClient(stack.baseUrl);
  const ok = await anon.request("POST", "/api/v1/devices/enroll", { code, name, platform: "darwin" });
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  return { deviceId: ok.body!.deviceId as string, token: ok.body!.deviceToken as string };
}

/** Connect a paired device, announce one project and return its id (as the owner sees it). */
export async function connectWithProject(
  stack: TestStack,
  owner: TestClient,
  token: string,
  project: { localId: string; name: string },
): Promise<{ device: FakeDevice; projectId: string }> {
  const device = await FakeDevice.connect(stack.baseUrl, token);
  device.send({
    type: "projects.sync",
    projects: [{ localId: project.localId, name: project.name, gitRemote: null, defaultBranch: "main" }],
  });
  await device.next((f) => f.type === "projects.ack");
  const projects = (await owner.request("GET", "/api/v1/projects")).body!.projects as Array<{
    id: string;
    name: string;
  }>;
  return { device, projectId: projects.find((p) => p.name === project.name)!.id };
}

/** Create a session through the API and bring it to `idle` through the fake device. */
export async function startSession(
  as: TestClient,
  device: FakeDevice,
  projectId: string,
  body: Record<string, unknown> = {},
): Promise<string> {
  const res = await as.request("POST", "/api/v1/work-sessions", { projectId, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const id = res.body!.id as string;
  const start = await device.command("session.start", id);
  device.ack(start.id);
  device.event(id, {
    type: "session.started",
    runtime: (body.runtime as string | undefined) ?? "claude-code",
    runtimeSessionId: `rt-${id}`,
    model: "claude-opus-5-5",
    permissionMode: (body.permissionMode as string | undefined) ?? "default",
  });
  device.event(id, { type: "session.state", status: "idle" });
  await eventually(async () => {
    const d = await as.request("GET", `/api/v1/work-sessions/${id}`);
    return (d.body?.session as { status?: string } | undefined)?.status === "idle";
  });
  return id;
}
