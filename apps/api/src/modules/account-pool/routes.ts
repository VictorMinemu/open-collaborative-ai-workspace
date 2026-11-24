import {
  type AccountLogoutPayload,
  AccountPoolPreview,
  AccountPoolView,
  AddClaudeTokenRequest,
  DeviceSignIn,
  Id,
  IdParams,
  Ok,
  PoolAccount,
  PoolPolicy,
  PoolProvider,
  ReorderPoolRequest,
  StartDeviceSignInRequest,
  UpdatePoolAccountRequest,
  UpdatePoolPolicyRequest,
} from "@ocw/contracts";
import { devices, type Tx } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { markDecided } from "../../authz";
import { type App, authOf, type Core, tenant } from "../../core";
import { badRequest, notFound } from "../../lib/errors";
import { type DeviceHub, deviceFacts, loadDeviceAccess } from "../device";
import { createPermissionService } from "../organization";
import { createDeviceSignIns } from "./device-sign-ins";
import { previewAccountSources } from "./preview";
import {
  addClaudeToken,
  loadPoolView,
  type PoolChange,
  type PoolPorts,
  removePoolAccount,
  reorderPool,
  updatePoolAccount,
  updatePoolPolicy,
} from "./store";

const tags = ["account-pool"];

export interface AccountPoolDeps {
  /** The Device Link hub (plan 13 sends slot sign-in and sign-out commands through it). */
  hub?: DeviceHub;
  /**
   * Called once per successful pool write, inside its transaction (plan 14 refreshes the cell; 13 signs a removed slot
   * out on its device). A throw rolls the write back.
   */
  onChange?: (tx: Tx, change: PoolChange) => Promise<void>;
}

/** `ClaudeSetupToken`'s sentence for an Anthropic API key (PD-22): org API keys live in Settings › Models. */
const API_KEY_SENTENCE = "This is an API key. Add it in Settings › Models.";
const API_KEY_PREFIX = "sk-ant-api";

/**
 * Runs after the permission check and before the body schema: an `sk-ant-api…` value answers 400
 * `api_key_not_allowed` (not a generic validation error), and never echoes the value.
 */
async function refuseApiKey(req: FastifyRequest): Promise<void> {
  const body = req.body;
  if (typeof body !== "object" || body === null || !("token" in body)) return;
  const token = (body as { token?: unknown }).token;
  if (typeof token === "string" && token.trim().startsWith(API_KEY_PREFIX)) {
    throw badRequest(API_KEY_SENTENCE, "api_key_not_allowed");
  }
}

const ProviderParams = z.object({ provider: PoolProvider });
const PreviewQuery = z.object({ deviceId: Id });
const DeviceQuery = z.object({ deviceId: Id });

/**
 * Settings › Account pool (Phase 07.18, D-01, D-04, D-10, D-13, PD-19 … PD-22, PD-25, ADR-0044). Every route needs
 * `provider.manage` (admins), decided before the body is read, and answers `cache-control: no-store`. No response
 * carries a token. Another organization's account is not found (RLS in the tenant transaction).
 */
export function registerAccountPoolRoutes(app: App, core: Core, deps: AccountPoolDeps = {}) {
  const perms = createPermissionService(core);
  const auth = [core.identity.requireUser, perms.requirePermission("provider.manage")];
  const admin = { config: { authz: "user" as const }, preValidation: auth };
  /** The routes whose body may carry a setup-token. */
  const adminWithToken = { ...admin, preValidation: [...auth, refuseApiKey] };
  const ports: PoolPorts = {
    audit: core.audit,
    secrets: core.secrets,
    // PD-25: a removed slot is signed out on its device. The command waits in the queue while the device is offline;
    // the row is removed now either way. Then the module's own listener (the cell, plan 14).
    async onChange(tx, change) {
      const row = change.account;
      if (change.reason === "removed" && row?.kind === "device_slot" && row.deviceId && row.slotId) {
        if (!deps.hub) throw new Error("removing a device slot needs the device hub");
        const payload: AccountLogoutPayload = { slotId: row.slotId };
        await deps.hub.enqueue(tx, {
          deviceId: row.deviceId,
          workSessionId: null,
          kind: "account.logout",
          payload,
        });
      }
      await deps.onChange?.(tx, change);
    },
  };
  const signIns = createDeviceSignIns(core, deps.hub);

  /** A device of the caller's organization (RLS: another organization's is not found). */
  const requireDevice = async (req: FastifyRequest, deviceId: string) => {
    const found = await core.db.withTenant(tenant(req), (tx) =>
      tx.select({ id: devices.id }).from(devices).where(eq(devices.id, deviceId)),
    );
    if (found.length === 0) throw notFound("Device not found");
  };

  app.get(
    "/account-pool",
    { ...admin, schema: { tags, response: { 200: AccountPoolView } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), (tx) => loadPoolView(tx, new Date()));
    },
  );

  // D-11, PD-19: any member who may use the device (device.use, decided as createWorkSession decides it) sees what a
  // new session there would run on; no label, id or token. Another organization's or an unusable device: 404.
  app.get(
    "/account-pool/preview",
    {
      config: { authz: "user" },
      preValidation: [core.identity.requireUser],
      schema: { tags, querystring: PreviewQuery, response: { 200: AccountPoolPreview } },
    },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      const userId = authOf(req).userId;
      const answer = await core.db.withTenant(tenant(req), async (tx) => {
        const [d] = await tx.select().from(devices).where(eq(devices.id, req.query.deviceId));
        if (!d) return null;
        const access = await loadDeviceAccess(tx, userId);
        const use = await perms.decide(
          tx,
          { kind: "user", userId },
          "device.use",
          deviceFacts(d, userId, access),
        );
        if (!use.allowed) return null;
        return previewAccountSources(tx, { deviceId: d.id, now: new Date() });
      });
      markDecided(req);
      if (!answer) throw notFound("Device not found");
      return answer;
    },
  );

  app.post(
    "/account-pool/claude/accounts",
    { ...adminWithToken, schema: { tags, body: AddClaudeTokenRequest, response: { 200: PoolAccount } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), (tx) => addClaudeToken(tx, ports, req.body));
    },
  );

  app.patch(
    "/account-pool/accounts/:id",
    {
      ...adminWithToken,
      schema: { tags, params: IdParams, body: UpdatePoolAccountRequest, response: { 200: PoolAccount } },
    },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), (tx) => updatePoolAccount(tx, ports, req.params.id, req.body));
    },
  );

  app.put(
    "/account-pool/:provider/order",
    {
      ...admin,
      schema: { tags, params: ProviderParams, body: ReorderPoolRequest, response: { 200: AccountPoolView } },
    },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), (tx) =>
        reorderPool(tx, ports, req.params.provider, req.body.accountIds),
      );
    },
  );

  app.put(
    "/account-pool/:provider/policy",
    {
      ...admin,
      schema: { tags, params: ProviderParams, body: UpdatePoolPolicyRequest, response: { 200: PoolPolicy } },
    },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), (tx) =>
        updatePoolPolicy(tx, ports, req.params.provider, req.body),
      );
    },
  );

  app.delete(
    "/account-pool/accounts/:id",
    { ...admin, schema: { tags, params: IdParams, response: { 200: Ok } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      await core.db.withTenant(tenant(req), (tx) => removePoolAccount(tx, ports, req.params.id));
      return { ok: true as const };
    },
  );

  // D-10 (07.18-13): ChatGPT accounts signed in on a service device. The device runs Codex's own device-code login; the
  // code is answered here only, to admins, and never put on a stream or in audit.
  app.post(
    "/account-pool/chatgpt/device-sign-ins",
    { ...admin, schema: { tags, body: StartDeviceSignInRequest, response: { 200: DeviceSignIn } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return signIns.start(tenant(req), req.body);
    },
  );

  app.get(
    "/account-pool/chatgpt/device-sign-ins/current",
    { ...admin, schema: { tags, querystring: DeviceQuery, response: { 200: DeviceSignIn.nullable() } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      await requireDevice(req, req.query.deviceId);
      return signIns.status(authOf(req).organizationId, req.query.deviceId);
    },
  );

  app.delete(
    "/account-pool/chatgpt/device-sign-ins/current",
    { ...admin, schema: { tags, querystring: DeviceQuery, response: { 200: DeviceSignIn.nullable() } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      await requireDevice(req, req.query.deviceId);
      return signIns.cancel(tenant(req), req.query.deviceId);
    },
  );
}
