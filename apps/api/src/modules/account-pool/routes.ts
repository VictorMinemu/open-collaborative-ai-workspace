import { randomUUID } from "node:crypto";
import { AccountPoolView, AddClaudeTokenRequest, PoolAccount } from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import type { FastifyRequest } from "fastify";
import { type App, type Core, tenant } from "../../core";
import { badRequest } from "../../lib/errors";
import type { DeviceHub } from "../device";
import { createPermissionService } from "../organization";
import { insertPoolAccount, loadPoolView, type PoolChange, toPoolAccount } from "./store";
import { sealPoolToken } from "./tokens";

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

/**
 * Settings › Account pool (Phase 07.18, D-01, D-10, D-13, PD-19 … PD-22, ADR-0044). Every route needs
 * `provider.manage` (admins), decided before the body is read, and answers `cache-control: no-store`. No response
 * carries a token.
 */
export function registerAccountPoolRoutes(app: App, core: Core, deps: AccountPoolDeps = {}) {
  const perms = createPermissionService(core);
  const admin = {
    config: { authz: "user" as const },
    preValidation: [core.identity.requireUser, perms.requirePermission("provider.manage")],
  };
  const ports = { audit: core.audit, secrets: core.secrets, onChange: deps.onChange };

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
    {
      ...admin,
      preValidation: [...admin.preValidation, refuseApiKey],
      schema: { tags, body: AddClaudeTokenRequest, response: { 200: PoolAccount } },
    },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      const body = req.body;
      return core.db.withTenant(tenant(req), async (tx) => {
        // The id exists before the token is sealed, so the AAD binds the ciphertext to this one account (PD-21).
        const id = randomUUID();
        const secretId = await sealPoolToken(tx, ports.secrets, id, body.token);
        const row = await insertPoolAccount(tx, ports.audit, {
          id,
          provider: "claude",
          kind: "token",
          label: body.label,
          secretId,
        });
        await ports.onChange?.(tx, { provider: "claude", reason: "added", account: row });
        return toPoolAccount(row, new Map(), new Date());
      });
    },
  );
}
