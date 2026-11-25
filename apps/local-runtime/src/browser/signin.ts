// A member's sign-in on the device (07.13 D-21 … D-26, D-32, PD-15 … PD-17; ADR-0035). The device never keeps one:
//
// - Hand back with save (PD-15): `saveHandback` exports the page's site state from the child (`exportState`:
//   `filterStateForSite`, cookies that domain-match the host and that host's origin storage only), compares its hash
//   with the one taken when the person took control (`changed`) and PUTs `WorkBrowserSignInUpload` to the one-use
//   upload route with the device JWT. 201 = sealed.
// - Load (PD-16): `SignInLoads.request` sends `browser.signin.load` for the turn and the origin and waits for the
//   matching `browser.signin.state` (by `requestId`) for at most 5 s; an API that does not answer (another device's
//   session, an offline link) leaves the page public. The state goes straight into the child's new in-memory context.
// - Unload (PD-17): `reseal` exports the locked page's state and PUTs it to `…/:signinId/state` BEFORE the manager
//   closes that context and reports `signin_unloaded` (after the unload the API answers 409).
//
// A storage state lives here only as a local variable on its way between the child and the API: never logged, never
// in an event, a frame of ours, a file or a field of a long-lived object.

import { randomUUID } from "node:crypto";
import {
  type BrowserOrigin,
  type BrowserSignInLoadFrame,
  type BrowserSignInStateFrame,
  WORK_BROWSER_SIGNIN_ROUTES,
  type WorkBrowserRefusal,
  type WorkBrowserSignInUpload,
} from "@ocw/contracts";
import type { ExportStateResult } from "./agent/ops.js";
import type { ManagedChild } from "./manager.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long the device waits for the API's answer to a load (PD-16): then the page opens public. */
export const SIGNIN_LOAD_TIMEOUT_MS = 5_000;
/** One sign-in PUT at most (the daemon's own fetch gives up at 30 s; an unload must not wait that long). */
const PUT_TIMEOUT_MS = 15_000;

/** The daemon's device-JWT client (`BrowserManagerOptions.api`). */
export interface SignInApi {
  put(path: string, body: unknown): Promise<number>;
}

/** `WORK_BROWSER_SIGNIN_ROUTES.upload` for a uuid, else null (no other path is ever built). */
export function uploadPath(uploadId: string): string | null {
  return UUID.test(uploadId) ? WORK_BROWSER_SIGNIN_ROUTES.upload.replace(":uploadId", uploadId) : null;
}

/** `WORK_BROWSER_SIGNIN_ROUTES.reseal` for a uuid, else null. */
export function resealPath(signinId: string): string | null {
  return UUID.test(signinId) ? WORK_BROWSER_SIGNIN_ROUTES.reseal.replace(":signinId", signinId) : null;
}

/** `URL.host` of an origin, as the agent names a site (`127.0.0.1:8080`, `github.com`). */
export function siteHostOfOrigin(origin: BrowserOrigin): string {
  return new URL(origin).host;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The site's state from the child, or why there is none (a refusal code only, never a message). */
async function exportState(
  child: ManagedChild,
  origin: BrowserOrigin,
): Promise<ExportStateResult | { refusal: WorkBrowserRefusal }> {
  try {
    return (await child.call("exportState", { host: siteHostOfOrigin(origin) })) as ExportStateResult;
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    return { refusal: code === "too_large" ? "too_large" : "browser_unavailable" };
  }
}

async function put(api: SignInApi, path: string, body: WorkBrowserSignInUpload): Promise<number | null> {
  return withTimeout(
    api.put(path, body).catch(() => null),
    PUT_TIMEOUT_MS,
  );
}

export type SaveOutcome =
  /** 201: sealed for the member. */
  | { kind: "saved" }
  /** The API answered (200: nothing new to seal; 404/409/410: the upload is gone or used). */
  | { kind: "not_saved"; status: number }
  /** Nothing was sent: the state is too large, or no state could be read. */
  | { kind: "refused"; refusal: WorkBrowserRefusal }
  /** The PUT got no answer. */
  | { kind: "failed" };

/**
 * "Done, save my sign-in" (D-22, PD-15): the page's site state, uploaded once to `uploadId` with `changed` against the
 * fingerprint taken when the person took control (null: none was taken, so it counts as changed).
 */
export async function saveHandback(opts: {
  child: ManagedChild;
  api: SignInApi;
  sessionId: string;
  uploadId: string;
  origin: BrowserOrigin;
  fingerprintAtHeld: string | null;
}): Promise<SaveOutcome> {
  const path = uploadPath(opts.uploadId);
  if (!path || !UUID.test(opts.sessionId)) return { kind: "refused", refusal: "not_allowed" };
  const exported = await exportState(opts.child, opts.origin);
  if ("refusal" in exported) return { kind: "refused", refusal: exported.refusal };
  const status = await put(opts.api, path, {
    sessionId: opts.sessionId,
    origin: opts.origin,
    state: exported.state,
    changed: opts.fingerprintAtHeld === null || exported.fingerprint !== opts.fingerprintAtHeld,
  });
  if (status === null) return { kind: "failed" };
  return status === 201 ? { kind: "saved" } : { kind: "not_saved", status };
}

/**
 * The re-seal before an unload (D-25, PD-17): the locked page's state to `…/:signinId/state`, `changed` against the
 * state as it was loaded. Answers the HTTP status, or null when nothing could be sent or no answer came. The caller
 * unloads whatever this answers.
 */
export async function reseal(opts: {
  child: ManagedChild;
  api: SignInApi;
  sessionId: string;
  signinId: string;
  origin: BrowserOrigin;
  fingerprintAtLoad: string;
}): Promise<number | null> {
  const path = resealPath(opts.signinId);
  if (!path || !UUID.test(opts.sessionId) || opts.child.state !== "running") return null;
  const exported = await exportState(opts.child, opts.origin);
  if ("refusal" in exported) return null;
  return put(opts.api, path, {
    sessionId: opts.sessionId,
    origin: opts.origin,
    state: exported.state,
    changed: exported.fingerprint !== opts.fingerprintAtLoad,
  });
}

type LoadResult = BrowserSignInStateFrame["result"];

interface PendingLoad {
  sessionId: string;
  resolve: (result: LoadResult | null) => void;
}

/**
 * The device's `browser.signin.load` requests (PD-16): one per `open` that may load a sign-in, answered by the
 * `browser.signin.state` with the same `requestId` (any other is dropped), or null after the timeout.
 */
export class SignInLoads {
  private readonly pending = new Map<string, PendingLoad>();

  constructor(
    private readonly opts: {
      send: (frame: BrowserSignInLoadFrame) => void;
      timeoutMs?: number;
    },
  ) {}

  /** Asks the API for the turn's asker's sign-in for `origin`; null when it did not answer in time. */
  request(sessionId: string, promptId: string, origin: BrowserOrigin): Promise<LoadResult | null> {
    const requestId = randomUUID();
    return new Promise<LoadResult | null>((resolve) => {
      const timer = setTimeout(() => settle(null), this.opts.timeoutMs ?? SIGNIN_LOAD_TIMEOUT_MS);
      timer.unref?.();
      const settle = (result: LoadResult | null) => {
        clearTimeout(timer);
        if (!this.pending.delete(requestId)) return;
        resolve(result);
      };
      this.pending.set(requestId, { sessionId, resolve: settle });
      this.opts.send({ type: "browser.signin.load", requestId, sessionId, promptId, origin });
    });
  }

  /** The API's answer: true when it matched a request waiting now. */
  onState(frame: BrowserSignInStateFrame): boolean {
    const p = this.pending.get(frame.requestId);
    if (!p) return false;
    p.resolve(frame.result);
    return true;
  }

  /** The session left: its waiting loads end without a sign-in. */
  cancelSession(sessionId: string): void {
    for (const p of [...this.pending.values()]) if (p.sessionId === sessionId) p.resolve(null);
  }
}
