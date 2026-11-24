import {
  AccountPoolView,
  AddClaudeTokenRequest,
  IdParams,
  Ok,
  PoolAccount,
  PoolPolicy,
  PoolProvider,
  ReorderPoolRequest,
  UpdatePoolAccountRequest,
  UpdatePoolPolicyRequest,
} from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { type App, type Core, tenant } from "../../core";
import { badRequest } from "../../lib/errors";
import type { DeviceHub } from "../device";
import { createPermissionService } from "../organization";
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
  const ports: PoolPorts = { audit: core.audit, secrets: core.secrets, onChange: deps.onChange };

  app.get(
    "/account-pool",
    { ...admin, schema: { tags, response: { 200: AccountPoolView } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), (tx) => loadPoolView(tx, new Date()));
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
}
