import { getCurrentAdapter } from "@better-auth/core/context";
import type { ClientKind } from "@ocw/contracts";
import type { Auth } from "./auth";
import { clientFromUserAgent } from "./client-kind";

/** A session as the platform exposes it: explicit columns only, never the session secret (Pitfall 9). */
export interface SessionRecord {
  id: string;
  userId: string;
  clientKind: ClientKind;
  clientLabel: string | null;
  ipAddress: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

/**
 * Session list/delete over the better-auth adapter. Every call goes through `getCurrentAdapter`, so it joins
 * an outer `runWithTransaction` (and rolls back with it); publish revocations only after that commits.
 */
export interface SessionStore {
  list(userId: string): Promise<SessionRecord[]>;
  /** Deletes the session only when it belongs to `userId`; false when there was nothing to delete. */
  delete(userId: string, sessionId: string): Promise<boolean>;
  /** Deletes every session of `userId` (except one, if given); returns the deleted ids. */
  deleteAllForUser(userId: string, opts?: { exceptSessionId?: string }): Promise<string[]>;
  /** The session exists and has not expired. */
  isActive(sessionId: string): Promise<boolean>;
}

/** The columns read from the adapter; anything else on the row is never selected into a record. */
interface SessionRow {
  id: string;
  userId: string;
  clientKind?: string | null;
  clientLabel?: string | null;
  userAgent?: string | null;
  ipAddress?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  expiresAt: Date | string;
}

const SESSION_CLIENT_KINDS: readonly ClientKind[] = ["web", "desktop", "mobile"];
const iso = (d: Date | string) => new Date(d).toISOString();

function toRecord(row: SessionRow): SessionRecord {
  const stored = SESSION_CLIENT_KINDS.find((k) => k === row.clientKind);
  return {
    id: row.id,
    userId: row.userId,
    clientKind: stored ?? clientFromUserAgent(row.userAgent).kind,
    clientLabel: row.clientLabel ?? null,
    ipAddress: row.ipAddress || null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    expiresAt: iso(row.expiresAt),
  };
}

export function createSessionStore(auth: Auth): SessionStore {
  const adapter = async () => getCurrentAdapter((await auth.$context).adapter);
  const byUser = async (userId: string) =>
    (await adapter()).findMany<SessionRow>({
      model: "session",
      where: [{ field: "userId", value: userId }],
      sortBy: { field: "createdAt", direction: "asc" },
    });

  return {
    async list(userId) {
      return (await byUser(userId)).map(toRecord);
    },

    async delete(userId, sessionId) {
      const a = await adapter();
      const row = await a.findOne<SessionRow>({
        model: "session",
        where: [
          { field: "id", value: sessionId },
          { field: "userId", value: userId },
        ],
      });
      if (!row) return false;
      await a.delete({ model: "session", where: [{ field: "id", value: sessionId }] });
      return true;
    },

    async deleteAllForUser(userId, opts = {}) {
      const ids = (await byUser(userId)).map((r) => r.id).filter((id) => id !== opts.exceptSessionId);
      if (ids.length === 0) return [];
      await (await adapter()).deleteMany({
        model: "session",
        where: [
          { field: "userId", value: userId },
          { field: "id", value: ids, operator: "in" },
        ],
      });
      return ids;
    },

    async isActive(sessionId) {
      const row = await (await adapter()).findOne<SessionRow>({
        model: "session",
        where: [{ field: "id", value: sessionId }],
      });
      return !!row && new Date(row.expiresAt).getTime() > Date.now();
    },
  };
}
