import {
  SANDBOXD_ROUTES,
  SandboxdError,
  type SandboxdErrorCode,
  type SandboxdInput,
  type SandboxdOp,
  type SandboxdOutput,
} from "@ocw/contracts";

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
  /** Test hook: the fetch implementation (default: the global one). */
  fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function createSandboxdClient(opts: SandboxdClientOptions): SandboxdClient {
  const base = opts.url.replace(/\/+$/u, "");
  const doFetch = opts.fetch ?? fetch;
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
