// FakeRuntime: a deterministic AgentRuntime for end-to-end tests and offline demos. Enabled only with
// OCW_RUNTIME_FAKE=1. It never talks to a model: it streams canned text, reads a file, asks for approval
// before writing one (unless the session is in plan mode, or acceptEdits/auto), and honours interrupt.
// Settings (03.2): a fixed catalog per runtime id, `configure()` applied between turns, and every turn says
// which model it "ran" on (`Model: <id>`) so end-to-end tests can see a change land.

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
import { minMode, type RuntimeCatalog, type RuntimeModel, type SessionSettingsPatch } from "@ocw/contracts";
import {
  type AgentRuntime,
  type EventSink,
  type RuntimeCapabilities,
  RuntimeError,
  type StartSessionOptions,
} from "../runtime.js";

interface FakeSettings {
  model: string;
  effort: string | null;
  contextWindow: number | null;
  fastMode: boolean;
}

interface FakeSession {
  id: string;
  cwd: string;
  mode: PermissionMode;
  settings: FakeSettings;
  /** A change received while a turn ran (D-14): applied before the next turn. */
  pending: SessionSettingsPatch | null;
  sink: EventSink;
  queue: PromptPayload[];
  running: PromptPayload | null;
  aborted: boolean;
  approvals: Map<string, (outcome: ApprovalOutcome, comment?: string) => void>;
  allowAll: boolean;
  turns: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const EFFORTS = (levels: string[]) => levels.map((value) => ({ value, description: null }));
const fakeModel = (id: string, displayName: string, extra: Partial<RuntimeModel> = {}): RuntimeModel => ({
  id,
  displayName,
  description: null,
  legacy: false,
  isDefault: false,
  badge: null,
  efforts: EFFORTS(["low", "medium", "high", "xhigh", "max"]),
  defaultEffort: "medium",
  contextWindows: [],
  defaultContextWindow: 1_000_000,
  fastMode: { supported: false, reason: "model_not_allowed" },
  supportsAutoMode: true,
  ...extra,
});

/**
 * THE FAKE RUNTIME'S OWN CATALOG (tests and demos only). Real adapters report what the installed runtime says
 * (Claude `supportedModels()`, Codex `model/list`); nothing outside this fake hard-codes a model list.
 */
const FAKE_MODELS: Record<RuntimeId, RuntimeModel[]> = {
  "claude-code": [
    fakeModel("opus", "Claude Opus 5.5", { isDefault: true, fastMode: { supported: true, reason: null } }),
    fakeModel("sonnet", "Claude Sonnet 5.5"),
    fakeModel("fable", "Claude Fable 5.1", { efforts: EFFORTS(["low", "medium", "high"]) }),
    fakeModel("haiku", "Claude Haiku 4.5", {
      efforts: [],
      defaultEffort: null,
      defaultContextWindow: 200_000,
      supportsAutoMode: false,
    }),
    fakeModel("claude-opus-4-6", "Claude Opus 4.6", {
      legacy: true,
      efforts: EFFORTS(["low", "medium", "high", "max"]),
      defaultEffort: "high",
      contextWindows: [200_000, 1_000_000],
      defaultContextWindow: 200_000,
    }),
  ],
  codex: [
    fakeModel("gpt-6.1-sol", "GPT-6.1 Sol", {
      isDefault: true,
      defaultEffort: "low",
      fastMode: { supported: true, reason: null },
      defaultContextWindow: null,
    }),
    fakeModel("gpt-5.5", "GPT-5.5", {
      legacy: true,
      efforts: EFFORTS(["low", "medium", "high", "xhigh"]),
      defaultContextWindow: null,
    }),
  ],
};

/** D-11: what fast mode costs, in each runtime's terms. */
const FAST_MODE_COST: Record<RuntimeId, string> = {
  "claude-code": "Fast mode uses paid usage credits, not your Claude subscription limits",
  codex: "Fast mode uses your ChatGPT subscription limits at about 2.5x the standard rate",
};

export class FakeRuntime implements AgentRuntime {
  readonly capabilities: RuntimeCapabilities = {
    supportsSteer: false,
    supportsResume: true,
    supportsPermissionModes: ["default", "acceptEdits", "plan", "auto"],
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

  async catalog(): Promise<RuntimeCatalog> {
    return {
      runtime: this.id,
      runtimeVersion: "fake",
      models: FAKE_MODELS[this.id],
      permissionModes: [...this.capabilities.supportsPermissionModes],
      fastModeCost: FAST_MODE_COST[this.id],
      collectedAt: new Date().toISOString(),
    };
  }

  async configure(sessionId: string, patch: SessionSettingsPatch): Promise<void> {
    const s = this.get(sessionId);
    if (patch.permissionMode && !this.capabilities.supportsPermissionModes.includes(patch.permissionMode)) {
      throw new RuntimeError(`permission mode ${patch.permissionMode} is not supported`, "settings_rejected");
    }
    if (patch.model && !FAKE_MODELS[this.id].some((m) => m.id === patch.model)) {
      throw new RuntimeError(`unknown model ${patch.model}`, "settings_rejected");
    }
    if (s.running) {
      s.pending = { ...(s.pending ?? {}), ...patch };
      return;
    }
    this.apply(s, patch);
  }

  async start(o: StartSessionOptions, sink: EventSink): Promise<void> {
    if (this.sessions.has(o.sessionId)) throw new RuntimeError("session exists", "session_exists");
    if (!this.capabilities.supportsPermissionModes.includes(o.permissionMode)) {
      throw new RuntimeError(`permission mode not allowed: ${o.permissionMode}`, "permission_mode_rejected");
    }
    const s: FakeSession = {
      id: o.sessionId,
      cwd: o.cwd,
      mode: o.permissionMode,
      settings: {
        model: o.model ?? this.defaultModel(),
        effort: o.effort ?? null,
        contextWindow: o.contextWindow ?? null,
        fastMode: o.fastMode ?? false,
      },
      pending: null,
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
    this.reportSettings(s);
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

  private defaultModel(): string {
    return FAKE_MODELS[this.id].find((m) => m.isDefault)?.id ?? FAKE_MODELS[this.id][0]!.id;
  }

  private apply(s: FakeSession, patch: SessionSettingsPatch) {
    if (patch.model !== undefined) s.settings.model = patch.model ?? this.defaultModel();
    if (patch.effort !== undefined) s.settings.effort = patch.effort;
    if (patch.contextWindow !== undefined) s.settings.contextWindow = patch.contextWindow;
    if (patch.fastMode !== undefined) s.settings.fastMode = patch.fastMode;
    if (patch.permissionMode !== undefined) s.mode = patch.permissionMode;
    this.reportSettings(s);
  }

  private reportSettings(s: FakeSession) {
    this.emit(s, {
      type: "session.settings",
      model: s.settings.model,
      permissionMode: s.mode,
      effort: s.settings.effort,
      contextWindow: s.settings.contextWindow,
      fastMode: s.settings.fastMode,
      fastModeState: s.settings.fastMode ? "on" : "off",
    });
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

  private async askApproval(
    s: FakeSession,
    mode: PermissionMode,
    tool: string,
    summary: string,
    paths: string[],
  ) {
    // `auto` behaves like acceptEdits in the fake (no classifier).
    if (s.allowAll || mode === "acceptEdits" || mode === "auto")
      return { outcome: "once" as ApprovalOutcome };
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
    // D-14: a change held during the previous turn is applied (and reported) before this one starts.
    if (s.pending) {
      const pending = s.pending;
      s.pending = null;
      this.apply(s, pending);
    }
    // P-07: the turn runs at most at the mode the server authorized for it.
    const mode = prompt.permissionMode ? minMode(s.mode, prompt.permissionMode) : s.mode;
    const footer = `\n\nModel: ${s.settings.model}`;
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
      if (!s.aborted && mode !== "plan") {
        const { outcome, comment } = await this.askApproval(s, mode, "Write", `Create ${target}`, [target]);
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
            `Done. I created \`${target}\` with your request:\n\n> ${prompt.text.split("\n")[0]}\n\n- Read \`README.md\` for context\n- Wrote **1 file**${footer}\n`,
          );
        } else {
          await this.stream(
            s,
            `${pid}-done`,
            `Understood, I won't write \`${target}\`.${comment ? ` Your note: _${comment}_` : ""}${footer}`,
          );
        }
      } else if (!s.aborted) {
        await this.stream(
          s,
          `${pid}-plan`,
          `Here is my plan (plan mode, no changes made):\n\n1. Read the README\n2. Make the change: _${prompt.text.split("\n")[0]}_\n3. Run the tests${footer}\n`,
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
