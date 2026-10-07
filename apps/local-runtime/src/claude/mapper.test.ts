import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  SDKMessage,
  SDKResultError,
  SDKUserMessage,
  SDKUserMessageReplay,
} from "@anthropic-ai/claude-agent-sdk";
import type { ImageBlockParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { SessionEvent } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { sanitizeEvent } from "../sanitize.js";
import { ClaudeEventMapper, TOOL_OUTPUT_MAX_BYTES } from "./mapper.js";

const FIXTURE_DIR = join(import.meta.dirname, "__fixtures__");
const FIXTURE_ROOT = "/tmp/ocw-fixture-repo";

function loadFixture(name: string): SDKMessage[] {
  return readFileSync(join(FIXTURE_DIR, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SDKMessage);
}

function run(messages: SDKMessage[], promptId = "prompt-1"): SessionEvent[] {
  const mapper = new ClaudeEventMapper();
  mapper.currentPromptId = promptId;
  return messages.flatMap((m) => mapper.map(m));
}

const sdk = (m: Record<string, unknown>) => m as unknown as SDKMessage;

describe("ClaudeEventMapper — recorded fixture (real Claude Code session, plan mode)", () => {
  const file = readdirSync(FIXTURE_DIR).find((f) => f.endsWith(".plan-read.sdk.jsonl"));
  if (!file) throw new Error("fixture missing; run `npx tsx scripts/record-fixture.ts`");
  const events = run(loadFixture(file));
  const types = events.map((e) => e.type);

  it("emits the normalised lifecycle in order", () => {
    const lifecycle = types.filter((t) => t !== "assistant.delta" && t !== "runtime.raw");
    expect(lifecycle).toEqual([
      "session.started",
      // D-15: every init, the first included, reports the effective settings.
      "session.settings",
      "assistant.message",
      "tool.started",
      "tool.completed",
      "assistant.message",
      "prompt.completed",
    ]);
    expect(types.filter((t) => t === "assistant.delta").length).toBeGreaterThan(0);
  });

  it("reports runtime metadata on session.started", () => {
    expect(events[0]).toMatchObject({
      type: "session.started",
      runtime: "claude-code",
      permissionMode: "plan",
    });
    expect((events[0] as { runtimeSessionId?: string }).runtimeSessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("maps the Read tool call and its result", () => {
    const started = events.find((e) => e.type === "tool.started");
    const completed = events.find((e) => e.type === "tool.completed");
    expect(started).toMatchObject({ name: "Read", summary: `Read ${FIXTURE_ROOT}/hello.txt` });
    expect(completed).toMatchObject({ ok: true, summary: "Read completed" });
    expect(completed && "output" in completed ? completed.output : "").toContain(
      "Hello from the fixture repo.",
    );
    expect(completed && "toolUseId" in completed ? completed.toolUseId : "").toBe(
      started && "toolUseId" in started ? started.toolUseId : "x",
    );
  });

  it("streams deltas whose concatenation equals the final message", () => {
    const final = events.filter((e) => e.type === "assistant.message").at(-1) as {
      messageId: string;
      text: string;
    };
    const deltas = events
      .filter((e): e is Extract<SessionEvent, { type: "assistant.delta" }> => e.type === "assistant.delta")
      .filter((e) => e.messageId === final.messageId)
      .map((e) => e.text)
      .join("");
    expect(final.text).toBe("OK");
    expect(deltas).toBe(final.text);
  });

  it("completes the prompt with usage and a cost estimate", () => {
    const done = events.at(-1);
    expect(done).toMatchObject({ type: "prompt.completed", promptId: "prompt-1" });
    const usage = (done as { usage: { inputTokens: number; outputTokens: number } }).usage;
    expect(usage.outputTokens).toBeGreaterThan(0);
    expect(typeof (done as { costUsd?: number }).costUsd).toBe("number");
  });

  it("leaves no absolute path once sanitised", () => {
    const out = JSON.stringify(events.map((e) => sanitizeEvent(e, [FIXTURE_ROOT], "/Users/fixture-user")));
    expect(out).not.toContain(FIXTURE_ROOT);
    expect(out).not.toContain("/Users/");
    expect(out).toContain('"summary":"Read hello.txt"');
  });
});

describe("ClaudeEventMapper — recorded fixture at 2.1.289 (setModel + applyFlagSettings + setPermissionMode)", () => {
  const FILE = "claude-code-2.1.289.settings.sdk.jsonl";
  const messages = loadFixture(FILE);
  const init = messages.find((m) => m.type === "system" && m.subtype === "init") as unknown as Record<
    string,
    unknown
  >;

  it("is a pinned, single-turn, scrubbed recording", () => {
    expect(init.claude_code_version).toBe("2.1.289");
    expect(messages.filter((m) => m.type === "result")).toHaveLength(1);
    const text = readFileSync(join(FIXTURE_DIR, FILE), "utf8");
    expect(text).not.toMatch(/\/Users\/(?!fixture-user\/)[A-Za-z0-9._]+\//);
    expect(text).not.toMatch(/@(gmail|autofylabs)\./);
  });

  it("the init after the changes reports the requested model and the auto mode", () => {
    const events = run(messages);
    const started = events.findIndex((e) => e.type === "session.started");
    expect(events[started]).toMatchObject({
      type: "session.started",
      runtimeVersion: "2.1.289",
      model: "claude-sonnet-5-5",
      permissionMode: "auto",
    });
    expect(events[started + 1]).toEqual({
      type: "session.settings",
      model: "claude-sonnet-5-5",
      permissionMode: "auto",
      fastModeState: "off",
      fastModeReason: "sdk_opt_in_required",
    });
    // setPermissionMode answers with a status frame before the turn's init: forwarded as the mode readback.
    expect(events[0]).toEqual({ type: "session.settings", permissionMode: "auto" });
    expect(events.at(-1)).toMatchObject({ type: "prompt.completed", promptId: "prompt-1" });
    expect(events.filter((e) => e.type === "session.error")).toEqual([]);
  });

  it("a later init (runtime-side change) becomes one session.settings, no second session.started", () => {
    const mapper = new ClaudeEventMapper();
    mapper.currentPromptId = "prompt-1";
    for (const m of messages) mapper.map(m);
    const later = sdk({
      ...init,
      model: "claude-opus-5-5",
      permissionMode: "acceptEdits",
      fast_mode_state: "off",
      fast_mode_disabled_reason: "extra_usage_disabled",
    });
    expect(mapper.map(later)).toEqual([
      {
        type: "session.settings",
        model: "claude-opus-5-5",
        permissionMode: "acceptEdits",
        fastModeState: "off",
        fastModeReason: "extra_usage_disabled",
      },
    ]);
  });
});

describe("ClaudeEventMapper — hand-written cases", () => {
  it("forwards every system/init as session.settings, session.started only once (D-15)", () => {
    const init = (extra: Record<string, unknown>) =>
      sdk({ type: "system", subtype: "init", session_id: "abc", claude_code_version: "2.1.289", ...extra });
    const events = run([
      init({ model: "claude-haiku-4-5", permissionMode: "plan" }),
      init({
        model: "claude-sonnet-5-5",
        permissionMode: "auto",
        fast_mode_state: "off",
        fast_mode_disabled_reason: "extra_usage_disabled",
        effort: "low",
      }),
    ]);
    expect(events).toEqual([
      expect.objectContaining({ type: "session.started", model: "claude-haiku-4-5", permissionMode: "plan" }),
      { type: "session.settings", model: "claude-haiku-4-5", permissionMode: "plan" },
      {
        type: "session.settings",
        model: "claude-sonnet-5-5",
        permissionMode: "auto",
        fastModeState: "off",
        fastModeReason: "extra_usage_disabled",
        effort: "low",
      },
    ]);
  });

  it("reports per-prompt cost from the cumulative total_cost_usd", () => {
    const mapper = new ClaudeEventMapper();
    const result = (cost: number) =>
      sdk({ type: "result", subtype: "success", is_error: false, total_cost_usd: cost, usage: {} });
    mapper.currentPromptId = "p1";
    expect(mapper.map(result(0.5))).toMatchObject([
      { type: "prompt.completed", promptId: "p1", costUsd: 0.5 },
    ]);
    mapper.currentPromptId = "p2";
    expect(mapper.map(result(0.75))).toMatchObject([
      { type: "prompt.completed", promptId: "p2", costUsd: 0.25 },
    ]);
  });

  it("maps error results to session.error + failed prompt", () => {
    const events = run([
      sdk({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        errors: ["too many turns"],
        total_cost_usd: 0,
        usage: {},
      }),
    ]);
    expect(events).toMatchObject([
      { type: "session.error", message: "too many turns" },
      { type: "prompt.completed", promptId: "prompt-1", isError: true },
    ]);
  });

  it("truncates tool output to 4 KB and marks failures", () => {
    const big = "x".repeat(10_000);
    const events = run([
      sdk({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          id: "m1",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "make" } }],
        },
      }),
      sdk({
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: big }],
        },
      }),
    ]);
    expect(events[0]).toMatchObject({ type: "tool.started", name: "Bash", summary: "$ make" });
    const done = events[1] as { ok: boolean; output: string; summary: string };
    expect(done.ok).toBe(false);
    expect(done.summary).toMatch(/^Bash failed/);
    expect(Buffer.byteLength(done.output.split("\n…")[0] ?? "")).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_BYTES);
  });

  it("forwards unknown SDK messages as runtime.raw and drops known noise", () => {
    const events = run([
      sdk({ type: "system", subtype: "brand_new_thing", foo: 1 }),
      sdk({ type: "tool_progress", tool_use_id: "t", tool_name: "Bash", elapsed_time_seconds: 1 }),
      sdk({ type: "system", subtype: "status", status: "requesting" }),
    ]);
    expect(events).toEqual([
      {
        type: "runtime.raw",
        rawType: "system/brand_new_thing",
        data: { type: "system", subtype: "brand_new_thing", foo: 1 },
      },
    ]);
  });

  it("ignores sub-agent text and replayed user messages", () => {
    const events = run([
      sdk({
        type: "assistant",
        parent_tool_use_id: "task1",
        message: { id: "m2", content: [{ type: "text", text: "inner" }] },
      }),
      sdk({
        type: "user",
        isReplay: true,
        parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x" }] },
      }),
    ]);
    expect(events).toEqual([]);
  });
});

describe("ClaudeEventMapper — prompt images (06.1-03, D-05, P-11)", () => {
  /** A synthetic base64 run standing in for an image (nothing is decoded). */
  const DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB".repeat(12);
  const image = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: DATA },
  } satisfies ImageBlockParam;
  const leaks = (events: SessionEvent[]) => {
    const json = JSON.stringify(events);
    return json.includes(";base64,") || json.includes(DATA.slice(0, 40));
  };

  it("a user message echoing image blocks (replayed or not) produces no event, in particular no runtime.raw", () => {
    const echo: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: [image, { type: "text", text: "what is this?" }] },
      parent_tool_use_id: null,
    };
    const replay: SDKUserMessageReplay = {
      ...echo,
      uuid: "00000000-0000-4000-8000-000000000001",
      session_id: "rt-session",
      isReplay: true,
    };
    const dataUrlEcho: SDKUserMessage = {
      ...echo,
      message: {
        role: "user",
        content: [{ type: "text", text: `data:image/png;base64,${DATA}` }],
      },
    };
    const events = run([echo, replay, dataUrlEcho] as SDKMessage[]);
    expect(events).toEqual([]);
    expect(leaks(events)).toBe(false);
  });

  it("a tool_result holding an image block becomes a tool.completed whose output says [image], without the bytes", () => {
    const toolResult = {
      type: "tool_result",
      tool_use_id: "t-img",
      content: [image, { type: "text", text: "screenshot taken" }],
    } satisfies ToolResultBlockParam;
    const events = run([
      sdk({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          id: "m-img",
          content: [{ type: "tool_use", id: "t-img", name: "mcp__browser__screenshot", input: {} }],
        },
      }),
      {
        type: "user",
        message: { role: "user", content: [toolResult] },
        parent_tool_use_id: null,
      } as SDKMessage,
    ]);
    const done = events.find((e) => e.type === "tool.completed");
    expect(done).toMatchObject({ type: "tool.completed", toolUseId: "t-img", ok: true });
    expect((done as { output?: string }).output).toBe("[image]\nscreenshot taken");
    expect(leaks(events)).toBe(false);
  });

  it("an image_error result names the cause, then fails the prompt", () => {
    const imageError: Pick<
      SDKResultError,
      | "type"
      | "subtype"
      | "is_error"
      | "errors"
      | "terminal_reason"
      | "total_cost_usd"
      | "num_turns"
      | "session_id"
    > = {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["Could not process image"],
      terminal_reason: "image_error",
      total_cost_usd: 0,
      num_turns: 1,
      session_id: "rt-session",
    };
    const events = run([sdk(imageError)]);
    expect(events).toMatchObject([
      {
        type: "session.error",
        message: "Claude Code could not read an attached image: Could not process image",
      },
      { type: "prompt.completed", promptId: "prompt-1", isError: true },
    ]);
    const bare = run([sdk({ ...imageError, errors: [] })]);
    expect(bare[0]).toMatchObject({
      type: "session.error",
      message: expect.stringMatching(/^Claude Code could not read an attached image/),
    });
  });

  it("other error results keep their messages", () => {
    const events = run([
      sdk({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["API error"],
        terminal_reason: "api_error",
        total_cost_usd: 0,
        usage: {},
      }),
    ]);
    expect(events[0]).toEqual({ type: "session.error", message: "API error" });
  });
});
