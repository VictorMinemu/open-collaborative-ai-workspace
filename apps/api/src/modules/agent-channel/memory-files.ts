import {
  AgentChannelMemoryList,
  AgentChannelMemoryListResponse,
  AgentChannelMemoryPropose,
  AgentChannelMemoryProposeResponse,
  AgentChannelMemoryRead,
  AgentChannelMemoryReadResponse,
  AgentChannelMemoryWrite,
  AgentChannelMemoryWriteResponse,
  BUILTIN_TOOLS,
  MAX_TOOL_CALLS_PER_TURN,
  type MemoryFileMeta,
  type MemoryScope,
  type MemoryToolRefusal,
  MemoryToolScope,
} from "@ocw/contracts";
import { agentTurns, conversationMembers, conversations, type Tx, withSavepoint } from "@ocw/db";
import { and, eq, lt, sql } from "drizzle-orm";
import type { App, Core } from "../../core";
import { HttpError } from "../../lib/errors";
import { audienceOf } from "../ai-chat";
import { currentTurnTools } from "../bot-capabilities";
import { createConversationAccess } from "../chat";
import {
  type MemoryActor,
  type MemoryAudience,
  type MemoryService,
  type ToolScope,
  withPersonalOwner,
} from "../memory";
import { AuthzDeniedError, type PermissionService } from "../organization";
import { type CellPrincipal, cellOf } from "./auth";
import { noTrigger } from "./cards";

/**
 * The Agent Channel memory routes (07.2-11; MEM-04, MEM-07, D-02, D-08, C-01, ADR-0023): `POST
 * /agent-channel/v1/memory/{list,read,write,propose}`, the API behind the plugin's `ocw_memory_list|read|write|propose`
 * (07.2-07). The body names the delivered turn (`eventId`) and the agent; the human the agent acts for is ALWAYS the
 * stored turn's (`agent_turns.user_id`), never a field (the bodies are strict: an extra `userId` is a 400).
 *
 * Every call, in one transaction:
 *   1. the turn: this agent's delivery (RLS keeps it to the cell's organization) whose human still reads the turn's
 *      conversation; otherwise 403 `no_trigger` (the rule of every agent post, PR #25), audited and committed first;
 *   2. the tool on that turn (`not_in_turn`) and still offered now (`memory_off`);
 *   3. the decision as the agent for that human (agent ∩ human, the resolver) and the audience rule: every reader of the
 *      conversation may read what the agent reads (`audience_too_wide`). Personal-like memory (the person's private
 *      scope with this bot, a personal bot's notebook) is used only in the owner's one-person DM (ADR-0023 decision 4).
 *      What the human may not read reads as `not_found` (never revealed). Aliases are decided before their scope is
 *      created, so a refused call never creates one.
 * Refusals answer 200 `{refused}` (the model reads the reason) and are audited `memory.agent_refused` with ids only.
 * Writes go only to the agent's own scopes, never after untrusted content (`tainted`), within the turn's tool cap; every
 * other change is a proposal a person approves (07.2-09). Audit rows never carry a path or content.
 */

const tags = ["agent-channel"];
const bearer = [{ cellToken: [] as string[] }];
const cellRoute = { config: { authz: "cell" as const } };

type Route = "list" | "read" | "write" | "propose";

const TOOL: Record<Route, string> = {
  list: BUILTIN_TOOLS.memoryList,
  read: BUILTIN_TOOLS.memoryRead,
  write: BUILTIN_TOOLS.memoryWrite,
  propose: BUILTIN_TOOLS.memoryPropose,
};

/** The turn columns these routes act on. */
interface MemoryTurn {
  eventId: string;
  agentId: string;
  userId: string;
  conversationId: string;
  conversationKind: string;
}

type Refused = { refused: MemoryToolRefusal };
const NO_TRIGGER = Symbol("no_trigger");

/**
 * `ocw_memory_write` names a scope id too: the plugin refuses ids locally, but a model that names a shared scope must
 * hear `own_scope_only` (the fake API's answer), not a 400. Otherwise the contract's strict body.
 */
const MemoryWriteBody = AgentChannelMemoryWrite.extend({ scope: MemoryToolScope });

// ---------------------------------------------------------------- who reads the turn's conversation

/** The human members of a conversation. */
async function humansOf(tx: Tx, conversationId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: conversationMembers.memberId })
    .from(conversationMembers)
    .where(
      and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.memberKind, "user")),
    );
  return rows.map((r) => r.id).sort();
}

/** The conversation a turn's readers are judged by: a thread conversation is its parent channel's. */
async function judgedConversation(tx: Tx, conversationId: string) {
  const [conv] = await tx
    .select({
      id: conversations.id,
      kind: conversations.kind,
      visibility: conversations.visibility,
      parentConversationId: conversations.parentConversationId,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (conv?.kind !== "thread" || !conv.parentConversationId) return conv ?? null;
  const [parent] = await tx
    .select({
      id: conversations.id,
      kind: conversations.kind,
      visibility: conversations.visibility,
      parentConversationId: conversations.parentConversationId,
    })
    .from(conversations)
    .where(eq(conversations.id, conv.parentConversationId))
    .limit(1);
  return parent ?? null;
}

/**
 * Who reads what an agent says in a turn's conversation (the audience rule, D-08, Pitfall 5): a DM, a group DM or a
 * private channel → its human members; a public channel → anyone (unbounded); an AI chat → its readers, unbounded once
 * a unit or the organization holds a grant (`audienceOf`, 06-10); a thread → its channel; anything else → unbounded
 * (fail closed: only organization-wide memory nobody is denied).
 */
export async function conversationAudience(
  tx: Tx,
  turn: { conversationId: string },
): Promise<{ userIds: string[]; unbounded: boolean }> {
  const conv = await judgedConversation(tx, turn.conversationId);
  if (!conv) return { userIds: [], unbounded: true };
  switch (conv.kind) {
    case "ai_chat":
      return audienceOf(tx, conv.id);
    case "dm":
    case "group":
      return { userIds: await humansOf(tx, conv.id), unbounded: false };
    case "channel":
      return conv.visibility === "private"
        ? { userIds: await humansOf(tx, conv.id), unbounded: false }
        : { userIds: [], unbounded: true };
    default:
      return { userIds: [], unbounded: true };
  }
}

/** A `dm` whose one and only human member is `userId`: the only place personal-like memory is used by an agent. */
export async function isOneHumanDm(tx: Tx, conversationId: string, userId: string): Promise<boolean> {
  const [conv] = await tx
    .select({ kind: conversations.kind })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (conv?.kind !== "dm") return false;
  const humans = await humansOf(tx, conversationId);
  return humans.length === 1 && humans[0] === userId;
}

// ---------------------------------------------------------------- domain errors → refusals

/** A memory service error as the refusal the model reads; null = not a domain error (it propagates). */
function refusalOf(err: unknown): MemoryToolRefusal | null {
  // The resolver's precondition refuses an agent writing anything but its own personal-like scope.
  if (err instanceof AuthzDeniedError) {
    return err.denial.reason === "agent_shared_write" ? "own_scope_only" : "denied";
  }
  if (!(err instanceof HttpError)) return null;
  switch (err.code) {
    case "memory_version_conflict":
    case "memory_path_exists":
      return "version_conflict";
    case "memory_not_found":
      return "not_found";
    case "memory_path_invalid":
    case "memory_root_file":
      return "path_invalid";
    case "memory_scope_full":
      return "scope_full";
    case "memory_file_too_large":
      return "too_large";
    case "secret_detected":
      return "secret_detected";
    default:
      return null;
  }
}

// ---------------------------------------------------------------- routes

export function registerMemoryFileRoutes(
  app: App,
  ctx: { core: Core; perms: PermissionService; memory: MemoryService },
): void {
  const { core, perms, memory } = ctx;
  const access = createConversationAccess(core);

  async function auditRefusal(
    tx: Tx,
    cell: CellPrincipal,
    p: { route: Route; reason: string; eventId: string; turn: MemoryTurn | null },
  ): Promise<void> {
    const { turn } = p;
    await core.audit.record(tx, {
      action: "memory.agent_refused",
      resourceType: "agent",
      resourceId: turn?.agentId ?? null,
      result: "denied",
      actorKind: turn ? "agent" : "system",
      actorId: turn?.agentId ?? null,
      agentId: turn?.agentId ?? null,
      userId: turn?.userId ?? null,
      clientKind: "agent",
      sessionId: `cell:${cell.credentialId}`,
      metadata: {
        route: p.route,
        reason: p.reason,
        eventId: p.eventId,
        conversationId: turn?.conversationId ?? null,
      },
    });
  }

  /** The human of the turn still reads its conversation (a thread is read through its channel). */
  async function humanReads(tx: Tx, turn: MemoryTurn): Promise<boolean> {
    const conv = await judgedConversation(tx, turn.conversationId);
    if (!conv) return false;
    return access.isReadable(tx, turn.userId, conv.id, { kinds: ["channel", "dm", "group", "ai_chat"] });
  }

  /** Steps 1 and 2 of every call (see the module comment). */
  async function gate(
    tx: Tx,
    cell: CellPrincipal,
    route: Route,
    body: { eventId: string; agentId: string },
  ): Promise<{ turn: MemoryTurn } | Refused | typeof NO_TRIGGER> {
    const [row] = await tx.select().from(agentTurns).where(eq(agentTurns.eventId, body.eventId));
    const turn: MemoryTurn | null =
      row && row.agentId === body.agentId
        ? {
            eventId: row.eventId,
            agentId: row.agentId,
            userId: row.userId,
            conversationId: row.conversationId,
            conversationKind: row.conversationKind,
          }
        : null;
    if (!turn || !row || !(await humanReads(tx, turn))) {
      await auditRefusal(tx, cell, { route, reason: "no_trigger", eventId: body.eventId, turn });
      return NO_TRIGGER;
    }
    const refuse = async (reason: MemoryToolRefusal): Promise<Refused> => {
      await auditRefusal(tx, cell, { route, reason, eventId: body.eventId, turn });
      return { refused: reason };
    };
    if (!row.tools.includes(TOOL[route])) return refuse("not_in_turn");
    const now = await currentTurnTools(
      tx,
      perms,
      { agentId: turn.agentId, humanUserId: turn.userId, conversationKind: turn.conversationKind },
      core.env,
    );
    if (!now.tools.includes(TOOL[route])) return refuse("memory_off");
    return { turn };
  }

  /** Runs the gate, then `act` for the turn, in one transaction; `no_trigger` is thrown once that commits. */
  async function onTurn<T>(
    cell: CellPrincipal,
    route: Route,
    body: { eventId: string; agentId: string },
    act: (
      tx: Tx,
      turn: MemoryTurn,
      refuse: (r: MemoryToolRefusal) => Promise<Refused>,
    ) => Promise<T | Refused>,
  ): Promise<T | Refused> {
    const out = await core.db.withTenant(
      { organizationId: cell.organizationId, userId: null },
      async (tx) => {
        const g = await gate(tx, cell, route, body);
        if (g === NO_TRIGGER || "refused" in g) return g;
        const refuse = async (reason: MemoryToolRefusal): Promise<Refused> => {
          await auditRefusal(tx, cell, { route, reason, eventId: body.eventId, turn: g.turn });
          return { refused: reason };
        };
        return act(tx, g.turn, refuse);
      },
    );
    if (out === NO_TRIGGER) throw noTrigger();
    return out;
  }

  /** What one turn decides with: the actor, the one-person-DM flag and the (lazily computed) audience. */
  function lensOf(tx: Tx, turn: MemoryTurn) {
    const actor: MemoryActor = { kind: "agent", agentId: turn.agentId, onBehalfOfUserId: turn.userId };
    let dm: Promise<boolean> | null = null;
    let audience: Promise<MemoryAudience> | null = null;
    const oneHumanDm = () => {
      dm ??= isOneHumanDm(tx, turn.conversationId, turn.userId);
      return dm;
    };
    const readers = () => {
      audience ??= oneHumanDm().then((only) =>
        only ? { userIds: [turn.userId], unbounded: false } : conversationAudience(tx, turn),
      );
      return audience;
    };
    /**
     * May the agent read (scope, path) for this turn? `not_found` for anything the human may not read (never
     * revealed), `audience_too_wide` when a reader may not, or personal-like memory outside the one-person DM.
     */
    const readable = async (scope: ToolScope, path?: string): Promise<MemoryToolRefusal | null> => {
      const v = await memory.decideAgentRead(tx, {
        agentId: turn.agentId,
        onBehalfOfUserId: turn.userId,
        audience: await readers(),
        scope,
        ...(path === undefined ? {} : { path }),
      });
      if (!v.allowed) return v.reason === "denied" ? "not_found" : "audience_too_wide";
      if (scope.personalLike && !(await oneHumanDm())) return "audience_too_wide";
      return null;
    };
    const resolve = (scope: string) =>
      memory.resolveToolScope(tx, { agentId: turn.agentId, onBehalfOfUserId: turn.userId, scope });
    const ensure = (scope: ToolScope) => memory.ensureToolScope(tx, turn.userId, scope);
    return { actor, oneHumanDm, readers, readable, resolve, ensure };
  }

  const auditOk = (
    tx: Tx,
    cell: CellPrincipal,
    turn: MemoryTurn,
    action: string,
    metadata: Record<string, unknown>,
  ) =>
    core.audit.record(tx, {
      action,
      resourceType: "agent",
      resourceId: turn.agentId,
      actorKind: "agent",
      actorId: turn.agentId,
      agentId: turn.agentId,
      userId: turn.userId,
      clientKind: "agent",
      sessionId: `cell:${cell.credentialId}`,
      metadata: { ...metadata, eventId: turn.eventId, conversationId: turn.conversationId },
    });

  // ---- list: no scope = the scopes the agent may use here; a scope = the files every reader may read
  app.post(
    "/memory/list",
    {
      ...cellRoute,
      schema: {
        tags,
        security: bearer,
        body: AgentChannelMemoryList,
        response: { 200: AgentChannelMemoryListResponse },
      },
    },
    async (req) => {
      const cell = cellOf(req);
      const body = req.body;
      return onTurn(cell, "list", body, async (tx, turn, refuse) => {
        const lens = lensOf(tx, turn);
        if (body.scope === undefined) {
          // The private scope exists from the first one-person DM (decided before it is created).
          if (await lens.oneHumanDm()) {
            const own = await lens.resolve("personal");
            if (own && !own.id && (await lens.readable(own)) === null) await lens.ensure(own);
          }
          const candidates = await withPersonalOwner(tx, turn.userId, () =>
            memory.listScopes(tx, turn.userId),
          );
          const scopes: MemoryScope[] = [];
          for (const c of candidates) {
            const ref = await lens.resolve(c.id);
            if (!ref?.id || (await lens.readable(ref)) !== null) continue;
            scopes.push(await memory.scopeView(tx, lens.actor, ref.id));
          }
          await auditOk(tx, cell, turn, "memory.agent_listed", { scopeId: null, count: scopes.length });
          return { scopes };
        }
        const ref = await lens.resolve(body.scope);
        if (!ref) return refuse("not_found");
        const no = await lens.readable(ref);
        if (no) return refuse(no);
        const scopeId = await lens.ensure(ref);
        const all = await memory.listReadableFiles(tx, lens.actor, scopeId, body.folder);
        const files: MemoryFileMeta[] = [];
        for (const f of all) {
          if ((await lens.readable({ ...ref, id: scopeId }, f.path)) === null) files.push(f);
        }
        await auditOk(tx, cell, turn, "memory.agent_listed", { scopeId, count: files.length });
        return { files };
      });
    },
  );

  // ---- read one file
  app.post(
    "/memory/read",
    {
      ...cellRoute,
      schema: {
        tags,
        security: bearer,
        body: AgentChannelMemoryRead,
        response: { 200: AgentChannelMemoryReadResponse },
      },
    },
    async (req) => {
      const cell = cellOf(req);
      const body = req.body;
      return onTurn(cell, "read", body, async (tx, turn, refuse) => {
        const lens = lensOf(tx, turn);
        const ref = await lens.resolve(body.scope);
        if (!ref) return refuse("not_found");
        const no = await lens.readable(ref, body.path);
        if (no) return refuse(no);
        const scopeId = await lens.ensure(ref);
        try {
          const file = await memory.readFile(tx, lens.actor, { scopeId, path: body.path });
          await auditOk(tx, cell, turn, "memory.agent_read", {
            scopeId,
            scopeKind: ref.kind,
            fileId: file.id,
            version: file.version,
          });
          return { file: { path: file.path, version: file.version, content: file.content } };
        } catch (err) {
          const reason = refusalOf(err);
          if (reason) return refuse(reason === "denied" ? "not_found" : reason);
          throw err;
        }
      });
    },
  );

  // ---- write: the agent's own scopes only (the person's private memory here, a personal bot's notebook)
  app.post(
    "/memory/write",
    {
      ...cellRoute,
      schema: {
        tags,
        security: bearer,
        body: MemoryWriteBody,
        response: { 200: AgentChannelMemoryWriteResponse },
      },
    },
    async (req) => {
      const cell = cellOf(req);
      const body = req.body;
      return onTurn(cell, "write", body, async (tx, turn, refuse) => {
        const lens = lensOf(tx, turn);
        const ref = await lens.resolve(body.scope);
        const agent = ref?.facts.agent?.id ?? null;
        if (!ref) return refuse("own_scope_only");
        const own =
          ref.personalLike &&
          agent === turn.agentId &&
          (ref.kind === "agent" || (ref.kind === "personal" && ref.facts.ownerUserId === turn.userId));
        if (!own) return refuse("own_scope_only");
        if (!(await lens.oneHumanDm())) return refuse("dm_only");

        // Count the call and check the taint in one statement (the `saveMemory` rule): a web call authorised
        // concurrently on the same turn lands either before (refused) or after this write.
        const counted = await tx
          .update(agentTurns)
          .set({ toolCalls: sql`${agentTurns.toolCalls} + 1` })
          .where(
            and(
              eq(agentTurns.eventId, turn.eventId),
              eq(agentTurns.tainted, false),
              lt(agentTurns.toolCalls, MAX_TOOL_CALLS_PER_TURN),
            ),
          )
          .returning({ eventId: agentTurns.eventId });
        if (counted.length === 0) {
          const [after] = await tx
            .select({ tainted: agentTurns.tainted })
            .from(agentTurns)
            .where(eq(agentTurns.eventId, turn.eventId));
          return refuse(after?.tainted ? "tainted" : "cap_reached");
        }

        const scopeId = await lens.ensure(ref);
        try {
          // A savepoint: a refused write leaves the counted call and the refusal's audit row in place.
          return await withSavepoint(
            tx,
            async (sp): Promise<{ fileId: string; version: number } | Refused> => {
              if (body.mode === "append") {
                return memory.appendToFile(sp, lens.actor, { scopeId, path: body.path, text: body.content });
              }
              let current: { id: string; version: number } | null = null;
              try {
                current = await memory.readFile(sp, lens.actor, { scopeId, path: body.path });
              } catch (err) {
                if (!(err instanceof HttpError && err.code === "memory_not_found")) throw err;
              }
              if (!current) {
                // The version it read is gone: read again. Without a version, a new file.
                if (body.expectedVersion !== undefined) return { refused: "not_found" };
                const created = await memory.writeFile(sp, lens.actor, {
                  op: "create",
                  scopeId,
                  path: body.path,
                  content: body.content,
                });
                if (!created) throw new Error("memory create returned nothing");
                return { fileId: created.id, version: created.version };
              }
              if (body.expectedVersion === undefined) return { refused: "version_conflict" };
              const updated = await memory.writeFile(sp, lens.actor, {
                op: "update",
                fileId: current.id,
                content: body.content,
                expectedVersion: body.expectedVersion,
              });
              if (!updated) throw new Error("memory update returned nothing");
              return { fileId: updated.id, version: updated.version };
            },
            () => true,
          ).then(async (r) => ("refused" in r ? refuse(r.refused) : r));
        } catch (err) {
          const reason = refusalOf(err);
          if (reason) return refuse(reason);
          throw err;
        }
      });
    },
  );

  // ---- propose: a change a person approves and the server applies (07.2-09 decides, counts and audits it)
  app.post(
    "/memory/propose",
    {
      ...cellRoute,
      schema: {
        tags,
        security: bearer,
        body: AgentChannelMemoryPropose,
        response: { 200: AgentChannelMemoryProposeResponse },
      },
    },
    async (req) => {
      const cell = cellOf(req);
      const body = req.body;
      return onTurn(cell, "propose", body, (tx, turn) =>
        memory.propose(tx, {
          origin: { kind: "agent_turn", eventId: turn.eventId, agentId: turn.agentId },
          scope: body.scope,
          path: body.path,
          op: body.op,
          content: body.content,
          ...(body.baseVersion === undefined ? {} : { baseVersion: body.baseVersion }),
          ...(body.reason === undefined ? {} : { reason: body.reason }),
        }),
      );
    },
  );
}
