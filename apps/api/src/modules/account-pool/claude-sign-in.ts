import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  CLAUDE_SIGN_IN_TTL_S,
  ClaudeSetupToken,
  type ClaudeSignInStart,
  type CompleteClaudeSignInRequest,
  POOL_LIMITS,
  type PoolAccount,
  type StartClaudeSignInRequest,
} from "@ocw/contracts";
import { accountPoolAccounts, type TenantCtx } from "@ocw/db";
import { and, count, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Core } from "../../core";
import { type Egress, egressFor, readCapped } from "../../lib/egress";
import { badRequest, conflict, HttpError, notFound } from "../../lib/errors";
import { addClaudeToken, type PoolPorts, updatePoolAccount } from "./store";

/**
 * "Connect a Claude account" (Phase 07.18-19 R3.1): the API runs what `claude setup-token` runs, so an admin adds a
 * Claude subscription account from Settings with no terminal. The parameters are the ones Claude Code 2.1.331 uses
 * for `setup-token` (read from the installed CLI bundle, cross-checked with the Agent SDK 0.3.282 binary and
 * CLIProxyAPI's `internal/auth/claude/anthropic_auth.go`): the claude.ai authorize page with the manual code page as
 * the redirect, the inference-only scope, PKCE S256 and a state, and a JSON token exchange that asks for a one-year
 * token. CLIProxyAPI's disguise (system prompt, billing header, TLS fingerprint) is not copied.
 *
 * Following ADR-0017's pattern: the verifier and state live only in Redis, 10 minutes, read once with GETDEL and bound
 * to the admin and the organization that started the flow; another admin's or organization's flow reads as missing
 * and stays intact. The exchange goes through the egress guard (`lib/egress.ts`). The token is sealed by the same
 * path as a pasted setup-token (`addClaudeToken` / `updatePoolAccount`), and no response, audit row or log line
 * carries the token, the code, the verifier or the state.
 */

export const CLAUDE_OAUTH = {
  authorizeUrl: "https://claude.com/cai/oauth/authorize",
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  /** The manual redirect: Anthropic's page shows `code#state` for the admin to paste. */
  redirectUri: "https://platform.claude.com/oauth/code/callback",
  /** `setup-token` asks for inference only. */
  scope: "user:inference",
  /** One year, in seconds: the long-lived token `setup-token` requests. */
  expiresIn: 31_536_000,
} as const;

export const claudeSignInKey = (flowId: string) => `ocw:account-pool:claude-sign-in:${flowId}`;

const FlowRecord = z.object({
  organizationId: z.string(),
  userId: z.string(),
  verifier: z.string(),
  state: z.string(),
  /** A token account whose token this sign-in replaces; null adds an account. */
  accountId: z.string().nullable(),
});
type FlowRecord = z.infer<typeof FlowRecord>;

const MESSAGES = {
  expired: "This sign-in expired. Start again.",
  invalid_code:
    "That doesn't look like the code. Copy all of it from Anthropic's page, including the # in the middle.",
  state_mismatch: "That code belongs to another sign-in. Start again and paste the newest code.",
  label_required: "Type a label for the account.",
  code_refused: "Anthropic didn't accept this code. It may have expired or been used already. Start again.",
  unavailable:
    "Anthropic's sign-in isn't answering right now. Try again shortly, or paste a setup-token instead.",
  not_a_token:
    "Anthropic answered with something that isn't a setup-token. Try again, or paste a setup-token instead.",
} as const;

const b64url = (buf: Buffer) => buf.toString("base64url");

/** The setup-token authorize URL, its parameters in the CLI's own order. */
export function claudeAuthorizeUrl(i: { challenge: string; state: string }): string {
  const url = new URL(CLAUDE_OAUTH.authorizeUrl);
  const q = url.searchParams;
  q.append("code", "true");
  q.append("client_id", CLAUDE_OAUTH.clientId);
  q.append("response_type", "code");
  q.append("redirect_uri", CLAUDE_OAUTH.redirectUri);
  q.append("scope", CLAUDE_OAUTH.scope);
  q.append("code_challenge", i.challenge);
  q.append("code_challenge_method", "S256");
  q.append("state", i.state);
  return url.toString();
}

const PART = /^[A-Za-z0-9._~-]{1,2048}$/u;
const REDIRECT = new URL(CLAUDE_OAUTH.redirectUri);

/**
 * What the admin pasted: `code#state` as Anthropic's page shows it, or the address of that page
 * (`https://platform.claude.com/oauth/code/callback?code=…&state=…`). Anything else (a loopback address, a
 * verification code, an API key) is null.
 */
export function parsePastedCode(input: string): { code: string; state: string } | null {
  const text = input.trim();
  if (/^https?:\/\//iu.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    if (url.origin !== REDIRECT.origin || url.pathname !== REDIRECT.pathname) return null;
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? url.hash.replace(/^#/u, "");
    return PART.test(code) && PART.test(state) ? { code, state } : null;
  }
  const parts = text.split("#");
  if (parts.length !== 2) return null;
  const [code = "", state = ""] = parts;
  return PART.test(code) && PART.test(state) ? { code, state } : null;
}

type Exchange =
  | { ok: true; token: string }
  | { ok: false; reason: "refused" | "unavailable" | "not_a_token"; status: number | null };

const TokenResponse = z.object({ access_token: z.string() }).loose();

/**
 * The setup-token code exchange: one POST with a JSON body in the CLI's key order. A 400/401/403 is Anthropic refusing
 * the code; anything else that is not a token is an outage. Never throws a value from the response.
 */
export async function exchangeClaudeCode(
  egress: Egress,
  tokenUrl: string,
  i: { code: string; state: string; verifier: string },
): Promise<Exchange> {
  const body = {
    grant_type: "authorization_code",
    code: i.code,
    redirect_uri: CLAUDE_OAUTH.redirectUri,
    client_id: CLAUDE_OAUTH.clientId,
    code_verifier: i.verifier,
    state: i.state,
    expires_in: CLAUDE_OAUTH.expiresIn,
  };
  let res: Response;
  let text: string;
  try {
    res = await egress.fetch(
      tokenUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/plain, */*" },
        body: JSON.stringify(body),
      },
      { maxBytes: 64 * 1024, timeoutMs: 30_000 },
    );
    text = (await readCapped(res, 64 * 1024)).text;
  } catch {
    // An egress refusal, a timeout or a network error: no detail of the request leaves this function.
    return { ok: false, reason: "unavailable", status: null };
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    return { ok: false, reason: "refused", status: res.status };
  }
  if (res.status !== 200) return { ok: false, reason: "unavailable", status: res.status };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not_a_token", status: res.status };
  }
  const parsed = TokenResponse.safeParse(json);
  const token = parsed.success ? ClaudeSetupToken.safeParse(parsed.data.access_token) : null;
  if (!token?.success) return { ok: false, reason: "not_a_token", status: res.status };
  return { ok: true, token: token.data };
}

export function createClaudeSignIns(core: Core) {
  const redis = core.bus.pub;
  const tokenUrl = core.env.OCW_CLAUDE_OAUTH_TOKEN_URL ?? CLAUDE_OAUTH.tokenUrl;

  /** The admin opens Anthropic's page; nothing secret goes back (the verifier and state stay in Redis). */
  async function start(ctx: TenantCtx, body: StartClaudeSignInRequest): Promise<ClaudeSignInStart> {
    const userId = ctx.userId;
    if (!userId) throw new Error("a Claude sign-in needs an admin");
    const accountId = body.accountId ?? null;
    const flowId = randomUUID();
    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    await core.db.withTenant(ctx, async (tx) => {
      if (accountId) {
        const [row] = await tx
          .select({ kind: accountPoolAccounts.kind })
          .from(accountPoolAccounts)
          .where(and(eq(accountPoolAccounts.id, accountId), isNull(accountPoolAccounts.removedAt)));
        if (!row) throw notFound("Account not found", "account_not_found");
        if (row.kind !== "token") {
          throw conflict("Only a Claude token account has a token to replace.", "wrong_kind");
        }
      } else {
        // The cap, said before the admin signs in (the add checks it again under the pool lock).
        const [live] = await tx
          .select({ n: count() })
          .from(accountPoolAccounts)
          .where(and(eq(accountPoolAccounts.provider, "claude"), isNull(accountPoolAccounts.removedAt)));
        if ((live?.n ?? 0) >= POOL_LIMITS.accountsPerProvider) {
          throw conflict(
            `This pool already has ${POOL_LIMITS.accountsPerProvider} accounts. Remove one before adding another.`,
            "too_many_accounts",
          );
        }
      }
      await core.audit.record(tx, {
        action: "account_pool.sign_in_started",
        resourceType: accountId ? "account_pool_account" : "account_pool",
        resourceId: accountId,
        metadata: { provider: "claude", replacing: accountId !== null },
      });
      const flow: FlowRecord = { organizationId: ctx.organizationId, userId, verifier, state, accountId };
      await redis.set(claudeSignInKey(flowId), JSON.stringify(flow), {
        expiration: { type: "EX", value: CLAUDE_SIGN_IN_TTL_S },
      });
    });
    return {
      flowId,
      authorizeUrl: claudeAuthorizeUrl({ challenge, state }),
      expiresAt: new Date(Date.now() + CLAUDE_SIGN_IN_TTL_S * 1000).toISOString(),
    };
  }

  /** The pasted code: checked, used once, exchanged, and the token sealed by the setup-token path. */
  async function complete(
    ctx: TenantCtx,
    ports: PoolPorts,
    body: CompleteClaudeSignInRequest,
  ): Promise<PoolAccount> {
    const key = claudeSignInKey(body.flowId);
    const missing = () => notFound(MESSAGES.expired, "sign_in_expired");
    const raw = await redis.get(key);
    let flow: FlowRecord | null = null;
    try {
      const parsed = raw ? FlowRecord.safeParse(JSON.parse(raw)) : null;
      flow = parsed?.success ? parsed.data : null;
    } catch {
      flow = null;
    }
    // Another admin's or another organization's flow reads exactly like a missing one, and stays intact.
    if (!flow || flow.organizationId !== ctx.organizationId || flow.userId !== ctx.userId) throw missing();

    // A paste of the wrong text, or a missing label, keeps the flow: no code was presented yet.
    const pasted = parsePastedCode(body.code);
    if (!pasted) throw badRequest(MESSAGES.invalid_code, "invalid_code");
    const target = flow.accountId
      ? ({ kind: "replace", accountId: flow.accountId } as const)
      : body.label
        ? ({ kind: "add", label: body.label } as const)
        : null;
    if (!target) throw badRequest(MESSAGES.label_required, "label_required");

    // Single use from here on (a mismatch may be an attack).
    if (!(await redis.getDel(key))) throw missing();
    if (pasted.state !== flow.state) throw badRequest(MESSAGES.state_mismatch, "state_mismatch");

    const result = await exchangeClaudeCode(egressFor(core.env), tokenUrl, {
      code: pasted.code,
      state: pasted.state,
      verifier: flow.verifier,
    });
    if (!result.ok) {
      core.log.warn(
        { provider: "claude", code: result.reason, status: result.status },
        "claude sign-in code exchange failed",
      );
      if (result.reason === "refused") throw badRequest(MESSAGES.code_refused, "code_refused");
      throw new HttpError(
        502,
        "claude_unavailable",
        result.reason === "not_a_token" ? MESSAGES.not_a_token : MESSAGES.unavailable,
      );
    }

    return core.db.withTenant(ctx, async (tx) => {
      const account =
        target.kind === "replace"
          ? await updatePoolAccount(tx, ports, target.accountId, { token: result.token })
          : await addClaudeToken(tx, ports, { label: target.label, token: result.token });
      await core.audit.record(tx, {
        action: "account_pool.signed_in",
        resourceType: "account_pool_account",
        resourceId: account.id,
        metadata: { provider: "claude", label: account.label, replaced: target.kind === "replace" },
      });
      return account;
    });
  }

  return { start, complete };
}

export type ClaudeSignIns = ReturnType<typeof createClaudeSignIns>;
