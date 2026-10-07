import {
  SearchChannelsResult,
  SearchMessagesResult,
  SearchOverview,
  SearchPeopleResult,
  SearchQuery,
  SearchTextQuery,
} from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import type { FastifyRequest } from "fastify";
import { markDecided } from "../../authz";
import { type ApiModule, type App, authOf, type Core, tenant } from "../../core";
import { createConversationAccess } from "../chat";
import { loadDirectory } from "../chat/directory";
import { agentResource, createPermissionService } from "../organization";
import {
  type ModelLabelOf,
  type PersonCandidate,
  searchAiChats,
  searchChannels,
  searchMessages,
  searchPeople,
} from "./service";

export {
  conversationRefs,
  type ModelLabelOf,
  searchAiChats,
  searchChannels,
  searchMessages,
  searchPeople,
} from "./service";

/**
 * Every kind a member can search (P-03): AI chats join the readable set here; the resolver keeps each one its
 * owner's alone (admins included), SQL only narrows.
 */
const SEARCH_KINDS = ["channel", "dm", "group", "ai_chat"] as const;

/** Items per section of the ⌘K overview. */
const OVERVIEW_LIMIT = 5;
/** People and channels routes. */
const LIST_LIMIT = 20;

/**
 * Search module (CHAT-11, D-04): messages (PostgreSQL full-text), people and channels (pg_trgm) for the ⌘K
 * palette and the results page. Every route computes the caller's readable set through the resolver (P-03)
 * before any search runs, so admins see exactly what they could open, and shares one 30/min/user budget (P-11).
 */
export function createSearchModule(core: Core, deps: { modelLabel?: ModelLabelOf } = {}): ApiModule {
  const labelOf = deps.modelLabel;
  const access = createConversationAccess(core);
  const perms = createPermissionService(core);

  /**
   * People the resolver lets the caller see: members only with `member.read` (the /members directory's
   * permission), bots through `bot.read` per bot, exactly like GET /agents.
   */
  function visiblePeople(req: FastifyRequest, tx: Tx) {
    return async (candidates: PersonCandidate[]): Promise<PersonCandidate[]> => {
      const me = authOf(req).userId;
      const users = candidates.filter((c) => c.kind === "user");
      const canReadMembers = users.length > 0 && (await perms.can(req, tx, "member.read"));
      const bots = await perms.filter(
        req,
        tx,
        candidates.filter((c) => c.kind === "agent"),
        "bot.read",
        (a) =>
          agentResource(
            {
              scope: a.scope ?? "team",
              ownerUserId: a.ownerUserId ?? null,
              disabled: a.status === "disabled",
            },
            me,
          ),
      );
      const keep = new Set([...(canReadMembers ? users : []), ...bots]);
      return candidates.filter((c) => keep.has(c));
    };
  }

  /**
   * The readable conversation ids (archived included, labelled in results). `readableIds` decides every id with
   * the resolver (`channel.read`), so the request is a resolver decision for the authz coverage hook.
   */
  async function readableFor(req: FastifyRequest, tx: Tx): Promise<string[]> {
    const ids = await access.readableIds(tx, authOf(req).userId, {
      includeArchived: true,
      kinds: SEARCH_KINDS,
    });
    markDecided(req);
    return ids;
  }

  return {
    name: "search",
    register(app: App) {
      const requireUser = core.identity.requireUser;
      const tags = ["search"];
      // One handler (one store) on every search route: the budget is per user across the overview, messages,
      // people and channels, and it runs after requireUser so the key is the user, not the IP.
      const limit = app.rateLimit({
        max: core.env.OCW_SEARCH_RATE_LIMIT_PER_MINUTE,
        timeWindow: "1 minute",
        keyGenerator: (req: FastifyRequest) => `search:${req.auth?.userId ?? req.ip}`,
      });
      const preHandler = [requireUser, limit];

      app.get(
        "/search",
        {
          config: { authz: "user" },
          preHandler,
          schema: { tags, querystring: SearchTextQuery, response: { 200: SearchOverview } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const me = authOf(req).userId;
            const readableIds = await readableFor(req, tx);
            const dir = await loadDirectory(tx);
            const { q } = req.query;
            const messages = await searchMessages(tx, {
              readableIds,
              viewerId: me,
              q,
              limit: OVERVIEW_LIMIT,
              dir,
              labelOf,
            });
            const people = await searchPeople(tx, {
              viewerId: me,
              q,
              limit: OVERVIEW_LIMIT,
              dir,
              visible: visiblePeople(req, tx),
            });
            const channels = await searchChannels(tx, {
              readableIds,
              viewerId: me,
              q,
              limit: OVERVIEW_LIMIT,
            });
            const aiChats = await searchAiChats(tx, {
              readableIds,
              viewerId: me,
              q,
              limit: OVERVIEW_LIMIT,
              labelOf,
            });
            return { messages: messages.hits, people, channels, aiChats };
          }),
      );

      app.get(
        "/search/messages",
        {
          config: { authz: "user" },
          preHandler,
          schema: { tags, querystring: SearchQuery, response: { 200: SearchMessagesResult } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const readableIds = await readableFor(req, tx);
            const { q, in: inConv, from, after, before, cursor, limit: pageSize } = req.query;
            return searchMessages(tx, {
              readableIds,
              viewerId: authOf(req).userId,
              q,
              in: inConv,
              from,
              after,
              before,
              cursor,
              limit: pageSize,
              dir: await loadDirectory(tx),
              labelOf,
            });
          }),
      );

      app.get(
        "/search/people",
        {
          config: { authz: "user" },
          preHandler,
          schema: { tags, querystring: SearchTextQuery, response: { 200: SearchPeopleResult } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const people = await searchPeople(tx, {
              viewerId: authOf(req).userId,
              q: req.query.q,
              limit: LIST_LIMIT,
              dir: await loadDirectory(tx),
              visible: visiblePeople(req, tx),
            });
            // An empty candidate list decided nothing yet; the answer is still the resolver's (no rows to judge).
            markDecided(req);
            return { people };
          }),
      );

      app.get(
        "/search/channels",
        {
          config: { authz: "user" },
          preHandler,
          schema: { tags, querystring: SearchTextQuery, response: { 200: SearchChannelsResult } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const readableIds = await readableFor(req, tx);
            return {
              channels: await searchChannels(tx, {
                readableIds,
                viewerId: authOf(req).userId,
                q: req.query.q,
                limit: LIST_LIMIT,
              }),
            };
          }),
      );
    },
  };
}
