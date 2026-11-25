import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEvent } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { sanitizeEvent } from "../sanitize.js";
import type { JsonRpcNotification } from "./jsonrpc.js";
import { CodexEventMapper } from "./mapper.js";

const FIXTURE_DIR = join(import.meta.dirname, "__fixtures__");
const FIXTURE_ROOT = "/tmp/ocw-fixture-repo";

interface RpcLine {
  dir: "in" | "out";
  msg: { id?: number | string; method?: string; params?: unknown; result?: unknown };
}

function load(file: string): RpcLine[] {
  return readFileSync(join(FIXTURE_DIR, file), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RpcLine);
}

/**
 * The plan-read recordings: 0.160.0 (the compatibility floor, a ChatGPT-login turn) and 0.172.0 (the pin, recorded
 * offline against the fake model by `record-codex-fixture.ts --offline`: the fake calls `exec_command` through its
 * `[[call]]` directive and reports the tool's output).
 */
const PLAN_READ = [
  {
    version: "0.160.0",
    file: "codex-0.160.0.plan-read.rpc.jsonl",
    command: "cat hello.txt",
    output: "Hello from the fixture repo.\n",
    text: "OK",
    contextWindow: 258_400,
  },
  {
    version: "0.172.0",
    file: "codex-0.172.0.plan-read.rpc.jsonl",
    command: "cat hello.txt",
    output: "Hello from the fixture repo.\n",
    text: expect.stringMatching(/^Tool exec_command said: .*Output: Hello from the fixture repo\.$/),
    contextWindow: 258_400,
  },
] as const;

describe.each(PLAN_READ)(
  "CodexEventMapper — recorded plan-read at codex-cli $version (read-only sandbox)",
  (fx) => {
    const lines = load(fx.file);
    const mapper = new CodexEventMapper();
    mapper.currentPromptId = "prompt-1";
    const events: SessionEvent[] = lines
      .filter((l) => l.dir === "in" && l.msg.method && l.msg.id === undefined)
      .flatMap((l) => mapper.map(l.msg as JsonRpcNotification));

    it("the client asked for on-request approvals and a non-full-access sandbox", () => {
      const start = lines.find((l) => l.dir === "out" && l.msg.method === "thread/start");
      expect(start?.msg.params).toMatchObject({
        approvalPolicy: "on-request",
        sandbox: "read-only",
        cwd: FIXTURE_ROOT,
      });
    });

    it("emits tool and message events in order and completes the prompt", () => {
      const types = events.map((e) => e.type).filter((t) => t !== "assistant.delta" && t !== "runtime.raw");
      expect(types).toEqual([
        "tool.started",
        "tool.completed",
        "session.settings",
        "assistant.message",
        "prompt.completed",
      ]);
    });

    it("reports the recorded model context window once (display only, D-10)", () => {
      expect(events.filter((e) => e.type === "session.settings")).toEqual([
        { type: "session.settings", contextWindow: fx.contextWindow },
      ]);
    });

    it("maps the command execution", () => {
      expect(events.find((e) => e.type === "tool.started")).toMatchObject({
        name: "Bash",
        summary: expect.stringContaining(fx.command),
      });
      expect(events.find((e) => e.type === "tool.completed")).toMatchObject({
        ok: true,
        output: fx.output,
      });
    });

    it("streams deltas and the final message for the same item", () => {
      const msg = events.find((e) => e.type === "assistant.message") as { messageId: string; text: string };
      expect(msg.text).toEqual(fx.text);
      const deltas = events.filter((e) => e.type === "assistant.delta" && e.messageId === msg.messageId);
      expect(deltas.map((d) => (d as { text: string }).text).join("")).toBe(msg.text);
    });

    it("reports token usage on prompt.completed", () => {
      const done = events.at(-1) as Extract<SessionEvent, { type: "prompt.completed" }>;
      expect(done).toMatchObject({ type: "prompt.completed", promptId: "prompt-1" });
      expect(done.usage.outputTokens).toBeGreaterThan(0);
      expect(done.isError).toBeUndefined();
    });

    it("leaves no absolute path once sanitised", () => {
      const out = JSON.stringify(events.map((e) => sanitizeEvent(e, [FIXTURE_ROOT], "/Users/fixture-user")));
      expect(out).not.toContain(FIXTURE_ROOT);
      expect(out).not.toContain("/Users/");
    });

    it("the recording names no home directory and no account e-mail", () => {
      const raw = readFileSync(join(FIXTURE_DIR, fx.file), "utf8");
      expect(raw).not.toMatch(/\/Users\/(?!fixture-user)|\/home\//);
      expect(raw.replaceAll("fixture@example.com", "")).not.toMatch(
        /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
      );
    });
  },
);

describe("CodexEventMapper — hand-written cases", () => {
  it("maps file changes, failures and interrupted turns", () => {
    const m = new CodexEventMapper();
    m.currentPromptId = "p";
    const change = {
      type: "fileChange",
      id: "f1",
      status: "inProgress",
      changes: [
        { path: "/r/src/a.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-a\n+b" },
      ],
    };
    const ev = [
      ...m.map({
        method: "item/started",
        params: { item: change, threadId: "t", turnId: "u", startedAtMs: 0 },
      }),
      ...m.map({
        method: "item/completed",
        params: { item: { ...change, status: "failed" }, threadId: "t", turnId: "u", completedAtMs: 0 },
      }),
      ...m.map({
        method: "turn/completed",
        params: { threadId: "t", turn: { id: "u", status: "interrupted", error: null, items: [] } },
      }),
    ];
    expect(ev).toMatchObject([
      { type: "tool.started", toolUseId: "f1", name: "Edit", summary: "Edit /r/src/a.ts" },
      { type: "tool.completed", toolUseId: "f1", ok: false, output: expect.stringContaining("+b") },
      { type: "prompt.completed", promptId: "p", interrupted: true },
    ]);
  });

  it("maps failed turns and fatal errors to session.error", () => {
    const m = new CodexEventMapper();
    expect(
      m.map({
        method: "error",
        params: { error: { message: "boom" }, willRetry: false, threadId: "t", turnId: "u" },
      }),
    ).toEqual([{ type: "session.error", message: "boom" }]);
    expect(
      m.map({
        method: "turn/completed",
        params: {
          threadId: "t",
          turn: { id: "u", status: "failed", error: { message: "quota" }, items: [] },
        },
      }),
    ).toMatchObject([
      { type: "session.error", message: "quota" },
      { type: "prompt.completed", isError: true },
    ]);
  });

  it("maps thread/settings/updated to session.settings with the platform mode from the inverse table", () => {
    const m = new CodexEventMapper();
    const settings = (over: Record<string, unknown>) => ({
      method: "thread/settings/updated",
      params: {
        threadId: "t",
        threadSettings: {
          disabledPluginIds: [],
          cwd: "/r",
          approvalPolicy: "untrusted",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          activePermissionProfile: null,
          model: "gpt-5.5",
          modelProvider: "openai",
          serviceTier: "priority",
          effort: "low",
          summary: null,
          collaborationMode: { mode: "default", settings: {} },
          personality: null,
          ...over,
        },
      },
    });
    expect(m.map(settings({}))).toEqual([
      {
        type: "session.settings",
        model: "gpt-5.5",
        effort: "low",
        serviceTier: "priority",
        fastMode: true,
        permissionMode: "default",
      },
    ]);
    // A combination no platform mode produces: the mode is left out (the contract field is not nullable).
    const [odd] = m.map(settings({ approvalsReviewer: "auto_review", serviceTier: null, effort: null }));
    expect(odd).toEqual({
      type: "session.settings",
      model: "gpt-5.5",
      effort: null,
      serviceTier: null,
      fastMode: false,
    });
    // Never forwards the absolute cwd.
    expect(JSON.stringify(odd)).not.toContain("/r");
  });

  it("reports the model context window once per value, display only (D-10)", () => {
    const m = new CodexEventMapper();
    const usage = (turnId: string, modelContextWindow: number | null) => ({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "t",
        turnId,
        tokenUsage: {
          total: {
            totalTokens: 1,
            inputTokens: 1,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: 1,
            inputTokens: 1,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          modelContextWindow,
        },
      },
    });
    expect(m.map(usage("u1", 258_400))).toEqual([{ type: "session.settings", contextWindow: 258_400 }]);
    expect(m.map(usage("u1", 258_400))).toEqual([]);
    expect(m.map(usage("u2", null))).toEqual([]);
    expect(m.map(usage("u2", 1_000_000))).toEqual([{ type: "session.settings", contextWindow: 1_000_000 }]);
  });

  it("forwards unknown notifications as runtime.raw", () => {
    expect(new CodexEventMapper().map({ method: "brand/new", params: { a: 1 } })).toEqual([
      { type: "runtime.raw", rawType: "brand/new", data: { a: 1 } },
    ]);
  });
});
