// Codex session titles (Phase 03.2 Plan 12, D-18, P-17, ADR-0014): a short-lived `codex app-server` (the
// `listCodexModels` pattern) with one EPHEMERAL thread on the small model (`gpt-6-luna`), never a session's own
// thread. Isolation: read-only sandbox, `untrusted` approvals reviewed by the user (nobody: every request is
// declined and fails the title), stable fields only (`experimentalApi: false`), an empty temporary working
// directory removed afterwards, API keys stripped (the device owner's own ChatGPT login). Any item other than a
// message or reasoning (a command, a file change, a tool call, a web search) interrupts the turn and fails it.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TITLE_INSTRUCTIONS, TitleError, titleUserMessage } from "../title.js";
import type { AppServerProcess, SpawnAppServer } from "./codex-runtime.js";
import type { InitializeParams } from "./generated/InitializeParams.js";
import type { ReviewDecision } from "./generated/ReviewDecision.js";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse.js";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.js";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse.js";
import { JsonRpcError, type JsonRpcNotification, JsonRpcPeer, type JsonRpcRequest } from "./jsonrpc.js";
import { isUnrestrictedCodexPolicy } from "./mode-policy.js";

const RPC_TIMEOUT_MS = 30_000;
/** Items a title turn may produce; `hookPrompt` items come from the owner's local hooks and are ignored. */
const ALLOWED_ITEMS = new Set(["userMessage", "agentMessage", "reasoning", "hookPrompt"]);

export interface CodexTitleOptions {
  env: Record<string, string | undefined>;
  prompt: string;
  /** `gpt-6-luna`; the thread must report exactly this model. */
  model: string;
  /** The model's lowest catalog effort (`low`). */
  effort: string | null;
  signal: AbortSignal;
  /** Parent of the temporary working directory (tests). */
  tmpRoot?: string;
  /** Observe every JSON-RPC message (fixture recording). */
  onRpcMessage?: (direction: "in" | "out", message: unknown) => void;
}

/** The stable `thread/start` fields of a title thread (exported for the tests and the recorder). */
export function titleThreadParams(cwd: string, model: string): ThreadStartParams {
  return {
    cwd,
    model,
    sandbox: "read-only",
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    ephemeral: true,
    baseInstructions: TITLE_INSTRUCTIONS,
  };
}

/** A declining answer for every approval request Codex may send (and a refusal for anything else). */
function decline(r: JsonRpcRequest): unknown {
  switch (r.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "item/permissions/requestApproval":
      return { permissions: {}, scope: "turn" };
    case "execCommandApproval":
    case "applyPatchApproval":
      return {
        decision: { denied: { rejection: "Session titles never use tools." } } satisfies ReviewDecision,
      };
    default:
      throw new JsonRpcError(`${r.method} is not supported by this client`, -32601);
  }
}

/** One title turn; returns the final agent message (the daemon normalizes and sanitizes it). */
export async function generateCodexTitle(spawn: SpawnAppServer, o: CodexTitleOptions): Promise<string> {
  if (o.signal.aborted) throw new TitleError("title_failed", "aborted");
  const cwd = await mkdtemp(join(o.tmpRoot ?? tmpdir(), "ocw-title-"));
  let proc: AppServerProcess | null = null;
  let peer: JsonRpcPeer | null = null;
  let threadId: string | null = null;
  let turnId: string | null = null;
  let lastText: string | null = null;
  let settle: { resolve: () => void; reject: (e: TitleError) => void } | null = null;
  let failure: TitleError | null = null;
  const finished = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject };
  });
  finished.catch(() => undefined);

  const interrupt = () => {
    if (peer && threadId && turnId) {
      peer.request("turn/interrupt", { threadId, turnId }, 5_000).catch(() => undefined);
    }
  };
  const fail = (err: TitleError) => {
    if (failure) return;
    failure = err;
    interrupt();
    settle?.reject(err);
  };
  const onAbort = () => fail(new TitleError("title_failed", "aborted"));
  o.signal.addEventListener("abort", onAbort, { once: true });

  const onNotification = (n: JsonRpcNotification) => {
    const params = (n.params ?? {}) as {
      item?: { type?: string; text?: string };
      turn?: { id?: string; status?: string };
    };
    if (n.method === "item/started") {
      const type = String(params.item?.type ?? "");
      if (!ALLOWED_ITEMS.has(type)) fail(new TitleError("title_used_tool", type || "unknown item"));
    } else if (n.method === "item/completed") {
      if (params.item?.type === "agentMessage" && typeof params.item.text === "string") {
        lastText = params.item.text;
      }
    } else if (n.method === "turn/completed") {
      if (params.turn?.status === "completed") settle?.resolve();
      else fail(new TitleError("title_failed", `the title turn ended ${params.turn?.status ?? "unknown"}`));
    }
  };

  try {
    proc = spawn({ cwd, env: o.env });
    proc.stderr?.resume();
    peer = new JsonRpcPeer(proc.stdout, proc.stdin, {
      onNotification,
      onRequest: async (r) => {
        const answer = decline(r);
        fail(new TitleError("title_used_tool", r.method));
        return answer;
      },
      onClose: () => fail(new TitleError("title_failed", "the Codex app-server exited")),
      ...(o.onRpcMessage ? { onLine: o.onRpcMessage } : {}),
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      finished.catch(reject);
    });
    aborted.catch(() => undefined);
    const step = <T>(p: Promise<T>): Promise<T> => Promise.race([p, aborted]);

    const init: InitializeParams = {
      clientInfo: { name: "ocw_local_runtime", title: "Open Collaborative AI Workspace", version: "0.0.0" },
      capabilities: { experimentalApi: false, requestAttestation: false },
    };
    await step(peer.request("initialize", init, RPC_TIMEOUT_MS));
    peer.notify("initialized");
    const thread = await step(
      peer.request<ThreadStartResponse>("thread/start", titleThreadParams(cwd, o.model), RPC_TIMEOUT_MS),
    );
    if (isUnrestrictedCodexPolicy({ approvalPolicy: thread.approvalPolicy, sandboxPolicy: thread.sandbox })) {
      throw new TitleError("title_failed", "Codex reported an unrestricted sandbox or approval policy");
    }
    if (thread.model !== o.model) {
      throw new TitleError("title_model_mismatch", `the thread runs ${thread.model}`);
    }
    threadId = thread.thread.id;
    const turnParams: TurnStartParams = {
      threadId,
      input: [{ type: "text", text: titleUserMessage(o.prompt), text_elements: [] }],
      ...(o.effort ? { effort: o.effort } : {}),
      summary: "none",
    };
    const turn = await step(peer.request<TurnStartResponse>("turn/start", turnParams, RPC_TIMEOUT_MS));
    turnId = turn?.turn?.id ?? null;
    if (failure) interrupt(); // a failure seen before the turn id was known
    await finished;
    if (failure) throw failure;
    if (lastText === null) throw new TitleError("title_failed", "the title turn produced no message");
    return lastText;
  } catch (err) {
    if (err instanceof TitleError) throw err;
    throw new TitleError("title_failed", err instanceof Error ? err.message : String(err));
  } finally {
    o.signal.removeEventListener("abort", onAbort);
    peer?.close();
    try {
      proc?.stdin.end();
      proc?.kill("SIGTERM");
    } catch {
      // already gone
    }
    await rm(cwd, { recursive: true, force: true });
  }
}
