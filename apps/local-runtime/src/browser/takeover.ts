// Taking control of a session's page on the device (07.13 D-20, D-22, PD-14, PD-15). The API decides who holds the
// lease; the device only applies it, per session:
//
// - `browser.lease { held }`: the agent's browser calls answer `paused` at once (the manager's gate reads `isPaused`),
//   the child's isolated world marks the fields that receive the holder's input (redacted from snapshots, masked in
//   screenshots), and the focus hint (`browser.focus { sensitive }`, a boolean, never a value) goes to the API.
// - `browser.input`: applied to the page only for the session's current held lease, through the agent's CDP `Input.*`
//   op. Any other lease id, session or state is ignored. Input frames, their text, keys and events are never logged,
//   kept or echoed (Semgrep `ocw.live-input-logging`): the only trace is the page itself.
// - `browser.lease { released }`: the pause ends; the page stays.
// - `browser.lease { abandoned }` (the lease was lost after input): the page closes and `takeover_abandoned` is
//   reported, so a page a person may have signed in to is never left open (T-07.13-15-05).

import type { BrowserFocusFrame, BrowserInputFrame, BrowserLeaseFrame } from "@ocw/contracts";
import type { ManagedChild } from "./manager.js";

/** What the takeover needs from the manager. */
export interface TakeoverHost {
  /** The session's running child, or null when no page is open. */
  child(sessionId: string): ManagedChild | null;
  /** `browser.focus` to the API (sent only while connected). */
  send(frame: BrowserFocusFrame): void;
  /** Closes the session's page and reports `takeover_abandoned`. */
  abandon(sessionId: string): Promise<void>;
  /** A person acted on the page: the idle close counts from now (PD-24). */
  touched(sessionId: string): void;
}

export class Takeover {
  /** sessionId → the lease id held now. */
  private readonly held = new Map<string, string>();

  constructor(private readonly host: TakeoverHost) {}

  /** A person holds the session's page: every agent call answers `paused`. */
  isPaused(sessionId: string): boolean {
    return this.held.has(sessionId);
  }

  /** The lease held now, or null. */
  leaseOf(sessionId: string): string | null {
    return this.held.get(sessionId) ?? null;
  }

  async onLease(frame: BrowserLeaseFrame): Promise<void> {
    const { sessionId, leaseId } = frame;
    if (frame.state === "held") {
      const before = this.held.get(sessionId);
      this.held.set(sessionId, leaseId);
      // A new holder (or the first): the child marks their input and reports the focus to them.
      if (before !== leaseId) this.tellChild(sessionId, true);
      return;
    }
    // Only the lease held now ends; a late frame of an earlier lease changes nothing.
    if (this.held.get(sessionId) !== leaseId) return;
    this.held.delete(sessionId);
    if (frame.state === "abandoned") {
      await this.host.abandon(sessionId);
      return;
    }
    this.tellChild(sessionId, false);
    this.host.touched(sessionId);
  }

  /** The holder's input: to the page only for the current held lease. Never logged. */
  onInput(frame: BrowserInputFrame): void {
    if (this.held.get(frame.sessionId) !== frame.leaseId) return;
    const child = this.host.child(frame.sessionId);
    if (!child) return;
    this.host.touched(frame.sessionId);
    // A refused batch (malformed, no page) is dropped silently: its content must not reach a log.
    void child.call("input", { events: frame.events }).catch(() => {});
  }

  /** The child's focus hint, for the current holder only. */
  onFocus(sessionId: string, sensitive: boolean): void {
    const leaseId = this.held.get(sessionId);
    if (!leaseId) return;
    this.host.send({ type: "browser.focus", sessionId, leaseId, sensitive });
  }

  /** The page closed or the session ended: no input is applied afterwards. */
  end(sessionId: string): void {
    this.held.delete(sessionId);
  }

  private tellChild(sessionId: string, on: boolean): void {
    const child = this.host.child(sessionId);
    if (!child) return;
    void child.call("takeover", { on }).catch(() => {});
  }
}
