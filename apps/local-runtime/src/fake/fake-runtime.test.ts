import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeCatalog, type SessionEvent } from "@ocw/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { enroll } from "../enroll.js";
import { RuntimeError } from "../runtime.js";
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

describe("FakeRuntime settings (03.2-01, D-07, D-14)", () => {
  it("reports a valid catalog per runtime id", async () => {
    for (const id of ["claude-code", "codex"] as const) {
      const catalog = RuntimeCatalog.parse(await new FakeRuntime(id, 1).catalog());
      expect(catalog.runtime).toBe(id);
      expect(catalog.models.filter((m) => m.isDefault)).toHaveLength(1);
      expect(catalog.permissionModes).toEqual(
        expect.arrayContaining(["default", "acceptEdits", "plan", "auto"]),
      );
      expect(catalog.permissionModes).not.toContain("fullAccess");
    }
    const claude = await new FakeRuntime("claude-code", 1).catalog();
    expect(claude.models.map((m) => m.id)).toEqual(["opus", "sonnet", "fable", "haiku", "claude-opus-4-6"]);
  });

  it("start reports the effective settings", async () => {
    const events: SessionEvent[] = [];
    const rt = new FakeRuntime("claude-code", 1);
    await rt.start({ sessionId: "c0", cwd: tmp(), permissionMode: "default", model: "sonnet" }, (e) =>
      events.push(e),
    );
    expect(events.find((e) => e.type === "session.settings")).toMatchObject({
      model: "sonnet",
      permissionMode: "default",
    });
  });

  it("configure while idle applies at once and reports session.settings", async () => {
    const events: SessionEvent[] = [];
    const rt = new FakeRuntime("claude-code", 1);
    await rt.start({ sessionId: "c1", cwd: tmp(), permissionMode: "default" }, (e) => events.push(e));
    events.length = 0;
    await rt.configure("c1", { model: "sonnet" });
    expect(events).toEqual([expect.objectContaining({ type: "session.settings", model: "sonnet" })]);
  });

  it("configure while a turn runs is held until the next turn starts, then reported before it", async () => {
    const cwd = tmp();
    const events: SessionEvent[] = [];
    const rt = new FakeRuntime("claude-code", 20);
    await rt.start({ sessionId: "c2", cwd, permissionMode: "plan" }, (e) => events.push(e));
    await rt.prompt("c2", { promptId: "p1", text: "first" });
    await until(events, (e) => e.type === "prompt.started");
    await rt.configure("c2", { model: "fable" });
    expect(events.some((e) => e.type === "session.settings" && e.model === "fable")).toBe(false);
    await rt.prompt("c2", { promptId: "p2", text: "second" });
    await until(events, (e) => e.type === "prompt.completed" && e.promptId === "p2");
    const settingsAt = events.findIndex((e) => e.type === "session.settings" && e.model === "fable");
    const secondAt = events.findIndex((e) => e.type === "prompt.started" && e.promptId === "p2");
    const firstDone = events.findIndex((e) => e.type === "prompt.completed" && e.promptId === "p1");
    expect(settingsAt).toBeGreaterThan(firstDone);
    expect(settingsAt).toBeLessThan(secondAt);
    const said = events
      .filter((e) => e.type === "assistant.message")
      .map((e) => (e as { text: string }).text);
    expect(said.at(-1)).toContain("Model: fable");
  });

  it("refuses a mode outside its capabilities", async () => {
    const rt = new FakeRuntime("codex", 1);
    await rt.start({ sessionId: "c3", cwd: tmp(), permissionMode: "default" }, () => undefined);
    await expect(rt.configure("c3", { permissionMode: "fullAccess" })).rejects.toMatchObject({
      code: "settings_rejected",
    });
    await expect(rt.configure("c3", { permissionMode: "fullAccess" })).rejects.toBeInstanceOf(RuntimeError);
  });

  it("the turn's permissionMode lowers the session mode for that turn (P-07)", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "README.md"), "# Demo\n");
    const events: SessionEvent[] = [];
    const rt = new FakeRuntime("claude-code", 1);
    await rt.start({ sessionId: "c4", cwd, permissionMode: "acceptEdits" }, (e) => events.push(e));
    await rt.prompt("c4", { promptId: "p1", text: "plan only", permissionMode: "plan" });
    await until(events, (e) => e.type === "prompt.completed");
    expect(existsSync(join(cwd, "notes"))).toBe(false);
    expect(events.some((e) => e.type === "approval.requested")).toBe(false);
  });
});

describe("FakeRuntime Full access (ADR-0012, D-01)", () => {
  it("offers fullAccess only while the device gate allows it", async () => {
    let allowed = false;
    const rt = new FakeRuntime("claude-code", 1, { allowFullAccess: () => allowed });
    expect(rt.capabilities.supportsPermissionModes).not.toContain("fullAccess");
    expect((await rt.catalog()).permissionModes).not.toContain("fullAccess");
    allowed = true;
    expect(rt.capabilities.supportsPermissionModes).toContain("fullAccess");
    expect((await rt.catalog()).permissionModes).toContain("fullAccess");
  });

  it("a fullAccess turn writes its file without any approval.requested and reports the mode", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "README.md"), "# Demo\n");
    const events: SessionEvent[] = [];
    const rt = new FakeRuntime("claude-code", 1, { allowFullAccess: () => true });
    await rt.start({ sessionId: "fa1", cwd, permissionMode: "fullAccess" }, (e) => events.push(e));
    expect(events.find((e) => e.type === "session.settings")).toMatchObject({ permissionMode: "fullAccess" });
    await rt.prompt("fa1", { promptId: "p1", text: "ship it", permissionMode: "fullAccess" });
    await until(events, (e) => e.type === "prompt.completed");
    expect(readFileSync(join(cwd, "notes/ocw-change-1.md"), "utf8")).toContain("ship it");
    expect(events.some((e) => e.type === "approval.requested")).toBe(false);
    const said = events
      .filter((e) => e.type === "assistant.message")
      .map((e) => (e as { text: string }).text);
    expect(said.at(-1)).toContain("Mode: fullAccess");
  });

  it("allowFullAccess false: start and configure refuse fullAccess", async () => {
    const rt = new FakeRuntime("codex", 1, { allowFullAccess: () => false });
    await expect(
      rt.start({ sessionId: "fa2", cwd: tmp(), permissionMode: "fullAccess" }, () => undefined),
    ).rejects.toMatchObject({ code: "permission_mode_rejected" });
    await rt.start({ sessionId: "fa3", cwd: tmp(), permissionMode: "acceptEdits" }, () => undefined);
    await expect(rt.configure("fa3", { permissionMode: "fullAccess" })).rejects.toMatchObject({
      code: "settings_rejected",
    });
  });

  it("a fullAccess turn after the gate closed fails instead of running unprompted", async () => {
    const cwd = tmp();
    let allowed = true;
    const events: SessionEvent[] = [];
    const rt = new FakeRuntime("claude-code", 1, { allowFullAccess: () => allowed });
    await rt.start({ sessionId: "fa4", cwd, permissionMode: "fullAccess" }, (e) => events.push(e));
    allowed = false;
    await rt.prompt("fa4", { promptId: "p1", text: "go" });
    const done = await until(events, (e) => e.type === "prompt.completed");
    expect(done).toMatchObject({ isError: true });
    expect(existsSync(join(cwd, "notes"))).toBe(false);
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
