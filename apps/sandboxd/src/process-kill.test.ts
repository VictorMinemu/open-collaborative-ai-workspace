import { describe, expect, it } from "vitest";
import { createSandboxes, type SandboxdEventInput } from "./sandboxes";
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

/**
 * 07.17.1.1.2-11 (D-03, PD-13): a command sandboxd answered `running` for (`yielded`) emits exactly one `process` event
 * when it ends (`exited` with its exit code, `killed` through `/process`, `timed_out` by its timeout or the backstop),
 * ids and numbers only. A command that ended within its yield emits none (the bot already has its result).
 */
describe("the process event of a background command", () => {
  async function eventStack() {
    const docker = new FakeDocker();
    const seen: SandboxdEventInput[] = [];
    const sandboxes = createSandboxes({
      docker,
      ns: "ocw-unit",
      runtime: "auto",
      image: "sbx:test",
      onEvent: (e) => seen.push(e),
    });
    sandboxes.setPolicy(testPolicy(ORG));
    await sandboxes.ensure(target);
    const processEvents = () => seen.filter((e) => e.type === "process");
    return { docker, sandboxes, processEvents };
  }

  /** A command that ends by itself after `ms` with `exitCode`, or when its group is killed (137). */
  function timedCommand(docker: FakeDocker, ms: number, exitCode: number) {
    let killed: (() => void) | null = null;
    docker.onExec = (call: ExecCall) => {
      if (call.cmd[1] === "--kill") {
        killed?.();
        return { exitCode: 0 };
      }
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve({ exitCode, stdout: "SENTINEL-output-4c1d\n" }), ms);
        killed = () => {
          clearTimeout(t);
          resolve({ exitCode: 137 });
        };
      });
    };
  }

  async function until(check: () => boolean, ms = 3_000): Promise<void> {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error("condition not met in time");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  const run = (sandboxes: Awaited<ReturnType<typeof eventStack>>["sandboxes"], timeoutMs = 60_000) =>
    sandboxes.exec({ target, argv: ["ocw-extract", "SENTINEL-argv-9e2f"], cwd: "", timeoutMs, yieldMs: 0 });

  it("ends by itself: one exited event with its exit code, nobody polling; ids and numbers only", async () => {
    const { docker, sandboxes, processEvents } = await eventStack();
    timedCommand(docker, 150, 75);
    const started = await run(sandboxes);
    expect(started).toMatchObject({ status: "running" });
    const processId = (started as { processId: string }).processId;
    await until(() => processEvents().length > 0);
    await new Promise((r) => setTimeout(r, 100));
    const list = processEvents();
    expect(list).toHaveLength(1);
    const [e] = list;
    expect(Object.keys(e ?? {}).sort()).toEqual([
      "durationMs",
      "exitCode",
      "processId",
      "status",
      "target",
      "type",
    ]);
    expect(e).toMatchObject({ type: "process", target, processId, status: "exited", exitCode: 75 });
    expect((e as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(100);
    expect(JSON.stringify(list)).not.toMatch(/SENTINEL|ocw-extract|workspace/u);
  });

  it("a poll racing the stream end still emits it once", async () => {
    const { docker, sandboxes, processEvents } = await eventStack();
    timedCommand(docker, 120, 0);
    const started = await run(sandboxes);
    const processId = (started as { processId: string }).processId;
    await new Promise((r) => setTimeout(r, 180));
    const polls = await Promise.allSettled(
      [1, 2, 3].map(() => sandboxes.process({ target, processId, action: "poll" })),
    );
    expect(polls.some((p) => p.status === "fulfilled" && p.value.status === "exited")).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(processEvents()).toEqual([expect.objectContaining({ processId, status: "exited", exitCode: 0 })]);
  });

  it("killed through /process: one killed event", async () => {
    const { docker, sandboxes, processEvents } = await eventStack();
    timedCommand(docker, 60_000, 0);
    const started = await run(sandboxes);
    const processId = (started as { processId: string }).processId;
    const res = await sandboxes.process({ target, processId, action: "kill" });
    expect(res).toMatchObject({ status: "exited", exitCode: 137 });
    await until(() => processEvents().length > 0);
    expect(processEvents()).toEqual([
      expect.objectContaining({ processId, status: "killed", exitCode: 137 }),
    ]);
  });

  it("ended by its own timeout (ocw-run's) → timed_out", async () => {
    const { docker, sandboxes, processEvents } = await eventStack();
    // `timeout -s KILL 1` ends the command once its second has passed.
    timedCommand(docker, 1_050, 137);
    const started = await run(sandboxes, 1_000);
    const processId = (started as { processId: string }).processId;
    await until(() => processEvents().length > 0);
    expect(processEvents()).toEqual([
      expect.objectContaining({ processId, status: "timed_out", exitCode: 137 }),
    ]);
  });

  it("ended by the backstop timer (the helper itself hung) → timed_out", async () => {
    const { docker, sandboxes, processEvents } = await eventStack();
    timedCommand(docker, 60_000, 0);
    const started = await run(sandboxes, 1_000);
    const processId = (started as { processId: string }).processId;
    // The backstop fires at the timeout plus its 5 s grace and kills the group.
    await until(() => processEvents().length > 0, 8_000);
    expect(processEvents()).toEqual([expect.objectContaining({ processId, status: "timed_out" })]);
  }, 12_000);

  it("a command that ended within its yield emits no process event", async () => {
    const { docker, sandboxes, processEvents } = await eventStack();
    docker.onExec = () => ({ exitCode: 0 });
    const res = await sandboxes.exec({ target, argv: ["true"], cwd: "", timeoutMs: 60_000, yieldMs: 2_000 });
    expect(res).toMatchObject({ status: "exited", exitCode: 0 });
    await new Promise((r) => setTimeout(r, 100));
    expect(processEvents()).toEqual([]);
  });
});
