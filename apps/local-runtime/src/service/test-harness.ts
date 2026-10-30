// Test-only helpers for the service module (07.12-04, PD-19): a temp filesystem root that holds a fake machine
// (`/home/alice`, `/opt/node/bin/node`, `/run/systemd/system`, …) and a fake exec that records every command. Nothing
// here reaches a real service manager or the developer's home.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ControlRequest } from "../control-socket.js";
import type { ServiceExecFn, ServiceExecResult } from "./exec.js";
import type { ServiceDeps } from "./index.js";

export type ExecHandler = (argv: string[]) => Partial<ServiceExecResult> | undefined;

export interface Harness {
  root: string;
  deps: ServiceDeps;
  calls: string[][];
  lines: string[];
  /** Absolute path of a machine path inside the temp root. */
  at: (p: string) => string;
  write: (p: string, content: string) => void;
  cleanup: () => void;
}

const roots: string[] = [];

export function cleanupRoots(): void {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}

export const NODE = "/opt/node/bin/node";

export function installRecord(nodePath = NODE): string {
  return JSON.stringify({
    serverUrl: "https://ocw.example.com",
    version: "0.1.0",
    sha256: "a".repeat(64),
    installedAt: "2026-10-29T10:00:00.000Z",
    nodePath,
  });
}

/**
 * A fake machine. `home` is the account's home inside the root; the runtime is installed under `<home>/.ocw` unless
 * `installed` is false. `exec` answers each command (joined argv); unanswered commands exit 0 with empty output.
 */
export function harness(
  opts: {
    platform?: NodeJS.Platform;
    uid?: number;
    account?: string;
    home?: string;
    ocwHome?: string;
    installed?: boolean;
    systemd?: boolean;
    env?: NodeJS.ProcessEnv;
    exec?: ExecHandler;
    controlRequest?: ServiceDeps["controlRequest"];
    kill?: ServiceDeps["kill"];
  } = {},
): Harness {
  const root = mkdtempSync(join(tmpdir(), "ocw-svc-"));
  roots.push(root);
  const at = (p: string) => join(root, p);
  const write = (p: string, content: string) => {
    mkdirSync(dirname(at(p)), { recursive: true });
    writeFileSync(at(p), content);
  };
  const platform = opts.platform ?? "linux";
  const home = opts.home ?? (platform === "darwin" ? "/Users/alice" : "/home/alice");
  const ocwHome = opts.ocwHome ?? join(home, ".ocw");
  mkdirSync(at(home), { recursive: true });
  for (const d of ["/usr/bin", "/bin", "/opt/node/bin"]) mkdirSync(at(d), { recursive: true });
  write(NODE, "#!/bin/sh\n");
  if (opts.systemd !== false && platform === "linux")
    mkdirSync(at("/run/systemd/system"), { recursive: true });
  if (opts.installed !== false) {
    write(join(ocwHome, "runtime", "install.json"), installRecord());
    write(join(ocwHome, "runtime", "current", "ocw-runtime.mjs"), "// bundle\n");
  }
  const calls: string[][] = [];
  const lines: string[] = [];
  const exec: ServiceExecFn = async (file, args) => {
    const argv = [file, ...args];
    calls.push(argv);
    const answer = opts.exec?.(argv) ?? {};
    return { code: 0, stdout: "", stderr: "", ...answer };
  };
  const controlRequest: ServiceDeps["controlRequest"] =
    opts.controlRequest ??
    (async (_path: string, _req: ControlRequest) => {
      throw Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });
    });
  const deps: ServiceDeps = {
    platform,
    uid: opts.uid ?? (platform === "darwin" ? 501 : 1000),
    account: opts.account ?? "alice",
    home,
    ocwHome,
    env: opts.env ?? { PATH: "/opt/node/bin:/usr/bin:/nonexistent:/bin:/usr/bin" },
    execPath: "/usr/bin/node-current",
    exec,
    which: (name) => (name === "systemctl" ? "/usr/bin/systemctl" : null),
    controlRequest,
    kill:
      opts.kill ??
      (() => {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      }),
    sleep: async () => undefined,
    root,
    out: (line) => lines.push(line),
  };
  return {
    root,
    deps,
    calls,
    lines,
    at,
    write,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
