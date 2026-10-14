import { randomUUID } from "node:crypto";
import type { vaultItems } from "@ocw/db";
import { describe, expect, it, vi } from "vitest";
import { type Egress, EgressRefusedError } from "../../lib/egress";
import {
  clientCredentialsToken,
  forgetClientCredentialsToken,
  TOKEN_EXPIRY_MARGIN_MS,
} from "./client-credentials";
import { KeychainError, type StoredOAuthSecret } from "./inject";

/** Client-credentials tokens (07.4-07 Task 3; D-07 item 3, T-07.4-07-07) against a stubbed egress guard. */

type Row = typeof vaultItems.$inferSelect;

const SECRET: StoredOAuthSecret = { kind: "oauth", clientId: "kc-client", clientSecret: "kc-secret-value" };

function item(over: Partial<Row> = {}): Row {
  return {
    id: randomUUID(),
    organizationId: randomUUID(),
    scope: "unit",
    ownerUserId: null,
    unitId: null,
    name: "ERP",
    handle: "k_abcdefghij",
    kind: "oauth",
    injection: { header: "Authorization", scheme: "bearer" },
    allowedHosts: ["auth.example.com"],
    allowedPathPrefix: null,
    tokenUrl: "https://auth.example.com/oauth/token",
    secretRef: { provider: "db", secretId: randomUUID(), organizationId: randomUUID() },
    valueUpdatedAt: "2026-10-13T10:00:00.000Z",
    createdBy: null,
    createdAt: "2026-10-13T10:00:00.000Z",
    updatedAt: "2026-10-13T10:00:00.000Z",
    lastUsedAt: null,
    ...over,
  };
}

function stubEgress(respond: (n: number) => Response | Promise<Response>) {
  let n = 0;
  const calls: Array<{ url: string; init: RequestInit | undefined; policy: unknown }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit, policy?: unknown) => {
    calls.push({ url: String(input), init, policy });
    n += 1;
    return respond(n);
  });
  const egress: Egress = { fetch, bound: () => globalThis.fetch };
  return { egress, calls };
}

const tokenResponse = (token: string, expiresIn = 60) =>
  new Response(JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: expiresIn }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("clientCredentialsToken", () => {
  it("fetches once with client_secret_basic and the scope, reuses it until expires_in − 30 s, then refetches", async () => {
    const { egress, calls } = stubEgress((n) => tokenResponse(`tok-${n}`, 60));
    const row = item();
    let now = 1_000_000;
    const clock = { now: () => now };
    const secret = { ...SECRET, scope: "read write" };

    const first = await clientCredentialsToken(egress, row, secret, ["auth.example.com:443"], clock);
    expect(first).toEqual({ token: "tok-1", expiresAt: now + 60_000 });
    const req = calls[0];
    expect(req?.url).toBe("https://auth.example.com/oauth/token");
    expect(req?.init?.method).toBe("POST");
    const headers = req?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from("kc-client:kc-secret-value").toString("base64")}`,
    );
    const body = new URLSearchParams(String(req?.init?.body));
    expect(Object.fromEntries(body)).toEqual({ grant_type: "client_credentials", scope: "read write" });
    expect(req?.policy).toMatchObject({ privateAllow: ["auth.example.com:443"] });

    now += 60_000 - TOKEN_EXPIRY_MARGIN_MS - 1;
    expect((await clientCredentialsToken(egress, row, secret, [], clock)).token).toBe("tok-1");
    expect(calls).toHaveLength(1);
    now += 2;
    expect((await clientCredentialsToken(egress, row, secret, [], clock)).token).toBe("tok-2");
    expect(calls).toHaveLength(2);
  });

  it("refuses a token URL outside the allowed hosts before any request", async () => {
    const { egress, calls } = stubEgress(() => tokenResponse("never"));
    for (const tokenUrl of [
      "https://evil.example.com/token",
      "https://auth.example.com:8443/token",
      "not a url",
    ]) {
      const err = await clientCredentialsToken(egress, item({ tokenUrl }), SECRET, []).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(KeychainError);
      expect((err as KeychainError).code).toBe("token_url_not_allowed");
    }
    expect(calls).toHaveLength(0);
  });

  it("never puts the token or the client secret into an error", async () => {
    const cases: Array<[Response | Error, string]> = [
      [
        new Response('{"error":"invalid_client","access_token":"leaky-token"}', { status: 401 }),
        "token_request_failed",
      ],
      [new Response("<html>kc-secret-value</html>", { status: 200 }), "token_invalid_response"],
      [
        new Response(JSON.stringify({ access_token: "leaky-token", token_type: "mac" }), { status: 200 }),
        "token_invalid_response",
      ],
      [new Error("socket said kc-secret-value"), "token_request_failed"],
    ];
    for (const [outcome, code] of cases) {
      const { egress } = stubEgress(() => {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      });
      const err = await clientCredentialsToken(egress, item(), SECRET, []).catch((e: unknown) => e);
      expect((err as KeychainError).code).toBe(code);
      const text = `${String(err)} ${JSON.stringify(err)} ${(err as Error).stack ?? ""}`;
      expect(text).not.toContain("leaky-token");
      expect(text).not.toContain("kc-secret-value");
    }
    const refused = stubEgress(() => {
      throw new EgressRefusedError("private_address", "auth.example.com");
    });
    const err = await clientCredentialsToken(refused.egress, item(), SECRET, []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressRefusedError);
  });

  it("two items never share a cache entry", async () => {
    const { egress, calls } = stubEgress((n) => tokenResponse(`tok-${n}`));
    const a = item();
    const b = item();
    expect((await clientCredentialsToken(egress, a, SECRET, [])).token).toBe("tok-1");
    expect((await clientCredentialsToken(egress, b, SECRET, [])).token).toBe("tok-2");
    expect((await clientCredentialsToken(egress, a, SECRET, [])).token).toBe("tok-1");
    expect(calls).toHaveLength(2);
  });

  it("a rotated client secret (new value version) or a forgotten item fetches a new token", async () => {
    const { egress, calls } = stubEgress((n) => tokenResponse(`tok-${n}`));
    const row = item();
    expect((await clientCredentialsToken(egress, row, SECRET, [])).token).toBe("tok-1");
    const rotated = { ...row, valueUpdatedAt: "2026-10-13T11:00:00.000Z" };
    expect(
      (await clientCredentialsToken(egress, rotated, { ...SECRET, clientSecret: "new" }, [])).token,
    ).toBe("tok-2");
    forgetClientCredentialsToken(row.id);
    expect((await clientCredentialsToken(egress, rotated, SECRET, [])).token).toBe("tok-3");
    expect(calls).toHaveLength(3);
  });

  it("concurrent callers share one in-flight request", async () => {
    const { egress, calls } = stubEgress((n) => tokenResponse(`tok-${n}`));
    const row = item();
    const [a, b] = await Promise.all([
      clientCredentialsToken(egress, row, SECRET, []),
      clientCredentialsToken(egress, row, SECRET, []),
    ]);
    expect(a.token).toBe(b.token);
    expect(calls).toHaveLength(1);
  });
});
