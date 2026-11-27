import { type APIRequestContext, expect } from "@playwright/test";
import type { DeviceHostKind } from "../../packages/contracts/src/device.ts";
import type { SessionAudienceInput } from "../../packages/contracts/src/work-session.ts";
import { type FakeDeviceHandle, startFakeDevice } from "./work-zone-device";
import { shareDevice } from "./work-zone-projects";

/**
 * Session owners (Phase 07.13.1.1, D-02 … D-05, D-15): the two shared fake devices `work-zone-session-owners.spec.ts`
 * needs, and its session helpers. Both devices are REAL local-runtime daemons in fake-runtime mode, paired by the
 * admin, one running as a headless service (`OCW_RUNTIME_HOST=service`: a server, where Assign to me is offered) and
 * one as the desktop app (`OCW_RUNTIME_HOST=desktop`: refused with "Only sessions on a server can be assigned.").
 * Each is shared with the spec's people the way `work-zone-shared-devices.spec.ts` shares a device (a per-person
 * grant, ADR-0012), so nobody else on the shared stack can use them. Only the public API is used.
 */

export interface OwnerDevices {
  server: FakeDeviceHandle;
  desktop: FakeDeviceHandle;
  /** Names as the people view and the session rows show them. */
  names: { server: string; desktop: string };
  stop(): Promise<void>;
}

/** Polls `GET /devices` until the device reports how its daemon runs (the daemon reports it after it connects). */
async function hostKindReported(admin: APIRequestContext, deviceId: string, kind: DeviceHostKind) {
  await expect
    .poll(
      async () => {
        const { devices } = (await (await admin.get("/api/v1/devices")).json()) as {
          devices: Array<{ id: string; hostKind?: string | null }>;
        };
        return devices.find((d) => d.id === deviceId)?.hostKind ?? null;
      },
      { timeout: 30_000, message: `the device reports hostKind ${kind}` },
    )
    .toBe(kind);
}

/**
 * Starts the server and the desktop device (names carry `run`, so a retry never meets an earlier attempt's devices)
 * and shares both with `shareWith` (user ids) up to Supervised. `stop()` stops and revokes both.
 */
export async function startOwnerDevices(
  admin: APIRequestContext,
  run: string,
  opts: { shareWith: string[] },
): Promise<OwnerDevices> {
  const started: FakeDeviceHandle[] = [];
  const stop = async () => {
    for (const d of started) await d.stop().catch(() => undefined);
  };
  try {
    const names = { server: `E2E Owners server ${run}`, desktop: `E2E Owners laptop ${run}` };
    const server = await startFakeDevice(admin, {
      name: names.server,
      projectName: `wzo-server-${run}`,
      env: { OCW_RUNTIME_HOST: "service" },
    });
    started.push(server);
    const desktop = await startFakeDevice(admin, {
      name: names.desktop,
      projectName: `wzo-laptop-${run}`,
      env: { OCW_RUNTIME_HOST: "desktop" },
    });
    started.push(desktop);
    await hostKindReported(admin, server.deviceId, "service");
    await hostKindReported(admin, desktop.deviceId, "desktop");
    for (const d of started) {
      for (const userId of opts.shareWith) await shareDevice(admin, d.deviceId, userId, "default");
    }
    return { server, desktop, names, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

/** Starts a Claude Code session in plan mode as the person signed in to `api`; resolves with its id. */
export async function startSessionAs(
  api: APIRequestContext,
  projectId: string,
  opts: { visibility?: SessionAudienceInput; title?: string; prompt?: string } = {},
): Promise<string> {
  const res = await api.post("/api/v1/work-sessions", {
    data: {
      projectId,
      runtime: "claude-code",
      permissionMode: "plan",
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.prompt ? { prompt: opts.prompt } : {}),
      ...(opts.visibility ? { visibility: opts.visibility } : {}),
    },
  });
  expect(res.ok(), `start a session: ${res.status()} ${await res.text()}`).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

/** The session as `api`'s person reads it, or null when the API answers 404 (outside their audience). */
export async function sessionAs(
  api: APIRequestContext,
  sessionId: string,
): Promise<{ status: string; title: string; createdBy: string } | null> {
  const res = await api.get(`/api/v1/work-sessions/${sessionId}`);
  if (res.status() === 404) return null;
  expect(res.ok(), `GET session ${sessionId}: ${res.status()}`).toBe(true);
  return ((await res.json()) as { session: { status: string; title: string; createdBy: string } }).session;
}

/** Waits until the device has settled the session (`idle`), so no turn runs when the spec acts on it. */
export async function waitIdle(api: APIRequestContext, sessionId: string, timeout = 45_000): Promise<void> {
  await expect
    .poll(async () => (await sessionAs(api, sessionId))?.status, {
      timeout,
      message: `session ${sessionId} is idle`,
    })
    .toBe("idle");
}
