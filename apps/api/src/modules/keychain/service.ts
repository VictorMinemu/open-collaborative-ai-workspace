import { randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type {
  CreateVaultItemRequest,
  UpdateVaultItemRequest,
  VaultInjection,
  VaultItem,
  VaultItemList,
  VaultScope,
} from "@ocw/contracts";
import { vaultHostAllowed } from "@ocw/contracts";
import { agentVaultGrants, botPolicies, orgUnits, type Tx, tenantOf, vaultItems } from "@ocw/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { authOf, type Core } from "../../core";
import { classifyAddress, egressFor, platformHostsFromEnv } from "../../lib/egress";
import { badRequest, notFound } from "../../lib/errors";
import { findBot, loadBotFacts } from "../bot-capabilities";
import {
  agentResource,
  loadPrincipalFacts,
  orgResource,
  type PermissionService,
  type PrincipalFacts,
  type ResourceFacts,
  unitResource,
  userResource,
} from "../organization";
import { clientCredentialsToken, forgetClientCredentialsToken } from "./client-credentials";
import { buildInjectionHeader, KeychainError, StoredSecret, secretParts } from "./inject";

/**
 * Keychain (Phase 07.4, D-04, D-06, D-07 items 1-3; CONN-05): secrets agents use BY HANDLE. The value is sealed in
 * `app.secrets` (kind `vault_item`) with AAD `${org}:vault:${itemId}`, so a row can never be pointed at another row's
 * ciphertext; `vault_items.secret_ref` is always a `db` SecretReference of the item's own organization (OpenBao-backed
 * items are out of scope, D-07 item 1). Values are write-only: no response, log line or audit row carries one.
 *
 * Who decides what:
 * - personal items are their owner's alone (API check + the restrictive `personal_owner_only` RLS policy); another
 *   member's personal item, or any item of another organization, is a 404;
 * - unit items (unit null = the organization) are managed with `vault.manage` on their unit (leads on the units they
 *   lead, admins everywhere);
 * - an agent may use an item on a turn only through `effectiveVaultItems`: grant ∩ owner rule ∩ unit audience ∩
 *   `vault.use` decided for the agent acting for the turn's human.
 *
 * Callers that resolve items for a turn must open the transaction with `userId` = the turn's human: personal items are
 * invisible to any other session (a cell context without a user included).
 */

export type VaultItemRow = typeof vaultItems.$inferSelect;

const HANDLE_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const HANDLE_ATTEMPTS = 5;

/** The AAD that binds a keychain value to its item. */
export const vaultAad = (organizationId: string, itemId: string) => `${organizationId}:vault:${itemId}`;

function newHandle(): string {
  const bytes = randomBytes(10);
  let out = "k_";
  for (const b of bytes) out += HANDLE_ALPHABET[b % 32];
  return out;
}

const iso = (v: string) => new Date(v).toISOString();

function toDto(row: VaultItemRow, agentIds: readonly string[]): VaultItem {
  return {
    id: row.id,
    scope: row.scope,
    unitId: row.unitId,
    ownerUserId: row.ownerUserId,
    name: row.name,
    handle: row.handle,
    kind: row.kind,
    injection: row.injection,
    allowedHosts: row.allowedHosts,
    allowedPathPrefix: row.allowedPathPrefix,
    tokenUrl: row.tokenUrl,
    hasValue: true,
    valueUpdatedAt: iso(row.valueUpdatedAt),
    agentIds: [...agentIds],
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    lastUsedAt: row.lastUsedAt ? iso(row.lastUsedAt) : null,
  };
}

/** Audit metadata of an item: ids, handle, shape and hosts, from an explicit list (never a value). */
function itemAudit(row: VaultItemRow): Record<string, unknown> {
  return {
    handle: row.handle,
    scope: row.scope,
    kind: row.kind,
    unitId: row.unitId,
    ownerUserId: row.ownerUserId,
    hosts: row.allowedHosts,
  };
}

// ---------------------------------------------------------------- lookups

async function grantsOf(tx: Tx, itemIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (itemIds.length === 0) return out;
  const rows = await tx
    .select({ itemId: agentVaultGrants.vaultItemId, agentId: agentVaultGrants.agentId })
    .from(agentVaultGrants)
    .where(inArray(agentVaultGrants.vaultItemId, [...itemIds]))
    .orderBy(asc(agentVaultGrants.agentId));
  for (const r of rows) out.set(r.itemId, [...(out.get(r.itemId) ?? []), r.agentId]);
  return out;
}

async function unitPaths(tx: Tx, unitIds: readonly string[]): Promise<Map<string, string[]>> {
  const ids = [...new Set(unitIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: orgUnits.id, path: orgUnits.path })
    .from(orgUnits)
    .where(inArray(orgUnits.id, ids));
  return new Map(rows.map((r) => [r.id, r.path]));
}

/** The resource `vault.manage` / `vault.use` are decided on: the item's unit, or the organization. */
function itemResource(
  row: Pick<VaultItemRow, "scope" | "unitId">,
  paths: Map<string, string[]>,
): ResourceFacts {
  if (row.scope === "unit" && row.unitId) {
    return unitResource({ id: row.unitId, path: paths.get(row.unitId) ?? [row.unitId] });
  }
  return orgResource();
}

/** The item with this handle in the tx's organization (personal items only when the tx's user owns them). */
export async function findVaultItemByHandle(tx: Tx, handle: string): Promise<VaultItemRow | null> {
  const [row] = await tx.select().from(vaultItems).where(eq(vaultItems.handle, handle)).limit(1);
  return row ?? null;
}

async function findVaultItem(tx: Tx, id: string): Promise<VaultItemRow | null> {
  const [row] = await tx.select().from(vaultItems).where(eq(vaultItems.id, id)).limit(1);
  return row ?? null;
}

const itemNotFound = () => notFound("Key not found", "vault_item_not_found");

/**
 * The item, decided for the caller: a personal item is its owner's (anyone else, admins included, gets 404); a unit
 * item needs `vault.manage` on its unit (404 otherwise, so nobody learns another unit's keys exist).
 */
async function itemForCaller(
  perms: PermissionService,
  req: FastifyRequest,
  tx: Tx,
  id: string,
): Promise<VaultItemRow> {
  const caller = authOf(req).userId;
  const row = await findVaultItem(tx, id);
  if (!row) {
    // Still a resolver decision on the caller's own account, so the strict authz check sees one.
    await perms.can(req, tx, "account.manage", userResource(caller, caller));
    throw itemNotFound();
  }
  if (row.scope === "personal") {
    if (row.ownerUserId !== caller) {
      await perms.can(req, tx, "account.manage", userResource(caller, caller));
      throw itemNotFound();
    }
    // Managing one's own keys is managing one's own account; it stays possible even when Bots are off.
    await perms.assertCan(req, tx, "account.manage", userResource(caller, caller), { hideAs404: true });
    return row;
  }
  const paths = await unitPaths(tx, row.unitId ? [row.unitId] : []);
  await perms.assertCan(req, tx, "vault.manage", itemResource(row, paths), { hideAs404: true });
  return row;
}

// ---------------------------------------------------------------- private hosts (D-07 item 2)

/** The organization's private-host allowlist for keychain requests (`bot_policies.egress_private_hosts`). */
export async function loadPrivateHosts(tx: Tx): Promise<string[]> {
  const [row] = await tx.select({ hosts: botPolicies.egressPrivateHosts }).from(botPolicies).limit(1);
  return row?.hosts ?? [];
}

/** `host` and `port` of a host pattern (`*.` kept on the host). */
function splitPattern(pattern: string): { host: string; port: string | null } {
  const m = /^(.*?)(?::(\d{1,5}))?$/.exec(pattern.trim().toLowerCase());
  return { host: m?.[1] ?? pattern, port: m?.[2] ?? null };
}

/** `host:port` entries a pattern stands for: its own port, or both default ports when it names none. */
function hostPorts(pattern: string): string[] {
  const { host, port } = splitPattern(pattern);
  return port ? [`${host}:${Number(port)}`] : [`${host}:80`, `${host}:443`];
}

/** True for a host a personal key may never name: a non-public IP literal, `localhost`, or an admin-listed host. */
function privateForPersonal(pattern: string, orgPrivate: ReadonlySet<string>): boolean {
  const { host } = splitPattern(pattern);
  const bare = host.startsWith("*.") ? host.slice(2) : host;
  // Any IP literal that is not public: loopback, RFC 1918, CGNAT, link-local, metadata, reserved…
  if (isIP(bare) !== 0 && classifyAddress(bare) !== "public") return true;
  if (bare === "localhost" || bare.endsWith(".localhost")) return true;
  return orgPrivate.has(bare);
}

async function assertPersonalHosts(tx: Tx, hosts: readonly string[]): Promise<void> {
  const orgPrivate = new Set((await loadPrivateHosts(tx)).map((h) => splitPattern(h).host));
  if (hosts.some((h) => privateForPersonal(h, orgPrivate))) {
    throw badRequest(
      "A personal key can only be sent to public hosts. Ask an admin for a unit key to reach a private network.",
      "private_host_personal",
    );
  }
}

/**
 * The exact `host:port` entries the egress guard may admit to a private address for this item: none for a personal
 * item; for a unit item, its non-wildcard hosts that the organization's private-host allowlist also names.
 */
export async function privateAllowFor(tx: Tx, item: VaultItemRow): Promise<string[]> {
  if (item.scope === "personal") return [];
  const listed = new Set((await loadPrivateHosts(tx)).flatMap(hostPorts));
  if (listed.size === 0) return [];
  const own = item.allowedHosts.filter((h) => !h.startsWith("*.")).flatMap(hostPorts);
  return [...new Set(own)].filter((e) => listed.has(e));
}

export async function setPrivateHosts(core: Core, tx: Tx, hosts: readonly string[], actorUserId: string) {
  const platform = new Set(platformHostsFromEnv(core.env).map((h) => splitPattern(h).host));
  for (const h of hosts) {
    const { host } = splitPattern(h);
    if (platform.has(host)) {
      throw badRequest("This host belongs to the platform itself and is never reachable.", "platform_host");
    }
    if (isIP(host) !== 0 && classifyAddress(host) === "refused") {
      throw badRequest("Loopback and link-local addresses are never reachable.", "private_host_refused");
    }
  }
  const before = await loadPrivateHosts(tx);
  const next = [...new Set(hosts)];
  const values = { egressPrivateHosts: next, updatedBy: actorUserId, updatedAt: new Date().toISOString() };
  await tx
    .insert(botPolicies)
    .values({ organizationId: tenantOf(tx).organizationId, ...values })
    .onConflictDoUpdate({ target: botPolicies.organizationId, set: values });
  await core.audit.record(tx, {
    action: "keychain.private_hosts_updated",
    resourceType: "bot_policy",
    resourceId: tenantOf(tx).organizationId,
    metadata: {
      hosts: next,
      added: next.filter((h) => !before.includes(h)),
      removed: before.filter((h) => !next.includes(h)),
    },
  });
  return { hosts: next };
}

// ---------------------------------------------------------------- list and CRUD (routes)

export async function listVaultItems(
  perms: PermissionService,
  req: FastifyRequest,
  tx: Tx,
): Promise<VaultItemList> {
  const caller = authOf(req).userId;
  const personal = await tx
    .select()
    .from(vaultItems)
    .where(and(eq(vaultItems.scope, "personal"), eq(vaultItems.ownerUserId, caller)))
    .orderBy(asc(vaultItems.name), asc(vaultItems.handle));
  const unitRows = await tx
    .select()
    .from(vaultItems)
    .where(eq(vaultItems.scope, "unit"))
    .orderBy(asc(vaultItems.name), asc(vaultItems.handle));
  const units = await tx
    .select({ id: orgUnits.id, name: orgUnits.name, path: orgUnits.path })
    .from(orgUnits)
    .orderBy(asc(orgUnits.name));
  const paths = new Map(units.map((u) => [u.id, u.path]));
  const manageable = await perms.filter(req, tx, unitRows, "vault.manage", (r) => itemResource(r, paths));
  const manageableUnits = await perms.filter(req, tx, units, "vault.manage", (u) => unitResource(u));
  const org = await perms.can(req, tx, "vault.manage", orgResource());
  const grants = await grantsOf(
    tx,
    [...personal, ...manageable].map((r) => r.id),
  );
  return {
    personal: personal.map((r) => toDto(r, grants.get(r.id) ?? [])),
    unit: manageable.map((r) => toDto(r, grants.get(r.id) ?? [])),
    manageableUnits: [
      ...(org ? [{ unitId: null, name: "Whole organization" }] : []),
      ...manageableUnits.map((u) => ({ unitId: u.id, name: u.name })),
    ],
  };
}

export async function getVaultItem(
  perms: PermissionService,
  req: FastifyRequest,
  tx: Tx,
  id: string,
): Promise<VaultItem> {
  const row = await itemForCaller(perms, req, tx, id);
  return toDto(row, (await grantsOf(tx, [row.id])).get(row.id) ?? []);
}

function secretOf(body: CreateVaultItemRequest): StoredSecret {
  switch (body.kind) {
    case "api_key":
      return { kind: "api_key", value: body.value };
    case "basic":
      return { kind: "basic", username: body.username, password: body.password };
    case "oauth":
      return {
        kind: "oauth",
        clientId: body.clientId,
        clientSecret: body.clientSecret,
        ...(body.scope ? { scope: body.scope } : {}),
      };
  }
}

export async function createVaultItem(
  core: Core,
  perms: PermissionService,
  req: FastifyRequest,
  tx: Tx,
  body: CreateVaultItemRequest,
): Promise<VaultItem> {
  const caller = authOf(req).userId;
  const org = tenantOf(tx).organizationId;
  let unitId: string | null = null;
  if (body.scope === "personal") {
    await perms.assertCan(req, tx, "vault.use", orgResource());
    await assertPersonalHosts(tx, body.allowedHosts);
  } else {
    unitId = body.unitId ?? null;
    let resource = orgResource();
    if (unitId) {
      // Resolved inside the tenant: another organization's unit id is simply not found.
      const [u] = await tx
        .select({ id: orgUnits.id, path: orgUnits.path })
        .from(orgUnits)
        .where(eq(orgUnits.id, unitId))
        .limit(1);
      if (!u) {
        await perms.can(req, tx, "vault.manage", orgResource());
        throw notFound("Unit not found", "unit_not_found");
      }
      resource = unitResource(u);
    }
    await perms.assertCan(req, tx, "vault.manage", resource);
  }

  const id = randomUUID();
  const secret = secretOf(body);
  // The id exists before the value is sealed, so the AAD binds the ciphertext to this one row.
  const secretId = await core.secrets.putSealed(tx, {
    name: `vault_item:${id}`,
    kind: "vault_item",
    value: JSON.stringify(secret),
    aad: vaultAad(org, id),
  });
  const values = {
    id,
    organizationId: org,
    scope: body.scope as VaultScope,
    ownerUserId: body.scope === "personal" ? caller : null,
    unitId,
    name: body.name,
    kind: body.kind,
    injection: body.injection as VaultInjection,
    allowedHosts: [...new Set(body.allowedHosts)],
    allowedPathPrefix: body.allowedPathPrefix ?? null,
    tokenUrl: body.kind === "oauth" ? body.tokenUrl : null,
    secretRef: { provider: "db" as const, secretId, organizationId: org },
    createdBy: caller,
  };
  let row: VaultItemRow | undefined;
  for (let attempt = 0; attempt < HANDLE_ATTEMPTS && !row; attempt++) {
    const handle = newHandle();
    try {
      // A savepoint: a handle collision (unique per organization) is retried without aborting the transaction.
      row = await tx.transaction(async (sp) => {
        const [r] = await sp
          .insert(vaultItems)
          .values({ ...values, handle })
          .returning();
        return r;
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  if (!row) throw new Error("could not allocate a key handle");
  await core.audit.record(tx, {
    action: "vault_item.created",
    resourceType: "vault_item",
    resourceId: row.id,
    metadata: itemAudit(row),
  });
  return toDto(row, []);
}

function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 4 && e && typeof e === "object"; i++) {
    if ((e as { code?: unknown }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** The sealed value's location when it is ours to read: a `db` reference of the tx's organization (D-07 item 1). */
function ownDbRef(tx: Tx, item: VaultItemRow): { secretId: string } | null {
  const ref = item.secretRef;
  const org = tenantOf(tx).organizationId;
  if (ref.provider !== "db" || ref.organizationId !== org || item.organizationId !== org) return null;
  return { secretId: ref.secretId };
}

export async function updateVaultItem(
  core: Core,
  perms: PermissionService,
  req: FastifyRequest,
  tx: Tx,
  id: string,
  body: UpdateVaultItemRequest,
): Promise<VaultItem> {
  const row = await itemForCaller(perms, req, tx, id);
  const hosts = body.allowedHosts ? [...new Set(body.allowedHosts)] : row.allowedHosts;
  if (row.scope === "personal" && body.allowedHosts) await assertPersonalHosts(tx, hosts);

  let injection = row.injection;
  if (body.injection) {
    if (row.kind === "basic") {
      if (body.injection.scheme !== "basic" || body.injection.header.toLowerCase() !== "authorization") {
        throw badRequest("A username and password key is always sent as HTTP Basic", "injection_scheme");
      }
    } else if (body.injection.scheme === "basic") {
      throw badRequest("Only a username and password key is Basic", "injection_scheme");
    }
    injection = body.injection;
  }

  if (body.tokenUrl !== undefined && row.kind !== "oauth") {
    throw badRequest("Only an OAuth client key has a token URL", "token_url");
  }
  const tokenUrl = body.tokenUrl ?? row.tokenUrl;
  if (row.kind === "oauth") {
    if (!tokenUrl || !vaultHostAllowed(hosts, tokenUrl)) {
      throw badRequest("The token URL's host must be an allowed host", "token_url");
    }
  }

  const now = new Date().toISOString();
  const changed: string[] = [];
  const patch: Partial<typeof vaultItems.$inferInsert> = {};
  if (body.name !== undefined && body.name !== row.name) {
    patch.name = body.name;
    changed.push("name");
  }
  if (body.injection && JSON.stringify(injection) !== JSON.stringify(row.injection)) {
    patch.injection = injection;
    changed.push("injection");
  }
  if (body.allowedHosts && JSON.stringify(hosts) !== JSON.stringify(row.allowedHosts)) {
    patch.allowedHosts = hosts;
    changed.push("allowedHosts");
  }
  if (body.allowedPathPrefix !== undefined && body.allowedPathPrefix !== row.allowedPathPrefix) {
    patch.allowedPathPrefix = body.allowedPathPrefix;
    changed.push("allowedPathPrefix");
  }
  if (body.tokenUrl !== undefined && body.tokenUrl !== row.tokenUrl) {
    patch.tokenUrl = body.tokenUrl;
    changed.push("tokenUrl");
  }
  const valueChanged = body.secret !== undefined;
  if (body.secret) {
    if (body.secret.kind !== row.kind) {
      throw badRequest("The new value must be of the key's kind", "secret_kind_mismatch");
    }
    const ref = ownDbRef(tx, row);
    if (!ref) throw badRequest("This key's value cannot be replaced here", "value_unavailable");
    const { kind: _kind, ...material } = body.secret;
    const secret = StoredSecret.parse({ kind: row.kind, ...material });
    await core.secrets.replaceSealed(
      tx,
      ref.secretId,
      JSON.stringify(secret),
      vaultAad(tenantOf(tx).organizationId, row.id),
    );
    // UI-SPEC R3: only a replaced value moves `value_updated_at`.
    patch.valueUpdatedAt = now;
  }
  if (changed.length === 0 && !valueChanged) return getVaultItemDto(tx, row);
  patch.updatedAt = now;
  const [next] = await tx.update(vaultItems).set(patch).where(eq(vaultItems.id, row.id)).returning();
  if (!next) throw itemNotFound();
  if (valueChanged || changed.includes("tokenUrl")) forgetClientCredentialsToken(row.id);
  await core.audit.record(tx, {
    action: "vault_item.updated",
    resourceType: "vault_item",
    resourceId: row.id,
    metadata: { ...itemAudit(next), changed, valueChanged },
  });
  return getVaultItemDto(tx, next);
}

async function getVaultItemDto(tx: Tx, row: VaultItemRow): Promise<VaultItem> {
  return toDto(row, (await grantsOf(tx, [row.id])).get(row.id) ?? []);
}

export async function deleteVaultItem(
  core: Core,
  perms: PermissionService,
  req: FastifyRequest,
  tx: Tx,
  id: string,
): Promise<void> {
  const row = await itemForCaller(perms, req, tx, id);
  // Grants cascade with the row; the sealed value goes with it.
  await tx.delete(vaultItems).where(eq(vaultItems.id, row.id));
  const ref = ownDbRef(tx, row);
  if (ref) await core.secrets.remove(tx, ref.secretId);
  forgetClientCredentialsToken(row.id);
  await core.audit.record(tx, {
    action: "vault_item.deleted",
    resourceType: "vault_item",
    resourceId: row.id,
    metadata: itemAudit(row),
  });
}

/**
 * The bots that may use the item (each still decided per turn). Personal item: its owner grants any bot they can see
 * (`bot.read`; a bot they cannot see is 404). Unit item: `vault.manage` on its unit (checked when loading) and
 * `bot.configure` on every bot. Ids of another organization are not found (resolved in the tenant).
 */
export async function setVaultItemAgents(
  core: Core,
  perms: PermissionService,
  req: FastifyRequest,
  tx: Tx,
  id: string,
  agentIds: readonly string[],
): Promise<VaultItem> {
  const row = await itemForCaller(perms, req, tx, id);
  const caller = authOf(req).userId;
  const wanted = [...new Set(agentIds)];
  for (const agentId of wanted) {
    const bot = await findBot(tx, agentId);
    if (!bot) throw notFound("Bot not found", "agent_not_found");
    const resource = agentResource(await loadBotFacts(tx, bot), caller);
    await perms.assertCan(req, tx, "bot.read", resource, { hideAs404: true });
    if (row.scope === "unit") await perms.assertCan(req, tx, "bot.configure", resource);
  }
  const current = (await grantsOf(tx, [row.id])).get(row.id) ?? [];
  const added = wanted.filter((a) => !current.includes(a));
  const removed = current.filter((a) => !wanted.includes(a));
  if (removed.length > 0) {
    await tx
      .delete(agentVaultGrants)
      .where(and(eq(agentVaultGrants.vaultItemId, row.id), inArray(agentVaultGrants.agentId, removed)));
  }
  if (added.length > 0) {
    await tx.insert(agentVaultGrants).values(
      added.map((agentId) => ({
        organizationId: row.organizationId,
        agentId,
        vaultItemId: row.id,
        createdBy: caller,
      })),
    );
  }
  if (added.length > 0 || removed.length > 0) {
    await core.audit.record(tx, {
      action: "vault_item.agents_changed",
      resourceType: "vault_item",
      resourceId: row.id,
      metadata: { ...itemAudit(row), agentIds: wanted.sort(), added, removed },
    });
  }
  return getVaultItemDto(tx, row);
}

// ---------------------------------------------------------------- use by agents (D-04)

/** A unit's audience (as for unit memory and personas): a member of the unit or below it, a lead on its path, an admin. */
function inUnitAudience(p: PrincipalFacts, unitPath: readonly string[]): boolean {
  if (p.orgRole === "admin") return true;
  const unitId = unitPath[unitPath.length - 1];
  if (unitId !== undefined && p.memberUnitPaths.some((path) => path.includes(unitId))) return true;
  return unitPath.some((u) => p.leadOfUnitIds.has(u));
}

export interface EffectiveVaultItem {
  id: string;
  handle: string;
  name: string;
  scope: VaultScope;
  ownerUserId: string | null;
  allowedHosts: string[];
}

/**
 * The keychain items `agentId` may use on a turn of `humanUserId`: granted to the agent, personal items only of that
 * human, unit items only for the unit's audience, and `vault.use` allowed for the agent acting for the human on the
 * item's unit (a deny rule on either side removes it). The tx must carry `userId` = the human (owner-only RLS).
 */
export async function effectiveVaultItems(
  tx: Tx,
  perms: PermissionService,
  p: { agentId: string; humanUserId: string },
): Promise<EffectiveVaultItem[]> {
  const bot = await findBot(tx, p.agentId);
  if (!bot || bot.status === "disabled") return [];
  const human = await loadPrincipalFacts(tx, { kind: "user", userId: p.humanUserId });
  if (human.deactivated) return [];
  const rows = await tx
    .select({ item: vaultItems })
    .from(agentVaultGrants)
    .innerJoin(vaultItems, eq(vaultItems.id, agentVaultGrants.vaultItemId))
    .where(eq(agentVaultGrants.agentId, p.agentId))
    .orderBy(asc(vaultItems.name), asc(vaultItems.handle));
  const items = rows.map((r) => r.item);
  const paths = await unitPaths(
    tx,
    items.flatMap((i) => (i.unitId ? [i.unitId] : [])),
  );
  const out: EffectiveVaultItem[] = [];
  for (const item of items) {
    if (item.scope === "personal" && item.ownerUserId !== p.humanUserId) continue;
    if (item.scope === "unit" && item.unitId) {
      const path = paths.get(item.unitId);
      if (!path || !inUnitAudience(human, path)) continue;
    }
    const decision = await perms.decide(
      tx,
      { kind: "agent", agentId: p.agentId, onBehalfOfUserId: p.humanUserId },
      "vault.use",
      itemResource(item, paths),
    );
    if (!decision.allowed) continue;
    out.push({
      id: item.id,
      handle: item.handle,
      name: item.name,
      scope: item.scope,
      ownerUserId: item.ownerUserId,
      allowedHosts: item.allowedHosts,
    });
  }
  return out;
}

/**
 * The header the proxy attaches for `item`, and every string it must redact from the response (server-side only:
 * never send any of it to a client, the model or a log). Opens the sealed value with the item's own AAD, so a value
 * moved onto another item does not open; `oauth` items fetch a client-credentials token through the egress guard.
 */
export async function prepareInjection(
  core: Core,
  tx: Tx,
  item: VaultItemRow,
): Promise<{ headerName: string; headerValue: string; secretParts: string[] }> {
  const ref = ownDbRef(tx, item);
  if (!ref) throw new KeychainError("value_unavailable");
  let secret: StoredSecret;
  try {
    const raw = await core.secrets.revealSealed(tx, ref.secretId, vaultAad(item.organizationId, item.id));
    secret = StoredSecret.parse(JSON.parse(raw));
  } catch {
    throw new KeychainError("value_unavailable");
  }
  if (secret.kind !== item.kind) throw new KeychainError("value_unavailable");
  let token: string | undefined;
  if (secret.kind === "oauth") {
    const privateAllow = await privateAllowFor(tx, item);
    ({ token } = await clientCredentialsToken(egressFor(core.env), item, secret, privateAllow));
  }
  const header = buildInjectionHeader(item.kind, item.injection, secret, token);
  return {
    headerName: header.name,
    headerValue: header.value,
    secretParts: secretParts(secret, header.value, token),
  };
}

const METHOD = /^[A-Z]{1,16}$/;

/**
 * Audits one use of a key (`secret.used`) and stamps `last_used_at` when the key was sent: ids, handle, host, method,
 * status, size and duration only, never the value, the path, the query or a body.
 */
export async function recordSecretUsed(
  core: Core,
  tx: Tx,
  e: {
    item: VaultItemRow;
    agentId: string;
    userId: string;
    eventId: string;
    host: string;
    method: string;
    status: number | null;
    bytes: number;
    durationMs: number;
    result: "success" | "denied" | "error";
  },
): Promise<void> {
  // A host only: anything after an authority (path, query, userinfo) is cut away defensively.
  const host = (/^[a-z0-9.[\]:-]{1,260}$/i.exec(e.host.split(/[/?#@\s]/)[0] ?? "")?.[0] ?? "").toLowerCase();
  const method = e.method.toUpperCase();
  await core.audit.record(tx, {
    action: "secret.used",
    resourceType: "vault_item",
    resourceId: e.item.id,
    result: e.result,
    actorKind: "agent",
    actorId: e.agentId,
    agentId: e.agentId,
    userId: e.userId,
    metadata: {
      vaultItemId: e.item.id,
      handle: e.item.handle,
      eventId: e.eventId,
      host,
      method: METHOD.test(method) ? method : "OTHER",
      status: e.status,
      bytes: Math.max(0, Math.trunc(e.bytes)),
      durationMs: Math.max(0, Math.trunc(e.durationMs)),
    },
  });
  if (e.result !== "denied") {
    await tx
      .update(vaultItems)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(vaultItems.id, e.item.id));
  }
}
