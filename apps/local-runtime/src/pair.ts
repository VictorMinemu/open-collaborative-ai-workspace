// Terminal pairing by device code (07.12, D-03, PD-06): `ocw-runtime enroll --server <url>` without `--code`, and
// `ocw-runtime setup` (07.12-08). The user-facing slice of RFC 8628:
//   1. `POST <server>/api/v1/devices/pairings` → a user code (`XXXX-XXXX`), the verification links and the device code;
//   2. print the link and the user code, never the device code (the poll secret);
//   3. poll `POST <server>/api/v1/devices/pairings/token` with the device code in the body every `interval` seconds
//      (5 s more after each `slow_down`) until the owner approves or denies it in Settings › Devices, or it expires;
//   4. approved → the same `saveEnrollment` as the typed-code flow (token 0600, runtime.json with `pairedWith`).
// A network error or a 5xx while polling is retried at the interval until expiry, so restarting the API never loses a
// pending pairing. Neither the device code nor the device token is ever printed or logged.

import {
  PAIRING_SLOW_DOWN_STEP_SECONDS,
  PairingErrorCode,
  PairingTokenResponse,
  StartPairingResponse,
} from "@ocw/contracts";
import {
  apiErrorMessage,
  type EnrollResult,
  normalizeServerUrl,
  platformOf,
  proposedDeviceName,
  saveEnrollment,
  withoutBadOptionalFields,
} from "./enroll.js";
import { RUNTIME_VERSION } from "./version.js";

export const PAIRING_DENIED_MESSAGE = "The pairing was denied in Settings › Devices.";
export const PAIRING_EXPIRED_MESSAGE = "The code expired. Run the command again.";
export const PAIRING_CANCELLED_MESSAGE = "Pairing cancelled.";

/** The pairing ended without a device: denied, expired, or the start was refused or not understood. */
export class PairingError extends Error {
  constructor(
    message: string,
    readonly reason: "denied" | "expired" | "refused",
  ) {
    super(message);
    this.name = "PairingError";
  }
}

/** The person cancelled (Ctrl-C): nothing was written. The CLI exits 130. */
export class PairingCancelledError extends Error {
  constructor() {
    super(PAIRING_CANCELLED_MESSAGE);
    this.name = "PairingCancelledError";
  }
}

export interface PairOptions {
  /** OCW_HOME: where the token and runtime.json are written once approved. */
  home: string;
  /** The workspace API (a path prefix is kept). */
  serverUrl: string;
  /** The proposed device name (the hostname by default); the approver may change it. */
  name?: string;
  fetchFn?: typeof fetch;
  /** Waits `ms`; rejects with `PairingCancelledError` when `signal` aborts. Injected by tests (a virtual clock). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The clock the expiry is measured with (ms). */
  now?: () => number;
  /** Aborting it cancels the pairing (Ctrl-C in the CLI). */
  signal?: AbortSignal;
  /** One line of what the person reads (stdout by default). */
  out?: (line: string) => void;
  /** One warning line (stderr by default). */
  warn?: (line: string) => void;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new PairingCancelledError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(new PairingCancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** True for `http://` to a host other than loopback: the device token would cross the network in clear. */
export function isPlainHttpToNetwork(serverUrl: string): boolean {
  const url = new URL(serverUrl);
  if (url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  return !(LOOPBACK_HOSTS.has(host) || host.startsWith("127.") || host.endsWith(".localhost"));
}

type PollOutcome =
  | { kind: "approved"; response: PairingTokenResponse }
  | { kind: "pending" }
  | { kind: "slow_down" }
  | { kind: "retry" };

/**
 * Pairs this machine by device code and saves the result (see the file comment). Resolves once approved; rejects with
 * `PairingError` (denied, expired, refused), `PairingCancelledError` (the signal aborted), or a network error at start.
 */
export async function pairByDeviceCode(opts: PairOptions): Promise<EnrollResult> {
  const serverUrl = normalizeServerUrl(opts.serverUrl);
  const name = proposedDeviceName(opts.name);
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const out = opts.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const warn = opts.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const signal = opts.signal;
  const cancelled = () => {
    if (signal?.aborted) throw new PairingCancelledError();
  };

  if (isPlainHttpToNetwork(serverUrl)) {
    warn(
      `Warning: ${serverUrl} uses plain http; the device token will cross the network unencrypted. Use https when the server is not on this machine.`,
    );
  }

  cancelled();
  const startRes = await fetchFn(`${serverUrl}/api/v1/devices/pairings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, platform: platformOf(), runtimeVersion: RUNTIME_VERSION }),
    ...(signal ? { signal } : {}),
  }).catch((err: unknown) => {
    cancelled();
    throw err;
  });
  const startBody = (await startRes.json().catch(() => null)) as unknown;
  if (!startRes.ok)
    throw new PairingError(apiErrorMessage(startBody, startRes.status, "starting the pairing"), "refused");
  const parsed = StartPairingResponse.safeParse(startBody);
  if (!parsed.success) {
    throw new PairingError(
      `${serverUrl} sent something that is not a valid pairing answer; check that it is the workspace API URL.`,
      "refused",
    );
  }
  const start = parsed.data;
  const deadline = now() + start.expiresIn * 1000;
  const minutes = Math.max(1, Math.round(start.expiresIn / 60));

  out("To pair this computer, open:");
  out(`  ${start.verificationUriComplete}`);
  out(`or open ${start.verificationUri} and enter the code:`);
  out(`  ${start.userCode}`);
  out(
    `Waiting for approval (expires in ${minutes} minute${minutes === 1 ? "" : "s"}). Press Ctrl-C to cancel.`,
  );

  let interval = start.interval;
  for (;;) {
    await sleep(interval * 1000, signal);
    cancelled();
    if (now() >= deadline) throw new PairingError(PAIRING_EXPIRED_MESSAGE, "expired");
    const outcome = await poll(fetchFn, serverUrl, start.deviceCode, signal).catch((err: unknown) => {
      cancelled();
      if (err instanceof PairingError) throw err;
      return { kind: "retry" } as const; // the network or the API is down for a moment: keep the pairing
    });
    cancelled();
    if (outcome.kind === "approved") return saveEnrollment(opts.home, outcome.response, serverUrl, name);
    if (outcome.kind === "slow_down") interval += PAIRING_SLOW_DOWN_STEP_SECONDS;
  }
}

async function poll(
  fetchFn: typeof fetch,
  serverUrl: string,
  deviceCode: string,
  signal: AbortSignal | undefined,
): Promise<PollOutcome> {
  const res = await fetchFn(`${serverUrl}/api/v1/devices/pairings/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceCode }),
    ...(signal ? { signal } : {}),
  });
  const body = (await res.json().catch(() => null)) as unknown;
  if (res.ok) {
    const approved = PairingTokenResponse.safeParse(withoutBadOptionalFields(body));
    if (!approved.success) {
      throw new PairingError("The server approved the pairing but its answer is not valid.", "refused");
    }
    return { kind: "approved", response: approved.data };
  }
  if (res.status === 429) return { kind: "slow_down" };
  if (res.status >= 500) return { kind: "retry" };
  const code = PairingErrorCode.safeParse((body as { error?: { code?: unknown } } | null)?.error?.code);
  if (!code.success) throw new PairingError(apiErrorMessage(body, res.status, "pairing"), "refused");
  switch (code.data) {
    case "authorization_pending":
      return { kind: "pending" };
    case "slow_down":
      return { kind: "slow_down" };
    case "access_denied":
      throw new PairingError(PAIRING_DENIED_MESSAGE, "denied");
    case "expired_token":
      throw new PairingError(PAIRING_EXPIRED_MESSAGE, "expired");
  }
}
