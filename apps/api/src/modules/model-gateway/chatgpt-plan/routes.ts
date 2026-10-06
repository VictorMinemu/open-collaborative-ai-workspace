import { randomUUID } from "node:crypto";
import {
  ChatgptPlanStatus,
  ChatgptSignInCompleteRequest,
  ChatgptSignInStartRequest,
  ChatgptSignInStartResponse,
} from "@ocw/contracts";
import { aiChatPolicies, type Tx, tenantOf, userModelCredentials } from "@ocw/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { type App, authOf, type Core, tenant } from "../../../core";
import { randomToken } from "../../../lib/crypto";
import { conflict, HttpError, notFound } from "../../../lib/errors";
import { createPermissionService, orgResource } from "../../organization";
import { loadAiChatPolicy } from "../policy";
import { authBaseOf, credentialOf, disconnectCredential, planStatusOf, storeCredential } from "./credentials";
import {
  CHATGPT_SCOPES,
  type Discovery,
  DYNAMIC_CLIENT_ID,
  discovery,
  exchangeCode,
  OAuthError,
  parseRedirect,
  revokeTokens,
  startSignIn,
  validateIdToken,
} from "./oauth";

/** Scopes "Sign in with ChatGPT – ChatGPT plan usage" grants (developers.openai.com/siwc). */
const PLAN_SCOPES = CHATGPT_SCOPES.split(" ");

/** A started sign-in lives this long (single use, bound to the member who started it). */
export const SIGNIN_FLOW_TTL_S = 600;
export const signinFlowKey = (flowId: string) => `ocw:ai:siwc:${flowId}`;

/** Server-side state of one sign-in (Redis only: the verifier, state and nonce never reach the browser). */
const FlowRecord = z.object({
  organizationId: z.string(),
  userId: z.string(),
  verifier: z.string(),
  state: z.string(),
  nonce: z.string(),
  clientId: z.string(),
  redirectUri: z.string(),
  redirectPort: z.number().int(),
});
type FlowRecord = z.infer<typeof FlowRecord>;

const REDIRECT_MESSAGES = {
  signin_cancelled: "The sign-in was cancelled in the ChatGPT window.",
  state_mismatch: "That address belongs to another sign-in. Start again and paste the newest address.",
  invalid_redirect: "Paste the full address that starts with http://127.0.0.1 from the page ChatGPT opened.",
} as const;

const unavailable = () =>
  new HttpError(502, "chatgpt_unavailable", "ChatGPT sign-in is not reachable right now. Try again shortly.");

/**
 * The opaque `ext_agent_host_id` of this deployment's organization: generated once (`urn:uuid:…`) and kept by an
 * insert-or-keep upsert, so concurrent first sign-ins agree on one value.
 */
async function hostIdOf(tx: Tx): Promise<string> {
  const { organizationId } = tenantOf(tx);
  const [row] = await tx
    .insert(aiChatPolicies)
    .values({ organizationId, chatgptHostId: `urn:uuid:${randomUUID()}` })
    .onConflictDoUpdate({
      target: aiChatPolicies.organizationId,
      set: { chatgptHostId: sql`coalesce(${aiChatPolicies.chatgptHostId}, excluded.chatgpt_host_id)` },
    })
    .returning({ hostId: aiChatPolicies.chatgptHostId });
  if (!row?.hostId) throw new Error("host id upsert returned no value");
  return row.hostId;
}

async function discover(core: Core): Promise<Discovery> {
  try {
    return await discovery(authBaseOf(core));
  } catch (err) {
    core.log.warn(
      { provider: "chatgpt_plan", code: err instanceof OAuthError ? err.code : "error" },
      "chatgpt sign-in discovery failed",
    );
    throw unavailable();
  }
}

/**
 * The test seed route exists only in non-production mock mode pointed at a fake ChatGPT API (P-12, T-05-02-07):
 * loadEnv already refuses the override in production, this is the second lock.
 */
export function chatgptPlanSeedEnabled(core: Core): boolean {
  return (
    core.env.NODE_ENV !== "production" &&
    core.env.OCW_MODEL_PROVIDER === "mock" &&
    core.env.OCW_CHATGPT_API_BASE_URL !== null
  );
}

/**
 * A member's own ChatGPT plan sign-in (D-02, 05-05). Every route is keyed by the session user: no route names
 * another member, and no admin path reads or uses a member's tokens (T-05-05-04). The pasted redirect address
 * travels in a POST body only and is never logged (these routes log at `info` at most; Fastify never logs bodies).
 */
export function registerChatgptPlanRoutes(app: App, core: Core): void {
  const perms = createPermissionService(core);
  const redis = core.bus.pub;
  const tags = ["ai-chat"];

  app.get(
    "/me/model-credentials/chatgpt",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags, response: { 200: ChatgptPlanStatus } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        await perms.assertCan(req, tx, "ai_chat.use", orgResource());
        return planStatusOf(await credentialOf(tx, authOf(req).userId), await loadAiChatPolicy(tx));
      }),
  );

  app.post(
    "/me/model-credentials/chatgpt/start",
    {
      config: { authz: "user" },
      logLevel: "info",
      preHandler: core.identity.requireUser,
      schema: { tags, body: ChatgptSignInStartRequest, response: { 200: ChatgptSignInStartResponse } },
    },
    async (req) => {
      const auth = authOf(req);
      return core.db.withTenant(tenant(req), async (tx) => {
        await perms.assertCan(req, tx, "ai_chat.use", orgResource());
        const policy = await loadAiChatPolicy(tx);
        if (!policy.chatgptPlanEnabled)
          throw conflict("Your organization turned off ChatGPT plans in AI chats.", "disabled_by_org");
        const hostId = await hostIdOf(tx);
        const row = await credentialOf(tx, auth.userId);
        const clientId = row?.issuedClientId ?? DYNAMIC_CLIENT_ID;
        const d = await discover(core);
        const s = startSignIn(d, { clientId, hostId, redirectPort: req.body.redirectPort });
        const flowId = randomUUID();
        const flow: FlowRecord = {
          organizationId: auth.organizationId,
          userId: auth.userId,
          verifier: s.verifier,
          state: s.state,
          nonce: s.nonce,
          clientId,
          redirectUri: s.redirectUri,
          redirectPort: req.body.redirectPort,
        };
        await core.audit.record(tx, {
          action: "ai_credential.signin_started",
          resourceType: "user_model_credential",
          resourceId: row?.id ?? null,
          metadata: { provider: "chatgpt_plan", state: planStatusOf(row, policy).state },
        });
        await redis.set(signinFlowKey(flowId), JSON.stringify(flow), {
          expiration: { type: "EX", value: SIGNIN_FLOW_TTL_S },
        });
        return {
          flowId,
          authorizeUrl: s.authorizeUrl,
          expiresAt: new Date(Date.now() + SIGNIN_FLOW_TTL_S * 1000).toISOString(),
        };
      });
    },
  );

  app.post(
    "/me/model-credentials/chatgpt/complete",
    {
      config: { authz: "user" },
      logLevel: "info",
      preHandler: core.identity.requireUser,
      schema: { tags, body: ChatgptSignInCompleteRequest, response: { 200: ChatgptPlanStatus } },
    },
    async (req) => {
      const auth = authOf(req);
      await core.db.withTenant(tenant(req), (tx) => perms.assertCan(req, tx, "ai_chat.use", orgResource()));
      const key = signinFlowKey(req.body.flowId);
      const missing = () => notFound("This sign-in expired. Start again.", "flow_not_found");
      const raw = await redis.get(key);
      const parsedFlow = raw ? FlowRecord.safeParse(JSON.parse(raw)) : null;
      const flow = parsedFlow?.success ? parsedFlow.data : null;
      // Another member's (or another organization's) flow reads exactly like a missing one, and stays intact.
      if (!flow || flow.organizationId !== auth.organizationId || flow.userId !== auth.userId)
        throw missing();

      const redirect = parseRedirect(req.body.redirectUrl, flow);
      // A paste of the wrong text keeps the flow: no code was presented yet.
      if ("error" in redirect && redirect.error === "invalid_redirect")
        throw new HttpError(400, "invalid_redirect", REDIRECT_MESSAGES.invalid_redirect);
      // Single use from here on (a mismatch may be an attack).
      if (!(await redis.getDel(key))) throw missing();
      if ("error" in redirect) throw new HttpError(400, redirect.error, REDIRECT_MESSAGES[redirect.error]);

      let clientId = flow.clientId;
      if (redirect.issuedClientId) {
        // Only a first registration may come back with a new client id; a known member keeps theirs.
        if (flow.clientId !== DYNAMIC_CLIENT_ID && redirect.issuedClientId !== flow.clientId)
          throw new HttpError(400, "invalid_redirect", REDIRECT_MESSAGES.invalid_redirect);
        clientId = redirect.issuedClientId;
      }
      const d = await discover(core);
      let tokens: Awaited<ReturnType<typeof exchangeCode>>;
      try {
        tokens = await exchangeCode(d, {
          code: redirect.code,
          verifier: flow.verifier,
          redirectUri: flow.redirectUri,
          clientId,
        });
      } catch (err) {
        const e = err instanceof OAuthError ? err : null;
        core.log.warn(
          { provider: "chatgpt_plan", code: e?.code ?? "error", status: e?.status ?? null },
          "chatgpt sign-in code exchange failed",
        );
        if (e?.terminal)
          throw new HttpError(400, "signin_failed", "ChatGPT did not accept this sign-in. Start again.");
        throw unavailable();
      }
      if (tokens.clientId && clientId === DYNAMIC_CLIENT_ID) clientId = tokens.clientId;
      if (!tokens.idToken || !tokens.refreshToken) {
        await revokeTokens(d, { token: tokens.refreshToken ?? tokens.accessToken, clientId });
        throw new HttpError(400, "id_token_invalid", "ChatGPT returned an incomplete sign-in. Start again.");
      }
      let identity: Awaited<ReturnType<typeof validateIdToken>>;
      try {
        identity = await validateIdToken(d, tokens.idToken, { audience: clientId, nonce: flow.nonce });
      } catch {
        core.log.warn({ provider: "chatgpt_plan", code: "id_token_invalid" }, "chatgpt sign-in rejected");
        await revokeTokens(d, { token: tokens.refreshToken, clientId });
        throw new HttpError(400, "id_token_invalid", "ChatGPT's sign-in could not be verified. Start again.");
      }
      const refreshToken = tokens.refreshToken;
      const scopes = tokens.scopes ?? PLAN_SCOPES;
      try {
        return await core.db.withTenant(tenant(req), async (tx) => {
          const policy = await loadAiChatPolicy(tx);
          if (!policy.chatgptPlanEnabled)
            throw conflict("Your organization turned off ChatGPT plans in AI chats.", "disabled_by_org");
          const row = await storeCredential(
            tx,
            core,
            auth.userId,
            {
              accessToken: tokens.accessToken,
              refreshToken,
              expiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
              clientId,
            },
            {
              issuedClientId: clientId === DYNAMIC_CLIENT_ID ? null : clientId,
              subject: identity.subject,
              email: identity.email,
              planType: identity.planType,
              scopes,
            },
          );
          await core.audit.record(tx, {
            action: "ai_credential.connected",
            resourceType: "user_model_credential",
            resourceId: row.id,
            metadata: { provider: "chatgpt_plan", state: row.status },
          });
          return planStatusOf(row, policy);
        });
      } catch (err) {
        // Nothing was stored: do not leave a live grant behind at OpenAI.
        await revokeTokens(d, { token: refreshToken, clientId });
        throw err;
      }
    },
  );

  // The one-time welcome after connecting (OpenAI UI rules, 05-07): the caller's own row only, idempotent (the first
  // time stays). Without a connection nothing is written and the status is returned as it is.
  app.post(
    "/me/model-credentials/chatgpt/welcome-seen",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags, response: { 200: ChatgptPlanStatus } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        await perms.assertCan(req, tx, "ai_chat.use", orgResource());
        const userId = authOf(req).userId;
        await tx
          .update(userModelCredentials)
          .set({ welcomeSeenAt: new Date().toISOString() })
          .where(
            and(
              eq(userModelCredentials.userId, userId),
              eq(userModelCredentials.provider, "chatgpt_plan"),
              isNull(userModelCredentials.welcomeSeenAt),
            ),
          );
        return planStatusOf(await credentialOf(tx, userId), await loadAiChatPolicy(tx));
      }),
  );

  app.delete(
    "/me/model-credentials/chatgpt",
    {
      config: { authz: "user" },
      logLevel: "info",
      preHandler: core.identity.requireUser,
      schema: { tags, response: { 200: ChatgptPlanStatus } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        await perms.assertCan(req, tx, "ai_chat.use", orgResource());
        await disconnectCredential(tx, core, authOf(req).userId);
        return planStatusOf(null, await loadAiChatPolicy(tx));
      }),
  );

  if (!chatgptPlanSeedEnabled(core)) return;

  // TEST-ONLY (P-12): connects the caller's own plan with fake tokens the fake Responses API accepts.
  app.post(
    "/test/ai/chatgpt-plan",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: {
        hide: true,
        tags: ["test"],
        body: z.object({ planType: z.string().max(40).optional() }).optional(),
        response: { 200: ChatgptPlanStatus },
      },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        await perms.assertCan(req, tx, "ai_chat.use", orgResource());
        const auth = authOf(req);
        const row = await storeCredential(
          tx,
          core,
          auth.userId,
          {
            accessToken: `fake-plan-${auth.userId}-${randomToken(12)}`,
            refreshToken: `fake-refresh-${randomToken(12)}`,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            clientId: "oaiapp_fake",
          },
          {
            issuedClientId: "oaiapp_fake",
            subject: `fake-sub-${auth.userId}`,
            email: auth.email,
            planType: req.body?.planType ?? "plus",
            scopes: PLAN_SCOPES,
          },
        );
        await core.audit.record(tx, {
          action: "ai_credential.connected",
          resourceType: "user_model_credential",
          resourceId: row.id,
          metadata: { provider: "chatgpt_plan", source: "test_seed" },
        });
        return planStatusOf(row, await loadAiChatPolicy(tx));
      }),
  );
}
