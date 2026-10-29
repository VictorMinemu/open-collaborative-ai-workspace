import { type APIRequestContext, expect, test } from "@playwright/test";
import { apiAs, ensureMember, SAM, userIdOf } from "../support/actors";
import {
  auditActions,
  type CliHome,
  deviceAs,
  deviceEnv,
  type FakeRegistry,
  makeCliHome,
  ownerRuntimeStatus,
  RUNTIME_PACKAGES,
  sessionEvents,
  startFakeRegistry,
} from "../support/runtime-updates";
import { type FakeDeviceHandle, startFakeDevice } from "../support/work-zone-device";
import { ADMIN } from "./env";

/**
 * Runtime CLI auto-updates on the real stack (Phase 07.11-09): the REAL local-runtime daemon in fake-runtime mode,
 * whose Claude Code and Codex are copies of the fake CLI in a scratch HOME (scratch bin first on PATH) and whose npm
 * registry is a 127.0.0.1 stub (OCW_RUNTIME_REGISTRY_URL), against the real API and database (PD-19: no real CLI, no
 * real registry, ever).
 * - the phase tracer (ROADMAP success criterion 2; D-03, D-03b, D-06): a device's Claude Code falls behind while a
 *   Claude turn waits on an approval; the update waits, Codex and another Claude session keep working, it runs once
 *   the turn ends, a Claude prompt sent meanwhile is held and its session stores `runtime.update` waiting → done before
 *   the prompt starts; the owner sees the new version and the run, and the audit log holds available/started/finished.
 * - "Update now" at the org level `notify` (D-02, D-05): nothing installs by itself; the owner's request does, the
 *   history names the requester, a second request on a current runtime ends refused "already up to date".
 * - a member (D-06, D-11): sees the device's compatibility, never its maintenance details; 403 on both routes.
 * - the org level `off` (D-02): the device never asks the registry, and Update now is 409 `runtime_updates_off`.
 * API-level spec: it runs once, on the desktop project.
 */

test.describe.configure({ mode: "serial" });

const CLAUDE_PKG = RUNTIME_PACKAGES["claude-code"];
const CODEX_PKG = RUNTIME_PACKAGES.codex;
const DESKTOP_ONLY = "API-level spec: runs once";

async function ok<R>(res: Awaited<ReturnType<APIRequestContext["get"]>>, what: string): Promise<R> {
  expect(res.ok(), `${what}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as R;
}

async function setOrgLevel(api: APIRequestContext, level: "automatic" | "notify" | "off"): Promise<string> {
  const before = await ok<{ runtimeUpdates: string }>(
    await api.get("/api/v1/work-zone-policy"),
    "read policy",
  );
  await ok(
    await api.put("/api/v1/work-zone-policy", { data: { runtimeUpdates: level } }),
    "set runtimeUpdates",
  );
  return before.runtimeUpdates;
}

async function restoreOrgLevel(api: APIRequestContext, level: string | null) {
  if (level === null) return;
  await api.put("/api/v1/work-zone-policy", { data: { runtimeUpdates: level } }).catch(() => undefined);
}

async function startSession(
  api: APIRequestContext,
  projectId: string,
  runtime: "claude-code" | "codex",
  title: string,
  opts: { prompt?: string; mode?: "plan" | "default" } = {},
): Promise<string> {
  const s = await ok<{ id: string }>(
    await api.post("/api/v1/work-sessions", {
      data: {
        projectId,
        runtime,
        permissionMode: opts.mode ?? "plan",
        title,
        ...(opts.prompt ? { prompt: opts.prompt } : {}),
      },
    }),
    `start ${title}`,
  );
  return s.id;
}

interface Detail {
  session: { status: string };
  prompts: Array<{ id: string; status: string }>;
  approvals: Array<{ id: string; status: string }>;
}

const detail = async (api: APIRequestContext, id: string) =>
  ok<Detail>(await api.get(`/api/v1/work-sessions/${id}`), `session ${id}`);

async function prompt(api: APIRequestContext, sessionId: string, body: string): Promise<string> {
  return (
    await ok<{ id: string }>(
      await api.post(`/api/v1/work-sessions/${sessionId}/prompts`, { data: { body } }),
      "prompt",
    )
  ).id;
}

const promptStatus = async (api: APIRequestContext, sessionId: string, promptId: string) =>
  (await detail(api, sessionId)).prompts.find((p) => p.id === promptId)?.status ?? "missing";

const pick = <T extends object, K extends keyof T>(o: T | null, keys: K[]) =>
  o === null ? null : Object.fromEntries(keys.map((k) => [k, o[k]]));

test("the phase tracer: on a busy device Claude Code updates between turns, held work resumes on the new version, the owner sees it, audited", async () => {
  test.skip(test.info().project.name !== "desktop", DESKTOP_ONLY);
  test.setTimeout(300_000);
  const admin = await apiAs(ADMIN);
  const run = Date.now().toString(36);
  let previousLevel: string | null = null;
  let registry: FakeRegistry | null = null;
  let cli: CliHome | null = null;
  let device: FakeDeviceHandle | null = null;
  try {
    previousLevel = await setOrgLevel(admin, "automatic");
    registry = await startFakeRegistry();
    registry.setLatest(CLAUDE_PKG, "latest", "2.1.290");
    registry.setLatest(CODEX_PKG, "latest", "0.164.0");
    cli = makeCliHome({ claude: "2.1.290", codex: "0.164.0" });
    // The fake's `claude update` takes long enough for a prompt to be sent while it runs.
    cli.setNextUpdate("claude-code", { next: "2.1.300", delayMs: 8000 });

    device = await startFakeDevice(admin, {
      name: `E2E Updates ${run}`,
      projectName: `updates-${run}`,
      env: deviceEnv(cli.home, registry),
    });
    const { deviceId, projectId } = device;
    const claude = () => ownerRuntimeStatus(admin, deviceId, "claude-code");

    // ---- the owner sees the scratch Claude Code: 2.1.290, current, native
    await expect
      .poll(async () => pick(await claude(), ["installedVersion", "advisory", "method", "state"]), {
        timeout: 60_000,
        message: "the owner sees Claude Code 2.1.290, current",
      })
      .toEqual({ installedVersion: "2.1.290", advisory: "current", method: "native", state: "idle" });

    // ---- A (Claude, Supervised) asks for an approval: a Claude turn is in flight
    const a = await startSession(admin, projectId, "claude-code", `Busy ${run}`, {
      prompt: "Write the release notes",
      mode: "default",
    });
    await expect
      .poll(async () => (await detail(admin, a)).approvals.some((x) => x.status === "pending"), {
        timeout: 30_000,
        message: "A waits on an approval",
      })
      .toBe(true);
    const b = await startSession(admin, projectId, "codex", `Codex ${run}`);
    const c = await startSession(admin, projectId, "claude-code", `Claude ${run}`);
    await expect
      .poll(async () => [(await detail(admin, b)).session.status, (await detail(admin, c)).session.status], {
        timeout: 30_000,
        message: "B and C are ready",
      })
      .toEqual(["idle", "idle"]);

    // ---- Claude Code 2.1.300 is published; the device checks and waits for an idle moment (D-03)
    registry.setLatest(CLAUDE_PKG, "latest", "2.1.300");
    await device.runtimeCli(["updates", "check"]);
    await expect
      .poll(async () => pick(await claude(), ["installedVersion", "latestVersion", "advisory", "state"]), {
        timeout: 30_000,
        message: "the owner sees Claude Code behind and pending",
      })
      .toEqual({
        installedVersion: "2.1.290",
        latestVersion: "2.1.300",
        advisory: "behind",
        state: "pending",
      });

    // ---- nobody is held in the first hour: Codex and the other Claude session both run a turn
    const bPrompt = await prompt(admin, b, "Summarise the README");
    const cFirst = await prompt(admin, c, "Plan the changelog");
    await expect
      .poll(async () => [await promptStatus(admin, b, bPrompt), await promptStatus(admin, c, cFirst)], {
        timeout: 30_000,
        message: "B's and C's turns complete while A waits",
      })
      .toEqual(["completed", "completed"]);
    expect(
      (await detail(admin, a)).approvals.some((x) => x.status === "pending"),
      "A still waits",
    ).toBe(true);
    expect((await claude())?.state, "the update still waits for A").toBe("pending");

    // ---- A's approval is answered; its turn ends; the update starts within seconds
    const pending = (await detail(admin, a)).approvals.find((x) => x.status === "pending");
    await ok(
      await admin.post(`/api/v1/work-sessions/${a}/approvals/${pending?.id}`, { data: { decision: "once" } }),
      "approve A",
    );
    const aPrompt = (await detail(admin, a)).prompts[0]?.id ?? "";
    await expect
      .poll(() => promptStatus(admin, a, aPrompt), { timeout: 30_000, message: "A's turn completes" })
      .toBe("completed");
    await expect
      .poll(async () => (await claude())?.state, {
        timeout: 10_000,
        intervals: [200],
        message: "Claude Code is updating",
      })
      .toBe("running");

    // ---- a Claude prompt sent now is held until the update is done, then runs on 2.1.300
    const held = await prompt(admin, c, "Now write it");
    await expect
      .poll(async () => pick(await claude(), ["installedVersion", "state", "advisory"]), {
        timeout: 60_000,
        message: "Claude Code 2.1.300 is installed",
      })
      .toEqual({ installedVersion: "2.1.300", state: "idle", advisory: "current" });
    await expect
      .poll(() => promptStatus(admin, c, held), { timeout: 30_000, message: "the held prompt runs" })
      .toBe("completed");

    // ---- C's timeline: runtime.update waiting, then done 2.1.300, then the held prompt starts
    const cEvents = await sessionEvents(c);
    const waiting = cEvents.findIndex((e) => e.type === "runtime.update" && e.phase === "waiting");
    const done = cEvents.findIndex(
      (e) => e.type === "runtime.update" && e.phase === "done" && e.version === "2.1.300",
    );
    const started = cEvents.findIndex((e) => e.type === "prompt.started" && e.promptId === held);
    expect(waiting, "runtime.update waiting stored").toBeGreaterThanOrEqual(0);
    expect(done, "runtime.update done stored after waiting").toBeGreaterThan(waiting);
    expect(started, "the held prompt starts after the update").toBeGreaterThan(done);
    expect(cEvents.filter((e) => e.type === "runtime.update").map((e) => e.runtime)).toEqual([
      "claude-code",
      "claude-code",
    ]);
    // Nobody's turn was cut (D-03): A's turn completed, never interrupted; Codex and A were never told to wait.
    const aEvents = await sessionEvents(a);
    expect(aEvents.some((e) => e.type === "prompt.completed" && e.interrupted === true)).toBe(false);
    expect(aEvents.some((e) => e.type === "prompt.completed" && e.promptId === aPrompt)).toBe(true);
    expect((await sessionEvents(b)).some((e) => e.type === "runtime.update")).toBe(false);

    // ---- the owner's view and the history
    const after = await claude();
    expect(after?.installedVersion).toBe("2.1.300");
    expect(after?.lastRun?.outcome).toBe("succeeded");
    const history = await ok<{ runs: Array<Record<string, unknown>> }>(
      await admin.get(`/api/v1/devices/${deviceId}/runtime-updates?runtime=claude-code`),
      "history",
    );
    expect(history.runs).toHaveLength(1);
    expect(history.runs[0]).toMatchObject({
      runtime: "claude-code",
      trigger: "automatic",
      state: "succeeded",
      fromVersion: "2.1.290",
      toVersion: "2.1.300",
      method: "native",
      requestedBy: null,
    });
    expect(JSON.stringify(history.runs[0])).not.toContain(cli.home);

    // ---- audited, with no scratch path anywhere in the metadata (PD-06)
    await expect
      .poll(async () => (await auditActions(deviceId)).map((r) => r.action), {
        timeout: 15_000,
        message: "available, started and finished are audited",
      })
      .toEqual(
        expect.arrayContaining([
          "device.runtime_update_available",
          "device.runtime_update_started",
          "device.runtime_update_finished",
        ]),
      );
    const audits = await auditActions(deviceId);
    const finished = audits.find((r) => r.action === "device.runtime_update_finished");
    expect(finished).toMatchObject({ actor_kind: "system", result: "success" });
    expect(finished?.metadata).toMatchObject({ runtime: "claude-code", from: "2.1.290", to: "2.1.300" });
    expect(audits.find((r) => r.action === "device.runtime_update_available")?.metadata).toMatchObject({
      runtime: "claude-code",
      installed: "2.1.290",
      candidate: "2.1.300",
    });
    for (const row of audits) expect(JSON.stringify(row.metadata)).not.toContain(cli.home);
    // The real registry is never asked; the stub got the device's requests.
    expect(registry.requests("/@anthropic-ai%2Fclaude-code/").length).toBeGreaterThan(0);
  } finally {
    await device?.stop();
    await registry?.stop();
    cli?.remove();
    await restoreOrgLevel(admin, previousLevel);
  }
});

interface HistoryRun {
  id: string;
  runtime: string;
  trigger: string;
  state: string;
  requestedBy: { id: string; name: string } | null;
  fromVersion: string | null;
  toVersion: string | null;
  error: string | null;
}

const historyOf = async (api: APIRequestContext, deviceId: string, runtime: "claude-code" | "codex") =>
  (
    await ok<{ runs: HistoryRun[] }>(
      await api.get(`/api/v1/devices/${deviceId}/runtime-updates?runtime=${runtime}`),
      "history",
    )
  ).runs;

/** One device on scratch CLIs and its own registry; everything is removed and the org level restored in `finally`. */
async function withUpdatingDevice(
  admin: APIRequestContext,
  setup: {
    orgLevel: "automatic" | "notify" | "off" | null;
    registry: { claude: string; codex: string };
    installed: { claude: string; codex: string };
  },
  body: (ctx: { device: FakeDeviceHandle; registry: FakeRegistry; cli: CliHome }) => Promise<void>,
) {
  const run = Date.now().toString(36);
  let previousLevel: string | null = null;
  let registry: FakeRegistry | null = null;
  let cli: CliHome | null = null;
  let device: FakeDeviceHandle | null = null;
  try {
    if (setup.orgLevel) previousLevel = await setOrgLevel(admin, setup.orgLevel);
    registry = await startFakeRegistry();
    registry.setLatest(CLAUDE_PKG, "latest", setup.registry.claude);
    registry.setLatest(CODEX_PKG, "latest", setup.registry.codex);
    cli = makeCliHome(setup.installed);
    device = await startFakeDevice(admin, {
      name: `E2E Updates ${run}`,
      projectName: `updates-${run}`,
      env: deviceEnv(cli.home, registry),
    });
    await body({ device, registry, cli });
  } finally {
    await device?.stop();
    await registry?.stop();
    cli?.remove();
    await restoreOrgLevel(admin, previousLevel);
  }
}

test("Update now: at the notify level the owner's request updates Codex, the history names the requester, a current runtime is refused", async () => {
  test.skip(test.info().project.name !== "desktop", DESKTOP_ONLY);
  test.setTimeout(180_000);
  const admin = await apiAs(ADMIN);
  const adminId = await userIdOf(admin);
  await withUpdatingDevice(
    admin,
    {
      orgLevel: "notify",
      registry: { claude: "2.1.290", codex: "0.165.0" },
      installed: { claude: "2.1.290", codex: "0.164.0" },
    },
    async ({ device, cli }) => {
      const { deviceId } = device;
      cli.setNextUpdate("codex", { next: "0.165.0" });
      const codex = () => ownerRuntimeStatus(admin, deviceId, "codex");
      await expect
        .poll(async () => pick(await codex(), ["installedVersion", "method"]), {
          timeout: 60_000,
          message: "the owner sees the scratch Codex",
        })
        .toEqual({ installedVersion: "0.164.0", method: "codex_standalone" });

      // ---- notify: the device checks and reports, but never installs by itself (D-02)
      await device.runtimeCli(["updates", "check"]);
      await expect
        .poll(async () => pick(await codex(), ["advisory", "latestVersion", "state"]), {
          timeout: 30_000,
          message: "Codex is behind and idle",
        })
        .toEqual({ advisory: "behind", latestVersion: "0.165.0", state: "idle" });
      await new Promise((r) => setTimeout(r, 3_000));
      expect(pick(await codex(), ["installedVersion", "state"])).toEqual({
        installedVersion: "0.164.0",
        state: "idle",
      });
      expect(await historyOf(admin, deviceId, "codex")).toEqual([]);

      // ---- Update now (D-05): the request carries the runtime only; the device picks the command
      const res = await admin.post(`/api/v1/devices/${deviceId}/runtimes/codex/update`);
      expect(res.status(), await res.text()).toBe(200);
      const { run } = (await res.json()) as { run: HistoryRun };
      expect(run).toMatchObject({ runtime: "codex", trigger: "manual", state: "requested" });
      expect(run.requestedBy?.id).toBe(adminId);
      await expect
        .poll(async () => pick(await codex(), ["installedVersion", "state", "advisory"]), {
          timeout: 60_000,
          message: "Codex 0.165.0 is installed",
        })
        .toEqual({ installedVersion: "0.165.0", state: "idle", advisory: "current" });
      expect(cli.version("codex")).toBe("codex-cli 0.165.0");
      expect((await codex())?.lastRun?.outcome).toBe("succeeded");
      await expect
        .poll(async () => (await historyOf(admin, deviceId, "codex")).map((r) => [r.state, r.trigger]), {
          timeout: 15_000,
          message: "the history lists the run",
        })
        .toEqual([["succeeded", "manual"]]);
      const [done] = await historyOf(admin, deviceId, "codex");
      expect(done).toMatchObject({ id: run.id, fromVersion: "0.164.0", toVersion: "0.165.0" });
      expect(done?.requestedBy?.id).toBe(adminId);
      // Claude Code was never touched.
      expect(cli.version("claude-code")).toBe("2.1.290 (Claude Code)");
      expect(await historyOf(admin, deviceId, "claude-code")).toEqual([]);

      // ---- a second request on a now current runtime: accepted by the API, refused by the device
      const again = await admin.post(`/api/v1/devices/${deviceId}/runtimes/codex/update`);
      expect(again.status(), await again.text()).toBe(200);
      await expect
        .poll(async () => (await historyOf(admin, deviceId, "codex"))[0]?.state, {
          timeout: 30_000,
          message: "the second request is refused",
        })
        .toBe("refused");
      const [refused] = await historyOf(admin, deviceId, "codex");
      expect(refused?.error).toContain("already up to date");
      expect(cli.version("codex")).toBe("codex-cli 0.165.0");

      const audits = await auditActions(deviceId);
      expect(audits.filter((r) => r.action === "device.runtime_update_requested")).toHaveLength(2);
      expect(audits.find((r) => r.action === "device.runtime_update_requested")).toMatchObject({
        actor_kind: "user",
        metadata: { runtime: "codex" },
      });
      for (const row of audits) expect(JSON.stringify(row.metadata)).not.toContain(cli.home);
    },
  );
});

test("a member sees the device's compatibility but no maintenance details, and may neither update nor read the history", async () => {
  test.skip(test.info().project.name !== "desktop", DESKTOP_ONLY);
  test.setTimeout(180_000);
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  const sam = await apiAs(SAM);
  await withUpdatingDevice(
    admin,
    {
      orgLevel: null,
      registry: { claude: "2.1.290", codex: "0.164.0" },
      installed: { claude: "2.1.290", codex: "0.164.0" },
    },
    async ({ device }) => {
      const { deviceId } = device;
      await expect
        .poll(async () => (await ownerRuntimeStatus(admin, deviceId, "claude-code"))?.installedVersion, {
          timeout: 60_000,
          message: "the owner sees the maintenance status",
        })
        .toBe("2.1.290");

      // D-06, D-11, PD-05: Sam sees the device and its compatibility, never the install method, state or history.
      const seen = await deviceAs(sam, deviceId);
      expect(seen, "Sam sees the device").not.toBeNull();
      expect(seen?.runtimeMaintenance).toBeUndefined();
      expect(seen?.runtimeCompatibility).toEqual({ "claude-code": "supported", codex: "supported" });
      expect(JSON.stringify(seen)).not.toMatch(/codex_standalone|claude update|\.local/);

      const update = await sam.post(`/api/v1/devices/${deviceId}/runtimes/claude-code/update`);
      expect(update.status()).toBe(403);
      const history = await sam.get(`/api/v1/devices/${deviceId}/runtime-updates`);
      expect(history.status()).toBe(403);
      expect(await historyOf(admin, deviceId, "claude-code")).toEqual([]);
      expect((await auditActions(deviceId)).map((r) => r.action)).not.toContain(
        "device.runtime_update_requested",
      );
    },
  );
});

test("with the organization's level off the device never asks the registry and Update now is refused", async () => {
  test.skip(test.info().project.name !== "desktop", DESKTOP_ONLY);
  test.setTimeout(180_000);
  const admin = await apiAs(ADMIN);
  await withUpdatingDevice(
    admin,
    {
      orgLevel: "off",
      registry: { claude: "2.1.300", codex: "0.165.0" },
      installed: { claude: "2.1.290", codex: "0.164.0" },
    },
    async ({ device, registry, cli }) => {
      const { deviceId } = device;
      // runtime.config (level off) reached the device: its snapshot says so, and it still reports what is installed.
      await expect
        .poll(
          async () => {
            const d = await deviceAs(admin, deviceId);
            const claude = d?.runtimeMaintenance?.runtimes.find((r) => r.runtime === "claude-code");
            return {
              effectiveLevel: d?.runtimeMaintenance?.effectiveLevel,
              installedVersion: claude?.installedVersion,
              latestVersion: claude?.latestVersion,
              advisory: claude?.advisory,
            };
          },
          { timeout: 60_000, message: "the device reports level off" },
        )
        .toEqual({
          effectiveLevel: "off",
          installedVersion: "2.1.290",
          latestVersion: null,
          advisory: "unknown",
        });

      await device.runtimeCli(["updates", "check"]);
      await new Promise((r) => setTimeout(r, 2_000));
      expect(registry.requests(), "no registry request from a device at off (D-02)").toEqual([]);

      const res = await admin.post(`/api/v1/devices/${deviceId}/runtimes/claude-code/update`);
      expect(res.status()).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("runtime_updates_off");
      expect(cli.version("claude-code")).toBe("2.1.290 (Claude Code)");
      expect(await historyOf(admin, deviceId, "claude-code")).toEqual([]);
      expect(registry.requests()).toEqual([]);
    },
  );
});
