import { describe, expect, it } from "vitest";
import { createSandboxes } from "./sandboxes";
import { OCW_RUN } from "./spec";
import { type ExecCall, FakeDocker } from "./testing/fake-docker";
import { testPolicy } from "./testing/policy";

/**
 * `ocw_sandbox_process` kill (07.8-04, D-02) on a loaded Docker daemon. `ocw-run <id>` records its process group in
 * /tmp/ocw-proc/<id> once its shell has started; `ocw-run --kill <id>` signals that group and exits 3 while there is
 * no record yet. Docker answers the exec start's hijack before runc has spawned the process, so on a slow daemon the
 * kill helper can run before the command has recorded itself (CI p144, sandbox-smoke: `process kill → running` 9.2 s
 * after the start, the `sleep 300` untouched). A kill must not be a silent no-op then.
 */

const ORG = "0199f0a0-0000-7000-8000-00000000000a";
const AGENT = "0199f0a0-1111-7000-8000-00000000000b";
const target = { orgId: ORG, agentId: AGENT };

/** A long command whose process group is recorded only after `registerAfterMs` (a slow runc exec start). */
function slowStartingCommand(docker: FakeDocker, registerAfterMs: number) {
  let registered = false;
  let killed: (() => void) | null = null;
  const helperExits: number[] = [];
  docker.onExec = (call: ExecCall) => {
    if (call.cmd[0] === OCW_RUN && call.cmd[1] === "--kill") {
      if (!registered) {
        helperExits.push(3);
        return { exitCode: 3 };
      }
      killed?.();
      helperExits.push(0);
      return { exitCode: 0 };
    }
    if (call.cmd[0] === OCW_RUN && call.cmd.includes("sleep")) {
      setTimeout(() => {
        registered = true;
      }, registerAfterMs);
      // Runs until its group is signalled; SIGKILL reads as 137.
      return new Promise((resolve) => {
        killed = () => resolve({ exitCode: 137 });
      });
    }
    return { exitCode: 0 };
  };
  return { helperExits };
}

async function stack() {
  const docker = new FakeDocker();
  const sandboxes = createSandboxes({ docker, ns: "ocw-unit", runtime: "auto", image: "sbx:test" });
  sandboxes.setPolicy(testPolicy(ORG));
  await sandboxes.ensure(target);
  return { docker, sandboxes };
}

describe("process kill: the kill reaches a command that has not recorded its group yet", () => {
  it("retries `ocw-run --kill` while it answers 3 (no record yet) and reports the process exited", async () => {
    const { docker, sandboxes } = await stack();
    const { helperExits } = slowStartingCommand(docker, 400);
    const started = await sandboxes.exec({
      target,
      argv: ["sleep", "300"],
      cwd: "",
      timeoutMs: 600_000,
      yieldMs: 0,
    });
    expect(started).toMatchObject({ status: "running" });
    const processId = (started as { processId: string }).processId;

    const t0 = Date.now();
    const res = await sandboxes.process({ target, processId, action: "kill" });
    const elapsed = Date.now() - t0;

    expect(res).toMatchObject({ status: "exited", exitCode: 137 });
    // The first attempt found no record; a later one signalled the group.
    expect(helperExits[0]).toBe(3);
    expect(helperExits.at(-1)).toBe(0);
    // Well inside the 5 s the kill waits for the end, so the answer is the kill's result, not a timeout.
    expect(elapsed).toBeLessThan(2_000);
  }, 10_000);

  it("stops retrying once the command has ended on its own (no endless helper execs)", async () => {
    const { docker, sandboxes } = await stack();
    let finish: (() => void) | null = null;
    docker.onExec = (call: ExecCall) => {
      if (call.cmd[1] === "--kill") return { exitCode: 3 };
      return new Promise((resolve) => {
        finish = () => resolve({ exitCode: 0 });
      });
    };
    const started = await sandboxes.exec({ target, argv: ["true"], cwd: "", timeoutMs: 60_000, yieldMs: 0 });
    const processId = (started as { processId: string }).processId;
    setTimeout(() => finish?.(), 300);
    const res = await sandboxes.process({ target, processId, action: "kill" });
    expect(res).toMatchObject({ status: "exited", exitCode: 0 });
    const helpers = docker.execCreates.filter((c) => (c.body as { Cmd: string[] }).Cmd[1] === "--kill");
    // Bounded by the command's own end (~300 ms at one attempt per 100 ms), never the whole 5 s budget.
    expect(helpers.length).toBeGreaterThan(0);
    expect(helpers.length).toBeLessThan(10);
  }, 10_000);
});
