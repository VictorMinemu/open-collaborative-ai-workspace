// FakeRuntime: a deterministic AgentRuntime for end-to-end tests and offline demos. Enabled only with
// OCW_RUNTIME_FAKE=1. It never talks to a model: it streams canned text, reads a file, asks for approval
// before writing one (unless the session is in plan mode, or acceptEdits), and honours interrupt.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ApprovalDecision,
  ApprovalOutcome,
  PermissionMode,
  PromptPayload,
  RuntimeId,
  RuntimeInfo,
  SessionEvent,
} from "@ocw/contracts";
import {
  type AgentRuntime,
  type EventSink,
  type RuntimeCapabilities,
  RuntimeError,
  type StartSessionOptions,
} from "../runtime.js";

interface FakeSession {
  id: string;
  cwd: string;
  mode: PermissionMode;
  sink: EventSink;
  queue: PromptPayload[];
  running: PromptPayload | null;
  aborted: boolean;
  approvals: Map<string, (outcome: ApprovalOutcome, comment?: string) => void>;
  allowAll: boolean;
  turns: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FakeRuntime implements AgentRuntime {
  readonly capabilities: RuntimeCapabilities = {
    supportsSteer: false,
    supportsResume: true,
    supportsPermissionModes: ["default", "acceptEdits", "plan"],
    supportsImages: false,
  };
  private readonly sessions = new Map<string, FakeSession>();

  constructor(
    readonly id: RuntimeId,
    private readonly delayMs = Number(process.env.OCW_RUNTIME_FAKE_DELAY_MS ?? 120),
  ) {}

  async detect(): Promise<RuntimeInfo> {
    return { id: this.id, installed: true, version: "fake", loggedIn: true };
  }

  async start(o: StartSessionOptions, sink: EventSink): Promise<void> {
    if (this.sessions.has(o.sessionId)) throw new RuntimeError("session exists", "session_exists");
    const s: FakeSession = {
      id: o.sessionId,
      cwd: o.cwd,
      mode: o.permissionMode,
      sink,
      queue: [],
      running: null,
      aborted: false,
      approvals: new Map(),
      allowAll: false,
      turns: 0,
    };
    this.sessions.set(s.id, s);
    sink({
      type: "session.started",
      runtime: this.id,
      runtimeSessionId: o.resumeRuntimeSessionId ?? `fake-${o.sessionId}`,
      runtimeVersion: "fake",
      ...(o.model ? { model: o.model } : {}),
      permissionMode: o.permissionMode,
    });
    sink({ type: "session.state", status: "idle" });
  }

  async prompt(sessionId: string, prompt: PromptPayload): Promise<void> {
    const s = this.get(sessionId);
    if (s.running) {
      s.queue.push(prompt);
      return;
    }
    void this.run(s, prompt);
  }

  async interrupt(sessionId: string): Promise<void> {
    const s = this.get(sessionId);
    if (!s.running) return;
    s.aborted = true;
    for (const settle of [...s.approvals.values()]) settle("deny", "Interrupted");
  }

  resolveApproval(
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
    comment?: string,
  ): boolean {
    const settle = this.sessions.get(sessionId)?.approvals.get(approvalId);
    if (!settle) return false;
    settle(decision, comment);
    return true;
  }

  async stop(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.queue.length = 0;
    if (s.running) await this.interrupt(sessionId);
    this.sessions.delete(sessionId);
    s.sink({ type: "session.state", status: "completed" });
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
  }

  // ------------------------------------------------------------------

  private get(id: string): FakeSession {
    const s = this.sessions.get(id);
    if (!s) throw new RuntimeError(`unknown session ${id}`, "unknown_session");
    return s;
  }

  private emit(s: FakeSession, e: SessionEvent) {
    s.sink(e);
  }

  private async stream(s: FakeSession, messageId: string, text: string) {
    const words = text.split(/(?<= )/);
    let acc = "";
    for (let i = 0; i < words.length; i += 3) {
      if (s.aborted) return;
      const chunk = words.slice(i, i + 3).join("");
      acc += chunk;
      this.emit(s, { type: "assistant.delta", messageId, text: chunk });
      await sleep(this.delayMs / 3);
    }
    this.emit(s, { type: "assistant.message", messageId, text: acc });
  }

  private async askApproval(s: FakeSession, tool: string, summary: string, paths: string[]) {
    if (s.allowAll || s.mode === "acceptEdits") return { outcome: "once" as ApprovalOutcome };
    const approvalId = crypto.randomUUID();
    const result = new Promise<{ outcome: ApprovalOutcome; comment?: string }>((resolve) => {
      s.approvals.set(approvalId, (outcome, comment) => {
        s.approvals.delete(approvalId);
        resolve(comment === undefined ? { outcome } : { outcome, comment });
      });
    });
    this.emit(s, { type: "approval.requested", approvalId, tool, summary, paths });
    this.emit(s, { type: "session.state", status: "waiting_approval" });
    const r = await result;
    this.emit(s, { type: "approval.resolved", approvalId, decision: r.outcome });
    if (!s.aborted) this.emit(s, { type: "session.state", status: "running" });
    if (r.outcome === "session") s.allowAll = true;
    return r;
  }

  private async run(s: FakeSession, prompt: PromptPayload): Promise<void> {
    s.running = prompt;
    s.aborted = false;
    s.turns++;
    const turn = s.turns;
    const pid = prompt.promptId;
    this.emit(s, { type: "prompt.started", promptId: pid });
    this.emit(s, { type: "session.state", status: "running" });
    let isError = false;
    try {
      await this.stream(s, `${pid}-intro`, "I'll start by reading the project README to get oriented. ");
      await sleep(this.delayMs);
      if (!s.aborted) {
        const readId = `${pid}-read`;
        this.emit(s, { type: "tool.started", toolUseId: readId, name: "Read", summary: "README.md" });
        await sleep(this.delayMs);
        const readme = await readFile(join(s.cwd, "README.md"), "utf8").catch(() => "(no README.md)");
        this.emit(s, {
          type: "tool.completed",
          toolUseId: readId,
          ok: true,
          summary: "README.md",
          output: readme.split("\n").slice(0, 12).join("\n"),
        });
      }
      const target = `notes/ocw-change-${turn}.md`;
      if (!s.aborted && s.mode !== "plan") {
        const { outcome, comment } = await this.askApproval(s, "Write", `Create ${target}`, [target]);
        if (s.aborted) {
          // fallthrough to the interrupted completion below
        } else if (outcome === "once" || outcome === "session") {
          const writeId = `${pid}-write`;
          this.emit(s, { type: "tool.started", toolUseId: writeId, name: "Write", summary: target });
          await mkdir(join(s.cwd, "notes"), { recursive: true });
          await writeFile(join(s.cwd, target), `# Change ${turn}\n\n${prompt.text}\n`);
          await sleep(this.delayMs);
          this.emit(s, { type: "tool.completed", toolUseId: writeId, ok: true, summary: `Wrote ${target}` });
          await this.stream(
            s,
            `${pid}-done`,
            `Done. I created \`${target}\` with your request:\n\n> ${prompt.text.split("\n")[0]}\n\n- Read \`README.md\` for context\n- Wrote **1 file**\n`,
          );
        } else {
          await this.stream(
            s,
            `${pid}-done`,
            `Understood, I won't write \`${target}\`.${comment ? ` Your note: _${comment}_` : ""}`,
          );
        }
      } else if (!s.aborted) {
        await this.stream(
          s,
          `${pid}-plan`,
          `Here is my plan (plan mode, no changes made):\n\n1. Read the README\n2. Make the change: _${prompt.text.split("\n")[0]}_\n3. Run the tests\n`,
        );
      }
    } catch (err) {
      isError = true;
      this.emit(s, { type: "session.error", message: err instanceof Error ? err.message : String(err) });
    }
    const interrupted = s.aborted;
    this.emit(s, {
      type: "prompt.completed",
      promptId: pid,
      usage: { inputTokens: 1200 + turn, outputTokens: 240 },
      costUsd: 0,
      ...(isError ? { isError: true } : {}),
      ...(interrupted ? { interrupted: true } : {}),
    });
    s.running = null;
    s.aborted = false;
    const next = s.queue.shift();
    if (next && this.sessions.has(s.id)) void this.run(s, next);
    else this.emit(s, { type: "session.state", status: "idle" });
  }
}
