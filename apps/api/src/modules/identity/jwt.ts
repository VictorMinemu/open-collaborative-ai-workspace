import {
  AccessTokenClaims,
  DEVICE_TOKEN_AUDIENCE,
  type DeviceAccessToken,
  DeviceTokenClaims,
} from "@ocw/contracts";
import {
  createLocalJWKSet,
  type JSONWebKeySet,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose";
import type { Env } from "../../config/env";
import type { Auth } from "./auth";

/** Device JWT lifetime: the daemon exchanges its device token for one before each Device Link connect. */
export const DEVICE_TOKEN_TTL_SECONDS = 600;
/** At most one JWKS refetch per cooldown window for tokens whose `kid` is unknown (T-02-08-06). */
export const JWKS_REFETCH_COOLDOWN_MS = 30_000;

/** The better-auth server API surface the token service needs (narrow, so tests can count JWKS fetches). */
export interface TokenAuth {
  api: {
    getJwks: () => Promise<unknown>;
    signJWT: (input: { body: { payload: Record<string, unknown> } }) => Promise<{ token: string }>;
  };
}

export interface TokenService {
  /** User access JWT → its claims; null when the signature, issuer, audience, expiry or claims are wrong. */
  verifyUserToken(token: string): Promise<AccessTokenClaims | null>;
  /** 10-minute device JWT (aud `ocw:device-link`, `typ: "device"`); never accepted as a user token. */
  signDeviceToken(input: { deviceId: string; organizationId: string }): Promise<DeviceAccessToken>;
  verifyDeviceToken(token: string): Promise<{ deviceId: string; organizationId: string } | null>;
}

/**
 * AUTH-06 verifier (research Pattern 5): `jose` against an in-process copy of our own JWKS, so a request
 * never pays a database round-trip for the signature (better-auth's server-side verify loads every key per
 * call). A token signed with a key the cache does not know (rotation) triggers ONE refetch; further unknown
 * kids wait for the cooldown. Tokens are never logged.
 */
export function createTokenService(deps: {
  auth: Auth | TokenAuth;
  env: Pick<Env, "OCW_PUBLIC_API_URL">;
  now?: () => number;
  refetchCooldownMs?: number;
}): TokenService {
  const auth = deps.auth as TokenAuth;
  const now = deps.now ?? Date.now;
  const cooldownMs = deps.refetchCooldownMs ?? JWKS_REFETCH_COOLDOWN_MS;
  const issuer = deps.env.OCW_PUBLIC_API_URL;
  let keySet: Promise<JWTVerifyGetKey> | null = null;
  let lastRefetch = Number.NEGATIVE_INFINITY;

  const load = (): Promise<JWTVerifyGetKey> => {
    const p = auth.api.getJwks().then((jwks) => createLocalJWKSet(jwks as JSONWebKeySet));
    // A failed load is retried by the next verification instead of being cached.
    p.catch(() => {
      if (keySet === p) keySet = null;
    });
    keySet = p;
    return p;
  };

  async function verify(token: string, audience: string): Promise<JWTPayload | null> {
    const options = { issuer, audience, algorithms: ["EdDSA"] };
    try {
      const used = keySet ?? load();
      try {
        return (await jwtVerify(token, await used, options)).payload;
      } catch (err) {
        if ((err as { code?: unknown }).code !== "ERR_JWKS_NO_MATCHING_KEY") throw err;
        // A concurrent verification may already have refetched; otherwise refetch once per cooldown.
        let next = keySet;
        if (!next || next === used) {
          if (now() - lastRefetch < cooldownMs) return null;
          lastRefetch = now();
          next = load();
        }
        return (await jwtVerify(token, await next, options)).payload;
      }
    } catch {
      return null;
    }
  }

  return {
    async verifyUserToken(token) {
      const payload = await verify(token, issuer);
      if (!payload) return null;
      // Strict: a device token (typ, other aud) or any unexpected claim never parses as a user token.
      const claims = AccessTokenClaims.safeParse(payload);
      return claims.success ? claims.data : null;
    },

    async signDeviceToken({ deviceId, organizationId }) {
      const iat = Math.floor(now() / 1000);
      const exp = iat + DEVICE_TOKEN_TTL_SECONDS;
      const { token } = await auth.api.signJWT({
        body: {
          payload: {
            sub: deviceId,
            org: organizationId,
            typ: "device",
            aud: DEVICE_TOKEN_AUDIENCE,
            iat,
            exp,
          },
        },
      });
      return { token, expiresAt: new Date(exp * 1000).toISOString() };
    },

    async verifyDeviceToken(token) {
      const payload = await verify(token, DEVICE_TOKEN_AUDIENCE);
      if (!payload) return null;
      const claims = DeviceTokenClaims.safeParse(payload);
      return claims.success ? { deviceId: claims.data.sub, organizationId: claims.data.org } : null;
    },
  };
}
