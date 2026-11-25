// Taking control of a session's page on the device (07.13 D-20, D-22, PD-14, PD-15). The API decides who holds the
// lease; the device only applies it, per session:
//
// - `browser.lease { held }`: the agent's browser calls answer `paused` at once (the manager's gate reads `isPaused`),
//   the child's isolated world marks the fields that receive the holder's input (redacted from snapshots, masked in
//   screenshots), and the focus hint (`browser.focus { sensitive }`, a boolean, never a value) goes to the API.
// - `browser.input`: applied to the page only for the session's current held lease, through the agent's CDP `Input.*`
//   op. Any other lease id, session or state is ignored. Input frames, their text, keys and events are never logged,
//   kept or echoed (Semgrep `ocw.live-input-logging`): the only trace is the page itself.
// - `browser.lease { released }` or `browser.handback { save: false }`: the pause ends; the page stays.
// - `browser.handback { save: true, uploadId }`: `onSaveHandback` exports the page's site state and uploads it (07.13-19,
//   `signin.ts`: compared with the fingerprint the manager took on `held`), then the pause ends. The API sends no
//   `released` after a save: the hand back itself ends the pause.
// - `browser.lease { abandoned }` (the lease was lost after input): the page closes and `takeover_abandoned` is
//   reported, so a page a person may have signed in to is never left open (T-07.13-15-05).

import type {
  BrowserFocusFrame,
  BrowserHandbackFrame,
  BrowserInputFrame,
  BrowserLeaseFrame,
} from "@ocw/contracts";
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
  /**
   * 19: a person took control of the page (a new lease): the manager takes the site state's fingerprint. HI-03: it may
   * also end the lease (`end`) and close a page that holds another member's sign-in; awaited before `onLease` returns.
   * The holder the API named (`holderUserId`) is readable through `holderOf` by then.
   */
  held?(sessionId: string, leaseId: string): void | Promise<void>;
  /** 19: "Done, save my sign-in": export and upload (the agent is still paused while this runs). */
  save?(sessionId: string, leaseId: string, uploadId: string): Promise<void>;
}

export class Takeover {
  /** sessionId → the lease id held now. */
  private readonly held = new Map<string, string>();
  /** HI-03: sessionId → the person the API granted the held lease to (absent: an older API that does not say). */
  private readonly holders = new Map<string, string>();

  constructor(private readonly host: TakeoverHost) {}

  /** A person holds the session's page: every agent call answers `paused`. */
  isPaused(sessionId: string): boolean {
    return this.held.has(sessionId);
  }

  /** The lease held now, or null. */
  leaseOf(sessionId: string): string | null {
    return this.held.get(sessionId) ?? null;
  }

  /**
   * HI-03: the person holding the session's page, as the API named them on `held` (`browser.lease.holderUserId`).
   * Undefined when nobody holds it, or when the API did not name the holder (older builds).
   */
  holderOf(sessionId: string): string | undefined {
    return this.held.has(sessionId) ? this.holders.get(sessionId) : undefined;
  }

  async onLease(frame: BrowserLeaseFrame): Promise<void> {
    const { sessionId, leaseId } = frame;
    if (frame.state === "held") {
      const before = this.held.get(sessionId);
      this.held.set(sessionId, leaseId);
      if (before !== leaseId) {
        if (frame.holderUserId) this.holders.set(sessionId, frame.holderUserId);
        else this.holders.delete(sessionId);
      }
      // A new holder (or the first): the child marks their input and reports the focus to them.
      if (before !== leaseId) {
        this.tellChild(sessionId, true);
        await this.host.held?.(sessionId, leaseId);
      }
      return;
    }
    // Only the lease held now ends; a late frame of an earlier lease changes nothing.
    if (this.held.get(sessionId) !== leaseId) return;
    this.end(sessionId);
    if (frame.state === "abandoned") {
      await this.host.abandon(sessionId);
      return;
    }
    this.tellChild(sessionId, false);
    this.host.touched(sessionId);
  }

  /**
   * The holder handed the page back (D-22, PD-15). `save` with an `uploadId` first goes to `onSaveHandback` while the
   * agent is still paused (the page must not move under the export); then the pause ends and the page stays on its URL.
   * A hand back of any other lease changes nothing.
   */
  async onHandback(frame: BrowserHandbackFrame): Promise<void> {
    const { sessionId, leaseId } = frame;
    if (this.held.get(sessionId) !== leaseId) return;
    if (frame.save && frame.uploadId) {
      await this.onSaveHandback(sessionId, leaseId, frame.uploadId).catch(() => {});
    }
    // The save may have taken a while: only the same lease ends here.
    if (this.held.get(sessionId) !== leaseId) return;
    this.end(sessionId);
    this.tellChild(sessionId, false);
    this.host.touched(sessionId);
  }

  /**
   * "Save this sign-in" at hand back (D-22, PD-15): the manager exports the page's site state from the child and PUTs it
   * to the one-use upload (`uploadId`, bound by the API to the session, the member and the origin) with the device JWT.
   */
  async onSaveHandback(sessionId: string, leaseId: string, uploadId: string): Promise<void> {
    await this.host.save?.(sessionId, leaseId, uploadId);
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
    this.holders.delete(sessionId);
  }

  private tellChild(sessionId: string, on: boolean): void {
    const child = this.host.child(sessionId);
    if (!child) return;
    void child.call("takeover", { on }).catch(() => {});
  }
}
