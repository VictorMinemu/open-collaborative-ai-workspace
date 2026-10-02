import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@ocw/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { enroll } from "../enroll.js";
import { FakeRuntime } from "./fake-runtime.js";

const dirs: string[] = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "ocw-fake-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function until(events: SessionEvent[], pred: (e: SessionEvent) => boolean) {
  for (let i = 0; i < 200; i++) {
    const hit = events.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no matching event in ${JSON.stringify(events.map((e) => e.type))}`);
}

describe("FakeRuntime", () => {
  it("asks for approval before writing, then writes and completes", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "README.md"), "# Demo\n");
    const events: SessionEvent[] = [];
    const rt = new FakeRuntime("claude-code", 1);
    await rt.start({ sessionId: "s1", cwd, permissionMode: "default" }, (e) => events.push(e));
    await rt.prompt("s1", { promptId: "p1", text: "add notes" });
    const req = await until(events, (e) => e.type === "approval.requested");
    expect(req).toMatchObject({ tool: "Write", paths: ["notes/ocw-change-1.md"] });
    if (req.type !== "approval.requested") throw new Error("unreachable");
    expect(rt.resolveApproval("s1", req.approvalId, "once")).toBe(true);
    await until(events, (e) => e.type === "prompt.completed");
    expect(readFileSync(join(cwd, "notes/ocw-change-1.md"), "utf8")).toContain("add notes");
    expect(events.some((e) => e.type === "assistant.delta")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "session.state", status: "idle" });
  });

  it("plan mode never writes; interrupt completes the turn as interrupted", async () => {
    const cwd = tmp();
    const events: SessionEvent[] = [];
    const rt = new FakeRuntime("codex", 1);
    await rt.start({ sessionId: "s2", cwd, permissionMode: "plan" }, (e) => events.push(e));
    await rt.prompt("s2", { promptId: "p1", text: "plan it" });
    await until(events, (e) => e.type === "prompt.completed");
    expect(existsSync(join(cwd, "notes"))).toBe(false);

    const rt2 = new FakeRuntime("claude-code", 50);
    const ev2: SessionEvent[] = [];
    await rt2.start({ sessionId: "s3", cwd, permissionMode: "default" }, (e) => ev2.push(e));
    await rt2.prompt("s3", { promptId: "p2", text: "long" });
    await rt2.interrupt("s3");
    const done = await until(ev2, (e) => e.type === "prompt.completed");
    expect(done).toMatchObject({ interrupted: true });
  });
});

describe("enroll", () => {
  it("writes the token (0600) and runtime.json, never echoing the token", async () => {
    const home = tmp();
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { code: string; name: string };
      expect(body).toMatchObject({ code: "ABCD-EFGH", name: "laptop" });
      return new Response(
        JSON.stringify({
          deviceId: "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e5f",
          organizationId: "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e60",
          deviceToken: "ocwd_secret",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const out = await enroll({
      home,
      serverUrl: "http://localhost:4301/",
      code: "ABCD-EFGH",
      name: "laptop",
      fetchFn,
    });
    expect(JSON.stringify(out)).not.toContain("ocwd_secret");
    expect(readFileSync(join(home, "device-token"), "utf8").trim()).toBe("ocwd_secret");
    expect(statSync(join(home, "device-token")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(home, "runtime.json"), "utf8"))).toMatchObject({
      serverUrl: "http://localhost:4301",
      deviceName: "laptop",
    });
  });

  it("surfaces the server's error message", async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({ error: { code: "code_expired", message: "This pairing code expired" } }),
        {
          status: 410,
        },
      )) as unknown as typeof fetch;
    await expect(enroll({ home: tmp(), serverUrl: "http://x", code: "AAAA-BBBB", fetchFn })).rejects.toThrow(
      "This pairing code expired",
    );
  });
});
