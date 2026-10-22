import {
  AgentChannelBrowserAct,
  AgentChannelBrowserActResponse,
  AgentChannelBrowserClose,
  AgentChannelBrowserCloseResponse,
  AgentChannelBrowserOpen,
  AgentChannelBrowserOpenResponse,
  AgentChannelBrowserScreenshot,
  AgentChannelBrowserScreenshotResponse,
  AgentChannelBrowserSignIn,
  AgentChannelBrowserSignInResponse,
  AgentChannelBrowserSnapshot,
  AgentChannelBrowserSnapshotResponse,
  AgentChannelBrowserWait,
  AgentChannelBrowserWaitResponse,
  BROWSER_LIMITS,
  BROWSER_REFUSAL_STATUS,
  type BrowserDownload,
  type BrowserRefusal,
  type BrowserSandboxMode,
  type BrowserToolName,
  BUILTIN_TOOLS,
  canonicalJson,
  modelAcceptsImages,
  REDACTED_VALUE,
  type SandboxdErrorCode,
  type SandboxdTarget,
  type SandboxRuntime,
  SiteHost,
  SnapshotRef,
  TOOL_APPROVAL_LIMITS,
  type TurnToolFlags,
} from "@ocw/contracts";
import { agents, agentTurns, type Tx, withSavepoint } from "@ocw/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { App, Core } from "../../core";
import { HttpError } from "../../lib/errors";
import { audienceOf } from "../ai-chat";
import { createObjectStorage } from "../artifact";
import {
  crossSiteFor,
  memberAccountAllowed,
  memberAccountFacts,
  recordMemberData,
  stickyMemberData,
} from "../bot-capabilities";
import {
  auditClosed,
  type BrowserContextRecord,
  closeContext,
  closeOrganizationContexts,
  contextFor,
  holdContext,
  hostOf,
  type LoadedContext,
  type LoadedSession,
  loadSessionFor,
  openContextOf,
  type RoutedDownload,
  releaseHold,
  requestSignIn,
  resealSession,
  routeDownload,
  sessionLoadedFor,
  takeoverActive,
  updateHost,
  validHost,
} from "../browser";
import type { PermissionService } from "../organization";
import {
  markState,
  pushPolicy,
  type SandboxdClient,
  SandboxdRefusedError,
  sandboxAvailable,
} from "../sandbox";
import { usableGrantArgs } from "../tool-approval";
import { downloadStep, recordStep, type StepOutcomeInput, stepFor } from "./activity";
import { type CellPrincipal, cellOf } from "./auth";
import { noTrigger } from "./cards";
import { type AgentTurnRow, auditUnknownTurn, liveTurn } from "./claim";
import {
  type ConfinedCallRefusal,
  containerStateAfter,
  decideSandboxCall,
  finishSandboxCall,
  refusedOutcome,
  refuseSandboxCall,
  type SandboxCallDeps,
  type SandboxCallRefusal,
  type SandboxDecision,
  sandboxRefusal,
  turnHumanOf,
  WAITING,
  waitingRoute,
} from "./sandbox";
import { approvalDetails, approvalVerdict, type ToolApprovalGate } from "./tool-calls";

/**
 * The bots' browser routes of the Agent Channel (07.8-14; BRW-01, BRW-03, SBX-04; D-05, D-07, D-09, D-11, D-12, D-13;
 * P-04, P-06, P-10, P-18; R2, R8, R9): `POST /agent-channel/v1/browser/{open,snapshot,act,screenshot,wait,close}`.
 * Every call is decided by the same `decideSandboxCall` as the sandbox (kind `browser`: the resolver's `browser.use` for
 * agent ∩ human, the organization switch, the kill switch, the bot's `capabilities.browser`, the tool on the delivered
 * turn, the shared 40-call budget, the organization's browser cap, 07.5 approvals) before sandboxd sees it.
 *
 * Order of one call (nothing calls out inside a transaction):
 *   1. tx0 (no user): the turn's human (`turnHumanOf`, 403 `no_trigger`);
 *   2. txA AS that human: the live turn, the context of (bot, conversation, member), and whether the browser is
 *      available now. Only when it is: no context → 404 `no_context`; a person's takeover lease → 409 `paused` (no budget
 *      used); for `act` on a ref, one internal snapshot (outside any transaction) reads the element's role and name, and
 *      a ref that is gone is 409 `element_gone` (a grant waiting for it stays unused: "Not used");
 *   3. tx1 AS the human: `decideSandboxCall` with the canonical arguments, the act's per-call flag class (side-effecting
 *      only while a member session is loaded for the page, F-7) and the member-session approval floor (signed-in act;
 *      D-13 open; decided by the requester alone, never by a policy's admins or leads: `withFloor`, ADR-0029), the
 *      context created for a first `open` (host only), the page held while an approval waits (U-5), and the step;
 *   4. outside any transaction: sandboxd (`browserEnsure` first when the bot's browser is not running, after pushing the
 *      organization's policy so a restarted broker never runs on defaults);
 *   5. tx2 AS the human: the context's host, the ledger row, the host-only outcome audit and the step's outcome. A
 *      `paused` answer (a takeover started meanwhile) gives the budget back.
 *
 * Snapshots go through the API's second pass (P-10): a node flagged `redacted` whose value is not exactly `[redacted]`
 * is replaced and an incident is recorded with ids only, and the text the model reads is composed here from the passed
 * nodes, so a broker or agent bug cannot leak a password. Audit rows, the ledger, logs and the activity carry hosts,
 * ids, actions and codes only: never a URL path or query, page text, typed text or a screenshot.
 */

const tags = ["agent-channel"];
const bearer = [{ cellToken: [] as string[] }];

const OPEN = BUILTIN_TOOLS.browserOpen;
const SNAPSHOT = BUILTIN_TOOLS.browserSnapshot;
const ACT = BUILTIN_TOOLS.browserAct;
const SCREENSHOT = BUILTIN_TOOLS.browserScreenshot;
const WAIT = BUILTIN_TOOLS.browserWait;
const CLOSE = BUILTIN_TOOLS.browserClose;
const SIGNIN = BUILTIN_TOOLS.browserSignIn;

const VIEWPORT = { width: BROWSER_LIMITS.expandedWidth, height: BROWSER_LIMITS.expandedHeight };
/** The page is held this long while an approval waits (U-5), and the approval expires with it (R8). */
const HOLD_MS = BROWSER_LIMITS.holdMinutes * 60_000;
const PENDING_TTL_MS = TOOL_APPROVAL_LIMITS.browserPendingTtlMs;
const ENSURE_TIMEOUT_MS = 60_000;
const OP_TIMEOUT_MS = 30_000;
/** How much longer than a wait the API waits for sandboxd's answer. */
const WAIT_MARGIN_MS = 15_000;
const DEFAULT_WAIT_MS = 30_000;
const SNAPSHOT_TEXT_MAX = 32_000;
/** sandboxd's key names (`SandboxdContextAct.key`): checked before the decision, so a bad key is never counted. */
const KEY_RE = /^[A-Za-z0-9+]{1,32}$/;

/** Codes only the browser has (the shared ones read as the sandbox's). */
const BROWSER_MESSAGES: Partial<Record<ConfinedCallRefusal, string>> = {
  sandbox_off: "Sandbox & Browser is off for this organization",
  bot_off: "The browser is off for this bot",
  not_allowed: "This bot may not use its browser for this person",
  killed: "An admin stopped every sandbox and browser of this organization",
  cap_reached: "The organization runs as many browsers as it allows",
  paused: "A person is in control of this browser",
  no_context: "There is no open page: open one first",
  element_gone: "That element is no longer on the page: take a new snapshot",
  navigation_refused: "That page is outside what this browser may open",
  screenshot_unavailable: "Screenshots are not available for this bot",
  signin_not_allowed: "Sign-in is not available here",
  signin_pending: "A sign-in is already waiting",
  service_unavailable: "The browser service is not available",
  timeout: "The browser did not answer in time",
};

/** A refusal as the HTTP error the plugin reads: `BROWSER_REFUSAL_STATUS` where the browser names it. */
export function browserRefusal(code: ConfinedCallRefusal, details?: Record<string, unknown>): HttpError {
  const base = code in BROWSER_REFUSAL_STATUS ? null : sandboxRefusal(code as SandboxCallRefusal, details);
  const status = base ? base.statusCode : BROWSER_REFUSAL_STATUS[code as BrowserRefusal];
  const message =
    BROWSER_MESSAGES[code] ?? base?.message ?? sandboxRefusal(code as SandboxCallRefusal).message;
  return new HttpError(status, code, message, details);
}

/** A refusal the API reaches itself around sandboxd's answer. */
class LocalRefusal extends Error {
  constructor(readonly code: ConfinedCallRefusal) {
    super(code);
    this.name = "LocalRefusal";
  }
}

/** sandboxd's refusal of a decided browser call → the bot's code (anything unexpected is the service failing). */
function refusalOfSandboxd(code: SandboxdErrorCode): ConfinedCallRefusal {
  switch (code) {
    case "paused":
    case "no_context":
    case "element_gone":
    case "navigation_refused":
    case "killed":
    case "timeout":
    case "busy":
    case "too_large":
    case "not_found":
      return code;
    case "limit_reached":
      return "cap_reached";
    default:
      return "service_unavailable";
  }
}

function failureOf(err: unknown): ConfinedCallRefusal {
  if (err instanceof LocalRefusal) return err.code;
  if (err instanceof SandboxdRefusedError) return refusalOfSandboxd(err.code);
  return "service_unavailable";
}

// ---------------------------------------------------------------- the second pass (P-10)

const LooseNode = z.object({
  ref: SnapshotRef,
  role: z.string().min(1).max(64),
  name: z.string().max(200),
  value: z.string().max(2000).nullable(),
  redacted: z.boolean(),
  depth: z.number().int().min(0).max(256),
});
/** sandboxd's snapshot WITHOUT the contract's redaction refinement: the API decides a leaked value itself. */
const LooseSnapshot = z.object({
  host: z.string().min(1).max(260),
  title: z.string().max(200),
  nodes: z.array(LooseNode).max(600),
  text: z.string().max(SNAPSHOT_TEXT_MAX),
  truncated: z.boolean(),
});
type LooseSnapshot = z.infer<typeof LooseSnapshot>;
type Node = z.infer<typeof LooseNode>;

/** One node as the agent's serializer writes it (`infra/sandbox/browser/redact.mjs` `line`). */
function lineOf(n: Node): string {
  const indent = "  ".repeat(Math.min(n.depth, 40));
  const name = n.name ? ` ${JSON.stringify(n.name)}` : "";
  const value = n.redacted ? ` = ${REDACTED_VALUE}` : n.value !== null ? ` = ${JSON.stringify(n.value)}` : "";
  return `${indent}- [${n.ref}] ${n.role}${name}${value}`;
}

export interface PassedSnapshot {
  host: string;
  title: string;
  nodes: Node[];
  text: string;
  truncated: boolean;
  /** Nodes flagged `redacted` that carried another value (each replaced by `[redacted]`). */
  leaked: number;
}

/**
 * The API's second pass over a snapshot (D-07, P-10, T-07.8-14-02). A node flagged `redacted` whose value is not
 * exactly `[redacted]` gets `[redacted]`, and every other occurrence of that value in names, values and the title is
 * replaced too. The text the model reads is composed from the passed nodes only (sandboxd's own text is never
 * forwarded), at most 32,000 characters. Pure.
 */
export function secondPass(s: LooseSnapshot): PassedSnapshot {
  let leaked = 0;
  const secrets: string[] = [];
  let nodes = s.nodes.map((n) => {
    if (n.redacted && n.value !== REDACTED_VALUE) {
      leaked += 1;
      if (n.value && n.value.length >= 4) secrets.push(n.value);
      return { ...n, value: REDACTED_VALUE };
    }
    return n;
  });
  const scrub = (v: string) => secrets.reduce((acc, secret) => acc.split(secret).join(REDACTED_VALUE), v);
  if (secrets.length > 0) {
    nodes = nodes.map((n) => ({
      ...n,
      name: scrub(n.name).slice(0, 200),
      value: n.value === null || n.redacted ? n.value : scrub(n.value),
    }));
  }
  let text = "";
  let truncated = s.truncated;
  for (const n of nodes) {
    const line = lineOf(n);
    if (text.length + line.length + 1 > SNAPSHOT_TEXT_MAX) {
      truncated = true;
      break;
    }
    text += text ? `\n${line}` : line;
  }
  return { host: s.host, title: scrub(s.title).slice(0, 200), nodes, text, truncated, leaked };
}

/**
 * A snapshot read raw from sandboxd (the generic client's byte stream of the op) and parsed WITHOUT the redaction
 * refinement, so the API's own second pass, not a parse failure, decides what a leaked value becomes.
 */
async function rawSnapshot(client: SandboxdClient, target: SandboxdTarget, contextId: string) {
  const body = await client.stream("contextSnapshot", { target, contextId }, { timeoutMs: OP_TIMEOUT_MS });
  let json: unknown;
  try {
    json = JSON.parse(await new Response(body).text());
  } catch {
    throw new LocalRefusal("service_unavailable");
  }
  const parsed = LooseSnapshot.safeParse(json);
  if (!parsed.success) throw new LocalRefusal("service_unavailable");
  return parsed.data;
}

// ---------------------------------------------------------------- the shared steps of one call

interface BrowserDeps {
  perms: Pick<PermissionService, "decide">;
  toolApproval: ToolApprovalGate;
  client: SandboxdClient | null;
}

interface TurnBody {
  eventId: string;
  agentId: string;
}

interface Begun {
  body: TurnBody;
  cell: CellPrincipal;
  tenant: { organizationId: string; userId: string };
  callDeps: SandboxCallDeps;
  turn: AgentTurnRow;
  context: LoadedContext | null;
  /** The browser is available for this bot and human now (the decision says it again, and records it). */
  available: boolean;
  /** The bot's model reads images (D-14). */
  images: boolean;
}

const tripleOf = (turn: AgentTurnRow) => ({
  agentId: turn.agentId,
  conversationId: turn.conversationId,
  userId: turn.userId,
});

/** Steps 1 and 2: the turn's human, the live turn, the context and the availability (read only). */
async function begin(
  core: Core,
  deps: BrowserDeps,
  cell: CellPrincipal,
  body: TurnBody,
  tool: BrowserToolName,
): Promise<Begun> {
  const human = await turnHumanOf(core, cell, { ...body, tool });
  const tenant = { organizationId: cell.organizationId, userId: human };
  const read = await core.db.withTenant(tenant, async (tx) => {
    const turn = await liveTurn(tx, core, body);
    if (!turn || turn.userId !== human) {
      await auditUnknownTurn(tx, core, {
        cell,
        tool,
        reason: "no_trigger",
        metadata: { eventId: body.eventId },
      });
      return null;
    }
    const context = await openContextOf(tx, tripleOf(turn));
    const available = await sandboxAvailable(
      tx,
      deps.perms,
      { agentId: turn.agentId, userId: turn.userId },
      "browser",
    );
    const [bot] = await tx
      .select({ provider: agents.modelProvider, modelId: agents.modelId })
      .from(agents)
      .where(eq(agents.id, turn.agentId))
      .limit(1);
    return {
      turn,
      context,
      available: available.ok,
      images: !!bot && modelAcceptsImages(bot.provider, bot.modelId),
    };
  });
  if (!read) throw noTrigger();
  return {
    body,
    cell,
    tenant,
    callDeps: {
      core,
      perms: deps.perms,
      toolApproval: deps.toolApproval,
      configured: deps.client !== null,
      cell,
    },
    ...read,
  };
}

/** The step options of a call on a context: its id and whether the requester's session is loaded for the page. */
const stepOpts = (context: LoadedContext | null, host: string | null) => ({
  contextId: context?.id ?? null,
  signedIn: context ? sessionLoadedFor(context, host) : false,
});

/** A refusal before the decision: recorded as a denied call with its blocked step (never counted), then thrown. */
async function refuseEarly(
  core: Core,
  b: Begun,
  tool: BrowserToolName,
  reason: ConfinedCallRefusal,
  stepInput: Record<string, unknown>,
): Promise<never> {
  await core.db.withTenant(b.tenant, async (tx) => {
    await refuseSandboxCall(tx, b.callDeps, { turn: b.turn, tool, reason, kind: "browser" });
    await recordStep(tx, core, {
      turn: b.turn,
      step: stepFor(
        tool,
        stepInput,
        { kind: "blocked", code: reason },
        stepOpts(b.context, b.context?.host ?? null),
      ),
    });
  });
  throw browserRefusal(reason);
}

/**
 * A turn that operates a context with a member's session has member data (D-13, P-11): never cleared. Since 07.8-28
 * (WINDOWS #292) the pair (bot, conversation) keeps it too, with the session's site: every later turn of this bot in
 * this conversation starts with member data (`turnPolicy`).
 */
async function markMemberData(tx: Tx, turn: AgentTurnRow, site: string | null): Promise<AgentTurnRow> {
  await recordMemberData(tx, {
    agentId: turn.agentId,
    conversationId: turn.conversationId,
    eventId: turn.eventId,
    site,
  });
  if (turn.memberData) return turn;
  await tx
    .update(agentTurns)
    .set({ memberData: true })
    .where(and(eq(agentTurns.eventId, turn.eventId), eq(agentTurns.memberData, false)));
  return { ...turn, memberData: true };
}

/** A `paused` answer (a takeover started after the decision): the call did not happen, the budget is given back. */
async function refund(tx: Tx, eventId: string): Promise<void> {
  await tx
    .update(agentTurns)
    .set({ sandboxCalls: sql`greatest(${agentTurns.sandboxCalls} - 1, 0)` })
    .where(eq(agentTurns.eventId, eventId));
}

/**
 * D-13 (P-18): the canonical arguments of an approved, unused grant that lets exactly this action (the same
 * arguments) reach another host once (`navigateTo`), or null. The hash in `approvalForCall` still decides.
 */
async function crossSiteGrant(
  tx: Tx,
  turn: AgentTurnRow,
  tool: BrowserToolName,
  base: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const want = canonicalJson(base);
  for (const args of await usableGrantArgs(tx, {
    agentId: turn.agentId,
    requestedForUserId: turn.userId,
    conversationId: turn.conversationId,
    tool,
  })) {
    if (typeof args.navigateTo !== "string") continue;
    const { navigateTo: _host, ...rest } = args;
    if (canonicalJson(rest) === want) return args;
  }
  return null;
}

interface Prepared<X> {
  args: Record<string, unknown>;
  stepInput: Record<string, unknown>;
  flags?: TurnToolFlags;
  approval: { floor?: "always"; pendingTtlMs: number };
  context: LoadedContext | null;
  /** The page the step names. */
  host: string | null;
  extra: X;
}

interface Decided<X> {
  turn: AgentTurnRow;
  decision: Extract<SandboxDecision, { ok: true }>;
  context: LoadedContext;
  created: boolean;
  stepId: string;
  prepared: Prepared<X>;
  /** 07.8-21: the member's sealed state loaded into the new page (in memory only, for `contextOpen`). */
  loaded: LoadedSession | null;
  /** 07.8-21: the page without a session that the new signed-in page replaced (closed in sandboxd too). */
  replaced: BrowserContextRecord | null;
}

/**
 * Step 3, the decision transaction: `prepare` computes the canonical arguments and the floor from the live rows, then
 * `decideSandboxCall`. A first `open` creates its context here; a call that waits for a person holds the page (U-5);
 * the kill switch ends the organization's open contexts. Throws the refusal after the commit (and after telling sandboxd
 * to hold the page).
 */
async function decide<X>(
  core: Core,
  deps: BrowserDeps,
  b: Begun,
  tool: BrowserToolName,
  prepare: (tx: Tx, turn: AgentTurnRow) => Promise<Prepared<X>>,
  opts: {
    create?: {
      host: string;
      secure: boolean;
      /**
       * 07.8-21 (D-08, D-13): the member's sealed session for the page's host, opened in this transaction AS the member
       * once the call is allowed (`loadSessionFor`, under the member-account rule). A page without a session is
       * replaced by a new one that loads it; `member_data` is set in this same transaction.
       */
      session?: (tx: Tx, turn: AgentTurnRow, context: LoadedContext | null) => Promise<LoadedSession | null>;
    };
  } = {},
): Promise<Decided<X>> {
  const out = await core.db.withTenant(b.tenant, async (tx) => {
    const live = await liveTurn(tx, core, b.body);
    if (!live || live.userId !== b.tenant.userId) {
      await auditUnknownTurn(tx, core, {
        cell: b.cell,
        tool,
        reason: "no_trigger",
        metadata: { eventId: b.body.eventId },
      });
      return null;
    }
    const prepared = await prepare(tx, live);
    const turn = prepared.context?.sessionId
      ? await markMemberData(tx, live, prepared.context.sessionSite)
      : live;
    // The page closed after the precheck (a crash, the bot's own close in a parallel call): refused before the claim,
    // so the budget is not used for a call that cannot run.
    const decision: SandboxDecision =
      !prepared.context && !opts.create && b.available
        ? await refuseSandboxCall(tx, b.callDeps, { turn, tool, reason: "no_context", kind: "browser" })
        : await decideSandboxCall(tx, b.callDeps, {
            turn,
            tool,
            args: prepared.args,
            toolCallId: null,
            kind: "browser",
            ...(prepared.flags ? { flags: prepared.flags } : {}),
            approval: prepared.approval,
          });
    let context = prepared.context;
    let created = false;
    let held = false;
    let loaded: LoadedSession | null = null;
    let replaced: BrowserContextRecord | null = null;
    let turnNow = turn;
    if (decision.ok && opts.create?.session && !context?.sessionId) {
      loaded = await opts.create.session(tx, turn, context);
      if (loaded && context) {
        // The page open without the member's session is replaced by one that loads it (a new sandboxd context).
        replaced = await closeContext(tx, context.id, "closed_by_bot");
        if (replaced) await auditClosed(tx, core, replaced, "closed_by_bot", { replaced: true });
        context = null;
      }
    }
    if (decision.ok && !context && opts.create) {
      const made = await contextFor(tx, {
        turn,
        host: opts.create.host,
        secure: opts.create.secure,
        session: loaded ? { id: loaded.sessionId, siteKey: loaded.siteKey } : null,
      });
      if (!made) throw browserRefusal("no_trigger");
      context = made.context;
      created = made.created;
      if (loaded && created) {
        // D-13 in the same transaction as the load: from now on this turn has member data.
        turnNow = await markMemberData(tx, turn, loaded.siteKey);
        await core.audit.record(tx, {
          action: "browser_session.used",
          actorKind: "agent",
          actorId: turn.agentId,
          agentId: turn.agentId,
          userId: turn.userId,
          resourceType: "browser_session",
          resourceId: loaded.sessionId,
          metadata: {
            sessionId: loaded.sessionId,
            agentId: turn.agentId,
            site: loaded.siteKey,
            contextId: context.id,
            eventId: turn.eventId,
          },
        });
      } else if (loaded) {
        loaded = null;
      }
    }
    if (!decision.ok && WAITING.has(decision.reason) && context) {
      await holdContext(tx, context.id, Date.now() + HOLD_MS);
      held = true;
    }
    if (!decision.ok && decision.reason === "killed") await closeOrganizationContextsAudited(tx, core);
    const step = stepFor(
      tool,
      prepared.stepInput,
      decision.ok ? { kind: "running" } : refusedOutcome(decision.reason, await waitingRoute(tx, decision)),
      stepOpts(context, prepared.host),
    );
    await recordStep(tx, core, { turn: turnNow, step, inFlight: decision.ok });
    return { turn: turnNow, decision, context, created, held, stepId: step.id, prepared, loaded, replaced };
  });
  if (!out) throw noTrigger();
  if (out.held && out.context && deps.client) {
    await holdInSandboxd(
      core,
      deps.client,
      { orgId: b.cell.organizationId, agentId: out.turn.agentId },
      out.context.id,
    );
  }
  if (!out.decision.ok) throw browserRefusal(out.decision.reason, out.decision.details);
  if (!out.context) throw browserRefusal("no_context");
  return {
    turn: out.turn,
    decision: out.decision,
    context: out.context,
    created: out.created,
    stepId: out.stepId,
    prepared: out.prepared,
    loaded: out.loaded,
    replaced: out.replaced,
  };
}

/** The kill switch ends every open context of the organization (`kill_switch`), each audited. */
async function closeOrganizationContextsAudited(tx: Tx, core: Core): Promise<void> {
  const rows: BrowserContextRecord[] = await closeOrganizationContexts(tx, "kill_switch");
  for (const row of rows) await auditClosed(tx, core, row, "kill_switch");
}

/** sandboxd keeps the page open while a person decides (best effort: the API's hold is the record). */
async function holdInSandboxd(
  core: Core,
  client: SandboxdClient,
  target: SandboxdTarget,
  contextId: string,
): Promise<void> {
  try {
    await client.call(
      "contextHold",
      { target, contextId, hold: true, reason: "approval" },
      { timeoutMs: OP_TIMEOUT_MS },
    );
  } catch (err) {
    core.log.warn(
      { organizationId: target.orgId, agentId: target.agentId, contextId, error: (err as Error)?.name },
      "sandboxd did not confirm the browser hold",
    );
  }
}

interface Box {
  ensured: boolean;
  runtime: SandboxRuntime | null;
  /** Chromium's own sandbox posture as sandboxd reported it on `browserEnsure` (D-14), null before or unknown. */
  browserSandbox: BrowserSandboxMode | null;
}

/**
 * D-14 (07.8-13 owed to 16): under gVisor, Chromium must run with its own sandbox on (`chromium+gvisor`); any other
 * reported posture there is a silent fallback and the browser is refused (`service_unavailable`). On hardened runc,
 * `chromium` and `container-only` are both honest postures (the latter shown as weaker isolation). A broker that does
 * not report one (null) is not judged.
 */
export function postureRefused(status: {
  runtime: SandboxRuntime | null;
  browserSandbox: BrowserSandboxMode | null;
}): boolean {
  if (status.browserSandbox === null) return false;
  if (status.runtime === "gvisor") return status.browserSandbox !== "chromium+gvisor";
  return status.browserSandbox === "chromium+gvisor";
}

/** Step 4: sandboxd, outside any transaction. `ensure` pushes the organization's policy, then starts the browser. */
async function runInSandboxd<R>(
  core: Core,
  client: SandboxdClient | null,
  target: SandboxdTarget,
  needEnsure: boolean,
  fn: (client: SandboxdClient, ensure: () => Promise<void>, box: Box) => Promise<R>,
): Promise<{ raw: R | null; failure: ConfinedCallRefusal | null; box: Box; durationMs: number }> {
  const box: Box = { ensured: false, runtime: null, browserSandbox: null };
  const started = Date.now();
  if (!client) return { raw: null, failure: "service_unavailable", box, durationMs: 0 };
  const ensure = async () => {
    await pushPolicy(core, client, target.orgId);
    const status = await client.call("browserEnsure", { target }, { timeoutMs: ENSURE_TIMEOUT_MS });
    box.ensured = true;
    box.runtime = status.runtime;
    box.browserSandbox = status.browserSandbox;
    if (postureRefused(status)) throw new LocalRefusal("service_unavailable");
  };
  try {
    if (needEnsure) await ensure();
    const raw = await fn(client, ensure, box);
    return { raw, failure: null, box, durationMs: Date.now() - started };
  } catch (err) {
    // Codes only: the error never names a URL, a value or page text, and it is never logged with a body.
    return { raw: null, failure: failureOf(err), box, durationMs: Date.now() - started };
  }
}

interface LaterRefusal {
  reason: ConfinedCallRefusal;
  details?: Record<string, unknown>;
  route: string | null;
}

interface Outcome<R> {
  response: R;
  audit: Record<string, unknown>;
  stepInput: Record<string, unknown>;
  host: string | null;
}

/**
 * Step 5, the outcome transaction: the browser container's state, the route's `finish` (in a savepoint), the ledger
 * row, the host-only outcome audit and the step's outcome. A `paused` answer refunds the call; a context sandboxd lost
 * ends (`crashed`). Returns the response, or throws the failure's refusal.
 */
async function conclude<X, Raw, R>(
  core: Core,
  b: Begun,
  d: Decided<X>,
  tool: BrowserToolName,
  run: { raw: Raw | null; failure: ConfinedCallRefusal | null; box: Box; durationMs: number },
  p: {
    client: SandboxdClient | null;
    auditAction: string | null;
    finish: (tx: Tx, raw: Raw) => Promise<Outcome<R>>;
    /** A refusal the route turns a recorded outcome into (D-13: the site lock stopped a navigation). */
    after?: (tx: Tx) => Promise<LaterRefusal | null>;
  },
): Promise<R> {
  let failure = run.failure;
  const result = await core.db.withTenant(b.tenant, async (tx) => {
    const after = containerStateAfter({
      reserved: d.decision.claim.ensure,
      ensured: run.box.ensured,
      failure: failure === "service_unavailable" ? "service_unavailable" : null,
    });
    if (after) {
      await markState(tx, {
        agentId: d.turn.agentId,
        kind: "brw",
        state: after.state,
        stopReason: after.stopReason,
        ...(after.state === "running" ? { runtime: run.box.runtime, active: true } : {}),
      });
    }
    let outcome: Outcome<R> | null = null;
    if (run.raw !== null && !failure) {
      const raw = run.raw;
      try {
        outcome = await withSavepoint(
          tx,
          (sp) => p.finish(sp, raw),
          () => true,
        );
      } catch (err) {
        failure = failureOf(err);
      }
    }
    if (failure === "paused") await refund(tx, d.turn.eventId);
    if (failure === "no_context") {
      const row = await closeContext(tx, d.context.id, "crashed");
      if (row) await auditClosed(tx, core, row, "crashed");
    }
    await finishSandboxCall(tx, core, {
      cell: b.cell,
      turn: d.turn,
      callId: d.decision.claim.callId,
      action: p.auditAction,
      status: outcome ? "ok" : "error",
      durationMs: run.durationMs,
      container: "brw",
      metadata: outcome
        ? { contextId: d.context.id, ...outcome.audit }
        : { contextId: d.context.id, host: d.context.host, reason: failure ?? "service_unavailable" },
    });
    const later = outcome && p.after ? await p.after(tx) : null;
    const host = outcome?.host ?? d.prepared.host;
    const stepOutcome: StepOutcomeInput = later
      ? refusedOutcome(later.reason, later.route)
      : outcome
        ? { kind: "ok", durationMs: run.durationMs }
        : { kind: "error", code: failure ?? "service_unavailable", durationMs: run.durationMs };
    const step = stepFor(tool, outcome?.stepInput ?? d.prepared.stepInput, stepOutcome, {
      id: d.stepId,
      ...stepOpts(d.context, host),
    });
    await recordStep(tx, core, { turn: d.turn, step });
    if (later) return { refused: later, value: null };
    return outcome ? { refused: null, value: outcome.response } : null;
  });
  if (result?.refused) {
    const refused = result.refused;
    // The page waits for the person (U-5): sandboxd keeps it open too.
    if (WAITING.has(refused.reason) && p.client) {
      await holdInSandboxd(core, p.client, targetOf(b, d.turn.agentId), d.context.id);
    }
    throw browserRefusal(refused.reason, refused.details);
  }
  if (!result || result.value === null) throw browserRefusal(failure ?? "service_unavailable");
  return result.value;
}

/** A context of this call, required: the open one of the turn's (bot, conversation, member). */
async function requireContext(core: Core, b: Begun, tool: BrowserToolName): Promise<LoadedContext | null> {
  if (!b.available) return b.context;
  if (!b.context) await refuseEarly(core, b, tool, "no_context", { host: null });
  if (b.context && takeoverActive(b.context)) {
    await refuseEarly(core, b, tool, "paused", { host: b.context.host });
  }
  return b.context;
}

const targetOf = (b: Begun, agentId: string): SandboxdTarget => ({
  orgId: b.cell.organizationId,
  agentId,
});

/** The context row as the decision reads it (fresh, with its session's site). */
const freshContext = (tx: Tx, turn: AgentTurnRow) => openContextOf(tx, tripleOf(turn));

/**
 * Opens the context in sandboxd, site-locked to the member's session's host while one is loaded (D-13), with the
 * session's storage state when this call loaded it (07.8-21; the plaintext lives only in this request). A page opened
 * without a session by a turn that has member data (sticky, WINDOWS #292) is locked to the host it opens (`lockTo`),
 * so a link or redirect to another host stops at the lock and asks the requester like a signed-in page does.
 */
async function openInSandboxd(
  client: SandboxdClient,
  target: SandboxdTarget,
  context: LoadedContext,
  ensure: () => Promise<void>,
  box: Box,
  loaded: LoadedSession | null = null,
  lockTo: string | null = null,
): Promise<void> {
  const locked =
    !!context.sessionId && !!context.sessionSite && SiteHost.safeParse(context.sessionSite).success;
  const siteLock = locked
    ? (context.sessionSite as string)
    : lockTo && SiteHost.safeParse(lockTo).success
      ? lockTo
      : null;
  const input = {
    target,
    contextId: context.id,
    viewport: VIEWPORT,
    ...(siteLock ? { memberId: context.requestedForUserId, siteLock } : {}),
    ...(locked && loaded && loaded.sessionId === context.sessionId ? { storageState: loaded.state } : {}),
  };
  try {
    await client.call("contextOpen", input, { timeoutMs: OP_TIMEOUT_MS });
  } catch (err) {
    // The bot's browser went away (an idle stop, a broker restart): start it once and retry.
    if (!(err instanceof SandboxdRefusedError) || err.code !== "not_found" || box.ensured) throw err;
    await ensure();
    await client.call("contextOpen", input, { timeoutMs: OP_TIMEOUT_MS });
  }
}

const isNoContext = (err: unknown) => err instanceof SandboxdRefusedError && err.code === "no_context";

/** The site lock stopped a navigation while member data is in the turn: the requester's `open` approval (D-13). */
async function crossSiteApproval(
  tx: Tx,
  deps: BrowserDeps,
  d: { turn: AgentTurnRow; context: LoadedContext },
  tool: BrowserToolName,
  args: Record<string, unknown>,
): Promise<LaterRefusal> {
  const verdict = approvalVerdict(
    await deps.toolApproval.approvalForCall(tx, {
      turn: { eventId: d.turn.eventId, agentId: d.turn.agentId },
      tool,
      args,
      toolCallId: null,
      source: { kind: "builtin", id: null, target: "browser" },
      floor: "always",
      pendingTtlMs: PENDING_TTL_MS,
    }),
  );
  const reason: ConfinedCallRefusal = verdict.reason ?? "approval_used";
  const details = approvalDetails(verdict);
  const decision: SandboxDecision = { ok: false, reason, ...(details ? { details } : {}) };
  if (WAITING.has(reason)) await holdContext(tx, d.context.id, Date.now() + HOLD_MS);
  return { reason, ...(details ? { details } : {}), route: await waitingRoute(tx, decision) };
}

/**
 * D-11 (07.8-21): a member's own sign-in and sealed session follow 07.4's member-account rule, decided by
 * `memberAccountAllowed` itself (never a copy): their private chat with the bot, or an AI chat nobody else reads now.
 * A browser session has no share, so a shared conversation never qualifies.
 */
async function memberSessionAllowed(tx: Tx, turn: AgentTurnRow): Promise<boolean> {
  const facts = await memberAccountFacts(
    tx,
    {
      conversationId: turn.conversationId,
      conversationKind: turn.conversationKind,
      agentId: turn.agentId,
      humanUserId: turn.userId,
    },
    turn.conversationKind === "ai_chat" ? await audienceOf(tx, turn.conversationId) : null,
  );
  return memberAccountAllowed({
    scopeKind: facts.scopeKind,
    aiChatShared: facts.aiChatShared,
    hasShare: false,
  });
}

/**
 * The rolling re-seal (07.8-21, D-08): after a call on a page with the member's session (and before the bot closes
 * it), its state is exported and sealed again in place AS the member, so an idle stop loses nothing. Best effort and
 * never the bot's answer: a failure is logged by name only.
 */
async function resealAfter(
  core: Core,
  client: SandboxdClient | null,
  b: Begun,
  context: Pick<LoadedContext, "id" | "agentId" | "sessionId">,
): Promise<void> {
  if (!client || !context.sessionId) return;
  const sessionId = context.sessionId;
  try {
    const { storageState } = await client.call(
      "contextExportState",
      { target: targetOf(b, context.agentId), contextId: context.id },
      { timeoutMs: OP_TIMEOUT_MS },
    );
    await core.db.withTenant(b.tenant, (tx) =>
      resealSession(tx, core, { userId: b.tenant.userId, sessionId, state: storageState }),
    );
  } catch (err) {
    core.log.warn(
      { contextId: context.id, error: (err as Error | undefined)?.name ?? "Error" },
      "browser session re-seal failed",
    );
  }
}

/** What the act tells the bot about a download it caused (F-8): where it landed, or null when it was not kept. */
function downloadOf(r: RoutedDownload | null): BrowserDownload | null {
  if (!r || r.stored === null) return null;
  return r.stored === "conversation"
    ? { name: r.name, size: r.size, stored: "conversation", attachmentId: r.attachmentId }
    : { name: r.name, size: r.size, stored: "workspace", path: r.path };
}

export function registerBrowserRoutes(scope: App, core: Core, deps: BrowserDeps): void {
  // 07.8-25 (F-8): downloads under a member's session become attachments of the conversation (server credentials).
  const storage = createObjectStorage(core.env, core.secretStore);
  const attachmentMaxBytes = core.env.OCW_ATTACHMENT_MAX_BYTES;
  const route = <B extends z.ZodType, R extends z.ZodType>(body: B, response: R) => ({
    config: { authz: "cell" as const },
    schema: { tags, security: bearer, body, response: { 200: response } },
  });

  // ---------------------------------------------------------------- open
  scope.post(
    "/browser/open",
    route(AgentChannelBrowserOpen, AgentChannelBrowserOpenResponse),
    async (req) => {
      const body = req.body;
      const to = hostOf(body.url);
      if (!to)
        throw new HttpError(400, "validation_error", "url must be an http or https address with a host");
      const b = await begin(core, deps, cellOf(req), body, OPEN);
      if (b.available && b.context && takeoverActive(b.context)) {
        await refuseEarly(core, b, OPEN, "paused", { host: to.host });
      }
      const d = await decide(
        core,
        deps,
        b,
        OPEN,
        async (tx, turn) => {
          const context = await freshContext(tx, turn);
          const memberData = turn.memberData || !!context?.sessionId;
          // D-13: once member data is in the turn, another host than the session's site needs the requester's yes.
          // Without a session on the page (sticky member data, WINDOWS #292, or a page closed after the load), the
          // sites loaded by this bot in this conversation are the only hosts it may open without asking.
          const sticky =
            memberData && !context?.sessionSite ? await stickyMemberData(tx, tripleOf(turn)) : null;
          const sessionSite = context?.sessionSite ?? sticky?.sites[0] ?? null;
          const crossSite = crossSiteFor({
            memberData,
            host: to.host,
            sessionSite: context?.sessionSite ?? null,
            stickySites: sticky?.sites ?? [],
          });
          const base = {
            action: "open",
            url: body.url,
            host: to.host,
            secure: to.secure,
            ...(sessionSite ? { sessionSite } : {}),
          };
          const blockedGrant = memberData ? await crossSiteGrant(tx, turn, OPEN, base) : null;
          return {
            args: blockedGrant ?? base,
            stepInput: { host: to.host },
            approval: {
              ...(crossSite || blockedGrant ? { floor: "always" as const } : {}),
              pendingTtlMs: PENDING_TTL_MS,
            },
            context,
            host: to.host,
            extra: { crossSite: crossSite || blockedGrant !== null, base },
          };
        },
        {
          create: {
            host: to.host,
            secure: to.secure,
            session: async (tx, turn) =>
              (await memberSessionAllowed(tx, turn))
                ? await loadSessionFor(tx, core, {
                    userId: turn.userId,
                    agentId: turn.agentId,
                    host: to.host,
                  }).then((s) => (s === "expired" ? null : s))
                : null,
          },
        },
      );
      const target = targetOf(b, d.turn.agentId);
      const allowCrossSite = d.prepared.extra.crossSite && d.decision.claim.approvalId !== null;
      const run = await runInSandboxd(
        core,
        deps.client,
        target,
        d.decision.claim.ensure,
        async (client, ensure, box) => {
          const navigate = () =>
            client.call(
              "contextNavigate",
              {
                target,
                contextId: d.context.id,
                url: body.url,
                ...(allowCrossSite ? { allowCrossSite: true } : {}),
              },
              { timeoutMs: OP_TIMEOUT_MS },
            );
          if (d.replaced) {
            await client
              .call("contextClose", { target, contextId: d.replaced.id }, { timeoutMs: OP_TIMEOUT_MS })
              .catch(() => {});
          }
          // Member data without a session on the page (WINDOWS #292): lock it to the host it opens.
          const lockTo = d.turn.memberData ? to.host : null;
          if (d.created) {
            await openInSandboxd(client, target, d.context, ensure, box, d.loaded, lockTo);
            return navigate();
          }
          try {
            return await navigate();
          } catch (err) {
            // sandboxd lost the context (its browser restarted): open it again, then navigate. A page whose session
            // was not loaded by this call cannot be reopened with it: it reopens site-locked, signed out.
            if (!isNoContext(err)) throw err;
            await openInSandboxd(client, target, d.context, ensure, box, null, lockTo);
            return navigate();
          }
        },
      );
      if (run.failure && d.created) {
        // A context sandboxd never opened is no page: it ends at once. A first navigation the egress refused
        // (`navigation_refused`, 07.8-13) is the bot's own open ending, not a crash; sandboxd closes its blank page too.
        const refused = run.failure === "navigation_refused";
        const reason = refused ? "closed_by_bot" : "crashed";
        await core.db.withTenant(b.tenant, async (tx) => {
          const row = await closeContext(tx, d.context.id, reason);
          if (row) await auditClosed(tx, core, row, reason, refused ? { refused: "navigation_refused" } : {});
        });
        if (refused && deps.client) {
          await deps.client
            .call("contextClose", { target, contextId: d.context.id }, { timeoutMs: OP_TIMEOUT_MS })
            .catch(() => {});
        }
      }
      const opened = await conclude(core, b, d, OPEN, run, {
        client: deps.client,
        auditAction: "browser.opened",
        finish: async (tx, nav) => {
          const host = validHost(nav.host) ?? to.host;
          await updateHost(tx, d.context.id, host, nav.secure);
          if (d.decision.claim.approvalId) await releaseHold(tx, d.context.id);
          return {
            response: {
              contextId: d.context.id,
              host,
              secure: nav.secure,
              title: nav.title.slice(0, 200),
              signedIn: sessionLoadedFor(d.context, host),
            },
            audit: {
              host,
              ...(nav.blockedNavigation ? { blockedHost: validHost(nav.blockedNavigation.host) } : {}),
              // D-14: the isolation the page runs under when this call started the browser (a fixed enum).
              ...(run.box.browserSandbox ? { browserSandbox: run.box.browserSandbox } : {}),
            },
            stepInput: { host },
            host,
          };
        },
        after: async (tx) => {
          const blocked = run.raw?.blockedNavigation ? validHost(run.raw.blockedNavigation.host) : null;
          if (!blocked) return null;
          // The site lock stopped a redirect to another host.
          if (!(d.turn.memberData || d.context.sessionId))
            return { reason: "navigation_refused", route: null };
          return crossSiteApproval(tx, deps, d, OPEN, { ...d.prepared.extra.base, navigateTo: blocked });
        },
      });
      await resealAfter(core, deps.client, b, d.context);
      return opened;
    },
  );

  // ---------------------------------------------------------------- snapshot
  scope.post(
    "/browser/snapshot",
    route(AgentChannelBrowserSnapshot, AgentChannelBrowserSnapshotResponse),
    async (req) => {
      const body = req.body;
      const b = await begin(core, deps, cellOf(req), body, SNAPSHOT);
      await requireContext(core, b, SNAPSHOT);
      const d = await decide(core, deps, b, SNAPSHOT, async (tx, turn) => {
        const context = await freshContext(tx, turn);
        return {
          args: { contextId: context?.id ?? null, host: context?.host ?? null },
          stepInput: { host: context?.host ?? null },
          approval: { pendingTtlMs: PENDING_TTL_MS },
          context,
          host: context?.host ?? null,
          extra: null,
        };
      });
      const target = targetOf(b, d.turn.agentId);
      const run = await runInSandboxd(core, deps.client, target, d.decision.claim.ensure, async (client) =>
        secondPass(await rawSnapshot(client, target, d.context.id)),
      );
      return conclude(core, b, d, SNAPSHOT, run, {
        client: deps.client,
        auditAction: null,
        finish: async (tx, snap) => {
          if (snap.leaked > 0) {
            // An incident with ids and a count only: never the value that leaked (T-07.8-14-02).
            core.log.warn(
              {
                organizationId: b.cell.organizationId,
                agentId: d.turn.agentId,
                eventId: d.turn.eventId,
                contextId: d.context.id,
                nodes: snap.leaked,
              },
              "browser snapshot carried a value on a redacted field; replaced by the API",
            );
            await core.audit.record(tx, {
              action: "browser.redaction_incident",
              actorKind: "system",
              agentId: d.turn.agentId,
              userId: d.turn.userId,
              resourceType: "browser_context",
              resourceId: d.context.id,
              result: "error",
              metadata: { eventId: d.turn.eventId, contextId: d.context.id, nodes: snap.leaked },
            });
          }
          const host = validHost(snap.host) ?? d.context.host;
          if (host !== d.context.host) await updateHost(tx, d.context.id, host);
          return {
            response: {
              contextId: d.context.id,
              host,
              title: snap.title,
              text: snap.text,
              truncated: snap.truncated,
              signedIn: sessionLoadedFor(d.context, host),
            },
            audit: { host },
            stepInput: { host },
            host,
          };
        },
      });
    },
  );

  // ---------------------------------------------------------------- act
  scope.post("/browser/act", route(AgentChannelBrowserAct, AgentChannelBrowserActResponse), async (req) => {
    const body = req.body;
    if (body.key !== undefined && !KEY_RE.test(body.key)) {
      throw new HttpError(400, "validation_error", "key must be a key name such as Enter, Tab or a");
    }
    const b = await begin(core, deps, cellOf(req), body, ACT);
    const context0 = await requireContext(core, b, ACT);
    // The element the action names, read from a fresh snapshot (only for an available call on an open context).
    let element: { role: string; name: string } | null = null;
    let pageHost: string | null = context0?.host ?? null;
    const actInput = (host: string | null) => ({
      host,
      action: body.action,
      elementName: element?.name ?? null,
      key: body.key ?? null,
      option: body.option ?? null,
    });
    if (b.available && context0 && body.ref !== undefined) {
      if (!deps.client) await refuseEarly(core, b, ACT, "service_unavailable", actInput(pageHost));
      let snap: PassedSnapshot | null = null;
      let early: ConfinedCallRefusal | null = null;
      try {
        snap = secondPass(
          await rawSnapshot(deps.client as SandboxdClient, targetOf(b, b.turn.agentId), context0.id),
        );
      } catch (err) {
        early = failureOf(err);
      }
      if (early === "no_context") {
        await core.db.withTenant(b.tenant, async (tx) => {
          const row = await closeContext(tx, context0.id, "crashed");
          if (row) await auditClosed(tx, core, row, "crashed");
        });
      }
      if (early) await refuseEarly(core, b, ACT, early, actInput(pageHost));
      pageHost = validHost(snap?.host) ?? pageHost;
      const node = snap?.nodes.find((n) => n.ref === body.ref);
      if (!node) await refuseEarly(core, b, ACT, "element_gone", actInput(pageHost));
      element = node ? { role: node.role, name: node.name } : null;
    }
    const d = await decide(core, deps, b, ACT, async (tx, turn) => {
      const context = await freshContext(tx, turn);
      const host = pageHost ?? context?.host ?? null;
      if (context && host && host !== context.host) await updateHost(tx, context.id, host);
      const memberData = turn.memberData || !!context?.sessionId;
      const signedIn = context ? sessionLoadedFor(context, host) : false;
      const base: Record<string, unknown> = {
        contextId: context?.id ?? null,
        action: body.action,
        host,
        secure: context?.secure ?? true,
        signedIn,
        ...(context?.sessionSite ? { sessionSite: context.sessionSite } : {}),
        ...(body.ref !== undefined ? { ref: body.ref, element } : {}),
        ...(body.text !== undefined ? { value: body.text } : {}),
        ...(body.key !== undefined ? { key: body.key } : {}),
        ...(body.option !== undefined ? { option: body.option } : {}),
        ...(body.direction !== undefined ? { direction: body.direction } : {}),
      };
      const crossGrant = memberData ? await crossSiteGrant(tx, turn, ACT, base) : null;
      return {
        args: crossGrant ?? base,
        stepInput: actInput(host),
        // F-7: side-effecting only while the requester's session is loaded for this page.
        flags: { untrustedOutput: true, sideEffecting: signedIn },
        approval: {
          ...(signedIn || crossGrant ? { floor: "always" as const } : {}),
          pendingTtlMs: PENDING_TTL_MS,
        },
        context,
        host,
        extra: { base, crossSite: crossGrant !== null, memberData },
      };
    });
    const target = targetOf(b, d.turn.agentId);
    const allowCrossSite = d.prepared.extra.crossSite && d.decision.claim.approvalId !== null;
    const run = await runInSandboxd(core, deps.client, target, d.decision.claim.ensure, async (client) => {
      const result = await client.call(
        "contextAct",
        {
          target,
          contextId: d.context.id,
          action: body.action,
          ...(body.ref !== undefined ? { ref: body.ref } : {}),
          ...(body.text !== undefined ? { text: body.text } : {}),
          ...(body.key !== undefined ? { key: body.key } : {}),
          ...(body.option !== undefined ? { option: body.option } : {}),
          ...(body.direction !== undefined ? { direction: body.direction } : {}),
          ...(allowCrossSite ? { allowCrossSite: true } : {}),
        },
        { timeoutMs: OP_TIMEOUT_MS },
      );
      // A navigation moved the page: its host, read without waiting (the events feed confirms it later).
      const where = result.navigated
        ? await client.call(
            "contextWait",
            { target, contextId: d.context.id, for: "time", ms: 0 },
            { timeoutMs: OP_TIMEOUT_MS },
          )
        : null;
      return { result, host: where ? validHost(where.host) : null };
    });
    // F-8 (P-11): a file the act downloaded goes where its audience allows: the conversation under a member's session
    // (or a team bot's member data), the workspace otherwise, or nowhere; never both.
    const reported = run.failure ? null : (run.raw?.result.download ?? null);
    const routed: RoutedDownload | null =
      reported && deps.client
        ? await routeDownload(
            { core, perms: deps.perms, client: deps.client, storage, attachmentMaxBytes },
            {
              tenant: b.tenant,
              turn: {
                eventId: d.turn.eventId,
                agentId: d.turn.agentId,
                userId: d.turn.userId,
                conversationId: d.turn.conversationId,
              },
              context: {
                id: d.context.id,
                host: run.raw?.host ?? d.prepared.host ?? d.context.host,
                sessionId: d.context.sessionId,
              },
              target,
              download: reported,
            },
          )
        : null;
    const acted = await conclude(core, b, d, ACT, run, {
      client: deps.client,
      auditAction: "browser.acted",
      finish: async (tx, { result, host: moved }) => {
        const host = moved ?? d.prepared.host ?? d.context.host;
        if (moved && moved !== d.context.host) {
          await updateHost(tx, d.context.id, moved);
          await core.audit.record(tx, {
            action: "browser.navigated",
            actorKind: "agent",
            actorId: d.turn.agentId,
            agentId: d.turn.agentId,
            userId: d.turn.userId,
            resourceType: "browser_context",
            resourceId: d.context.id,
            metadata: { contextId: d.context.id, host: moved },
          });
        }
        if (d.decision.claim.approvalId) await releaseHold(tx, d.context.id);
        const blocked = result.blockedNavigation ? validHost(result.blockedNavigation.host) : null;
        if (routed) {
          await recordStep(tx, core, {
            turn: d.turn,
            step: downloadStep(routed, stepOpts(d.context, host)),
          });
        }
        return {
          response: {
            contextId: d.context.id,
            host,
            signedIn: sessionLoadedFor(d.context, host),
            navigated: result.navigated,
            download: downloadOf(routed),
          },
          audit: {
            host: d.prepared.host ?? host,
            action: body.action,
            ...(blocked ? { blockedHost: blocked } : {}),
          },
          stepInput: actInput(d.prepared.host ?? host),
          host: d.prepared.host ?? host,
        };
      },
      after: async (tx) => {
        const blocked = run.raw?.result.blockedNavigation
          ? validHost(run.raw.result.blockedNavigation.host)
          : null;
        if (!blocked) return null;
        // D-13: the site lock stopped a navigation to another host; with member data it needs the requester's yes.
        if (!d.prepared.extra.memberData) return { reason: "navigation_refused", route: null };
        return crossSiteApproval(tx, deps, d, ACT, { ...d.prepared.extra.base, navigateTo: blocked });
      },
    });
    await resealAfter(core, deps.client, b, d.context);
    return acted;
  });

  // ---------------------------------------------------------------- screenshot (D-14: image-capable models only)
  scope.post(
    "/browser/screenshot",
    route(AgentChannelBrowserScreenshot, AgentChannelBrowserScreenshotResponse),
    async (req) => {
      const body = req.body;
      const b = await begin(core, deps, cellOf(req), body, SCREENSHOT);
      if (!b.images)
        await refuseEarly(core, b, SCREENSHOT, "screenshot_unavailable", { host: b.context?.host ?? null });
      await requireContext(core, b, SCREENSHOT);
      const d = await decide(core, deps, b, SCREENSHOT, async (tx, turn) => {
        const context = await freshContext(tx, turn);
        return {
          args: { contextId: context?.id ?? null, host: context?.host ?? null },
          stepInput: { host: context?.host ?? null },
          approval: { pendingTtlMs: PENDING_TTL_MS },
          context,
          host: context?.host ?? null,
          extra: null,
        };
      });
      const target = targetOf(b, d.turn.agentId);
      const run = await runInSandboxd(core, deps.client, target, d.decision.claim.ensure, async (client) => {
        const shot = await client.call(
          "contextScreenshot",
          { target, contextId: d.context.id },
          { timeoutMs: OP_TIMEOUT_MS },
        );
        // The contract's image is a masked JPEG within the expanded frame (the agent draws the masks, P-10).
        if (
          shot.mimeType !== "image/jpeg" ||
          shot.width > BROWSER_LIMITS.expandedWidth ||
          shot.height > BROWSER_LIMITS.expandedHeight
        ) {
          throw new LocalRefusal("service_unavailable");
        }
        return shot;
      });
      return conclude(core, b, d, SCREENSHOT, run, {
        client: deps.client,
        auditAction: null,
        finish: async (_tx, shot) => ({
          response: {
            contextId: d.context.id,
            host: d.context.host,
            image: {
              mimeType: "image/jpeg" as const,
              data: shot.data,
              width: shot.width,
              height: shot.height,
              masked: shot.masked,
            },
          },
          audit: { host: d.context.host, masked: shot.masked },
          stepInput: { host: d.context.host },
          host: d.context.host,
        }),
      });
    },
  );

  // ---------------------------------------------------------------- wait
  scope.post(
    "/browser/wait",
    route(AgentChannelBrowserWait, AgentChannelBrowserWaitResponse),
    async (req) => {
      const body = req.body;
      const b = await begin(core, deps, cellOf(req), body, WAIT);
      await requireContext(core, b, WAIT);
      const d = await decide(core, deps, b, WAIT, async (tx, turn) => {
        const context = await freshContext(tx, turn);
        return {
          args: {
            contextId: context?.id ?? null,
            for: body.for,
            ...(body.text !== undefined ? { text: body.text } : {}),
            ...(body.ms !== undefined ? { ms: body.ms } : {}),
          },
          stepInput: { host: context?.host ?? null },
          approval: { pendingTtlMs: PENDING_TTL_MS },
          context,
          host: context?.host ?? null,
          extra: null,
        };
      });
      const target = targetOf(b, d.turn.agentId);
      const ms = body.for === "time" ? (body.ms ?? 0) : (body.ms ?? DEFAULT_WAIT_MS);
      const run = await runInSandboxd(core, deps.client, target, d.decision.claim.ensure, (client) =>
        client.call(
          "contextWait",
          {
            target,
            contextId: d.context.id,
            for: body.for,
            ...(body.text !== undefined ? { text: body.text } : {}),
            ms,
          },
          { timeoutMs: ms + WAIT_MARGIN_MS },
        ),
      );
      const waited = await conclude(core, b, d, WAIT, run, {
        client: deps.client,
        auditAction: null,
        finish: async (tx, waited) => {
          const host = validHost(waited.host) ?? d.context.host;
          if (host !== d.context.host) await updateHost(tx, d.context.id, host);
          return {
            response: { contextId: d.context.id, host, ok: waited.ok },
            audit: { host },
            stepInput: { host },
            host,
          };
        },
      });
      await resealAfter(core, deps.client, b, d.context);
      return waited;
    },
  );

  // ---------------------------------------------------------------- sign-in (07.8-21; D-07, D-11, R1, R9)
  scope.post(
    "/browser/signin",
    route(AgentChannelBrowserSignIn, AgentChannelBrowserSignInResponse),
    async (req) => {
      const body = req.body;
      const b = await begin(core, deps, cellOf(req), body, SIGNIN);
      const context0 = await requireContext(core, b, SIGNIN);
      // D-11: only where 07.4's member-account rule allows a member's own account (refused before the decision, so it
      // never counts): their private chat with the bot, never a shared conversation.
      if (b.available && context0) {
        const allowed = await core.db.withTenant(b.tenant, (tx) => memberSessionAllowed(tx, b.turn));
        if (!allowed) await refuseEarly(core, b, SIGNIN, "signin_not_allowed", { host: context0.host });
      }
      const d = await decide(core, deps, b, SIGNIN, async (tx, turn) => {
        const context = await freshContext(tx, turn);
        return {
          // The reason is the bot's text: it decides nothing and is never part of an approval (never approvable).
          args: { contextId: context?.id ?? null, host: context?.host ?? null },
          stepInput: { host: context?.host ?? null },
          approval: { pendingTtlMs: PENDING_TTL_MS },
          context,
          host: context?.host ?? null,
          extra: null,
        };
      });
      const target = targetOf(b, d.turn.agentId);
      // R9: sandboxd keeps the page open while the card waits (best effort; the API's hold is the record).
      const run = await runInSandboxd(core, deps.client, target, false, async (client) => {
        await client
          .call(
            "contextHold",
            { target, contextId: d.context.id, hold: true, reason: "signin" },
            { timeoutMs: OP_TIMEOUT_MS },
          )
          .catch((err: unknown) =>
            core.log.warn(
              { contextId: d.context.id, error: (err as Error | undefined)?.name ?? "Error" },
              "sandboxd did not confirm the sign-in hold",
            ),
          );
        return true;
      });
      return conclude(core, b, d, SIGNIN, run, {
        client: deps.client,
        auditAction: null,
        finish: async (tx) => {
          const asked = await requestSignIn(tx, core, {
            turn: d.turn,
            context: d.context,
            reason: body.reason,
          });
          if ("refused" in asked) throw new LocalRefusal(asked.refused);
          return {
            response: { posted: true as const, host: asked.host },
            audit: { host: asked.host, requestId: asked.requestId },
            stepInput: { host: asked.host },
            host: asked.host,
          };
        },
      });
    },
  );

  // ---------------------------------------------------------------- close
  scope.post(
    "/browser/close",
    route(AgentChannelBrowserClose, AgentChannelBrowserCloseResponse),
    async (req) => {
      const body = req.body;
      const b = await begin(core, deps, cellOf(req), body, CLOSE);
      await requireContext(core, b, CLOSE);
      const d = await decide(core, deps, b, CLOSE, async (tx, turn) => {
        const context = await freshContext(tx, turn);
        return {
          args: { contextId: context?.id ?? null },
          stepInput: { host: context?.host ?? null },
          approval: { pendingTtlMs: PENDING_TTL_MS },
          context,
          host: context?.host ?? null,
          extra: null,
        };
      });
      const target = targetOf(b, d.turn.agentId);
      // The member's session is sealed once more before its page goes (07.8-21, the rolling re-seal).
      await resealAfter(core, deps.client, b, d.context);
      const run = await runInSandboxd(core, deps.client, target, false, async (client) => {
        try {
          await client.call(
            "contextClose",
            { target, contextId: d.context.id },
            { timeoutMs: OP_TIMEOUT_MS },
          );
        } catch (err) {
          // Already gone in sandboxd (a restart): closing it is done.
          if (!isNoContext(err)) throw err;
        }
        return { closed: true as const };
      });
      return conclude(core, b, d, CLOSE, run, {
        client: deps.client,
        auditAction: null,
        finish: async (tx) => {
          const row = await closeContext(tx, d.context.id, "closed_by_bot");
          if (row) await auditClosed(tx, core, row, "closed_by_bot", { eventId: d.turn.eventId });
          return {
            response: { closed: true as const },
            audit: { host: d.context.host },
            stepInput: { host: d.context.host },
            host: d.context.host,
          };
        },
      });
    },
  );
}
