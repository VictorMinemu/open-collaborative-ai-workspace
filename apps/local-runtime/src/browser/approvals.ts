// The device's browser approvals (07.13 D-11, D-21, D-26, D-34, PD-10, Pitfall 7). The manager asks here, not through
// an adapter's permission callback, because the runtimes' auto and bypass modes skip those callbacks (research Pattern
// 3): one broker for both runtimes and every mode.
//
// An ask is the session's normal approval flow: `approval.requested` (with `browser: { kind, origin, tool }`, a hint the
// API shows but never trusts to decide who answers) and `session.state waiting_approval`, then `approval.resolved` with
// the decision, or `expired` when nobody answered in time. The daemon routes `approval.resolve` here first; an id the
// broker does not know goes on to the adapter as before.

import { randomUUID } from "node:crypto";
import {
  type ApprovalDecision,
  type ApprovalOutcome,
  type BrowserOrigin,
  type CanonicalBrowserTool,
  type SessionEvent,
  WORK_BROWSER_LIMITS,
  type WorkBrowserApprovalKind,
} from "@ocw/contracts";

/** How long each kind waits for a person (PD-10): host and admin rules 10 min, member and sign-in asks 15 min. */
export function approvalTimeoutMs(kind: WorkBrowserApprovalKind): number {
  switch (kind) {
    case "host":
    case "admin_rule":
      return WORK_BROWSER_LIMITS.hostApprovalMinutes * 60_000;
    case "signed_in_host":
      return WORK_BROWSER_LIMITS.memberApprovalMinutes * 60_000;
    case "signin":
      return WORK_BROWSER_LIMITS.signinWaitMinutes * 60_000;
  }
}

export interface BrowserApprovalAsk {
  kind: WorkBrowserApprovalKind;
  origin: BrowserOrigin;
  tool: CanonicalBrowserTool;
  /** What the person reads ("Open https://github.com:443"): an action and an origin, never page text. */
  summary: string;
  /** The model's sign-in reason (`signin` only, 19). */
  reason?: string;
  /** Default: `approvalTimeoutMs(kind)`. */
  timeoutMs?: number;
  /** The turn was cancelled: the ask ends as `deny`. */
  signal?: AbortSignal;
}

interface Pending {
  sessionId: string;
  settle: (outcome: ApprovalOutcome, opts?: { resume?: boolean }) => void;
}

export interface BrowserApprovalBrokerOptions {
  /** The session's normal event path (the daemon's `forwardEvent`). */
  emit: (sessionId: string, event: SessionEvent) => void;
}

export class BrowserApprovalBroker {
  private readonly pendingById = new Map<string, Pending>();

  constructor(private readonly opts: BrowserApprovalBrokerOptions) {}

  /** Asks a person; resolves with their decision, `expired` after the kind's wait, or `deny` when cancelled. */
  ask(sessionId: string, req: BrowserApprovalAsk): Promise<ApprovalOutcome> {
    const approvalId = randomUUID();
    return new Promise<ApprovalOutcome>((resolve) => {
      let done = false;
      const timer = setTimeout(() => settle("expired"), req.timeoutMs ?? approvalTimeoutMs(req.kind));
      timer.unref?.();
      const onAbort = () => settle("deny");
      const settle = (outcome: ApprovalOutcome, o: { resume?: boolean } = {}) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
        this.pendingById.delete(approvalId);
        this.opts.emit(sessionId, { type: "approval.resolved", approvalId, decision: outcome });
        // Back to running while the turn goes on and nothing else waits (as the adapters report it).
        if (o.resume !== false && this.pending(sessionId) === 0) {
          this.opts.emit(sessionId, { type: "session.state", status: "running" });
        }
        resolve(outcome);
      };
      if (req.signal?.aborted) {
        done = true;
        clearTimeout(timer);
        resolve("deny");
        return;
      }
      req.signal?.addEventListener("abort", onAbort, { once: true });
      this.pendingById.set(approvalId, { sessionId, settle });
      this.opts.emit(sessionId, {
        type: "approval.requested",
        approvalId,
        tool: req.tool,
        summary: req.summary,
        paths: [],
        browser: {
          kind: req.kind,
          origin: req.origin,
          tool: req.tool,
          ...(req.reason !== undefined ? { reason: req.reason } : {}),
        },
      });
      this.opts.emit(sessionId, { type: "session.state", status: "waiting_approval" });
    });
  }

  /** A person's answer (`approval.resolve`). False when the id is not a pending browser approval of this session. */
  resolve(sessionId: string, approvalId: string, decision: ApprovalDecision): boolean {
    const p = this.pendingById.get(approvalId);
    if (!p || p.sessionId !== sessionId) return false;
    p.settle(decision);
    return true;
  }

  /** How many browser approvals of the session wait now (the manager reports `waiting_approval` like adapters do). */
  pending(sessionId: string): number {
    let n = 0;
    for (const p of this.pendingById.values()) if (p.sessionId === sessionId) n++;
    return n;
  }

  /**
   * The session's turn ended or the session left: every pending ask of it ends as `deny` (reported, but the session is
   * not set back to running).
   */
  cancelSession(sessionId: string): void {
    for (const p of [...this.pendingById.values()]) {
      if (p.sessionId === sessionId) p.settle("deny", { resume: false });
    }
  }
}
