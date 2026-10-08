import type { IncomingHttpHeaders } from "node:http";

/**
 * The request headers better-auth sees, with `x-forwarded-for` set to the client IP Fastify resolved (07-08, D-18).
 * better-auth reads that header by itself when it stores a session's IP (it trusts a single-value header whatever
 * OCW_TRUST_PROXY says), so without this a client reaching the API directly could plant any address in its session
 * list. `req.ip` honours OCW_TRUST_PROXY: the socket address by default, the proxy-supplied one behind Caddy.
 */
export function headersForAuth(req: { headers: IncomingHttpHeaders; ip: string }): IncomingHttpHeaders {
  return { ...req.headers, "x-forwarded-for": req.ip };
}
