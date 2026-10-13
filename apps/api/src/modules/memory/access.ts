import {
  type AuthzDenial,
  isUnderFolder,
  type MemoryCapability,
  type Permission,
  permissionMatches,
} from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import { sql } from "drizzle-orm";
import {
  type MemoryScopeFacts,
  memoryResource,
  type PermissionService,
  type PrincipalRef,
  type ResourceFacts,
  type RuleFact,
} from "../organization";

/**
 * Who acts on memory (07.2-08 interfaces block):
 * - `user`: a person through the REST API; every decision goes through the resolver.
 * - `agent`: a bot acting for the human of its turn (07.2-11). The human is REQUIRED: an agent decision without a human
 *   would judge the agent alone (WINDOWS 131), so the type has no optional field and `assertActor` refuses an empty one.
 * - `system`: scope creation and migrations; no resolver check.
 * - `approved`: only an approval kind's apply hook (07.2-09). The primitive already decided (`canDecide`), so there is
 *   no resolver check here; the author is recorded as the agent on behalf of the human and the revision is linked to
 *   the approval request.
 */
export type MemoryActor =
  | { kind: "user"; userId: string }
  | { kind: "agent"; agentId: string; onBehalfOfUserId: string }
  | { kind: "system" }
  | {
      kind: "approved";
      agentId: string | null;
      onBehalfOfUserId: string | null;
      approvalRequestId: string;
    };

export function assertActor(actor: MemoryActor): void {
  if (actor.kind === "agent" && !actor.onBehalfOfUserId) {
    throw new Error("a memory decision for an agent needs the human it acts for");
  }
}

// ---------------------------------------------------------------- the personal-owner lens (ADR-0010, Pattern 2b)

/**
 * Runs `fn` with `app.user_id` set to `ownerUserId` (transaction-local), then restores the previous value, so the
 * RESTRICTIVE `personal_owner_only` policy shows that person's personal rows and nobody else's. The memory service
 * calls it only for an agent or an approved apply acting for that very human (the human's own view of the database;
 * the resolver then decides agent ∩ human before anything is read or written), and for the system creating that
 * human's scope. Never for a person browsing someone else's memory.
 */
export async function withPersonalOwner<T>(tx: Tx, ownerUserId: string, fn: () => Promise<T>): Promise<T> {
  const res = await tx.execute(sql`select current_setting('app.user_id', true) as uid`);
  const previous = ((res.rows[0] as { uid: string | null } | undefined)?.uid ?? "") as string;
  if (previous === ownerUserId) return fn();
  await tx.execute(sql`select set_config('app.user_id', ${ownerUserId}, true)`);
  try {
    return await fn();
  } finally {
    await tx.execute(sql`select set_config('app.user_id', ${previous}, true)`);
  }
}

/** The human whose RLS view an actor reads through (null = the transaction's own). */
function lensOf(actor: MemoryActor): string | null {
  if (actor.kind === "agent") return actor.onBehalfOfUserId;
  if (actor.kind === "approved") return actor.onBehalfOfUserId;
  return null;
}

/** Runs `fn` through the actor's lens: agents and approved applies see what the human they act for may see. */
export async function asActor<T>(tx: Tx, actor: MemoryActor, fn: () => Promise<T>): Promise<T> {
  assertActor(actor);
  const lens = lensOf(actor);
  return lens ? withPersonalOwner(tx, lens, fn) : fn();
}

// ---------------------------------------------------------------- resolver decisions

export type MemoryDecision = { allowed: true } | { allowed: false; denial: AuthzDenial };

const ALLOWED: MemoryDecision = { allowed: true };

/** One memory decision for any actor; `path` = a file decision (folder rules apply), undefined = scope level. */
export async function decideMemory(
  perms: PermissionService,
  tx: Tx,
  actor: MemoryActor,
  permission: Permission,
  scope: MemoryScopeFacts,
  path: string | undefined,
): Promise<MemoryDecision> {
  assertActor(actor);
  let principal: PrincipalRef;
  let resource: ResourceFacts;
  let human: ResourceFacts | undefined;
  switch (actor.kind) {
    case "system":
    case "approved":
      return ALLOWED;
    case "user":
      principal = { kind: "user", userId: actor.userId };
      resource = memoryResource(scope, path, { kind: "user", id: actor.userId });
      break;
    case "agent":
      principal = { kind: "agent", agentId: actor.agentId, onBehalfOfUserId: actor.onBehalfOfUserId };
      resource = memoryResource(scope, path, { kind: "agent", id: actor.agentId });
      // The human is judged on their own view of the scope (owner relation for their personal memory).
      human = memoryResource(scope, path, { kind: "user", id: actor.onBehalfOfUserId });
      break;
  }
  const res = await perms.decide(tx, principal, permission, resource, human);
  if (res.allowed) return ALLOWED;
  return {
    allowed: false,
    denial: res.denial ?? { permission, layer: "role", reason: "missing_permission" },
  };
}

const CAPABILITIES: ReadonlyArray<readonly [MemoryCapability, Permission]> = [
  ["read", "memory.read"],
  ["write", "memory.write"],
  ["promote", "memory.promote"],
];

/** What the actor may do on a scope (path undefined) or a file: drives `viewerCan`. */
export async function capabilitiesOf(
  perms: PermissionService,
  tx: Tx,
  actor: MemoryActor,
  scope: MemoryScopeFacts,
  path: string | undefined,
): Promise<MemoryCapability[]> {
  const out: MemoryCapability[] = [];
  for (const [cap, perm] of CAPABILITIES) {
    if ((await decideMemory(perms, tx, actor, perm, scope, path)).allowed) out.push(cap);
  }
  return out;
}

/**
 * The items whose path the actor may read: one request-less `filterFor` pass per principal (facts and rules load once,
 * then one in-memory decision per path). An agent keeps what both it and its human may read: the on-behalf-of rule is
 * an intersection of two independent decisions, so two passes equal one combined decision per item.
 */
export async function filterReadable<T>(
  perms: PermissionService,
  tx: Tx,
  actor: MemoryActor,
  scope: MemoryScopeFacts,
  items: readonly T[],
  pathOf: (item: T) => string,
): Promise<T[]> {
  assertActor(actor);
  if (items.length === 0) return [];
  switch (actor.kind) {
    case "system":
    case "approved":
      return [...items];
    case "user":
      return perms.filterFor(tx, { kind: "user", userId: actor.userId }, items, "memory.read", (item) =>
        memoryResource(scope, pathOf(item), { kind: "user", id: actor.userId }),
      );
    case "agent": {
      const byAgent = await perms.filterFor(
        tx,
        { kind: "agent", agentId: actor.agentId },
        items,
        "memory.read",
        (item) => memoryResource(scope, pathOf(item), { kind: "agent", id: actor.agentId }),
      );
      return perms.filterFor(
        tx,
        { kind: "user", userId: actor.onBehalfOfUserId },
        byAgent,
        "memory.read",
        (item) => memoryResource(scope, pathOf(item), { kind: "user", id: actor.onBehalfOfUserId }),
      );
    }
  }
}

// ---------------------------------------------------------------- the audience rule (D-08, Pitfall 5)

/** Who will read what an agent says in a turn: listed people, or anyone (a public channel, a group-granted AI chat). */
export interface MemoryAudience {
  userIds: readonly string[];
  unbounded: boolean;
}

export type AgentReadVerdict = { allowed: true } | { allowed: false; reason: "denied" | "audience_too_wide" };

export interface AudienceFacts {
  /** A personal scope or a personal bot's notebook (owner-only memory). */
  personalLike: boolean;
  /** The owner of a personal-like scope. */
  ownerUserId: string | null;
  /** The human the agent acts for (always one of the readers). */
  askingUserId: string;
  audience: MemoryAudience;
  /** The listed readers who hold `memory.read` on (scope, path). */
  allowedReaders: ReadonlySet<string>;
  /** Unbounded audiences only: an organization-wide scope with no `memory.read` deny matching the file. */
  openToEveryone: boolean;
}

/**
 * Pure combinator of the audience rule, applied after agent ∩ asking human allowed the read:
 * - personal-like memory: only when the owner is the one and only reader (never an unbounded audience);
 * - an unbounded audience: only organization-wide memory nobody is denied;
 * - a listed audience: every reader (the asking human included) holds `memory.read` on the file.
 */
export function audienceVerdict(f: AudienceFacts): AgentReadVerdict {
  const readers = new Set([...f.audience.userIds, f.askingUserId]);
  const tooWide: AgentReadVerdict = { allowed: false, reason: "audience_too_wide" };
  if (f.personalLike) {
    if (f.audience.unbounded || f.ownerUserId === null) return tooWide;
    return readers.size === 1 && readers.has(f.ownerUserId) ? { allowed: true } : tooWide;
  }
  if (f.audience.unbounded) return f.openToEveryone ? { allowed: true } : tooWide;
  for (const id of readers) if (!f.allowedReaders.has(id)) return tooWide;
  return { allowed: true };
}

/** The scope is readable by the whole organization: the org scope, or the notebook of an organization-wide bot. */
export function organizationWide(scope: MemoryScopeFacts): boolean {
  if (scope.kind === "org") return true;
  if (scope.kind !== "agent" || scope.agent === null) return false;
  return scope.agent.scope === "team" && (scope.agent.unitPath ?? []).length === 0;
}

/**
 * True when any rule denies `memory.read` on this resource's path for any human subject, wherever it is scoped (a
 * unit-scoped rule reaches the unit's members on organization resources too). Agent-subject rules are left out: the
 * audience is people, and the agent itself was already decided.
 */
export function anyReadDeny(rules: readonly RuleFact[], resource: ResourceFacts): boolean {
  return rules.some(
    (r) =>
      r.effect === "deny" &&
      r.subjectKind !== "agent" &&
      r.tool === null &&
      permissionMatches(r.permission, "memory.read") &&
      (r.pathPrefix === null || (resource.path !== undefined && isUnderFolder(resource.path, r.pathPrefix))),
  );
}

/** A personal scope or a personal bot's notebook: owner-only memory. */
export function personalOwnerOf(scope: MemoryScopeFacts): string | null {
  if (scope.kind === "personal") return scope.ownerUserId;
  if (scope.kind === "agent" && scope.agent !== null && scope.agent.scope === "personal") {
    return scope.agent.ownerUserId;
  }
  return null;
}

export function isPersonalLike(scope: MemoryScopeFacts): boolean {
  return (
    scope.kind === "personal" ||
    (scope.kind === "agent" && (scope.agent === null || scope.agent.scope === "personal"))
  );
}

/**
 * The audience rule for agent reads (MEM-04 support, D-08): agent ∩ the asking human ∩ every reader of the turn.
 * `scope` is already loaded through the asking human's lens. Enforced by the Agent Channel memory routes (07.2-11).
 */
export async function decideAgentRead(
  perms: PermissionService,
  tx: Tx,
  rules: (tx: Tx) => Promise<RuleFact[]>,
  scope: MemoryScopeFacts,
  a: { agentId: string; onBehalfOfUserId: string; audience: MemoryAudience; path?: string },
): Promise<AgentReadVerdict> {
  const actor: MemoryActor = { kind: "agent", agentId: a.agentId, onBehalfOfUserId: a.onBehalfOfUserId };
  const own = await decideMemory(perms, tx, actor, "memory.read", scope, a.path);
  if (!own.allowed) return { allowed: false, reason: "denied" };
  const personalLike = isPersonalLike(scope);
  let allowedReaders: ReadonlySet<string> = new Set();
  let openToEveryone = false;
  if (!personalLike && a.audience.unbounded) {
    openToEveryone =
      organizationWide(scope) && !anyReadDeny(await rules(tx), memoryResource(scope, a.path, null));
  } else if (!personalLike) {
    const candidates = [...new Set([...a.audience.userIds, a.onBehalfOfUserId])];
    allowedReaders = new Set(
      await perms.usersAllowed(tx, {
        candidates,
        permission: "memory.read",
        resourceFor: (userId) => memoryResource(scope, a.path, { kind: "user", id: userId }),
      }),
    );
  }
  return audienceVerdict({
    personalLike,
    ownerUserId: personalOwnerOf(scope),
    askingUserId: a.onBehalfOfUserId,
    audience: a.audience,
    allowedReaders,
    openToEveryone,
  });
}
