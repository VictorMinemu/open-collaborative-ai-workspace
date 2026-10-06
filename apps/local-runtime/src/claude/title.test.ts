import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelInfo, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { normalizeSessionTitle, titleProblems } from "@ocw/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AsyncQueue } from "../async-queue.js";
import { TITLE_INSTRUCTIONS, TitleError, titleUserMessage } from "../title.js";
import { ClaudeCodeRuntime, childEnv, type QueryHandle } from "./claude-runtime.js";
import { type ClaudeTitleOptions, generateClaudeTitle } from "./title.js";
import { secretDenyRules } from "./tool-policy.js";

/** generateClaudeTitle: a one-shot, tool-less, unpersisted haiku query (Phase 03.2 Plan 12, D-18, P-17). */

class ReplayQuery implements QueryHandle {
  readonly out = new AsyncQueue<SDKMessage>();
  readonly prompts: SDKUserMessage[] = [];
  interrupts = 0;
  closed = false;
  constructor(readonly params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) {
    void (async () => {
      for await (const m of params.prompt) this.prompts.push(m);
    })();
  }
  play(messages: Array<Record<string, unknown>>, end = true) {
    for (const m of messages) this.out.push(m as unknown as SDKMessage);
    if (end) this.out.close();
  }
  interrupt(): Promise<unknown> {
    this.interrupts++;
    return Promise.resolve(undefined);
  }
  close(): void {
    this.closed = true;
    this.out.close();
  }
  setModel(model?: string): Promise<void> {
    this.calls.push(`setModel:${model}`);
    return Promise.resolve();
  }
  setPermissionMode(): Promise<void> {
    throw new Error("a title query never changes its mode");
  }
  applyFlagSettings(): Promise<void> {
    throw new Error("a title query never changes its settings");
  }
  /** The catalog probe's models (runtime-level test). */
  models: ModelInfo[] = [];
  readonly calls: string[] = [];
  initializationResult(): Promise<{ models: ModelInfo[] }> {
    this.calls.push("initializationResult");
    return Promise.resolve({ models: this.models });
  }
  getContextUsage(): Promise<never> {
    this.calls.push("getContextUsage");
    return Promise.reject(new Error("no window"));
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return this.out[Symbol.asyncIterator]();
  }
}

const tmpRoots: string[] = [];
afterEach(() => {
  for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true });
});

const init = (model: string) => ({
  type: "system",
  subtype: "init",
  model,
  permissionMode: "default",
  apiKeySource: "none",
});
const assistantText = (text: string) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const success = (result: string) => ({ type: "result", subtype: "success", is_error: false, result });

function harness(messages: Array<Record<string, unknown>> | null, extra: Partial<ClaudeTitleOptions> = {}) {
  const tmpRoot = mkdtempSync(join(tmpdir(), "ocw-title-test-"));
  tmpRoots.push(tmpRoot);
  const queries: ReplayQuery[] = [];
  const env = childEnv({
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "x",
    ANTHROPIC_AUTH_TOKEN: "y",
    OCW_TOKEN: "z",
  });
  const abort = new AbortController();
  const run = generateClaudeTitle(
    (params) => {
      const q = new ReplayQuery(params);
      queries.push(q);
      if (messages) q.play(messages);
      return q;
    },
    {
      claudePath: "/usr/local/bin/claude",
      env,
      prompt: "Arregla el error de redirección del login",
      model: "haiku",
      resolvedModel: "claude-haiku-4-5-20251001",
      signal: abort.signal,
      tmpRoot,
      ...extra,
    },
  );
  return { run, queries, abort, tmpRoot };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(TitleError);
    return (err as TitleError).code;
  }
  throw new Error("expected a TitleError");
}

/** One real title turn recorded at Claude Code 2.1.289 (scripts/record-fixture.ts --scenario title). */
const FIXTURE = readFileSync(
  join(import.meta.dirname, "__fixtures__", "claude-code-2.1.289.title.sdk.jsonl"),
  "utf8",
)
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as Record<string, unknown>);
/** The recorded prompt is Spanish; so is the recorded title. */
const RECORDED_TITLE = "Redirección de login al expirar sesión";

describe("generateClaudeTitle over the 2.1.289 recording", () => {
  it("returns the recorded answer, which normalizes to a valid 3-6 word Spanish title", async () => {
    const init = FIXTURE.find((m) => m.subtype === "init")!;
    expect(init).toMatchObject({ claude_code_version: "2.1.289", model: "claude-haiku-4-5-20251001" });
    expect(init).toMatchObject({ permissionMode: "default", apiKeySource: "none" });
    expect(FIXTURE.filter((m) => m.type === "result")).toHaveLength(1);
    const raw = await harness(FIXTURE).run;
    expect(raw).toBe(RECORDED_TITLE);
    const title = normalizeSessionTitle(raw);
    expect(title).toBe(RECORDED_TITLE);
    expect(titleProblems(title!)).toEqual([]);
  });

  it("the recorded turn used no tool", () => {
    const blocks = FIXTURE.filter((m) => m.type === "assistant").flatMap(
      (m) => (m.message as { content: Array<{ type: string }> }).content,
    );
    expect(blocks.map((b) => b.type)).not.toContain("tool_use");
  });
});

describe("generateClaudeTitle", () => {
  it("returns the result text of a one-shot haiku query with locked-down options", async () => {
    const h = harness([
      init("claude-haiku-4-5-20251001"),
      assistantText("Arregla redirección del login"),
      success("Arregla redirección del login"),
    ]);
    expect(await h.run).toBe("Arregla redirección del login");
    const q = h.queries[0]!;
    const o = q.params.options;
    expect(o).toMatchObject({
      model: "haiku",
      permissionMode: "default",
      tools: [],
      persistSession: false,
      settingSources: [],
      strictMcpConfig: true,
      maxTurns: 1,
      thinking: { type: "disabled" },
      systemPrompt: TITLE_INSTRUCTIONS,
      allowDangerouslySkipPermissions: false,
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
      settings: { permissions: { deny: secretDenyRules(), disableBypassPermissionsMode: "disable" } },
    });
    expect(o.resume).toBeUndefined();
    expect(o.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(o.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(o.env).not.toHaveProperty("OCW_TOKEN");
    // A fresh temp directory, removed afterwards.
    expect(o.cwd!.startsWith(join(h.tmpRoot, "ocw-title-"))).toBe(true);
    expect(existsSync(o.cwd!)).toBe(false);
    expect(readdirSync(h.tmpRoot)).toEqual([]);
    // One user message: the prompt inside titleUserMessage.
    expect(q.prompts.map((p) => p.message.content)).toEqual([
      titleUserMessage("Arregla el error de redirección del login"),
    ]);
    expect(q.closed).toBe(true);
    // canUseTool denies everything.
    const verdict = await o.canUseTool!("Bash", { command: "ls" }, {
      signal: new AbortController().signal,
      toolUseID: "t1",
    } as never);
    expect(verdict?.behavior).toBe("deny");
  });

  it("accepts the alias itself as the init model", async () => {
    expect(await harness([init("haiku"), success("Fix the login flow")]).run).toBe("Fix the login flow");
  });

  it("refuses an init that runs another model", async () => {
    const h = harness([init("claude-sonnet-5-5"), success("Fix the login flow")]);
    expect(await code(h.run)).toBe("title_model_mismatch");
    expect(h.queries[0]!.closed).toBe(true);
  });

  it("refuses an answer that used a tool", async () => {
    const h = harness([
      init("claude-haiku-4-5-20251001"),
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }] },
      },
      success("Fix the login flow"),
    ]);
    expect(await code(h.run)).toBe("title_used_tool");
    expect(h.queries[0]!.closed).toBe(true);
  });

  it("refuses a non-success result or a missing one", async () => {
    expect(
      await code(
        harness([init("haiku"), { type: "result", subtype: "error_max_turns", is_error: true }]).run,
      ),
    ).toBe("title_failed");
    expect(await code(harness([init("haiku")]).run)).toBe("title_failed");
  });

  it("an abort interrupts and closes the query and rejects; the temp dir is removed", async () => {
    const h = harness(null);
    await new Promise((r) => setTimeout(r, 20));
    const q = h.queries[0]!;
    q.play([init("haiku")], false);
    h.abort.abort();
    expect(await code(h.run)).toBe("title_failed");
    expect(q.interrupts).toBe(1);
    expect(q.closed).toBe(true);
    expect(readdirSync(h.tmpRoot)).toEqual([]);
  });
});

describe("ClaudeCodeRuntime.generateTitle", () => {
  it("delegates with the catalog row's resolved model and never touches a running session", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ocw-title-rt-"));
    tmpRoots.push(cwd);
    const queries: ReplayQuery[] = [];
    const runtime = new ClaudeCodeRuntime({
      claudePath: "/usr/local/bin/claude",
      catalogCwd: cwd,
      detect: () =>
        Promise.resolve({ id: "claude-code", installed: true, version: "2.1.289", loggedIn: true }),
      queryFn: (params) => {
        const q = new ReplayQuery(params);
        queries.push(q);
        q.models = [
          {
            value: "haiku",
            displayName: "Haiku",
            description: "Fastest",
            resolvedModel: "claude-haiku-4-5-20251001",
          } as ModelInfo,
        ];
        // The title query is the only one without tools; it answers once.
        if (Array.isArray(params.options.tools) && params.options.tools.length === 0) {
          q.play([init("claude-haiku-4-5-20251001"), success("Fix login redirect bug")]);
        }
        return q;
      },
    });
    const events: unknown[] = [];
    await runtime.start({ sessionId: "s1", cwd, permissionMode: "default" }, (e) => events.push(e));
    const session = queries[0]!;
    await runtime.prompt("s1", { promptId: "p1", text: "keep working" });
    const before = { prompts: session.prompts.length, calls: [...session.calls], events: events.length };

    const title = await runtime.generateTitle({
      prompt: "Please fix the login redirect bug",
      model: "haiku",
      signal: new AbortController().signal,
    });
    expect(title).toBe("Fix login redirect bug");
    const titleQuery = queries.find((q) => Array.isArray(q.params.options.tools))!;
    expect(titleQuery).not.toBe(session);
    expect(titleQuery.params.options.model).toBe("haiku");
    expect(titleQuery.params.options.resume).toBeUndefined();
    expect(titleQuery.params.options.cwd).not.toBe(cwd);
    expect({ prompts: session.prompts.length, calls: session.calls, events: events.length }).toEqual(before);
    expect(session.closed).toBe(false);
    await runtime.stopAll();
  });
});
