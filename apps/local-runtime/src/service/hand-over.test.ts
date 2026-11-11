// 07.17.1 (D-05, PD-08, PD-19): `ocw-runtime run` hands the self-update's restart to the service manager. The hook lives
// in a module with no side effects on import (review WR-07), so the test imports it directly; stop and exit are spies,
// nothing exits and no signal is sent.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createShutdownGuard, HAND_OVER_TIMEOUT_MS, selfUpdateExit } from "./hand-over.js";

describe("the self-update exit hook (07.17.1, D-05, PD-08)", () => {
  it("marks the shared stopping guard first, stops the daemon once, then exits with the code", async () => {
    const guard = createShutdownGuard();
    const order: string[] = [];
    let release: () => void = () => undefined;
    const stop = vi.fn(
      () =>
        new Promise<void>((r) => {
          order.push("stop");
          release = r;
        }),
    );
    const exit = vi.fn((code: number) => {
      order.push(`exit:${code}`);
    });
    const hook = selfUpdateExit({ guard, stop, exit });
    const done = hook(75);
    // A SIGTERM arriving now finds the guard set: the exit-0 path does not run (the signal handler reads this guard).
    expect(guard.stopping).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    release();
    await done;
    expect(order).toEqual(["stop", "exit:75"]);
    // A second call does nothing.
    await hook(75);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("a stop that rejects still exits with the code", async () => {
    const stop = vi.fn(async () => {
      throw new Error("boom");
    });
    const exit = vi.fn((_code: number) => undefined);
    await selfUpdateExit({ guard: createShutdownGuard(), stop, exit })(75);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(75);
  });

  it("a stop that hangs still exits with the code after the hand-over timeout", async () => {
    expect(HAND_OVER_TIMEOUT_MS).toBe(10_000);
    const stop = vi.fn(() => new Promise<void>(() => undefined));
    const exit = vi.fn((_code: number) => undefined);
    await selfUpdateExit({ guard: createShutdownGuard(), stop, exit, timeoutMs: 20 })(75);
    expect(exit).toHaveBeenCalledWith(75);
  });

  it("after a signal began stopping, the hook does nothing (the signal's exit 0 stands)", async () => {
    const guard = createShutdownGuard();
    guard.stopping = true;
    const stop = vi.fn(async () => undefined);
    const exit = vi.fn((_code: number) => undefined);
    await selfUpdateExit({ guard, stop, exit })(75);
    expect(stop).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("each guard is its own: a fresh guard is not stopping", () => {
    const a = createShutdownGuard();
    a.stopping = true;
    expect(createShutdownGuard().stopping).toBe(false);
  });
});

describe("cli.ts runs its command on every import (review WR-07)", () => {
  it("has no import-only switch and calls main() unconditionally", () => {
    const source = readFileSync(join(import.meta.dirname, "..", "cli.ts"), "utf8");
    expect(source).not.toContain("__OCW_CLI_IMPORT_ONLY__");
    expect(source).not.toMatch(/export\s+(const|function)\s+(cliShutdown|selfUpdateExit)/);
    expect(source).toMatch(/^main\(process\.argv\.slice\(2\)\)/m);
  });
});
