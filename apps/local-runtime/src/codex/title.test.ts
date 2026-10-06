import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { normalizeSessionTitle, titleProblems } from "@ocw/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { TITLE_INSTRUCTIONS, TitleError, titleUserMessage } from "../title.js";
import { type AppServerProcess, CodexRuntime } from "./codex-runtime.js";
import type { ModelListResponse } from "./generated/v2/ModelListResponse.js";
import { generateCodexTitle } from "./title.js";

/** generateCodexTitle: an ephemeral, read-only gpt-6-luna thread on a short-lived app-server (03.2-12, P-17). */

type Msg = Record<string, unknown> & { id?: number | string; method?: string; params?: unknown };
type Line = { dir: "in" | "out"; msg: Msg };

/**
 * Replays a recorded JSON-RPC conversation: each client message is matched to the next scripted "out" line (by
 * method), then every scripted "in" line up to the next "out" is sent. A scripted response takes the id of the
 * client's latest request. Client messages the script does not expect (turn/interrupt, answers to server
 * requests) are recorded in `extra`.
 */
class ReplayAppServer extends EventEmitter implements AppServerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly received: Msg[] = [];
  readonly extra: Msg[] = [];
  killed: string[] = [];
  private pos = 0;
  private lastRequestId: number | string | undefined;

  constructor(
    private readonly script: Line[],
    readonly spawnedWith: { cwd: string; env: Record<string, string | undefined> },
  ) {
    super();
    let buf = "";
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (c: string) => {
      buf += c;
      let i = buf.indexOf("\n");
      while (i >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line) this.handle(JSON.parse(line) as Msg);
        i = buf.indexOf("\n");
      }
    });
  }

  private handle(m: Msg) {
    this.received.push(m);
    const next = this.script[this.pos];
    if (!m.method || !next || next.dir !== "out" || next.msg.method !== m.method) {
      this.extra.push(m);
      if (m.method && m.id !== undefined) this.send({ id: m.id, result: {} });
      return;
    }
    if (m.id !== undefined) this.lastRequestId = m.id;
    this.pos++;
    while (this.pos < this.script.length && this.script[this.pos]!.dir === "in") {
      const out = { ...this.script[this.pos]!.msg };
      if (out.id !== undefined && !out.method) out.id = this.lastRequestId;
      this.send(out);
      this.pos++;
    }
  }

  send(m: Msg) {
    this.stdout.write(`${JSON.stringify(m)}\n`);
  }

  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.killed.push(signal);
    this.stdout.end();
    this.emit("exit", 0);
  }
}

const THREAD = "thread-title-1";
const TURN = "turn-title-1";

function threadStarted(over: Record<string, unknown> = {}): Line {
  return {
    dir: "in",
    msg: {
      id: 0,
      result: {
        thread: { id: THREAD },
        model: "gpt-6-luna",
        modelProvider: "openai",
        serviceTier: null,
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandbox: { type: "readOnly", networkAccess: false },
        reasoningEffort: "low",
        ...over,
      },
    },
  };
}

const item = (method: "item/started" | "item/completed", it: Record<string, unknown>): Line => ({
  dir: "in",
  msg: { method, params: { item: it, threadId: THREAD, turnId: TURN } },
});
const turnCompleted = (status = "completed"): Line => ({
  dir: "in",
  msg: { method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, status } } },
});

/** A hand-built conversation (the fixture replay below uses the recording). */
function conversation(turnLines: Line[], thread: Line = threadStarted()): Line[] {
  return [
    { dir: "out", msg: { method: "initialize" } },
    { dir: "in", msg: { id: 0, result: { userAgent: "codex" } } },
    { dir: "out", msg: { method: "initialized" } },
    { dir: "out", msg: { method: "thread/start" } },
    thread,
    { dir: "out", msg: { method: "turn/start" } },
    { dir: "in", msg: { id: 0, result: { turn: { id: TURN, status: "inProgress" } } } },
    ...turnLines,
  ];
}

const tmpRoots: string[] = [];
afterEach(() => {
  for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true });
});

function harness(script: Line[], prompt = "Please fix the login redirect bug") {
  const tmpRoot = mkdtempSync(join(tmpdir(), "ocw-codex-title-test-"));
  tmpRoots.push(tmpRoot);
  const servers: ReplayAppServer[] = [];
  const abort = new AbortController();
  const run = generateCodexTitle(
    (opts) => {
      const s = new ReplayAppServer(script, opts);
      servers.push(s);
      return s;
    },
    { env: { PATH: "/usr/bin" }, prompt, model: "gpt-6-luna", effort: "low", signal: abort.signal, tmpRoot },
  );
  return { run, servers, abort, tmpRoot };
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

const sent = (s: ReplayAppServer, method: string) => s.received.find((m) => m.method === method);

/** One real title turn recorded at codex-cli 0.160.0 (scripts/record-codex-fixture.ts --scenario title). */
const FIXTURE = readFileSync(
  join(import.meta.dirname, "__fixtures__", "codex-0.160.0.title.rpc.jsonl"),
  "utf8",
)
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as Line);
const RECORDED_PROMPT = "Please fix the login redirect bug on the settings page when the session expires";
const RECORDED_TITLE = "Fix settings page login redirect bug";

describe("generateCodexTitle over the 0.160.0 recording", () => {
  it("sends the recorded requests and returns the final agent message, a valid English title", async () => {
    const h = harness(FIXTURE, RECORDED_PROMPT);
    const raw = await h.run;
    expect(raw).toBe(RECORDED_TITLE);
    expect(normalizeSessionTitle(raw)).toBe(RECORDED_TITLE);
    expect(titleProblems(RECORDED_TITLE)).toEqual([]);
    const s = h.servers[0]!;
    const recorded = (method: string) =>
      FIXTURE.find((l) => l.dir === "out" && l.msg.method === method)!.msg.params as Record<string, unknown>;
    expect(s.received.filter((m) => m.method).map((m) => m.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
    ]);
    expect(sent(s, "initialize")?.params).toEqual(recorded("initialize"));
    expect(recorded("initialize")).toMatchObject({ capabilities: { experimentalApi: false } });
    const { cwd: _a, ...thread } = sent(s, "thread/start")!.params as Record<string, unknown>;
    const { cwd: _b, ...recordedThread } = recorded("thread/start");
    expect(thread).toEqual(recordedThread);
    expect(recordedThread).toEqual({
      model: "gpt-6-luna",
      sandbox: "read-only",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      ephemeral: true,
      baseInstructions: TITLE_INSTRUCTIONS,
    });
    expect(sent(s, "turn/start")?.params).toEqual(recorded("turn/start"));
    expect(recorded("turn/start")).toMatchObject({ effort: "low", summary: "none" });
    expect(s.extra).toEqual([]);
  });

  it("the recording is one turn on an ephemeral read-only gpt-6-luna thread with no tool item", () => {
    const thread = FIXTURE.find((l) => l.dir === "in" && (l.msg.result as { thread?: unknown })?.thread)!.msg
      .result as Record<string, unknown>;
    expect(thread).toMatchObject({
      model: "gpt-6-luna",
      approvalPolicy: "untrusted",
      sandbox: { type: "readOnly" },
      thread: { ephemeral: true },
    });
    expect(FIXTURE.filter((l) => l.msg.method === "turn/completed")).toHaveLength(1);
    const items = FIXTURE.filter((l) => l.msg.method === "item/started").map(
      (l) => (l.msg.params as { item: { type: string } }).item.type,
    );
    expect(new Set(items)).toEqual(new Set(["userMessage", "agentMessage"]));
  });
});

describe("generateCodexTitle", () => {
  it("starts an ephemeral read-only gpt-6-luna thread and returns the final agent message", async () => {
    const h = harness(
      conversation([
        item("item/started", { type: "userMessage", id: "u1" }),
        item("item/started", { type: "hookPrompt", id: "h1" }),
        item("item/started", { type: "reasoning", id: "r1" }),
        item("item/started", { type: "agentMessage", id: "m1", text: "" }),
        item("item/completed", { type: "agentMessage", id: "m1", text: "Fix login redirect bug" }),
        turnCompleted(),
      ]),
    );
    expect(await h.run).toBe("Fix login redirect bug");
    const s = h.servers[0]!;
    expect(sent(s, "initialize")?.params).toMatchObject({ capabilities: { experimentalApi: false } });
    const thread = sent(s, "thread/start")?.params as Record<string, unknown>;
    expect(thread).toEqual({
      cwd: s.spawnedWith.cwd,
      model: "gpt-6-luna",
      sandbox: "read-only",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      ephemeral: true,
      baseInstructions: TITLE_INSTRUCTIONS,
    });
    expect(s.spawnedWith.cwd.startsWith(join(h.tmpRoot, "ocw-title-"))).toBe(true);
    expect(sent(s, "turn/start")?.params).toEqual({
      threadId: THREAD,
      input: [
        { type: "text", text: titleUserMessage("Please fix the login redirect bug"), text_elements: [] },
      ],
      effort: "low",
      summary: "none",
    });
    expect(s.extra).toEqual([]);
    expect(s.killed).toEqual(["SIGTERM"]);
    expect(readdirSync(h.tmpRoot)).toEqual([]);
  });

  for (const type of ["commandExecution", "fileChange", "mcpToolCall", "webSearch"]) {
    it(`an item/started of type ${type} interrupts the turn and fails with title_used_tool`, async () => {
      const h = harness(
        conversation([item("item/started", { type, id: "x1" }), turnCompleted("interrupted")]),
      );
      expect(await code(h.run)).toBe("title_used_tool");
      const s = h.servers[0]!;
      expect(s.extra.find((m) => m.method === "turn/interrupt")?.params).toEqual({
        threadId: THREAD,
        turnId: TURN,
      });
      expect(s.killed).toEqual(["SIGTERM"]);
    });
  }

  it("any server request is declined and fails with title_used_tool", async () => {
    const h = harness(
      conversation([
        {
          dir: "in",
          msg: { id: 77, method: "item/commandExecution/requestApproval", params: { threadId: THREAD } },
        },
        turnCompleted("interrupted"),
      ]),
    );
    expect(await code(h.run)).toBe("title_used_tool");
    const answer = h.servers[0]!.extra.find((m) => m.id === 77);
    expect(answer).toMatchObject({ result: { decision: "decline" } });
  });

  for (const over of [{ sandbox: { type: "dangerFullAccess" } }, { approvalPolicy: "never" }] as Array<
    Record<string, unknown>
  >) {
    it(`a thread reporting ${JSON.stringify(over)} fails before any turn/start`, async () => {
      const h = harness(conversation([], threadStarted(over)));
      expect(await code(h.run)).toBe("title_failed");
      expect(sent(h.servers[0]!, "turn/start")).toBeUndefined();
    });
  }

  it("a thread on another model fails with title_model_mismatch before any turn/start", async () => {
    const h = harness(conversation([], threadStarted({ model: "gpt-6.1-sol" })));
    expect(await code(h.run)).toBe("title_model_mismatch");
    expect(sent(h.servers[0]!, "turn/start")).toBeUndefined();
  });

  it("a failed turn or one without a message fails with title_failed", async () => {
    expect(await code(harness(conversation([turnCompleted("failed")])).run)).toBe("title_failed");
    expect(await code(harness(conversation([turnCompleted()])).run)).toBe("title_failed");
  });

  it("an abort interrupts the turn, kills the process and rejects", async () => {
    const h = harness(conversation([item("item/started", { type: "reasoning", id: "r1" })]));
    await new Promise((r) => setTimeout(r, 50));
    h.abort.abort();
    expect(await code(h.run)).toBe("title_failed");
    const s = h.servers[0]!;
    expect(s.extra.find((m) => m.method === "turn/interrupt")).toBeDefined();
    expect(s.killed).toEqual(["SIGTERM"]);
    expect(readdirSync(h.tmpRoot)).toEqual([]);
  });
});

describe("CodexRuntime.generateTitle", () => {
  it("uses the catalog's lowest effort on its own app-server and never touches a running session", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ocw-codex-title-rt-"));
    tmpRoots.push(cwd);
    const recorded = JSON.parse(
      readFileSync(join(import.meta.dirname, "__fixtures__", "codex-0.160.0.model-list.json"), "utf8"),
    ) as ModelListResponse;
    const luna = recorded.data.find((m) => m.id === "gpt-6-luna");
    expect(luna).toBeDefined();
    const handshake: Line[] = [
      { dir: "out", msg: { method: "initialize" } },
      { dir: "in", msg: { id: 0, result: { userAgent: "codex" } } },
      { dir: "out", msg: { method: "initialized" } },
    ];
    const scripts: Line[][] = [
      // 1. the session's own app-server
      [
        ...handshake,
        { dir: "out", msg: { method: "thread/start" } },
        threadStarted({ thread: { id: "session-thread" }, model: "gpt-6.1-sol" }),
      ],
      // 2. the catalog (model/list, no thread)
      [
        ...handshake,
        { dir: "out", msg: { method: "model/list" } },
        { dir: "in", msg: { id: 0, result: { data: [luna], nextCursor: null } } },
      ],
      // 3. the title thread
      conversation([
        item("item/completed", { type: "agentMessage", id: "m1", text: "Fix login redirect bug" }),
        turnCompleted(),
      ]),
    ];
    const servers: ReplayAppServer[] = [];
    const runtime = new CodexRuntime({
      detect: () => Promise.resolve({ id: "codex", installed: true, version: "0.160.0", loggedIn: true }),
      spawnAppServer: (opts) => {
        const s = new ReplayAppServer(scripts[servers.length]!, opts);
        servers.push(s);
        return s;
      },
    });
    const events: unknown[] = [];
    await runtime.start({ sessionId: "s1", cwd, permissionMode: "default" }, (e) => events.push(e));
    const before = { received: servers[0]!.received.length, events: events.length };

    const title = await runtime.generateTitle({
      prompt: "Please fix the login redirect bug",
      model: "gpt-6-luna",
      signal: new AbortController().signal,
    });
    expect(title).toBe("Fix login redirect bug");
    expect(servers).toHaveLength(3);
    expect(sent(servers[2]!, "thread/start")?.params).toMatchObject({ model: "gpt-6-luna", ephemeral: true });
    expect(sent(servers[2]!, "turn/start")?.params).toMatchObject({ effort: "low", summary: "none" });
    expect(servers[2]!.spawnedWith.cwd).not.toBe(cwd);
    expect(servers[2]!.spawnedWith.env).not.toHaveProperty("OPENAI_API_KEY");
    // The session's own app-server saw nothing new, and the session emitted nothing.
    expect({ received: servers[0]!.received.length, events: events.length }).toEqual(before);
    expect(servers[0]!.received.map((m) => m.method)).toEqual(["initialize", "initialized", "thread/start"]);
    expect(servers[0]!.killed).toEqual([]);
    await runtime.stopAll().catch(() => undefined);
  });
});
