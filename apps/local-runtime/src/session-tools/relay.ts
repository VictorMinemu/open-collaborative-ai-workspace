// The session's `ocw_session` tools on the device (07.13.1.1 D-07, D-08, PD-08 … PD-11; ADR-0047). One relay per
// daemon, fed at the same call sites as the browser manager: each start's and prompt's `sessionTools` grant, the turn
// events, the session's end and the `session.rename.result` frames.
//
// The relay decides what it can on its own; the API decides the rename (`session.rename` on the Device Link, answered
// by `session.rename.result` with the same `requestId`, or nothing within 5 s: then `not_available`). A title, a rule
// or the call's arguments are never logged.

import { randomUUID } from "node:crypto";
import {
  SESSION_RENAME_REFUSAL_TEXT,
  type SessionRenameFrame,
  type SessionRenameRefusal,
  type SessionRenameResultFrame,
  type SessionToolsGrant,
  type WorkSessionTool,
} from "@ocw/contracts";
import type { Logger } from "../logger.js";
import type { SessionToolResult, SessionToolsHandle } from "../runtime.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long the device waits for the API's answer to a rename (PD-09): then `not_available`. */
export const SESSION_RENAME_TIMEOUT_MS = 5_000;

export interface SessionToolRelayOptions {
  /** The Device Link's send: false when the frame could not go out now (offline), so the call ends at once. */
  send: (frame: SessionRenameFrame) => boolean;
  /** The session's roots for `sanitizeString` (project, worktree and their realpaths). */
  rootsFor: (sessionId: string) => readonly string[];
  /** The daemon's OCW home: shim tokens live under `<ocwHome>/run/sessions/<sessionId>/`. */
  ocwHome: string;
  /** How long a rename waits for the API (default `SESSION_RENAME_TIMEOUT_MS`). */
  timeoutMs?: number;
  log?: Logger;
}

type RenameResult = SessionRenameResultFrame["result"];

interface Turn {
  promptId: string;
  grant: SessionToolsGrant | undefined;
}

interface SessionState {
  id: string;
  /** The newest grant (start or prompt); decides `offered`. */
  latestGrant: SessionToolsGrant | undefined;
  /** Grants of prompts handed over and not yet started, by prompt id. */
  pending: Map<string, { grant: SessionToolsGrant | undefined; steer: boolean }>;
  turn: Turn | null;
  handle: SessionToolsHandle;
  listeners: Set<() => void>;
}

interface PendingRename {
  sessionId: string;
  resolve: (result: RenameResult | null) => void;
}

/** A refusal's fixed sentence as an error result. */
function refusal(reason: SessionRenameRefusal): SessionToolResult {
  return { content: [{ type: "text", text: SESSION_RENAME_REFUSAL_TEXT[reason] }], isError: true };
}

/** What the agent reads back for the API's answer. */
function resultOf(result: RenameResult): SessionToolResult {
  if (!result.ok) return refusal(result.reason);
  return { content: [{ type: "text", text: `Renamed the session to "${result.title}".` }], isError: false };
}

/** Prompts handed over and not yet started, kept per session at most (an API that never starts them). */
const MAX_PENDING = 64;

export class SessionToolRelay {
  private readonly sessions = new Map<string, SessionState>();
  private readonly waiting = new Map<string, PendingRename>();

  constructor(private readonly opts: SessionToolRelayOptions) {}

  /** The session's handle (one object per session, created on first use). */
  forSession(sessionId: string): SessionToolsHandle {
    return this.state(sessionId).handle;
  }

  /**
   * A grant arrived with `session.start` (`promptId` null) or a `prompt`: the turn that prompt starts uses it, the
   * newest decides `offered`. `steer` = the prompt joins the running turn (never a new one).
   */
  onPrompt(
    sessionId: string,
    promptId: string | null,
    grant: SessionToolsGrant | undefined,
    opts: { steer?: boolean } = {},
  ): void {
    const s = this.state(sessionId);
    s.latestGrant = grant;
    if (promptId !== null) {
      s.pending.delete(promptId);
      s.pending.set(promptId, { grant, steer: opts.steer === true });
      while (s.pending.size > MAX_PENDING) {
        const first = s.pending.keys().next().value;
        if (first === undefined) break;
        s.pending.delete(first);
      }
    }
    this.notify(s);
  }

  /** `prompt.started`: a new turn with that prompt's grant; a steer keeps the running turn as it is. */
  onTurnStarted(sessionId: string, promptId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const pending = s.pending.get(promptId);
    s.pending.delete(promptId);
    if (pending?.steer && s.turn) return;
    s.turn = { promptId, grant: pending?.grant };
  }

  /** `prompt.completed`: calls outside a turn are refused `no_turn`. */
  onTurnEnded(sessionId: string, promptId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.turn?.promptId !== promptId) return;
    s.turn = null;
  }

  /** The session left the device: its waiting calls end `not_available`. */
  async endSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    s.turn = null;
    for (const p of [...this.waiting.values()]) if (p.sessionId === sessionId) p.resolve(null);
    this.notify(s);
  }

  /** `session.rename.result`: the answer to one of this device's renames (by request id); any other is dropped. */
  onServerFrame(frame: SessionRenameResultFrame): boolean {
    const p = this.waiting.get(frame.requestId);
    if (!p) return false;
    p.resolve(frame.result);
    return true;
  }

  /** Daemon stop: every waiting call ends `not_available`. */
  async stop(): Promise<void> {
    for (const p of [...this.waiting.values()]) p.resolve(null);
    await Promise.all([...this.sessions.keys()].map((id) => this.endSession(id)));
  }

  // ------------------------------------------------------------------ internals

  private state(sessionId: string): SessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const relay = this;
    const s: SessionState = {
      id: sessionId,
      latestGrant: undefined,
      pending: new Map(),
      turn: null,
      listeners: new Set(),
      handle: undefined as unknown as SessionToolsHandle,
    };
    s.handle = {
      get offered() {
        return relay.offered(s);
      },
      description: () => "Rename this Work Zone session.",
      call: (tool, args, signal) => this.call(s, tool, args, signal),
      markUnavailable: () => undefined,
      onChange: (cb) => {
        s.listeners.add(cb);
        return () => s.listeners.delete(cb);
      },
      shimTokenFile: () => Promise.reject(new Error("not available")),
    };
    this.sessions.set(sessionId, s);
    return s;
  }

  private offered(s: SessionState): boolean {
    return this.sessions.get(s.id) === s && UUID.test(s.id) && s.latestGrant !== undefined;
  }

  private notify(s: SessionState): void {
    for (const cb of s.listeners) {
      try {
        cb();
      } catch {
        // An adapter's callback never breaks the relay.
      }
    }
  }

  private async call(
    s: SessionState,
    _tool: WorkSessionTool,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<SessionToolResult> {
    if (!this.offered(s)) return refusal("not_available");
    const turn = s.turn;
    if (!turn) return refusal("no_turn");
    const title = (args as { title?: unknown } | null)?.title;
    if (typeof title !== "string") return refusal("invalid_title");
    const result = await this.request(s.id, turn.promptId, title, signal);
    return result ? resultOf(result) : refusal("not_available");
  }

  /** Sends `session.rename` and waits for the matching answer; null on timeout, abort, offline or session end. */
  private request(
    sessionId: string,
    promptId: string,
    title: string,
    signal?: AbortSignal,
  ): Promise<RenameResult | null> {
    const requestId = randomUUID();
    return new Promise<RenameResult | null>((resolve) => {
      const timer = setTimeout(() => settle(null), this.opts.timeoutMs ?? SESSION_RENAME_TIMEOUT_MS);
      timer.unref?.();
      const onAbort = () => settle(null);
      const settle = (result: RenameResult | null) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (!this.waiting.delete(requestId)) return;
        resolve(result);
      };
      this.waiting.set(requestId, { sessionId, resolve: settle });
      if (signal?.aborted) return settle(null);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (!this.opts.send({ type: "session.rename", requestId, sessionId, promptId, title })) settle(null);
    });
  }
}
