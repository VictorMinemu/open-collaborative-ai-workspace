// Phase 07.11-09 (RTU-07, D-08, D-09): the headless Linux proof. These cases run ONLY inside the throwaway container
// `scripts/runtime-update-proof.sh` starts (`OCW_RUNTIME_PROOF=1`, Linux, a non-root user); everywhere else, the Mac and
// `pnpm verify` included, the suite is reported as skipped. They drive the real resolver, registry client, runner and
// orchestrator against copies of the fake CLI in scratch homes, a registry stub on 127.0.0.1 and a root-owned npm
// prefix the script built as root (`OCW_PROOF_ROOT_PREFIX`). Nothing here runs a real installer or reaches the real
// npm registry (PD-19).

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RUNTIME_COMPATIBILITY_MANIFEST,
  type RuntimeId,
  type RuntimeMaintenanceFrame,
  type RuntimeUpdateRunFrame,
} from "@ocw/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RuntimeGate } from "./gate.js";
import { resolveInstall, updateCommandFor } from "./install-method.js";
import { RuntimeMaintenance, UPDATE_REFUSALS } from "./maintenance.js";
import { defaultLockDir, runUpdate } from "./runner.js";

const PROOF =
  process.env.OCW_RUNTIME_PROOF === "1" &&
  process.platform === "linux" &&
  typeof process.getuid === "function" &&
  process.getuid() !== 0;

const FAKE_CLI = fileURLToPath(new URL("./fake-cli/fake-cli.mjs", import.meta.url));
/** Absolute host-path tokens that must never leave the device (principle 7). */
const HOST_PATH = /\/(home|tmp|opt|usr)\//;

const dirs: string[] = [];
function scratchHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ocw-proof-home-")));
  dirs.push(home);
  execFileSync(process.execPath, [FAKE_CLI, "install-fake", "claude-native", home, "2.1.290"], {
    stdio: "pipe",
  });
  execFileSync(process.execPath, [FAKE_CLI, "install-fake", "codex-standalone", home, "0.164.0"], {
    stdio: "pipe",
  });
  return home;
}

const scratchWhich = (home: string) => (name: string) => {
  const p = join(home, ".local", "bin", name);
  return existsSync(p) ? p : null;
};

function scratchEnv(home: string, registryUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    CODEX_HOME: join(home, ".codex"),
    PATH: [join(home, ".local", "bin"), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    OCW_RUNTIME_REGISTRY_URL: registryUrl,
  };
}

const versionOf = (home: string, bin: "claude" | "codex") =>
  execFileSync(join(home, ".local", "bin", bin), ["--version"], { stdio: "pipe" })
    .toString("utf8")
    .trim();

async function until(
  what: string,
  fn: () => boolean,
  state: () => unknown = () => null,
  timeoutMs = 30_000,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(state())}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Every process whose argv holds `bin` and then `arg`, with its process group (`/proc/<pid>/stat`, field 5). */
function processesRunning(bin: string, arg: string): Array<{ pid: number; pgid: number }> {
  const found: Array<{ pid: number; pgid: number }> = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
      const at = argv.indexOf(bin);
      if (at === -1 || argv[at + 1] !== arg) continue;
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      found.push({ pid: Number(entry), pgid: Number(fields[2]) });
    } catch {
      // the process ended while we looked
    }
  }
  return found;
}

function processesInGroup(pgid: number): number[] {
  const pids: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === pgid) pids.push(Number(entry));
    } catch {
      // gone
    }
  }
  return pids;
}

describe.runIf(PROOF)(
  "runtime updates on a headless Linux daemon, as a non-root user (07.11-09, RTU-07)",
  () => {
    let server: Server;
    let registryUrl = "";
    const latest: Record<string, string> = {
      "/@anthropic-ai%2Fclaude-code/latest": "2.1.300",
      "/@openai%2Fcodex/latest": "0.164.0",
    };
    const outward: string[] = [];

    beforeAll(async () => {
      server = createServer((req, res) => {
        const version = latest[(req.url ?? "").split("?")[0] ?? ""];
        res.writeHead(version ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify(version ? { version } : { error: "Not found" }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      registryUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
      // Every status, frame and output collected below: no absolute host path (principle 7, D-08).
      for (const text of outward) expect(text).not.toMatch(HOST_PATH);
    });

    it("runs as a non-root user", () => {
      expect(process.getuid?.()).not.toBe(0);
    });

    it("a root-owned npm prefix is needs_admin: shown with sudo, never run, Update now refused", {
      timeout: 60_000,
    }, async () => {
      const prefix = process.env.OCW_PROOF_ROOT_PREFIX ?? "";
      expect(prefix, "OCW_PROOF_ROOT_PREFIX (the script builds it as root)").not.toBe("");
      expect(statSync(prefix).uid).toBe(0);
      const home = scratchHome();
      const env = scratchEnv(home, registryUrl);
      const which = (name: string) => (name === "claude" ? join(prefix, "bin", "claude") : null);

      const r = resolveInstall("claude-code", { home, env, which });
      expect(r.method).toBe("npm");
      expect(r.canUpdate).toBe(false);
      expect(r.reason).toBe("needs_admin");
      expect(r.display?.startsWith("sudo npm install -g")).toBe(true);
      expect(r.location).toBeNull();
      expect(updateCommandFor(r, "2.1.300", env)).toBeNull();

      const runs: RuntimeUpdateRunFrame[] = [];
      const m = new RuntimeMaintenance({
        runtimes: [{ id: "claude-code", activeTurns: () => 0, retireIdle: async () => 0 }],
        gates: new Map<RuntimeId, RuntimeGate>([["claude-code", new RuntimeGate()]]),
        userHome: home,
        env,
        which,
        localLevel: "automatic",
        localLevelSource: "env",
        requireScratchHome: true,
        sendRun: (f) => runs.push(f),
      });
      const answer = await m.requestUpdate("claude-code", "local");
      expect(answer).toEqual({ accepted: false, reason: UPDATE_REFUSALS.needsAdmin });
      expect(runs).toEqual([]);
      // The fake npm never ran: it would have left its env report in the prefix.
      expect(existsSync(join(prefix, "fake-update-env.json"))).toBe(false);
      const status = m.statuses().find((s) => s.runtime === "claude-code");
      expect(status).toMatchObject({ method: "npm", canUpdate: false, reason: "needs_admin" });
      outward.push(JSON.stringify(m.statuses()), JSON.stringify(answer));
      m.stop();
    });

    it("a native Claude Code updates once its busy session goes idle; Codex is untouched; the lock dir is 0700", {
      timeout: 90_000,
    }, async () => {
      const home = scratchHome();
      writeFileSync(
        join(home, ".local", "share", "claude", "fake-update.json"),
        JSON.stringify({ next: "2.1.300", delayMs: 200 }),
      );
      const env = scratchEnv(home, registryUrl);
      const claude = { id: "claude-code" as const, turns: 1, retired: 0 };
      const codex = { id: "codex" as const, turns: 0, retired: 0 };
      const adapter = (a: typeof claude | typeof codex) => ({
        id: a.id,
        activeTurns: () => a.turns,
        retireIdle: async () => {
          a.retired++;
          return 0;
        },
      });
      const gates = new Map<RuntimeId, RuntimeGate>([
        ["claude-code", new RuntimeGate()],
        ["codex", new RuntimeGate()],
      ]);
      const snapshots: RuntimeMaintenanceFrame[] = [];
      const runs: RuntimeUpdateRunFrame[] = [];
      const notified: string[] = [];
      const m = new RuntimeMaintenance({
        runtimes: [adapter(claude), adapter(codex)],
        gates,
        userHome: home,
        env,
        which: scratchWhich(home),
        localLevel: "automatic",
        localLevelSource: "env",
        requireScratchHome: true,
        pollMs: 100,
        sendSnapshot: (f) => snapshots.push(f),
        sendRun: (f) => runs.push(f),
        notifySession: (runtime, phase, version) => notified.push(`${runtime}:${phase}:${version ?? ""}`),
      });
      try {
        // The server's runtime.config: without it the effective level stays notify (D-10).
        m.setOrgPolicy("automatic", RUNTIME_COMPATIBILITY_MANIFEST);
        m.start({ paired: false });
        const claudeStatus = () => m.statuses().find((s) => s.runtime === "claude-code");
        const where = () => ({ statuses: m.statuses(), runs });
        await until(
          "Claude Code pending behind its busy session",
          () => claudeStatus()?.state === "pending",
          where,
        );
        expect(claudeStatus()).toMatchObject({
          installedVersion: "2.1.290",
          advisory: "behind",
          method: "native",
        });
        // The busy session is never cut: the gate stays open and nothing ran while it is busy.
        await new Promise((r) => setTimeout(r, 500));
        expect(claudeStatus()?.state).toBe("pending");
        expect(gates.get("claude-code")?.isOpen).toBe(true);
        expect(versionOf(home, "claude")).toBe("2.1.290 (Claude Code)");
        expect(runs).toEqual([]);

        claude.turns = 0;
        m.onRuntimeActivity("claude-code");
        await until(
          "the update finishes",
          () => claudeStatus()?.lastRun?.outcome === "succeeded" && claudeStatus()?.state === "idle",
          where,
        );
        expect(claudeStatus()).toMatchObject({ installedVersion: "2.1.300", advisory: "current" });
        expect(versionOf(home, "claude")).toBe("2.1.300 (Claude Code)");
        expect(claude.retired).toBe(1);
        expect(runs.map((f) => [f.phase, f.outcome ?? null, f.trigger, f.method])).toEqual([
          ["started", null, "automatic", "native"],
          ["finished", "succeeded", "automatic", "native"],
        ]);
        expect(runs[1]).toMatchObject({ fromVersion: "2.1.290", toVersion: "2.1.300" });

        // Codex: current, never run, never retired.
        expect(m.statuses().find((s) => s.runtime === "codex")).toMatchObject({
          installedVersion: "0.164.0",
          advisory: "current",
          state: "idle",
          lastRun: null,
        });
        expect(versionOf(home, "codex")).toBe("codex-cli 0.164.0");
        expect(existsSync(join(home, ".codex", "packages", "standalone", "fake-update-env.json"))).toBe(
          false,
        );
        expect(codex.retired).toBe(0);

        // The installer's env carried no OCW_* variable or API key (PD-11).
        const childEnv = JSON.parse(
          readFileSync(join(home, ".local", "share", "claude", "fake-update-env.json"), "utf8"),
        ) as { names: string[] };
        expect(childEnv.names).toEqual([]);

        const lockDir = defaultLockDir(home);
        expect(lockDir.startsWith(join(home, ".cache", "ocw", "runtime-updates"))).toBe(true);
        expect(statSync(lockDir).mode & 0o777).toBe(0o700);

        outward.push(
          JSON.stringify(m.statuses()),
          JSON.stringify(snapshots),
          JSON.stringify(runs),
          JSON.stringify(notified),
        );
        expect(snapshots.length).toBeGreaterThan(0);
      } finally {
        m.stop();
      }
    });

    it("an update past its timeout fails and its whole process group is killed", {
      timeout: 60_000,
    }, async () => {
      const home = scratchHome();
      const root = join(home, ".local", "share", "claude");
      writeFileSync(join(root, "fake-update.json"), JSON.stringify({ next: "2.1.300", delayMs: 60_000 }));
      const env = scratchEnv(home, registryUrl);
      const resolution = resolveInstall("claude-code", { home, env, which: scratchWhich(home) });
      expect(resolution).toMatchObject({ method: "native", canUpdate: true });

      const lockDir = defaultLockDir(home);
      const running = runUpdate({
        resolution,
        candidate: "2.1.300",
        lockDir,
        home,
        env,
        timeoutMs: 300,
        killGraceMs: 200,
      });
      let seen: Array<{ pid: number; pgid: number }> = [];
      const watch = (async () => {
        const end = Date.now() + 5_000;
        while (Date.now() < end && seen.length === 0) {
          seen = processesRunning(join(home, ".local", "bin", "claude"), "update");
          if (seen.length === 0) await new Promise((r) => setTimeout(r, 10));
        }
      })();
      const result = await running;
      await watch;

      expect(result.outcome).toBe("failed");
      expect(result.toVersion).toBeNull();
      expect(seen.length, "the fake updater was seen running").toBeGreaterThan(0);
      for (const { pid, pgid } of seen) {
        expect(existsSync(`/proc/${pid}`), `process ${pid} is gone`).toBe(false);
        expect(processesInGroup(pgid), `process group ${pgid} is empty`).toEqual([]);
      }
      expect(versionOf(home, "claude")).toBe("2.1.290 (Claude Code)");
      outward.push(JSON.stringify(result));
    });
  },
);

// Off the proof container this file must still load and report its suite as skipped (never failed).
describe.skipIf(PROOF)("runtime updates on a headless Linux daemon (proof container only)", () => {
  it.skip("runs only through scripts/runtime-update-proof.sh (OCW_RUNTIME_PROOF=1, Linux, non-root)", () => {});
});
