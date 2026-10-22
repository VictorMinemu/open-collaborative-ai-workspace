import {
  type BrowserActivityItem,
  type BrowserContextRow,
  type BrowserConversationKind,
  BrowserSessionList,
  BrowserTabView,
  IdParams,
  isAgentCardRoute,
} from "@ocw/contracts";
import {
  botSandboxes,
  browserContexts,
  browserSessions,
  browserSigninRequests,
  conversations,
  orgMembers,
  type Tx,
} from "@ocw/db";
import { and, desc, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { markDecided } from "../../authz";
import { type App, authOf, type Core, tenant } from "../../core";
import { notFound } from "../../lib/errors";
import { agentFactsOf, type ConversationAccess, loadDirectory } from "../chat";
import { agentResource, browserContextResource, type PermissionService } from "../organization";
import type { SandboxdClient } from "../sandbox";
import { auditClosed, closeContext } from "./contexts";
import { registerConversationBrowsers } from "./conversation-browsers";
import { listMine, revoke } from "./sessions";
import { announce, leaseLive } from "./takeover";

/**
 * The people's browser routes (07.8-21; D-06, D-08, R7, UI-SPEC § 3.6 and § 4.5), all `authz: user`:
 *
 * - `GET /browser-sessions`: the caller's OWN sealed sessions (site, bot, dates, status), never anything sealed;
 * - `DELETE /browser-sessions/:id`: revokes one of them (the secret goes, the pages that had it loaded end). Another
 *   member's id, an admin's attempt and another organization's id are all 404: the owner-only policy hides the row;
 * - `GET /agents/:id/browser`: the bot page's Browser tab: the open pages the caller may watch (the resolver's
 *   `browser.watch`, as the live view decides it), private rows for pages that are someone else's (a member's session
 *   or a takeover), and the host-level activity in conversations the caller reads. Pages and addresses are never kept.
 */

const tags = ["browser"];
const ACTIVITY_PAGE = 20;
const OPEN_MAX = 50;
const SCAN = 200;
const STOPPED = ["kill_switch", "module_off", "crashed"] as const;

const BrowserTabQuery = z.object({ cursor: z.string().max(200).optional() });

export interface BrowserRouteDeps {
  core: Core;
  perms: PermissionService;
  access: ConversationAccess;
  client: SandboxdClient | null;
}

type Conv = typeof conversations.$inferSelect;

/** The conversation as the tab names it, with the app route the web opens (an internal card route only). */
function conversationOf(conv: Conv, parent: Conv | null) {
  const kind: BrowserConversationKind =
    conv.kind === "thread" ? "thread" : (conv.kind as BrowserConversationKind);
  const route =
    conv.kind === "channel"
      ? `/chat/${conv.id}`
      : conv.kind === "thread" && parent && conv.rootMessageId
        ? `/chat/${parent.id}?thread=${conv.rootMessageId}`
        : conv.kind === "dm" || conv.kind === "group"
          ? `/chat/dm/${conv.id}`
          : conv.kind === "ai_chat"
            ? `/chat/ai/${conv.id}`
            : "/chat";
  const name = (conv.kind === "thread" ? parent?.name : conv.name) ?? "";
  return { kind, name: name.slice(0, 200), route: isAgentCardRoute(route) ? route : "/chat" };
}

export function registerBrowserRoutes(app: App, deps: BrowserRouteDeps): void {
  const { core, perms, access } = deps;
  const user = { config: { authz: "user" as const }, preHandler: [core.identity.requireUser] };
  // 07.8-26: the conversation header's live chip.
  registerConversationBrowsers(app, { core, perms, access });

  app.get(
    "/browser-sessions",
    { ...user, schema: { tags, response: { 200: BrowserSessionList } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      // The member's own rows, whatever their modules say (a session they can no longer use is still theirs to see
      // and revoke): the owner-only policy is the decision, as for their connector connections.
      markDecided(req);
      const { userId } = authOf(req);
      return { items: await core.db.withTenant(tenant(req), (tx) => listMine(tx, userId)) };
    },
  );

  app.delete("/browser-sessions/:id", { ...user, schema: { tags, params: IdParams } }, async (req, reply) => {
    // Owner-only: the policy decides (anyone else's id is 404 below), whatever the caller's modules say.
    markDecided(req);
    const { userId, organizationId } = authOf(req);
    const ended = await core.db.withTenant(tenant(req), async (tx) => {
      // The owner-only policy decides first: anyone else's id (an admin's attempt included) is simply missing.
      const [mine] = await tx
        .select({ id: browserSessions.id })
        .from(browserSessions)
        .where(eq(browserSessions.id, req.params.id))
        .limit(1);
      if (!mine) throw notFound("Browser session not found");
      // The pages that have it loaded hold its cookies: found before the revoke unlinks them, ended after it.
      const pages = await tx
        .select({ id: browserContexts.id })
        .from(browserContexts)
        .where(and(eq(browserContexts.sessionId, mine.id), isNull(browserContexts.closedAt)));
      if (!(await revoke(tx, core, { userId, id: mine.id }))) throw notFound("Browser session not found");
      return endPages(
        tx,
        pages.map((p) => p.id),
      );
    });
    for (const page of ended) {
      await deps.client
        ?.call(
          "contextClose",
          { target: { orgId: organizationId, agentId: page.agentId }, contextId: page.id },
          { timeoutMs: 15_000 },
        )
        .catch(() => {});
      await announce(core.bus, organizationId, page.id);
    }
    return reply.code(204).send();
  });

  /** Ends the pages a revoked session was loaded in (`access_lost`, audited): their cookies must not stay usable. */
  async function endPages(tx: Tx, ids: string[]) {
    const ended: Array<{ id: string; agentId: string }> = [];
    for (const id of ids) {
      const row = await closeContext(tx, id, "access_lost");
      if (row) {
        await auditClosed(tx, core, row, "access_lost", { revoked: true });
        ended.push({ id: row.id, agentId: row.agentId });
      }
    }
    return ended;
  }

  app.get(
    "/agents/:id/browser",
    {
      ...user,
      schema: { tags, params: IdParams, querystring: BrowserTabQuery, response: { 200: BrowserTabView } },
    },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), (tx) => tabView(req, tx, req.params.id, req.query.cursor));
    },
  );

  async function tabView(
    req: FastifyRequest,
    tx: Tx,
    agentId: string,
    cursor: string | undefined,
  ): Promise<BrowserTabView> {
    const viewerId = authOf(req).userId;
    const dir = await loadDirectory(tx);
    const bot = dir.agents.get(agentId);
    if (!bot || bot.deleted) throw notFound("Bot not found");
    await perms.assertCan(req, tx, "bot.read", agentResource(agentFactsOf(bot), viewerId), {
      hideAs404: true,
    });
    const owner = bot.ownerUserId === viewerId;

    const convCache = new Map<string, { conv: Conv; parent: Conv | null } | null>();
    const convOf = async (id: string) => {
      if (convCache.has(id)) return convCache.get(id) ?? null;
      const [conv] = await tx.select().from(conversations).where(eq(conversations.id, id)).limit(1);
      const [parent] =
        conv?.kind === "thread" && conv.parentConversationId
          ? await tx
              .select()
              .from(conversations)
              .where(eq(conversations.id, conv.parentConversationId))
              .limit(1)
          : [];
      const v = conv ? { conv, parent: parent ?? null } : null;
      convCache.set(id, v);
      return v;
    };
    const readable = new Map<string, boolean>();
    const reads = async (conversationId: string) => {
      const known = readable.get(conversationId);
      if (known !== undefined) return known;
      // A thread is read through its channel or DM (single-level threads), as the bots' turns are judged.
      const c = await convOf(conversationId);
      const judged = c?.conv.kind === "thread" ? (c.parent?.id ?? null) : (c?.conv.id ?? null);
      const v =
        judged !== null &&
        (await access.isReadable(tx, viewerId, judged, { kinds: ["channel", "dm", "group", "ai_chat"] }));
      readable.set(conversationId, v);
      return v;
    };
    const names = new Map(
      (await tx.select({ id: orgMembers.userId, name: orgMembers.displayName }).from(orgMembers)).map((m) => [
        m.id,
        m.name,
      ]),
    );

    // Open now: what the resolver lets the viewer watch, and private rows for someone else's page.
    const open: BrowserContextRow[] = [];
    const pages = await tx
      .select()
      .from(browserContexts)
      .where(and(eq(browserContexts.agentId, agentId), isNull(browserContexts.closedAt)))
      .orderBy(desc(browserContexts.openedAt))
      .limit(OPEN_MAX);
    for (const page of pages) {
      const reader = await reads(page.conversationId);
      if (!reader && !owner) continue;
      const c = await convOf(page.conversationId);
      if (!c) continue;
      const resource = browserContextResource({
        reader,
        botOwner: owner,
        requester: page.requestedForUserId === viewerId,
        memberSession: page.sessionId !== null,
      });
      const principal = { kind: "user" as const, userId: viewerId };
      const watch = await perms.decide(tx, principal, "browser.watch", resource);
      const control = await perms.decide(tx, principal, "browser.control", resource);
      const leased = leaseLive(page) && page.controllerUserId !== viewerId;
      const privateFor =
        !watch.allowed && watch.denial?.reason === "member_session"
          ? (names.get(page.requestedForUserId) ?? "a member")
          : leased
            ? (names.get(page.controllerUserId ?? "") ?? "a member")
            : null;
      if (!watch.allowed && privateFor === null) continue;
      open.push({
        contextId: page.id,
        host: page.host,
        secure: page.secure,
        state: privateFor ? "private" : page.pausedFor ? "paused" : page.state === "idle" ? "idle" : "live",
        conversation: conversationOf(c.conv, c.parent),
        openedAt: new Date(String(page.openedAt)).toISOString(),
        viewerCan: { watch: watch.allowed && !privateFor, control: control.allowed && !privateFor },
        privateFor: privateFor ? privateFor.slice(0, 200) : null,
      });
    }

    // Recent activity: host-level events only, in conversations the viewer reads, newest first, keyset by time.
    const before = cursor && !Number.isNaN(Date.parse(cursor)) ? new Date(cursor).toISOString() : null;
    const opened = await tx
      .select({
        at: browserContexts.openedAt,
        host: browserContexts.host,
        conversationId: browserContexts.conversationId,
      })
      .from(browserContexts)
      .where(
        and(eq(browserContexts.agentId, agentId), ...(before ? [lt(browserContexts.openedAt, before)] : [])),
      )
      .orderBy(desc(browserContexts.openedAt))
      .limit(SCAN);
    const stopped = await tx
      .select({
        at: browserContexts.closedAt,
        host: browserContexts.host,
        conversationId: browserContexts.conversationId,
      })
      .from(browserContexts)
      .where(
        and(
          eq(browserContexts.agentId, agentId),
          isNotNull(browserContexts.closedAt),
          inArray(browserContexts.endReason, [...STOPPED]),
          ...(before ? [lt(browserContexts.closedAt, before)] : []),
        ),
      )
      .orderBy(desc(browserContexts.closedAt))
      .limit(SCAN);
    const signedIn = await tx
      .select({
        at: browserSigninRequests.decidedAt,
        host: browserSigninRequests.host,
        conversationId: browserSigninRequests.conversationId,
        actor: browserSigninRequests.requesterUserId,
      })
      .from(browserSigninRequests)
      .where(
        and(
          eq(browserSigninRequests.agentId, agentId),
          eq(browserSigninRequests.status, "signed_in"),
          isNotNull(browserSigninRequests.decidedAt),
          ...(before ? [lt(browserSigninRequests.decidedAt, before)] : []),
        ),
      )
      .orderBy(desc(browserSigninRequests.decidedAt))
      .limit(SCAN);
    const events = [
      ...opened.map((e) => ({ kind: "opened" as const, actor: null as string | null, ...e })),
      ...stopped.map((e) => ({ kind: "stopped" as const, actor: null as string | null, ...e })),
      ...signedIn.map((e) => ({ ...e, kind: "signed_in" as const })),
    ]
      .filter((e) => e.at !== null)
      .sort((a, b) => Date.parse(String(b.at)) - Date.parse(String(a.at)));
    const activity: BrowserActivityItem[] = [];
    let more = false;
    for (const e of events) {
      if (!(await reads(e.conversationId))) continue;
      if (activity.length === ACTIVITY_PAGE) {
        more = true;
        break;
      }
      const c = await convOf(e.conversationId);
      if (!c) continue;
      const { route: _route, ...conversation } = conversationOf(c.conv, c.parent);
      activity.push({
        kind: e.kind,
        host: e.host,
        conversation,
        at: new Date(String(e.at)).toISOString(),
        actor: e.actor
          ? { id: e.actor, displayName: (names.get(e.actor) ?? "Former member").slice(0, 200) }
          : null,
      });
    }
    const [brw] = await tx
      .select({ runtime: botSandboxes.runtime })
      .from(botSandboxes)
      .where(and(eq(botSandboxes.agentId, agentId), eq(botSandboxes.kind, "brw")))
      .limit(1);
    return {
      open,
      activity,
      nextCursor: more ? (activity.at(-1)?.at ?? null) : null,
      runtime: brw?.runtime ?? null,
    };
  }
}
