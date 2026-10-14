import {
  type AgentChannelHttpMethod,
  AgentChannelHttpRequest,
  AgentChannelHttpResponse,
  type AgentChannelToolRefusal,
  BUILTIN_TOOLS,
  HTTP_TOOL_LIMITS,
  type ToolApprovalRefusal,
  type TurnToolFlags,
} from "@ocw/contracts";
import { agentTurns } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { App, Core } from "../../core";
import { EgressRefusedError, egressFor, readCapped } from "../../lib/egress";
import { HttpError } from "../../lib/errors";
import { audienceOf } from "../ai-chat";
import { currentTurn } from "../bot-capabilities";
import {
  findVaultItemByHandle,
  hostAllowed,
  injectionFor,
  openVaultSecret,
  pathAllowed,
  privateAllowFor,
  recordSecretUsed,
  sanitizeModelHeaders,
  type VaultItemRow,
} from "../keychain";
import type { PermissionService } from "../organization";
import { cellOf } from "./auth";
import { noTrigger } from "./cards";
import { type AgentTurnRow, auditUnknownTurn, claimToolCall, finishToolCall, liveTurn } from "./claim";
import {
  APPROVAL_MESSAGES,
  approvalDetails,
  approvalVerdict,
  type ToolApprovalGate,
  turnAtCap,
} from "./tool-calls";

/**
 * `POST /agent-channel/v1/http-requests` (07.4-11; D-04, D-06, D-07; CONN-05): the cell's `ocw_http_request` sends one
 * request with a keychain key named by its handle. The model never sees the key: the API resolves it for the turn's bot
 * acting for the turn's human (`agent_turns.user_id`, never a body field), injects it towards an allowed host only and
 * redacts it from the answer.
 *
 * Order (refusals before the claim are recorded and audited through `claimToolCall`; nothing calls out in a tx):
 *   1. tx0 (no user): the turn's human, read from the turn ledger; no such turn of this agent → 403 `no_trigger`;
 *   2. tx1, opened AS that human (owner-only RLS on personal keys: never no user, never another member):
 *      the live turn (its human still reads the conversation, else 403 `no_trigger`) → the tool on the turn
 *      (`not_in_turn`) → the turn re-decided now, audience rule included (`policy_changed`) → the key: usable here
 *      (`handle_not_allowed`), a member-account key the audience rule withholds here (`member_account`), or a unit key
 *      some reader here is outside of (`unit_audience`, 07.4-12) → host and
 *      path (`host_not_allowed`) → the approval decision (07.5-11: `approvalForCall` with tool `ocw_http_request` and
 *      `{handle, method, url, headers, body}` as the arguments; 409 `approval_required` … with `details`, never a
 *      secret opened or a request sent before it) → the claim (caps, taint: GET/HEAD read, other methods
 *      side-effecting; a consumed grant lifts the taint condition for this call only) → the sealed value opened with
 *      its own AAD;
 *   3. outside any tx: the header (an `oauth` token through the guard), the request through the egress guard
 *      (pinned public addresses, a personal key never reaches a private one, a unit key only the admin-listed ones,
 *      platform hosts never; no redirects; 256 KB; 15 s);
 *   4. tx2 (as the human): `bot.tool_call.completed` and `secret.used` with ids, handle, host, method, status, size and
 *      duration, never the value, the path, the query or a body.
 * The answer keeps `content-type` only, a redirect's Location as its host, and a textual body with every part of the
 * secret replaced by `[redacted]`.
 */

const tags = ["agent-channel"];
const bearer = [{ cellToken: [] as string[] }];
const TOOL = BUILTIN_TOOLS.httpRequest;
const TIMEOUT_MS = 15_000;
const MAX_BYTES = HTTP_TOOL_LIMITS.responseBodyBytes;
const REDACTED = "[redacted]";

/** GET and HEAD read; every other method may change something on the other side (D-08 taint rule). */
const READ_METHODS: ReadonlySet<AgentChannelHttpMethod> = new Set(["GET", "HEAD"]);
const flagsFor = (method: AgentChannelHttpMethod): TurnToolFlags => ({
  untrustedOutput: true,
  sideEffecting: !READ_METHODS.has(method),
});

type Refusal =
  | Extract<
      AgentChannelToolRefusal,
      | "not_in_turn"
      | "policy_changed"
      | "member_account"
      | "unit_audience"
      | "handle_not_allowed"
      | "host_not_allowed"
      | "cap_reached"
      | "tainted"
    >
  | ToolApprovalRefusal;
type Failure = Extract<AgentChannelToolRefusal, "egress_refused" | "upstream_error" | "timeout">;

const MESSAGES: Record<Refusal | Failure, string> = {
  // First, so this route's own wording of a shared code (`policy_changed`) stays exactly as before.
  ...APPROVAL_MESSAGES,
  not_in_turn: "That tool was not offered on this turn",
  policy_changed: "That tool is no longer available on this turn",
  member_account: "That key belongs to a member's own account and is not used in this conversation",
  unit_audience: "That key belongs to a unit, and people outside that unit read this conversation",
  handle_not_allowed: "That key is not available to this bot for this person",
  host_not_allowed: "That key may not be sent to this address",
  cap_reached: "This turn reached its tool call limit",
  tainted: "This turn read untrusted content and can no longer make changes",
  egress_refused: "The address is not reachable from the workspace",
  upstream_error: "The request failed",
  timeout: "The request timed out",
};

/** Content types whose body is returned to the model as text. */
const TEXTUAL =
  /^(text\/|application\/(json|xml|javascript|ecmascript|x-www-form-urlencoded|x-ndjson|yaml|x-yaml|graphql)\b|application\/[a-z0-9.+-]+\+(json|xml)\b)/i;

/** Every occurrence of every secret part replaced (longest first: `secretParts` is sorted). */
function redact(text: string, parts: readonly string[]): string {
  let out = text;
  for (const part of parts) if (part.length > 0) out = out.split(part).join(REDACTED);
  return out;
}

/** At most `max` UTF-8 bytes, cut on a character boundary. */
function capUtf8(text: string, max: number): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return { text, cut: false };
  let end = max;
  // Step back over continuation bytes so the cut never splits a character.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString("utf8"), cut: true };
}

/** A Location's host only (never its path or query, which could echo a secret). */
function redirectHostOf(location: string | null, base: URL): string | null {
  if (!location) return null;
  try {
    const host = new URL(location, base).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host.length > 0 && host.length <= 253 ? host : null;
  } catch {
    return null;
  }
}

function failureOf(err: unknown): { code: Failure; outcome: "blocked" | "error" } {
  if (err instanceof EgressRefusedError) {
    if (err.code === "timeout") return { code: "timeout", outcome: "error" };
    if (err.code === "network_error" || err.code === "dns_failed" || err.code === "too_large") {
      return { code: "upstream_error", outcome: "error" };
    }
    return { code: "egress_refused", outcome: "blocked" };
  }
  return { code: "upstream_error", outcome: "error" };
}

type Decided =
  | { refused: "no_trigger" }
  | { refused: Refusal; details?: Record<string, unknown> }
  | {
      go: {
        turn: AgentTurnRow;
        item: VaultItemRow;
        callId: string;
        privateAllow: string[];
        secret: Awaited<ReturnType<typeof openVaultSecret>> | null;
      };
    };

export function registerHttpRequestRoutes(
  scope: App,
  core: Core,
  perms: PermissionService,
  toolApproval: ToolApprovalGate,
): void {
  scope.post(
    "/http-requests",
    {
      config: { authz: "cell" as const },
      schema: {
        tags,
        security: bearer,
        body: AgentChannelHttpRequest,
        response: { 200: AgentChannelHttpResponse },
      },
    },
    async (req) => {
      const cell = cellOf(req);
      const body = req.body;
      const url = new URL(body.url);
      // Host (and port) only: never the path or the query.
      const target = url.host.toLowerCase();
      const meta = { handle: body.handle, method: body.method, eventId: body.eventId };

      // 1. The turn's human, from the ledger: no session user is ever taken from the request.
      const humanUserId = await core.db.withTenant(
        { organizationId: cell.organizationId, userId: null },
        async (tx) => {
          const [turn] = await tx
            .select({ agentId: agentTurns.agentId, userId: agentTurns.userId })
            .from(agentTurns)
            .where(eq(agentTurns.eventId, body.eventId));
          if (turn && turn.agentId === body.agentId) return turn.userId;
          await auditUnknownTurn(tx, core, { cell, tool: TOOL, reason: "no_trigger", metadata: meta });
          return null;
        },
      );
      if (!humanUserId) throw noTrigger();

      // 2. Everything decided as that human, in one short transaction without any outbound call.
      const decided = await core.db.withTenant(
        { organizationId: cell.organizationId, userId: humanUserId },
        async (tx): Promise<Decided> => {
          const turn = await liveTurn(tx, core, body);
          if (!turn || turn.userId !== humanUserId) {
            await auditUnknownTurn(tx, core, { cell, tool: TOOL, reason: "no_trigger", metadata: meta });
            return { refused: "no_trigger" };
          }
          const refuse = async (
            reason: Refusal,
            item: VaultItemRow | null = null,
            extra: Record<string, unknown> = {},
          ): Promise<Decided> => {
            await claimToolCall(tx, core, {
              cell,
              turn,
              tool: TOOL,
              flags: flagsFor(body.method),
              web: false,
              sourceKind: "vault",
              sourceId: item?.id ?? null,
              target,
              reason,
              metadata: { ...meta, ...extra },
            });
            return { refused: reason };
          };

          if (!turn.tools.includes(TOOL)) return refuse("not_in_turn");
          const now = await currentTurn(
            tx,
            perms,
            {
              agentId: turn.agentId,
              humanUserId: turn.userId,
              conversationKind: turn.conversationKind,
              conversationId: turn.conversationId,
            },
            core.env,
            turn.conversationKind === "ai_chat" ? await audienceOf(tx, turn.conversationId) : null,
          );
          if (!now.tools.includes(TOOL)) return refuse("policy_changed");

          // Resolved in the cell's organization as the turn's human: another member's personal key is invisible.
          const item = await findVaultItemByHandle(tx, body.handle);
          if (item && now.keys.memberAccount.some((k) => k.id === item.id)) {
            // The member's own key, withheld here by the audience rule (D-03): only their DM, an AI chat nobody else
            // reads, or a conversation they shared it with.
            return refuse("member_account", item);
          }
          if (item && now.keys.unitAudience.some((k) => k.id === item.id)) {
            // A unit's key, withheld here: someone outside that unit reads this conversation (WINDOWS #191).
            return refuse("unit_audience", item);
          }
          const usable = item ? now.keys.usable.find((k) => k.id === item.id) : undefined;
          if (!item || !usable) return refuse("handle_not_allowed");
          if (!hostAllowed(item.allowedHosts, url) || !pathAllowed(item.allowedPathPrefix, url)) {
            return refuse("host_not_allowed", item);
          }

          // 07.5-11 (D-04, APPROVE-01): the approval decision on exactly this request, before the secret is opened or
          // anything is sent. With a rule, the caps first (a consumed grant is never given back).
          if (now.toolFlags[TOOL]?.approval && (await turnAtCap(tx, turn.eventId, false))) {
            return refuse("cap_reached", item);
          }
          const verdict = approvalVerdict(
            await toolApproval.approvalForCall(tx, {
              turn: { eventId: turn.eventId, agentId: turn.agentId },
              tool: TOOL,
              args: {
                handle: body.handle,
                method: body.method,
                url: body.url,
                ...(body.headers !== undefined ? { headers: body.headers } : {}),
                ...(body.body !== undefined ? { body: body.body } : {}),
              },
              toolCallId: null,
              source: { kind: "vault", id: item.id, target },
            }),
          );
          if (verdict.reason) {
            await refuse(verdict.reason, item, verdict.metadata);
            return { refused: verdict.reason, details: approvalDetails(verdict) };
          }

          const claim = await claimToolCall(tx, core, {
            cell,
            turn,
            tool: TOOL,
            flags: flagsFor(body.method),
            web: false,
            sourceKind: "vault",
            sourceId: item.id,
            target,
            reason: null,
            metadata: meta,
            grantApprovalId: verdict.grantApprovalId,
          });
          if (!claim.allowed) return { refused: claim.reason as Refusal };
          const secret = await openVaultSecret(core, tx, item).catch(() => null);
          return {
            go: { turn, item, callId: claim.callId, privateAllow: await privateAllowFor(tx, item), secret },
          };
        },
      );
      if ("refused" in decided) {
        if (decided.refused === "no_trigger") throw noTrigger();
        throw new HttpError(
          409,
          decided.refused,
          MESSAGES[decided.refused],
          "details" in decided ? decided.details : undefined,
        );
      }

      // 3. The request, outside any transaction.
      const { turn, item, callId, privateAllow, secret } = decided.go;
      const started = Date.now();
      let failure: { code: Failure; outcome: "blocked" | "error" } | null = null;
      let answer: AgentChannelHttpResponse | null = null;
      let bytes = 0;
      try {
        if (!secret) throw new Error("value unavailable");
        const injection = await injectionFor(core, item, secret, privateAllow);
        const headers = {
          ...sanitizeModelHeaders(body.headers ?? {}, injection.headerName),
          [injection.headerName]: injection.headerValue,
        };
        const sendsBody = body.body !== undefined && !READ_METHODS.has(body.method);
        const res = await egressFor(core.env).fetch(
          url.href,
          { method: body.method, headers, ...(sendsBody ? { body: body.body } : {}) },
          { privateAllow, requireHttps: true, maxBytes: MAX_BYTES, timeoutMs: TIMEOUT_MS },
        );
        const contentType = res.headers.get("content-type");
        const textual = contentType === null || TEXTUAL.test(contentType);
        let text = "";
        let truncated = false;
        if (body.method !== "HEAD" && textual) {
          ({ text, truncated } = await readCapped(res, MAX_BYTES));
        } else {
          await res.body?.cancel().catch(() => {});
        }
        bytes = Buffer.byteLength(text, "utf8");
        const capped = capUtf8(redact(text, injection.secretParts), MAX_BYTES);
        const shownType =
          contentType === null
            ? null
            : textual
              ? contentType
              : `${contentType.split(";")[0]?.trim() ?? "binary"} (not text: body not returned)`;
        answer = {
          status: res.status,
          contentType:
            shownType === null ? null : capUtf8(redact(shownType, injection.secretParts), 200).text,
          body: capped.text,
          truncated: truncated || capped.cut,
          redirectHost:
            res.status >= 300 && res.status < 400 ? redirectHostOf(res.headers.get("location"), url) : null,
        };
      } catch (err) {
        // Codes only: the error (which may name the request) is never logged or returned.
        failure = failureOf(err);
      }
      const durationMs = Date.now() - started;

      // 4. The outcome, audited without the value, the path, the query or a body.
      await core.db.withTenant({ organizationId: cell.organizationId, userId: humanUserId }, async (tx) => {
        const status = answer?.status ?? null;
        await finishToolCall(tx, core, {
          cell,
          callId,
          status: failure ? failure.outcome : "ok",
          durationMs,
          metadata: { target, method: body.method, httpStatus: status, bytes, reason: failure?.code ?? null },
        });
        await recordSecretUsed(core, tx, {
          item,
          agentId: turn.agentId,
          userId: turn.userId,
          eventId: turn.eventId,
          host: target,
          method: body.method,
          status,
          bytes,
          durationMs,
          result: failure ? (failure.outcome === "blocked" ? "denied" : "error") : "success",
        });
      });
      if (failure || !answer) {
        const code = failure?.code ?? "upstream_error";
        throw new HttpError(502, code, MESSAGES[code]);
      }
      return answer;
    },
  );
}
