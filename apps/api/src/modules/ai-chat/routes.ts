import {
  AiChatDetail,
  AiChatList,
  AiChatListQuery,
  AiChatSnapshot,
  CreateAiChatRequest,
  IdParams,
  IsoDateTime,
  MessagePage,
  PageQueryFields,
  SendAiMessageRequest,
  SendAiMessageResponse,
  UpdateAiChatRequest,
} from "@ocw/contracts";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type { App, Core } from "../../core";
import { chatgptPlanSeedEnabled } from "../model-gateway";
import type { AiChatService } from "./service";

/**
 * AI chat routes (owner only: every route resolves the chat through the readable set with `ai_chat` and decides
 * `ai_chat.use`; anyone else, admins included, gets 404). Sends share one per-user rate limit.
 */
export function registerAiChatRoutes(app: App, core: Core, service: AiChatService): void {
  const tags = ["ai-chat"];
  const sendLimit = app.rateLimit({
    max: core.env.OCW_AI_SEND_RATE_LIMIT_PER_MINUTE,
    timeWindow: "1 minute",
    keyGenerator: (req: FastifyRequest) => `ai-send:${req.auth?.userId ?? req.ip}`,
  });
  const send = [core.identity.requireUser, sendLimit];

  app.post(
    "/ai-chats",
    {
      config: { authz: "user" },
      preHandler: send,
      schema: { tags, body: CreateAiChatRequest, response: { 201: SendAiMessageResponse } },
    },
    async (req, reply) => reply.status(201).send(await service.createChat(req, req.body)),
  );

  app.post(
    "/ai-chats/:id/messages",
    {
      config: { authz: "user" },
      preHandler: send,
      schema: {
        tags,
        params: IdParams,
        body: SendAiMessageRequest,
        response: { 201: SendAiMessageResponse },
      },
    },
    async (req, reply) => reply.status(201).send(await service.sendMessage(req, req.params.id, req.body)),
  );

  app.get(
    "/ai-chats",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags, querystring: AiChatListQuery, response: { 200: AiChatList } },
    },
    async (req) => service.list(req, req.query),
  );

  app.patch(
    "/ai-chats/:id",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags, params: IdParams, body: UpdateAiChatRequest, response: { 200: AiChatDetail } },
    },
    async (req) => service.update(req, req.params.id, req.body),
  );

  // TEST-ONLY (05-10 e2e, P-12): only where the ChatGPT test seed exists (never in production).
  if (chatgptPlanSeedEnabled(core)) {
    app.post(
      "/test/ai/chats/:id/activity",
      {
        config: { authz: "user" },
        preHandler: core.identity.requireUser,
        schema: {
          hide: true,
          tags: ["test"],
          params: IdParams,
          body: z.object({ lastActivityAt: IsoDateTime }),
        },
      },
      async (req, reply) => {
        await service.setActivityForTest(req, req.params.id, req.body.lastActivityAt);
        return reply.status(204).send();
      },
    );
  }

  app.get(
    "/ai-chats/:id",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: { tags, params: IdParams, response: { 200: AiChatSnapshot } },
    },
    async (req) => service.snapshot(req, req.params.id),
  );

  app.get(
    "/ai-chats/:id/messages",
    {
      config: { authz: "user" },
      preHandler: core.identity.requireUser,
      schema: {
        tags,
        params: IdParams,
        querystring: PageQueryFields.pick({ before: true, limit: true }),
        response: { 200: MessagePage },
      },
    },
    async (req) => service.page(req, req.params.id, req.query),
  );
}
