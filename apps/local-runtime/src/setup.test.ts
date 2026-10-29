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

describe("runSetup: the service step (07.12-08, D-04, D-14, PD-13, RESEARCH Pitfall 7)", () => {
  it("--service user installs after pairing and projects, then prints the next steps", async () => {
    const h = harness();
    expect(await runSetup(flagsArgs({ service: "user" }), h.deps)).toBe(0);
    expect(h.calls).toEqual([
      "token",
      `pair ${SERVER} rack-1`,
      `add ${USER_HOME}/repo`,
      "service.detect",
      "service.install systemd-user",
      "doctor",
    ]);
    const text = h.stdout.join("\n");
    expect(text).toContain("The service runs as alice");
    expect(text).toContain("~/.config/systemd/user/ocw-runtime.service");
    expect(text).toContain("ocw-runtime service status");
    expect(text).toContain("ocw-runtime service logs");
  });

  it("a service that ran unpaired is restarted after pairing", async () => {
    const h = harness({ daemonStatus: async () => ({ paired: false, sessions: 0 }) });
    h.deps.service.detect = async () => ({ kind: "launchd", available: true, reason: null });
    h.deps.service.install = async (opts) => {
      h.calls.push(`service.install ${opts?.manager ?? ""}`);
      return {
        ok: true,
        manager: "launchd",
        unitPath: "~/Library/LaunchAgents/org.ocw.runtime.plist",
        outcome: "unchanged",
        active: true,
        lines: [],
      };
    };
    h.deps.service.restart = async () => {
      h.calls.push("service.restart");
      return { ok: true, lines: ["Restarted org.ocw.runtime"] };
    };
    expect(await runSetup(flagsArgs({ service: "user" }), h.deps)).toBe(0);
    expect(h.calls).toEqual([
      "token",
      `pair ${SERVER} rack-1`,
      `add ${USER_HOME}/repo`,
      "service.install launchd",
      "service.restart",
      "doctor",
    ]);
    expect(h.stdout.join("\n")).toContain("Restarted org.ocw.runtime");
  });

  it("never restarts a daemon that reports a running session: it prints the restart command instead", async () => {
    let n = 0;
    const h = harness({
      daemonStatus: async () => (n++ === 0 ? { paired: false, sessions: 0 } : { paired: false, sessions: 1 }),
    });
    h.deps.service.install = async () => ({
      ok: true,
      manager: "systemd-user",
      unitPath: "~/.config/systemd/user/ocw-runtime.service",
      outcome: "unchanged",
      active: true,
      lines: [],
    });
    expect(await runSetup(flagsArgs({ service: "user" }), h.deps)).toBe(0);
    expect(h.calls).not.toContain("service.restart");
    expect(h.stdout.join("\n")).toContain("ocw-runtime service restart");
  });

  it("a fresh install starts the paired runtime: no extra restart", async () => {
    const h = harness({ daemonStatus: async () => null });
    expect(await runSetup(flagsArgs({ service: "user" }), h.deps)).toBe(0);
    expect(h.calls).not.toContain("service.restart");
  });

  it("--yes without --service on a machine with no manager: the supervisor line, and setup goes on", async () => {
    const h = harness();
    h.deps.service.detect = async () => ({
      kind: "none",
      available: false,
      reason:
        "systemd is not running here: run `ocw-runtime run` under your own supervisor (Docker restart policy, tmux, supervisord)",
    });
    const { service: _omit, ...args } = flagsArgs();
    expect(await runSetup(args, h.deps)).toBe(0);
    expect(h.calls.some((c) => c.startsWith("service.install"))).toBe(false);
    expect(h.stdout.join("\n")).toContain("run `ocw-runtime run` under your own supervisor");
    expect(h.calls).toContain("doctor");
  });

  it("--yes without --service where a manager exists installs the user service", async () => {
    const h = harness();
    const { service: _omit, ...args } = flagsArgs();
    expect(await runSetup(args, h.deps)).toBe(0);
    expect(h.calls).toContain("service.install systemd-user");
  });

  it("--service user on a machine without a manager: exit 1 with the manager's reason", async () => {
    const h = harness();
    h.deps.service.detect = async () => ({
      kind: "systemd-user",
      available: false,
      reason: "the systemd user manager of alice is not reachable from this shell",
    });
    expect(await runSetup(flagsArgs({ service: "user" }), h.deps)).toBe(1);
    expect(h.stderr.join("\n")).toContain("not reachable from this shell");
    expect(h.calls).not.toContain("doctor");
  });

  it("a conflicting runtime on the account: exit 1 with install's message (D-14)", async () => {
    const h = harness();
    h.deps.service.install = async () => ({
      ok: false,
      error: "the desktop app supervises a runtime on this account; use one or the other",
      lines: [],
    });
    expect(await runSetup(flagsArgs({ service: "user" }), h.deps)).toBe(1);
    expect(h.stderr.join("\n")).toContain("the desktop app supervises a runtime");
  });

  it("--service none while an unpaired runtime runs: says to restart it", async () => {
    const h = harness({ daemonStatus: async () => ({ paired: false, sessions: 0 }) });
    expect(await runSetup(flagsArgs(), h.deps)).toBe(0);
    expect(h.stdout.join("\n")).toContain("restart it so it connects with the new pairing");
  });

  it("--service system: refused as root and for another account; as that account it prints the root command", async () => {
    const sys = flagsArgs({ service: "system", userName: "alice" });
    const root = harness({ uid: 0, account: "root" });
    expect(await runSetup(sys, root.deps)).toBe(2);
    expect(root.stderr.join("\n")).toContain("sudo -u alice -i ocw-runtime setup");
    expect(root.calls).toEqual([]);

    const other = harness({ account: "bob" });
    expect(await runSetup(sys, other.deps)).toBe(2);
    expect(other.calls).toEqual([]);

    const h = harness();
    h.deps.service.detect = async (opts) => {
      h.calls.push(`service.detect ${opts?.system ? "system" : ""}`);
      return { kind: "systemd-system", available: true, reason: null };
    };
    expect(await runSetup(sys, h.deps)).toBe(0);
    expect(h.calls).toContain("service.detect system");
    expect(h.calls.some((c) => c.startsWith("service.install"))).toBe(false);
    expect(h.stdout.join("\n")).toContain(
      'sudo "$(command -v ocw-runtime)" service install --system --user-name alice',
    );
  });

  it("parseSetupArgs: --service system without --user-name names --user-name", () => {
    expect(() => parseSetupArgs(["--service", "system"])).toThrow(/--user-name/);
    expect(() => parseSetupArgs(["--user-name", "alice"])).toThrow(/--service system/);
  });
});
