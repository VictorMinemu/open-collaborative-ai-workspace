// The session's `ocw_session` tools on the device (07.13.1.1 D-07, D-08, PD-08 … PD-11; ADR-0047). One relay per
// daemon, fed at the same call sites as the browser manager: each start's and prompt's `sessionTools` grant, the turn
// events, the session's end and the `session.rename.result` frames.
//
// The relay refuses on its own what it can, before any frame and in this order: not offered (`not_available`), no
// turn in flight (`no_turn`), the turn's grant says a person typed the title (`title_locked`), the turn already renamed
// (`already_renamed`), a body that is not `SessionRenameInput`, a title longer than the shape allows or that normalizes
// to nothing, that `sanitizeString` would change (a host path or a secret), or that fails `SessionTitle`
// (`invalid_title`). Refused, never fixed (Pitfall 11). The API decides the rest (`session.rename`, answered by
// `session.rename.result` with the same `requestId`, or nothing within 5 s: then `not_available`).
//
// A title, a rule or the call's arguments are never logged: log lines carry the session id and the refusal code only.
// The Codex shim reaches the relay through the control socket with the session's 0600 token (`shimList`, `shimCall`).

import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  normalizeSessionTitle,
  SESSION_RENAME_TIMEOUT_MS,
  SESSION_TITLE_MAX_CHARS,
  SESSION_TITLE_MAX_WORDS,
  type SessionRenameFrame,
  SessionRenameInput,
  type SessionRenameRefusal,
  type SessionRenameResultFrame,
  SessionTitle,
  type SessionToolsGrant,
  titleWords,
  WorkSessionTool,
} from "@ocw/contracts";
import { ensureShimToken, verifyShimToken } from "../browser/shim-token.js";
import type { Logger } from "../logger.js";
import type { SessionToolResult, SessionToolsHandle } from "../runtime.js";
import { sanitizeString } from "../sanitize.js";
import { refusalResult, renameDescription, renameResult } from "./tools.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long the device waits for the API's answer to a rename (PD-09); the API decides within less (IN-03). */
export { SESSION_RENAME_TIMEOUT_MS };

/** Prompts handed over and not yet started, kept per session at most (an API that never starts them). */
const MAX_PENDING = 64;

export interface SessionToolRelayOptions {
  /** The Device Link's send: false when the frame could not go out now (offline), so the call ends at once. */
  send: (frame: SessionRenameFrame) => boolean;
  /** The session's roots for `sanitizeString` (project, worktree and their realpaths). */
  rootsFor: (sessionId: string) => readonly string[];
  /** The daemon's OCW home: shim tokens live under `<ocwHome>/run/sessions/<sessionId>/`. */
  ocwHome: string;
  /** How long a rename waits for the API (default `SESSION_RENAME_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** `contain()`'s home (tests); default the OS user's. */
  home?: string;
  log?: Logger;
}

type RenameResult = SessionRenameResultFrame["result"];

interface Turn {
  promptId: string;
  grant: SessionToolsGrant | undefined;
  /** A rename of this turn was accepted, or one is on its way (a second call is `already_renamed`). */
  renamed: boolean;
}

interface SessionState {
  id: string;
  /** The newest grant (start or prompt); decides `offered` and the description. */
  latestGrant: SessionToolsGrant | undefined;
  /** Grants of prompts handed over and not yet started, by prompt id. */
  pending: Map<string, { grant: SessionToolsGrant | undefined; steer: boolean }>;
  turn: Turn | null;
  unavailable: "shadowed" | "runtime" | null;
  handle: SessionToolsHandle;
  listeners: Set<() => void>;
  /** `offered` and the description as the listeners last saw them. */
  lastSeen: string;
}

interface PendingRename {
  sessionId: string;
  resolve: (result: RenameResult | null) => void;
}

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
   * newest decides `offered` and the description. `steer` = the prompt joins the running turn (never a new one).
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

  /** `prompt.started`: a new turn with that prompt's grant; a steer keeps the running turn (and its rename) as it is. */
  onTurnStarted(sessionId: string, promptId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const pending = s.pending.get(promptId);
    s.pending.delete(promptId);
    if (pending?.steer && s.turn) return;
    s.turn = { promptId, grant: pending?.grant, renamed: false };
  }

  /** `prompt.completed`: calls outside a turn are refused `no_turn`. */
  onTurnEnded(sessionId: string, promptId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.turn?.promptId !== promptId) return;
    s.turn = null;
  }

  /** The session left the device: its waiting calls end `not_available` and its run dir (shim token) goes. */
  async endSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) {
      this.sessions.delete(sessionId);
      s.turn = null;
      for (const p of [...this.waiting.values()]) if (p.sessionId === sessionId) p.resolve(null);
      this.notify(s);
    }
    if (UUID.test(sessionId)) {
      await rm(this.runDir(sessionId), { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Removes the run dirs of sessions not in `alive` (default: this relay's sessions), e.g. after a crash. */
  async sweep(alive: ReadonlySet<string> = new Set(this.sessions.keys())): Promise<void> {
    const dir = join(this.opts.ocwHome, "run", "sessions");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (alive.has(name) || this.sessions.has(name)) continue;
      await rm(join(dir, name), { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  }

  /** `session.rename.result`: the answer to one of this device's renames (by request id); any other is dropped. */
  onServerFrame(frame: SessionRenameResultFrame): boolean {
    const p = this.waiting.get(frame.requestId);
    if (!p) return false;
    p.resolve(frame.result);
    return true;
  }

  /** Daemon stop: every waiting call ends `not_available`, every session's run dir goes. */
  async stop(): Promise<void> {
    for (const p of [...this.waiting.values()]) p.resolve(null);
    await Promise.all([...this.sessions.keys()].map((id) => this.endSession(id)));
  }

  /**
   * The Codex shim's tool list over the control socket (plan 05): only with the session's own token, read from its
   * 0600 file now. Throws `not allowed` otherwise; the token is never logged.
   */
  async shimList(req: {
    session: string;
    token: string;
  }): Promise<Array<{ name: WorkSessionTool; description: string }>> {
    const s = await this.shimSession(req.session, req.token);
    if (!s) throw new Error("not allowed");
    return WorkSessionTool.options.map((name) => ({ name, description: s.handle.description(name) }));
  }

  /** The Codex shim's call (plan 05): the session's own token and a known tool, else an error result, no frame. */
  async shimCall(req: {
    session: string;
    token: string;
    tool: string;
    args: unknown;
  }): Promise<SessionToolResult> {
    const s = await this.shimSession(req.session, req.token);
    const tool = WorkSessionTool.safeParse(req.tool);
    if (!s || !tool.success) return refusalResult("not_available");
    return s.handle.call(tool.data, req.args);
  }

  // ------------------------------------------------------------------ internals

  /** `<ocwHome>/run/sessions/<sessionId>` (the shim token's home). */
  private runDir(sessionId: string): string {
    if (!UUID.test(sessionId)) throw new Error("the session id is not a uuid");
    return join(this.opts.ocwHome, "run", "sessions", sessionId);
  }

  private async shimSession(sessionId: string, token: string): Promise<SessionState | null> {
    const s = this.sessions.get(sessionId);
    if (!s || !UUID.test(sessionId) || typeof token !== "string") return null;
    return (await verifyShimToken(this.runDir(sessionId), token)) ? s : null;
  }

  private state(sessionId: string): SessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const relay = this;
    const s: SessionState = {
      id: sessionId,
      latestGrant: undefined,
      pending: new Map(),
      turn: null,
      unavailable: null,
      listeners: new Set(),
      lastSeen: "",
      handle: undefined as unknown as SessionToolsHandle,
    };
    s.handle = {
      get offered() {
        return relay.offered(s);
      },
      description: () => renameDescription(s.latestGrant?.namingRules ?? null),
      call: (tool, args, signal) => this.call(s, tool, args, signal),
      markUnavailable: (reason) => {
        s.unavailable = reason;
        this.notify(s);
      },
      onChange: (cb) => {
        s.listeners.add(cb);
        return () => s.listeners.delete(cb);
      },
      shimTokenFile: () => ensureShimToken(this.runDir(s.id)),
    };
    s.lastSeen = this.seen(s);
    this.sessions.set(sessionId, s);
    return s;
  }

  private offered(s: SessionState): boolean {
    return (
      this.sessions.get(s.id) === s &&
      UUID.test(s.id) &&
      s.unavailable === null &&
      s.latestGrant !== undefined
    );
  }

  private seen(s: SessionState): string {
    return `${this.offered(s)}\u0000${s.handle?.description("rename") ?? ""}`;
  }

  /** Tells the adapter when `offered` or the description changed (never for an unchanged grant). */
  private notify(s: SessionState): void {
    const now = this.seen(s);
    if (now === s.lastSeen) return;
    s.lastSeen = now;
    for (const cb of s.listeners) {
      try {
        cb();
      } catch {
        // An adapter's callback never breaks the relay.
      }
    }
  }

  private refuse(s: SessionState, reason: SessionRenameRefusal): SessionToolResult {
    this.opts.log?.debug("session rename refused on the device", { sessionId: s.id, reason });
    return refusalResult(reason);
  }

  /** The title to send, or null when it must be refused (`invalid_title`): checked, never fixed. */
  private titleOf(s: SessionState, args: unknown): string | null {
    const body = SessionRenameInput.safeParse(args);
    if (!body.success) return null;
    const raw = body.data.title;
    const trimmed = raw.trim();
    // Normalizing would cut a longer title on a word boundary: the agent's title is refused instead.
    if (trimmed.length > SESSION_TITLE_MAX_CHARS || titleWords(trimmed).length > SESSION_TITLE_MAX_WORDS) {
      return null;
    }
    const title = normalizeSessionTitle(raw);
    if (!title) return null;
    // D-20, Pitfall 11: no host path and no secret, in the raw text or the normalized one.
    const roots = this.opts.rootsFor(s.id);
    const clean = (text: string) => sanitizeString(text, roots, this.opts.home) === text;
    if (!clean(raw) || !clean(title)) return null;
    return SessionTitle.safeParse(title).success ? title : null;
  }

  private async call(
    s: SessionState,
    tool: WorkSessionTool,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<SessionToolResult> {
    if (tool !== "rename" || !this.offered(s)) return this.refuse(s, "not_available");
    const turn = s.turn;
    if (!turn) return this.refuse(s, "no_turn");
    if (!turn.grant) return this.refuse(s, "not_available");
    if (!turn.grant.rename) return this.refuse(s, "title_locked");
    if (turn.renamed) return this.refuse(s, "already_renamed");
    const title = this.titleOf(s, args);
    if (title === null) return this.refuse(s, "invalid_title");
    turn.renamed = true;
    const result = await this.request(s.id, turn.promptId, title, signal);
    // Only an accepted rename, or the API saying the turn already renamed, uses up the turn's rename.
    turn.renamed = result !== null && (result.ok || result.reason === "already_renamed");
    if (!result) return this.refuse(s, "not_available");
    if (!result.ok)
      this.opts.log?.debug("session rename refused by the API", { sessionId: s.id, reason: result.reason });
    return renameResult(result);
  }

  /** Sends `session.rename` and waits for the matching answer; null on timeout, abort, offline or session end. */
  private request(
    sessionId: string,
    promptId: string,
    title: string,
    signal?: AbortSignal,
  ): Promise<RenameResult | null> {
    if (!UUID.test(sessionId) || promptId.length < 1 || promptId.length > 128) return Promise.resolve(null);
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
