import { ApiError } from "@ocw/contracts";
import { getRuntimeConfig } from "./config";

/** Anything with a Zod-style `parse` (every schema exported by @ocw/contracts). */
export interface Schema<T> {
  parse(data: unknown): T;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  /** `error.details` of the API body, when it sent one (e.g. the current card of a 409 version conflict). */
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** The browser could not reach the API at all (down, wrong URL, CORS). */
  get isNetwork(): boolean {
    return this.status === 0;
  }
}

export function isApiError(err: unknown, status?: number): err is ApiRequestError {
  return err instanceof ApiRequestError && (status === undefined || err.status === status);
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.isNetwork) return "Can't reach the server. Check that the API is running.";
    return err.message;
  }
  return err instanceof Error ? err.message : "Something went wrong";
}

interface RequestOptions<T> {
  body?: unknown;
  schema?: Schema<T>;
  signal?: AbortSignal;
}

async function request<T>(method: string, path: string, opts: RequestOptions<T> = {}): Promise<T> {
  const { apiUrl } = getRuntimeConfig();
  let res: Response;
  try {
    res = await fetch(`${apiUrl}${path}`, {
      method,
      credentials: "include",
      headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiRequestError(0, "network_error", "Can't reach the server");
  }

  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!res.ok) {
    const parsed = ApiError.safeParse(json);
    if (parsed.success) {
      const { code, message, details } = parsed.data.error;
      throw new ApiRequestError(res.status, code, message, details);
    }
    // better-auth style `{ message, code }` bodies.
    const loose = json as { message?: unknown; code?: unknown } | null;
    const message = typeof loose?.message === "string" ? loose.message : res.statusText || "Request failed";
    const code = typeof loose?.code === "string" ? loose.code : `http_${res.status}`;
    throw new ApiRequestError(res.status, code, message);
  }

  if (!opts.schema) return json as T;
  try {
    return opts.schema.parse(json);
  } catch {
    throw new ApiRequestError(res.status, "invalid_response", "The server sent an unexpected response");
  }
}

export const api = {
  get: <T>(path: string, opts?: Omit<RequestOptions<T>, "body">) => request<T>("GET", path, opts),
  post: <T>(path: string, opts?: RequestOptions<T>) => request<T>("POST", path, opts),
  patch: <T>(path: string, opts?: RequestOptions<T>) => request<T>("PATCH", path, opts),
  put: <T>(path: string, opts?: RequestOptions<T>) => request<T>("PUT", path, opts),
  del: <T>(path: string, opts?: RequestOptions<T>) => request<T>("DELETE", path, opts),
};
