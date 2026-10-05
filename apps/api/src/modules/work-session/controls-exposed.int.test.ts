import { controlStatus, type RuntimeCatalog, type RuntimeControlStatus } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import type { FakeDevice } from "../../testing-device";
import { eventually } from "../../testing-device";
import { connectWithProject, errorCode, model, pairDevice, startSession } from "../../testing-workzone";

/**
 * The inventory rows that waited for recorded fixtures (Phase 03.2, WZC-02, WZC-03, WZC-06) are offered by the
 * API exactly as their final inventory status says. The expected statuses are HARD-CODED from the adapter plans'
 * fixture outcomes, so this suite fails when the inventory and the recorded evidence disagree:
 *
 * - `claude-code/effort` and `claude-code/mode.auto`: 03.2-02-SUMMARY.md ("Auto: confirmed" by the 2.1.289
 *   settings fixture; effort "accepted" by `applyFlagSettings`; rows "exposed with fixture evidence").
 * - `codex/mode.auto`: 03.2-03-SUMMARY.md ("Codex Auto is exposed with the reason 'runtime review
 *   (auto_review); behaviour not fixtured'").
 */
const CLAUDE_EFFORT_STATUS: RuntimeControlStatus = "exposed"; // 03.2-02-SUMMARY.md
const CLAUDE_AUTO_STATUS: RuntimeControlStatus = "exposed"; // 03.2-02-SUMMARY.md
const CODEX_AUTO_STATUS: RuntimeControlStatus = "exposed"; // 03.2-03-SUMMARY.md

const ADMIN = { name: "Víctor Ruiz", email: "victor@example.test", password: "correct-horse-battery" };
const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const now = () => new Date().toISOString();

/** Mirrors FakeRuntime's catalogs (apps/local-runtime/src/fake/fake-runtime.ts): what the e2e device reports. */
const CLAUDE: RuntimeCatalog = {
  runtime: "claude-code",
  runtimeVersion: "fake",
  models: [
    model("opus", "Claude Opus 5.5", {
      isDefault: true,
      supportsAutoMode: true,
      fastMode: { supported: true, reason: null },
    }),
    model("haiku", "Claude Haiku 4.5", { efforts: [], defaultEffort: null, supportsAutoMode: false }),
  ],
  permissionModes: ["default", "acceptEdits", "plan", "auto"],
  fastModeCost: "Fast mode uses paid usage credits, not your Claude subscription limits",
  collectedAt: now(),
};
const CODEX: RuntimeCatalog = {
  runtime: "codex",
  runtimeVersion: "fake",
  models: [model("gpt-6.1-sol", "GPT-6.1 Sol", { isDefault: true, defaultEffort: "low" })],
  permissionModes: ["default", "acceptEdits", "plan", "auto"],
  fastModeCost: "Fast mode uses your ChatGPT subscription limits at about 2.5x the standard rate",
  collectedAt: now(),
};

type Option = { available: boolean; reason: string | null };
type Controls = {
  models: Array<{ id: string; efforts: Array<Option & { value: string }> }>;
  permissionModes: Array<Option & { value: string }>;
};

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let device: FakeDevice;
let projectId: string;

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await admin.request("POST", "/api/v1/setup", {
    token: TEST_SETUP_TOKEN,
    ...ADMIN,
    orgName: "Autofy Labs",
  });
  expect(setup.status).toBe(200);
  const paired = await pairDevice(stack, admin, "Víctor's MacBook");
  ({ device, projectId } = await connectWithProject(stack, admin, paired.token, {
    localId: "lp_demo",
    name: "ocw",
  }));
  device.capabilities([CLAUDE, CODEX], false);
  await eventually(async () => {
    const r = await su.query("select runtime_catalog from app.devices where id = $1", [paired.deviceId]);
    return (r.rows[0].runtime_catalog as unknown[]).length === 2;
  });
  // The test device's hello reports Codex signed out; the e2e device (fake runtime) has both signed in.
  await su.query(
    `update app.devices set runtime_info = (
       select jsonb_agg(case when r->>'id' = 'codex' then r || '{"loggedIn": true}'::jsonb else r end)
       from jsonb_array_elements(runtime_info) r)
     where id = $1`,
    [paired.deviceId],
  );
}, 180_000);

afterAll(async () => {
  await device?.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

async function controls(sessionId: string): Promise<Controls> {
  const res = await admin.request("GET", `/api/v1/work-sessions/${sessionId}/controls`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as unknown as Controls;
}

const mode = (c: Controls, value: string) => c.permissionModes.find((m) => m.value === value)!;

describe("the inventory matches the adapter plans' recorded fixture outcomes", () => {
  it("claude-code/effort, claude-code/mode.auto and codex/mode.auto have the recorded final status", () => {
    expect(controlStatus("claude-code", "effort")).toBe(CLAUDE_EFFORT_STATUS);
    expect(controlStatus("claude-code", "mode.auto")).toBe(CLAUDE_AUTO_STATUS);
    expect(controlStatus("codex", "mode.auto")).toBe(CODEX_AUTO_STATUS);
  });
});

describe("Claude Code: effort and Auto are offered exactly as the inventory says (WZC-02, WZC-03, WZC-06)", () => {
  let sessionId: string;

  beforeAll(async () => {
    sessionId = await startSession(admin, device, projectId, { title: "Claude controls" });
  });

  it("GET /controls marks Opus efforts low…max available iff claude-code/effort is exposed", async () => {
    const c = await controls(sessionId);
    const opus = c.models.find((m) => m.id === "opus")!;
    expect(opus.efforts.map((e) => e.value)).toEqual(ALL_EFFORTS);
    for (const e of opus.efforts) {
      if (CLAUDE_EFFORT_STATUS === "exposed")
        expect(e, e.value).toMatchObject({ available: true, reason: null });
      else expect(e, e.value).toMatchObject({ available: false, reason: "not_confirmed" });
    }
  });

  it("GET /controls marks Auto available iff claude-code/mode.auto is exposed, else not_confirmed", async () => {
    const auto = mode(await controls(sessionId), "auto");
    if (CLAUDE_AUTO_STATUS === "exposed") expect(auto).toMatchObject({ available: true, reason: null });
    else expect(auto).toMatchObject({ available: false, reason: "not_confirmed" });
  });

  it("PATCH effort xhigh answers 200 when exposed and 403 not_confirmed when not", async () => {
    const res = await admin.request("PATCH", `/api/v1/work-sessions/${sessionId}/settings`, {
      effort: "xhigh",
    });
    if (CLAUDE_EFFORT_STATUS === "exposed") expect(res.status, JSON.stringify(res.body)).toBe(200);
    else {
      expect(res.status).toBe(403);
      expect(errorCode(res)).toBe("not_confirmed");
    }
  });

  it("PATCH permissionMode auto answers 200 when exposed and 403 not_confirmed when not", async () => {
    const res = await admin.request("PATCH", `/api/v1/work-sessions/${sessionId}/settings`, {
      permissionMode: "auto",
    });
    if (CLAUDE_AUTO_STATUS === "exposed") expect(res.status, JSON.stringify(res.body)).toBe(200);
    else {
      expect(res.status).toBe(403);
      expect(errorCode(res)).toBe("not_confirmed");
    }
  });
});

describe("Codex: Auto is offered exactly as the inventory says (WZC-03, WZC-06)", () => {
  let sessionId: string;

  beforeAll(async () => {
    sessionId = await startSession(admin, device, projectId, { title: "Codex controls", runtime: "codex" });
  });

  it("GET /controls marks Auto available iff codex/mode.auto is exposed, else not_confirmed", async () => {
    const auto = mode(await controls(sessionId), "auto");
    if (CODEX_AUTO_STATUS === "exposed") expect(auto).toMatchObject({ available: true, reason: null });
    else expect(auto).toMatchObject({ available: false, reason: "not_confirmed" });
  });

  it("PATCH permissionMode auto answers 200 when exposed and 403 not_confirmed when not", async () => {
    const res = await admin.request("PATCH", `/api/v1/work-sessions/${sessionId}/settings`, {
      permissionMode: "auto",
    });
    if (CODEX_AUTO_STATUS === "exposed") expect(res.status, JSON.stringify(res.body)).toBe(200);
    else {
      expect(res.status).toBe(403);
      expect(errorCode(res)).toBe("not_confirmed");
    }
  });
});
