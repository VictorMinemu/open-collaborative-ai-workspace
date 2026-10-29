import { randomInt } from "node:crypto";
import {
  ApprovePairingRequest,
  DenyPairingRequest,
  DevicePlatform,
  formatUserCode,
  normalizeUserCode,
  Ok,
  PAIRING_INTERVAL_SECONDS,
  PAIRING_TTL_SECONDS,
  type PairingErrorCode,
  PairingLookupRequest,
  PairingRequestView,
  PairingTokenRequest,
  PairingTokenResponse,
  StartPairingRequest,
  StartPairingResponse,
  USER_CODE_ALPHABET,
  USER_CODE_LENGTH,
} from "@ocw/contracts";
import { deviceEnrollments, type Tx } from "@ocw/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { type App, authOf, type Core, tenant } from "../../core";
import { randomToken, sha256Hex } from "../../lib/crypto";
import { badRequest, conflict, HttpError, notFound } from "../../lib/errors";
import type { RedisClient } from "../../lib/redis";
import type { PermissionService } from "../organization";
import { enrollWithCodeHash } from "./enroll";

/**
 * Terminal pairing by device code (07.12-02, HSR-03, D-03, PD-06..PD-08): the Control Plane side of RFC 8628 on top of
 * the existing enrollment path. A server with no session starts a pairing (public, per-IP limit) and gets a short user
 * code and a long device code; the pending request lives only in Redis (pre-tenant, 10 minutes, hashes only). An owner
 * signed in with `device.pair` looks it up and approves it, which writes an ordinary `device_enrollments` row in the
 * approver's organization with its audit; the server's poll then runs the one enroll transaction
 * (`enrollWithCodeHash`) and gets today's `ocwd_` device token, once. Neither code ever reaches a URL, a log line, an
 * audit row or Redis in clear.
 */

const KEY_PREFIX = "ocw:pair:";
const deviceCodeKey = (deviceCodeHash: string) => `${KEY_PREFIX}dc:${deviceCodeHash}`;
const userCodeKey = (userCodeHash: string) => `${KEY_PREFIX}uc:${userCodeHash}`;

/** Up to this many user-code collisions are retried before a start answers 503. */
const USER_CODE_ATTEMPTS = 5;

/** A fresh user code: 8 uniform draws over the 32-symbol Crockford alphabet (40 bits), shown `XXXX-XXXX`. */
export function generateUserCode(): string {
  let raw = "";
  for (let i = 0; i < USER_CODE_LENGTH; i++) raw += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return formatUserCode(raw);
}

/**
 * The `device_enrollments.code_hash` of a device-code pairing: domain-separated from the typed-code hash
 * (`sha256(normalized code)`), so a device code can never be redeemed as a typed code or the other way round.
 */
export function pairingEnrollmentHash(deviceCode: string): string {
  return sha256Hex(`pair:${deviceCode}`);
}

const Iso = z.string();
/** What Redis holds for one pending request under `ocw:pair:dc:<sha256(deviceCode)>` (PD-06). No code in clear. */
export const PairingRecord = z.object({
  userCodeHash: z.string(),
  enrollmentHash: z.string(),
  name: z.string(),
  platform: DevicePlatform,
  runtimeVersion: z.string().nullable(),
  requestIp: z.string().nullable(),
  createdAt: Iso,
  expiresAt: Iso,
  status: z.enum(["pending", "approved", "denied"]),
  lastPollAt: Iso.nullable(),
  approvedName: z.string().nullable().optional(),
  decidedBy: z.string().nullable().optional(),
});
export type PairingRecord = z.infer<typeof PairingRecord>;
type PairingStatus = PairingRecord["status"];

/**
 * Compare-and-set of the status (KEYS[1] the record, ARGV[1] the expected status, ARGV[2] the new one, ARGV[3] a JSON
 * object of fields to merge). Keeps the TTL. 1 when it won, 0 when the record is gone or no longer in ARGV[1].
 */
const DECIDE = `
local v = redis.call('get', KEYS[1])
if not v then return 0 end
local r = cjson.decode(v)
if r.status ~= ARGV[1] then return 0 end
r.status = ARGV[2]
for k, val in pairs(cjson.decode(ARGV[3])) do r[k] = val end
redis.call('set', KEYS[1], cjson.encode(r), 'KEEPTTL')
return 1
`;

/**
 * The reverse of one decision (KEYS[1] the record, ARGV[1] the decided status, ARGV[2] the deciding user): back to
 * pending, only while the record still holds that decision by that user. Keeps the TTL. 1 when it was undone.
 */
const UNDECIDE = `
local v = redis.call('get', KEYS[1])
if not v then return 0 end
local r = cjson.decode(v)
if r.status ~= ARGV[1] or r.decidedBy ~= ARGV[2] then return 0 end
r.status = 'pending'
r.approvedName = cjson.null
r.decidedBy = cjson.null
redis.call('set', KEYS[1], cjson.encode(r), 'KEEPTTL')
return 1
`;

/**
 * One poll (KEYS[1] the record, ARGV[1] now): answers the record as it was before this poll and, when it is pending,
 * stamps `lastPollAt`, atomically so a poll can never overwrite a decision made between its read and its write.
 */
const POLL = `
local v = redis.call('get', KEYS[1])
if not v then return false end
local r = cjson.decode(v)
if r.status == 'pending' then
  r.lastPollAt = ARGV[1]
  redis.call('set', KEYS[1], cjson.encode(r), 'KEEPTTL')
end
return v
`;

const parseRecord = (raw: unknown): PairingRecord | null => {
  if (typeof raw !== "string") return null;
  try {
    const parsed = PairingRecord.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** The pending pairings in Redis (PD-06). Lost Redis state reads as "expired, start again". */
export class PairingStore {
  constructor(private readonly redis: RedisClient) {}

  /**
   * Store a new request under a fresh user code (its key set NX, so two live requests never share a code; up to five
   * draws) and return that user code. 503 `pairing_unavailable` when every draw collided.
   */
  async create(
    deviceCodeHash: string,
    record: Omit<PairingRecord, "userCodeHash" | "status" | "lastPollAt">,
  ): Promise<string> {
    for (let attempt = 0; attempt < USER_CODE_ATTEMPTS; attempt++) {
      const userCode = generateUserCode();
      const userCodeHash = sha256Hex(normalizeUserCode(userCode)!);
      const claimed = await this.redis.set(userCodeKey(userCodeHash), deviceCodeHash, {
        condition: "NX",
        expiration: { type: "EX", value: PAIRING_TTL_SECONDS },
      });
      if (claimed !== "OK") continue;
      const full: PairingRecord = { ...record, userCodeHash, status: "pending", lastPollAt: null };
      await this.redis.set(deviceCodeKey(deviceCodeHash), JSON.stringify(full), {
        expiration: { type: "EX", value: PAIRING_TTL_SECONDS },
      });
      return userCode;
    }
    throw new HttpError(503, "pairing_unavailable", "Pairing is busy right now; try again in a moment");
  }

  async byDeviceCodeHash(deviceCodeHash: string): Promise<PairingRecord | null> {
    return parseRecord(await this.redis.get(deviceCodeKey(deviceCodeHash)));
  }

  /** The request behind a canonical user code, with the device-code hash that keys it. */
  async byUserCode(canonical: string): Promise<{ deviceCodeHash: string; record: PairingRecord } | null> {
    const deviceCodeHash = await this.redis.get(userCodeKey(sha256Hex(canonical)));
    if (typeof deviceCodeHash !== "string") return null;
    const record = await this.byDeviceCodeHash(deviceCodeHash);
    return record ? { deviceCodeHash, record } : null;
  }

  /** Atomic status change `from` → `to` with merged fields; false when another decision (or expiry) came first. */
  async decide(
    deviceCodeHash: string,
    from: PairingStatus,
    to: PairingStatus,
    fields: Partial<Pick<PairingRecord, "approvedName" | "decidedBy">> = {},
  ): Promise<boolean> {
    const won = await this.redis.eval(DECIDE, {
      keys: [deviceCodeKey(deviceCodeHash)],
      arguments: [from, to, JSON.stringify(fields)],
    });
    return won === 1;
  }

  /**
   * Undo `decide(…, "pending", status, { decidedBy })` when the transaction it ran in did not commit (07.12 review
   * LO-02): otherwise Redis would say approved with no enrollment row, and every retry would answer 409.
   */
  async undecide(deviceCodeHash: string, status: "approved" | "denied", decidedBy: string): Promise<boolean> {
    const undone = await this.redis.eval(UNDECIDE, {
      keys: [deviceCodeKey(deviceCodeHash)],
      arguments: [status, decidedBy],
    });
    return undone === 1;
  }

  /** The record before this poll (null when gone); a pending record gets `lastPollAt = now`. */
  async touchPoll(deviceCodeHash: string, now: Date): Promise<PairingRecord | null> {
    return parseRecord(
      await this.redis.eval(POLL, { keys: [deviceCodeKey(deviceCodeHash)], arguments: [now.toISOString()] }),
    );
  }

  /** Forget a request (both keys). */
  async remove(deviceCodeHash: string, userCodeHash: string): Promise<void> {
    await this.redis.del([deviceCodeKey(deviceCodeHash), userCodeKey(userCodeHash)]);
  }
}

/** RFC 8628 §3.5 answers as HTTP 400 in the API's error envelope. */
const PAIRING_ERRORS: Record<PairingErrorCode, string> = {
  authorization_pending: "Waiting for approval in Settings › Devices",
  slow_down: "Polling too fast",
  access_denied: "The pairing was denied",
  expired_token: "The code expired; start again",
};
const pairingError = (code: PairingErrorCode) => badRequest(PAIRING_ERRORS[code], code);

const notFoundCode = () => notFound("This code is not valid or has expired", "pairing_not_found");
const alreadyDecided = () => conflict("This pairing was already approved or denied", "already_decided");

const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
};

/** The canonical user code of a validated body field (the schema already refused anything else). */
const canonicalOf = (userCode: string): string => {
  const canonical = normalizeUserCode(userCode);
  if (!canonical) throw notFoundCode();
  return canonical;
};

const webUrlOf = (core: Core) => core.env.OCW_PUBLIC_WEB_URL.replace(/\/+$/u, "");

/**
 * `POST /api/v1/devices/pairings` (start) and `/pairings/token` (poll), both public; `/pairings/lookup`, `/approve`
 * and `/deny` for a signed-in member holding `device.pair`, sharing one bucket of 10 per minute per member (PD-07),
 * so a member guessing codes cannot multiply it across the three routes. The limits are in memory, per API instance
 * and per apparent client IP (`OCW_TRUST_PROXY` behind a proxy).
 */
export function registerDevicePairingRoutes(app: App, core: Core, perms: PermissionService): void {
  const store = new PairingStore(core.bus.pub);
  const requireUser = core.identity.requireUser;
  const decisionLimit = app.rateLimit({
    max: 10,
    timeWindow: "1 minute",
    keyGenerator: (req: FastifyRequest) => `pair:${req.auth?.userId ?? req.ip}`,
  });
  const decider = {
    config: { authz: "user" as const },
    // requireUser first, so the shared bucket is the member, not the IP.
    preHandler: [requireUser, decisionLimit, perms.requirePermission("device.pair")],
  };

  /**
   * One decision: `write` records it in the approver's tenant transaction, then, last inside that transaction, the
   * Redis compare-and-set from pending runs (a lost race throws 409 and rolls `write` back). Redis cannot join the
   * transaction, so when the commit itself fails after the compare-and-set won, the decision is undone in Redis
   * (07.12 review LO-02): the request is pending again and the approver can retry, instead of an "approved" record
   * with no enrollment row that answers 409 to every retry until it expires.
   */
  async function decideInTransaction(
    req: FastifyRequest,
    deviceCodeHash: string,
    status: "approved" | "denied",
    write: (tx: Tx) => Promise<{ approvedName?: string }>,
  ): Promise<void> {
    const decidedBy = authOf(req).userId;
    let won = false;
    try {
      await core.db.withTenant(tenant(req), async (tx) => {
        const fields = await write(tx);
        won = await store.decide(deviceCodeHash, "pending", status, { ...fields, decidedBy });
        if (!won) throw alreadyDecided();
      });
    } catch (err) {
      if (won) await store.undecide(deviceCodeHash, status, decidedBy).catch(() => {});
      throw err;
    }
  }

  app.post(
    "/devices/pairings",
    {
      // No session yet: the server is anonymous until an owner approves it.
      config: { authz: "public", rateLimit: { max: 10, timeWindow: "10 minutes" } },
      schema: { tags: ["device"], body: StartPairingRequest, response: { 200: StartPairingResponse } },
    },
    async (req) => {
      const { name, platform, runtimeVersion } = req.body;
      const deviceCode = randomToken(32);
      const now = new Date();
      const userCode = await store.create(sha256Hex(deviceCode), {
        enrollmentHash: pairingEnrollmentHash(deviceCode),
        name,
        platform,
        runtimeVersion: runtimeVersion ?? null,
        requestIp: req.ip ?? null,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + PAIRING_TTL_SECONDS * 1000).toISOString(),
      });
      const web = webUrlOf(core);
      return {
        deviceCode,
        userCode,
        verificationUri: `${web}/settings/devices?add=server`,
        verificationUriComplete: `${web}/settings/devices?pair=${userCode}`,
        expiresIn: PAIRING_TTL_SECONDS,
        interval: PAIRING_INTERVAL_SECONDS,
      };
    },
  );

  app.post(
    "/devices/pairings/token",
    {
      // Authenticated by the device code itself (the poll secret, in the body only).
      config: { authz: "public", rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: { tags: ["device"], body: PairingTokenRequest, response: { 200: PairingTokenResponse } },
    },
    async (req) => {
      const { deviceCode } = req.body;
      const deviceCodeHash = sha256Hex(deviceCode);
      const now = new Date();
      const record = await store.touchPoll(deviceCodeHash, now);
      if (!record) throw pairingError("expired_token");
      if (record.status === "denied") {
        await store.remove(deviceCodeHash, record.userCodeHash);
        throw pairingError("access_denied");
      }
      if (record.status === "pending") {
        const last = record.lastPollAt ? new Date(record.lastPollAt).getTime() : null;
        if (last !== null && now.getTime() - last < PAIRING_INTERVAL_SECONDS * 1000) {
          throw pairingError("slow_down");
        }
        throw pairingError("authorization_pending");
      }
      try {
        const enrolled = await enrollWithCodeHash(core, pairingEnrollmentHash(deviceCode), {
          name: record.approvedName ?? record.name,
          platform: record.platform,
          via: "device_code",
        });
        await store.remove(deviceCodeHash, record.userCodeHash).catch(() => {});
        return enrolled;
      } catch (err) {
        if (err instanceof HttpError && err.code === "invalid_code") {
          // Approved in Redis, its enrollment row not committed yet: keep polling.
          throw pairingError("authorization_pending");
        }
        if (err instanceof HttpError && (err.code === "code_used" || err.code === "code_expired")) {
          await store.remove(deviceCodeHash, record.userCodeHash).catch(() => {});
          throw pairingError("expired_token");
        }
        throw err;
      }
    },
  );

  app.post(
    "/devices/pairings/approve",
    { ...decider, schema: { tags: ["device"], body: ApprovePairingRequest, response: { 200: Ok } } },
    async (req) => {
      const canonical = canonicalOf(req.body.userCode);
      const { name } = req.body;
      const found = await store.byUserCode(canonical);
      if (!found) throw notFoundCode();
      const { deviceCodeHash, record } = found;
      if (record.status !== "pending") throw alreadyDecided();
      const auth = authOf(req);
      await decideInTransaction(req, deviceCodeHash, "approved", async (tx) => {
        try {
          await tx.insert(deviceEnrollments).values({
            codeHash: record.enrollmentHash,
            organizationId: auth.organizationId,
            userId: auth.userId,
            expiresAt: record.expiresAt,
          });
        } catch (err) {
          // A concurrent approval of the same request committed its row first.
          if (isUniqueViolation(err)) throw alreadyDecided();
          throw err;
        }
        await core.audit.record(tx, {
          action: "device.pairing_approved",
          resourceType: "device_pairing",
          metadata: {
            name,
            requestedName: record.name,
            platform: record.platform,
            requestIp: record.requestIp,
            runtimeVersion: record.runtimeVersion,
          },
        });
        // Last, still inside the transaction: a lost race rolls the enrollment row and the audit row back.
        return { approvedName: name };
      });
      return { ok: true as const };
    },
  );

  app.post(
    "/devices/pairings/deny",
    { ...decider, schema: { tags: ["device"], body: DenyPairingRequest, response: { 200: Ok } } },
    async (req) => {
      const found = await store.byUserCode(canonicalOf(req.body.userCode));
      if (!found) throw notFoundCode();
      const { deviceCodeHash, record } = found;
      if (record.status !== "pending") throw alreadyDecided();
      await decideInTransaction(req, deviceCodeHash, "denied", async (tx) => {
        await core.audit.record(tx, {
          action: "device.pairing_denied",
          resourceType: "device_pairing",
          metadata: { requestedName: record.name, platform: record.platform, requestIp: record.requestIp },
        });
        // A lost race throws in the compare-and-set after this, so the audit row rolls back with it.
        return {};
      });
      return { ok: true as const };
    },
  );

  app.post(
    "/devices/pairings/lookup",
    {
      ...decider,
      schema: { tags: ["device"], body: PairingLookupRequest, response: { 200: PairingRequestView } },
    },
    async (req) => {
      const canonical = canonicalOf(req.body.userCode);
      const found = await store.byUserCode(canonical);
      // Only a pending request can be shown; a decided or vanished one reads like an unknown code.
      if (found?.record.status !== "pending") throw notFoundCode();
      const { record } = found;
      // The resolver decided `device.pair` in the preHandler; this read is pre-tenant (Redis) and names no org data.
      return {
        userCode: formatUserCode(canonical),
        name: record.name,
        platform: record.platform,
        runtimeVersion: record.runtimeVersion,
        requestIp: record.requestIp,
        requestedAt: record.createdAt,
        expiresAt: record.expiresAt,
      };
    },
  );
}
