import {
  ApprovalDecisionRequest,
  ApprovalDetail,
  ApprovalList,
  ApprovalListQuery,
  ApprovalSummary,
  IdParams,
} from "@ocw/contracts";
import { markDecided } from "../../authz";
import { type App, authOf, type Core, tenant } from "../../core";
import type { ApprovalService } from "./service";

/**
 * The approvals inbox (D-08): approvers may not read the conversation a request was born in, so the primitive has its
 * own routes. Every answer is decided by the kind's live `canDecide` (through the resolver); a request the caller may
 * neither decide nor asked for is 404. Authenticated on request: an anonymous caller gets 401 before validation.
 */
export function registerApprovalRoutes(app: App, ctx: { core: Core; service: ApprovalService }): void {
  const { core, service } = ctx;
  const tags = ["approvals"];
  const user = { config: { authz: "user" as const }, onRequest: core.identity.requireUser };

  app.get(
    "/approvals",
    { ...user, schema: { tags, querystring: ApprovalListQuery, response: { 200: ApprovalList } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const list = await service.list(tx, authOf(req).userId, req.query);
        markDecided(req);
        return list;
      }),
  );

  app.get(
    "/approvals/:id",
    { ...user, schema: { tags, params: IdParams, response: { 200: ApprovalDetail } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const detail = await service.get(tx, req.params.id, authOf(req).userId);
        markDecided(req);
        return detail;
      }),
  );

  app.post(
    "/approvals/:id/decision",
    {
      ...user,
      schema: { tags, params: IdParams, body: ApprovalDecisionRequest, response: { 200: ApprovalSummary } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const summary = await service.decide(tx, {
          id: req.params.id,
          deciderUserId: authOf(req).userId,
          outcome: req.body.outcome,
          actionHash: req.body.actionHash,
          note: req.body.note,
        });
        markDecided(req);
        return summary;
      }),
  );
}
