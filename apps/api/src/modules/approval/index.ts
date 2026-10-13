import type { ApiModule, App, Core } from "../../core";
import { registerApprovalRoutes } from "./routes";
import { type ApprovalService, createApprovalService } from "./service";

/**
 * The `approval` module (MEM-06, D-05, D-08, ADR-0023): the reusable approve-and-apply primitive. Kinds register on
 * the service (07.2 memory proposals, 07.5 tool-call grants, 07.6 automation confirmations); this module never imports
 * them, and chat reaches it only through the chat-agent bridge.
 */
export { actionHash, type HashAtom } from "./hash";
export type { ApplyResult, ApprovalKind, ApprovalRow } from "./registry";
export type {
  ApprovalService,
  ConsumeGrantResult,
  DecideInput,
  RequestApprovalInput,
} from "./service";

export function createApprovalModule(core: Core): { module: ApiModule; service: ApprovalService } {
  const service = createApprovalService(core);
  // Chat shows and decides the cards that mirror a request through the bridge (it never imports this module).
  core.chatAgent.registerLinkedCards(service.linkedCards);
  return {
    service,
    module: {
      name: "approval",
      register(app: App) {
        registerApprovalRoutes(app, { core, service });
      },
    },
  };
}
