import {
  SANDBOXD_ROUTES,
  SandboxdError,
  type SandboxdErrorCode,
  type SandboxdInput,
  type SandboxdOp,
  type SandboxdOrgPolicy,
  type SandboxdOutput,
} from "@ocw/contracts";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * The API's only way to reach `sandboxd` (07.8-05, D-11, P-03): a bearer-token HTTP client over `SANDBOXD_ROUTES`,
 * generic over the op so later plans add calls without editing it. Every input is parsed with the op's contract schema
 * before it leaves and every answer is parsed with its output schema before anyone reads it. The API never holds the
 * Docker socket; sandboxd is policy-free plumbing, so this client is only ever called after the Control Plane decided.
 *
 * Errors carry the op, the HTTP status and sandboxd's error code only: never a body, an argv, a path or the token, so
 * whatever logs them cannot leak what a bot ran.
 */

/** sandboxd is unreachable, timed out, failed (5xx) or answered something that is not the contract. */
export class SandboxdUnavailableError extends Error {
  constructor(
    readonly op: SandboxdOp,
    readonly status: number | null,
  ) {
    super(`sandboxd ${op} unavailable${status === null ? "" : ` (${status})`}`);
    this.name = "SandboxdUnavailableError";
  }
}

/** sandboxd refused the op with a 4xx and one of its codes (`not_found`, `killed`, `disk_full`, …). */
export class SandboxdRefusedError extends Error {
  constructor(
    readonly op: SandboxdOp,
    readonly status: number,
    readonly code: SandboxdErrorCode,
  ) {
    super(`sandboxd ${op} refused: ${code} (${status})`);
    this.name = "SandboxdRefusedError";
  }
}

export interface SandboxdCallOptions {
  /** Deadline of this call (default: the client's). */
  timeoutMs?: number;
  /** Ends the call early (the events consumer's long poll on shutdown, 07.8-11). */
  signal?: AbortSignal;
}

export interface SandboxdClient {
  /** One JSON op: input parsed with the contract, output parsed with the contract. */
  call<Op extends SandboxdOp>(
    op: Op,
    input: SandboxdInput<Op>,
    opts?: SandboxdCallOptions,
  ): Promise<SandboxdOutput<Op>>;
  /** A frame-stream op (`contextFrames`): the raw response body; the caller decodes frames (`decodeFrameHeader`). */
  stream<Op extends SandboxdOp>(
    op: Op,
    input: SandboxdInput<Op>,
    opts?: SandboxdCallOptions,
  ): Promise<ReadableStream<Uint8Array>>;
}

export interface SandboxdClientOptions {
  url: string;
  token: string;
  /** Default deadline of one call (ms). */
  timeoutMs?: number;
  /**
   * Transport header timeout in ms (default 0 = none). Each call's own deadline (`timeoutMs`, an AbortSignal) is the
   * limit until the answer's headers arrive: the global fetch's 300 s header timeout would end a package install (up to
   * 600 s at sandboxd) while sandboxd completes it (07.8-24, #259). The body keeps undici's idle timeout (300 s between
   * chunks), so an abandoned stream is still released. Tests set a small value.
   */
  transportTimeoutMs?: number;
  /** Test hook: the fetch implementation (default: undici's fetch over the client's own dispatcher). */
  fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** undici's fetch over a dispatcher with the given header timeout (0 disables it). */
function transportFetch(timeoutMs: number): typeof fetch {
  const dispatcher = new Agent({ headersTimeout: timeoutMs });
  return ((url: string, init: RequestInit) =>
    undiciFetch(url, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    })) as unknown as typeof fetch;
}

export function createSandboxdClient(opts: SandboxdClientOptions): SandboxdClient {
  const base = opts.url.replace(/\/+$/u, "");
  const doFetch = opts.fetch ?? transportFetch(opts.transportTimeoutMs ?? 0);
  const defaultTimeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function send<Op extends SandboxdOp>(
    op: Op,
    input: SandboxdInput<Op>,
    o: SandboxdCallOptions & { stream?: boolean },
  ): Promise<Response> {
    const route = SANDBOXD_ROUTES[op];
    // A malformed input is a programming error of the caller, never sent.
    const parsed = route.input.parse(input) as Record<string, unknown>;
    let url = `${base}${route.path}`;
    const init: RequestInit = {
      method: route.method,
      headers: { authorization: `Bearer ${opts.token}`, accept: "application/json" },
    };
    if (route.method === "GET") {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(parsed)) if (v !== undefined) qs.set(k, String(v));
      const q = qs.toString();
      if (q) url += `?${q}`;
    } else {
      init.headers = { ...init.headers, "content-type": "application/json" };
      init.body = JSON.stringify(parsed);
    }
    // A frame stream lives as long as its caller's signal unless a deadline is given; a JSON op always has one.
    const timeout =
      o.stream && o.timeoutMs === undefined ? null : AbortSignal.timeout(o.timeoutMs ?? defaultTimeout);
    const signals = [o.signal, timeout].filter((s): s is AbortSignal => s !== undefined && s !== null);
    if (signals.length > 0) init.signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    let res: Response;
    try {
      res = await doFetch(url, init);
    } catch {
      // Network failure or deadline: the cause may name the URL; it is dropped.
      throw new SandboxdUnavailableError(op, null);
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    if (res.status >= 400 && res.status < 500) {
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      const err = SandboxdError.safeParse(body);
      if (err.success) throw new SandboxdRefusedError(op, res.status, err.data.error.code);
    }
    throw new SandboxdUnavailableError(op, res.status);
  }

  return {
    async call(op, input, o = {}) {
      const res = await send(op, input, o);
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new SandboxdUnavailableError(op, res.status);
      }
      const out = SANDBOXD_ROUTES[op].output.safeParse(json);
      if (!out.success) throw new SandboxdUnavailableError(op, res.status);
      return out.data as SandboxdOutput<typeof op>;
    },
    async stream(op, input, o = {}) {
      const res = await send(op, input, { ...o, stream: true });
      if (!res.body) throw new SandboxdUnavailableError(op, res.status);
      return res.body;
    },
  };
}

/** The organization a sandboxd input names (`target.orgId` or `orgId`), or null. */
function orgOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const o = input as { target?: { orgId?: unknown }; orgId?: unknown };
  const id = o.target?.orgId ?? o.orgId;
  return typeof id === "string" ? id : null;
}

/**
 * The client the API uses (07.8 policy fix; D-09, the kill switch). sandboxd holds policies in memory only and has no
 * default: after a restart it answers 409 `policy_missing` to anything that would start or run a container until it
 * is told the organization's policy again. On that refusal this client loads the organization's current policy (the
 * kill state and the settings version included), pushes it with the `policy` op and retries the call once. A killed
 * organization's retry is still refused (`killed`) and nothing starts; a second `policy_missing` (the push was lost)
 * is the caller's refusal as usual. The push itself is never retried here.
 */
export function withPolicyRecovery(
  inner: SandboxdClient,
  loadPolicy: (organizationId: string) => Promise<SandboxdOrgPolicy>,
): SandboxdClient {
  async function recovering<T>(op: SandboxdOp, input: unknown, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      const orgId = orgOf(input);
      if (
        !(err instanceof SandboxdRefusedError) ||
        err.code !== "policy_missing" ||
        op === "policy" ||
        !orgId
      ) {
        throw err;
      }
      let policy: SandboxdOrgPolicy;
      try {
        policy = await loadPolicy(orgId);
      } catch {
        // The database could not say what the policy is: nothing runs (the original refusal stands).
        throw err;
      }
      await inner.call("policy", policy);
      return run();
    }
  }
  return {
    call(op, input, o) {
      return recovering(op, input, () => inner.call(op, input, o));
    },
    stream(op, input, o) {
      return recovering(op, input, () => inner.stream(op, input, o));
    },
  };
}
