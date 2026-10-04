import { ApiRequestError } from "./api";
import { getRuntimeConfig } from "./config";

/** Refresh when fewer than this many milliseconds of the token's lifetime remain. */
const REFRESH_MARGIN_MS = 60_000;

interface CachedToken {
  token: string;
  /** Expiry in epoch milliseconds (0 when the payload could not be read: never reused). */
  expiresAt: number;
}

let cached: CachedToken | null = null;
let inflight: Promise<string> | null = null;
/** Bumped by clearAccessToken() so a request started for a previous session never repopulates the cache. */
let epoch = 0;

/** `exp` from the JWT payload. Read only for scheduling; the API verifies the token, the browser never does. */
function expiryOf(token: string): number {
  try {
    const payload = token.split(".")[1] ?? "";
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))) as { exp?: unknown };
    return typeof json.exp === "number" ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function fetchToken(): Promise<CachedToken> {
  const { apiUrl } = getRuntimeConfig();
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/api/auth/token`, { credentials: "include" });
  } catch {
    throw new ApiRequestError(0, "network_error", "Can't reach the server");
  }
  if (res.status === 401) throw new ApiRequestError(401, "unauthorized", "Sign in required");
  if (!res.ok) throw new ApiRequestError(res.status, `http_${res.status}`, "Could not get an access token");
  const body = (await res.json().catch(() => null)) as { token?: unknown } | null;
  if (typeof body?.token !== "string")
    throw new ApiRequestError(500, "bad_token", "Malformed token response");
  return { token: body.token, expiresAt: expiryOf(body.token) };
}

/**
 * Short-lived access JWT for the browser WebSocket (AUTH-06). The session cookie stays the REST credential;
 * this token only opens `/ws`. Single-flight: concurrent callers share one request. The cached token is
 * reused while more than 60 s remain unless `force` (after the server closed the socket with 4401).
 * Rejects with `ApiRequestError(401)` when signed out.
 */
export function getAccessToken({ force = false }: { force?: boolean } = {}): Promise<string> {
  if (!force && cached && cached.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return Promise.resolve(cached.token);
  }
  if (inflight) return inflight;
  const started = epoch;
  const p = fetchToken()
    .then((t) => {
      if (epoch === started) cached = t;
      return t.token;
    })
    .finally(() => {
      if (inflight === p) inflight = null;
    });
  inflight = p;
  return p;
}

/** Forget the cached token (sign-out or session change). */
export function clearAccessToken(): void {
  cached = null;
  inflight = null;
  epoch++;
}
