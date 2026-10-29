// `ocw-runtime setup` (07.12-08, HSR-02, D-02, D-06, D-14, PD-13). Every dependency is a fake: no real pairing, server,
// service manager, daemon or `~/.ocw` (PD-19). The CLI half (a spawned `ocw-runtime setup`) lives in cli.test.ts.

import { describe, expect, it } from "vitest";
import type { DoctorReport } from "./doctor.js";
import type { EnrollResult } from "./enroll.js";
import { PairingCancelledError, PairingError } from "./pair.js";
import type { InstallResult } from "./service/index.js";
import { parseSetupArgs, runSetup, type SetupArgs, type SetupDeps, SetupUsageError } from "./setup.js";

const SERVER = "https://ocw.example.com";
const WEB = "https://app.example.com";
const USER_HOME = "/home/alice";
const HOME = "/home/alice/.ocw";

function report(fail = 0): DoctorReport {
  return {
    account: "alice",
    device: "rack-1",
    checks: [
      { id: "node", status: "ok", summary: "Node 24.22.1", fix: null },
      ...(fail > 0
        ? [{ id: "claude-code" as const, status: "fail" as const, summary: "broken", fix: "reinstall" }]
        : []),
    ],
    link: `${WEB}/settings/devices`,
    counts: { ok: 1, warn: 0, fail },
    checkedAt: "2026-10-29T00:00:00.000Z",
  };
}

interface Harness {
  deps: SetupDeps;
  calls: string[];
  stdout: string[];
  stderr: string[];
  prompts: string[];
  /** Mutable fake state. */
  state: {
    token: string | null;
    tokenState: "valid" | "revoked" | "unreachable";
    paired: { serverUrl?: string; deviceName?: string; webUrl?: string };
    registered: Set<string>;
  };
}

function harness(over: Partial<SetupDeps> & { answers?: string[]; doctorFails?: number } = {}): Harness {
  const calls: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const prompts: string[] = [];
  const answers = [...(over.answers ?? [])];
  const state: Harness["state"] = {
    token: null,
    tokenState: "valid",
    paired: {},
    registered: new Set(),
  };
  const deps: SetupDeps = {
    home: HOME,
    userHome: USER_HOME,
    env: {},
    isTTY: false,
    account: "alice",
    uid: 1000,
    hostname: () => "box-7",
    prompt: async (question) => {
      prompts.push(question);
      const a = answers.shift();
      if (a === undefined) throw new Error(`unexpected prompt: ${question}`);
      return a;
    },
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    installInfo: async () => null,
    pairedState: async () => ({ ...state.paired }),
    token: async () => {
      calls.push("token");
      return state.token;
    },
    tokenCheck: async (serverUrl) => {
      calls.push(`tokenCheck ${serverUrl}`);
      return state.tokenState;
    },
    pair: async ({ serverUrl, name }): Promise<EnrollResult> => {
      calls.push(`pair ${serverUrl} ${name}`);
      state.token = "dt_fake";
      state.paired = { serverUrl, deviceName: name, webUrl: WEB };
      return {
        deviceId: "3f0c1a8e-6c55-4b8e-9d0e-0d3c6d8b9a11",
        organizationId: "7b3e2c51-41f4-4a3e-a5d8-9c1b2e4f6a70",
        name,
        serverUrl,
        tokenPath: `${HOME}/device-token`,
        webUrl: WEB,
        pairedWith: { organization: "Acme", owner: "Ada", at: "2026-10-29T00:00:00.000Z" },
      };
    },
    registry: {
      add: async (path) => {
        calls.push(`add ${path}`);
        const added = !state.registered.has(path);
        state.registered.add(path);
        return {
          added,
          project: {
            localId: "lp_1",
            path,
            name: path.split("/").pop() ?? "repo",
            gitRemote: null,
            defaultBranch: "main",
            addedAt: "2026-10-29T00:00:00.000Z",
          },
        };
      },
    },
    service: {
      detect: async () => {
        calls.push("service.detect");
        return { kind: "systemd-user", available: true, reason: null };
      },
      install: async (opts): Promise<InstallResult> => {
        calls.push(`service.install ${opts?.manager ?? ""}`);
        return {
          ok: true,
          manager: "systemd-user",
          unitPath: "~/.config/systemd/user/ocw-runtime.service",
          outcome: "installed",
          active: true,
          lines: ["The service runs as alice: sign Claude Code and Codex in as alice."],
        };
      },
      restart: async () => {
        calls.push("service.restart");
        return { ok: true, lines: ["Restarted ocw-runtime.service"] };
      },
    },
    doctor: async () => {
      calls.push("doctor");
      return report(over.doctorFails ?? 0);
    },
    daemonStatus: async () => null,
    ...over,
  };
  return { deps, calls, stdout, stderr, prompts, state };
}

const flagsArgs = (over: Partial<SetupArgs> = {}): SetupArgs => ({
  yes: true,
  server: SERVER,
  name: "rack-1",
  projects: [`${USER_HOME}/repo`],
  service: "none",
  ...over,
});

describe("parseSetupArgs (07.12-08, D-02)", () => {
  it("reads every flag, --project repeated, --flag=value too", () => {
    expect(
      parseSetupArgs([
        "--yes",
        "--server",
        SERVER,
        "--name=rack-1",
        "--project",
        "a",
        "--project=b",
        "--service",
        "none",
      ]),
    ).toEqual({ yes: true, server: SERVER, name: "rack-1", projects: ["a", "b"], service: "none" });
    expect(parseSetupArgs([])).toEqual({ yes: false, projects: [] });
  });

  it("refuses unknown flags, missing values and bad service kinds", () => {
    expect(() => parseSetupArgs(["--nope"])).toThrow(SetupUsageError);
    expect(() => parseSetupArgs(["--server"])).toThrow(/--server needs a value/);
    expect(() => parseSetupArgs(["--service", "docker"])).toThrow(/user\|system\|none/);
  });
});

describe("runSetup --yes … --service none (07.12-08 tracer, D-02, D-06, PD-13)", () => {
  it("first run: token check, pairing, project, no service, doctor, then the Settings › Devices link", async () => {
    const h = harness({ doctorFails: 1 });
    const code = await runSetup(flagsArgs(), h.deps);
    expect(code).toBe(0);
    expect(h.calls).toEqual(["token", `pair ${SERVER} rack-1`, `add ${USER_HOME}/repo`, "doctor"]);
    const text = h.stdout.join("\n");
    expect(text).toContain('Paired "rack-1" with Acme as Ada.');
    expect(text).toContain('Registered "repo" (~/repo).');
    expect(text).toContain("run `ocw-runtime run` under your own supervisor");
    expect(text).toContain("1 failure");
    expect(h.stdout.slice(-2)).toEqual([
      `Settings › Devices: ${WEB}/settings/devices`,
      "Share it with members and teams there.",
    ]);
  });

  it("second run with the same args changes nothing and says each step is already done", async () => {
    const h = harness();
    expect(await runSetup(flagsArgs(), h.deps)).toBe(0);
    h.calls.length = 0;
    h.stdout.length = 0;
    expect(await runSetup(flagsArgs(), h.deps)).toBe(0);
    expect(h.calls).toEqual(["token", `tokenCheck ${SERVER}`, `add ${USER_HOME}/repo`, "doctor"]);
    const text = h.stdout.join("\n");
    expect(text).toContain(`Already paired as "rack-1" with ${SERVER}`);
    expect(text).toContain("~/repo is already registered");
    expect(h.stdout.at(-1)).toBe("Share it with members and teams there.");
  });

  it("a denied pairing ends with its line and exit 1, before projects or the service", async () => {
    const h = harness({
      pair: async () => {
        throw new PairingError("The pairing was denied in Settings › Devices.", "denied");
      },
    });
    expect(await runSetup(flagsArgs(), h.deps)).toBe(1);
    expect(h.stderr.join("\n")).toContain("The pairing was denied");
    expect(h.calls).toEqual(["token"]);
  });

  it("Ctrl-C while pairing: exit 130 and nothing after it runs", async () => {
    const h = harness({
      pair: async () => {
        throw new PairingCancelledError();
      },
    });
    expect(await runSetup(flagsArgs(), h.deps)).toBe(130);
    expect(h.stderr.join("\n")).toContain("Pairing cancelled.");
    expect(h.calls).toEqual(["token"]);
  });

  it("a project that cannot be registered fails the step (exit 1)", async () => {
    const h = harness({
      registry: {
        add: async () => {
          throw new Error("path does not exist");
        },
      },
    });
    expect(await runSetup(flagsArgs(), h.deps)).toBe(1);
    expect(h.stderr.join("\n")).toContain("path does not exist");
  });
});
