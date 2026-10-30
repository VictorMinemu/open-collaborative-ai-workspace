import type { Tx } from "@ocw/db";
import type { Core } from "../../core";
import type { ApprovalService } from "../approval";
import type { AutomationService } from "./service";

/**
 * The `automation.create` approval kind (07.6-12 fills this file): a bot's natural-language proposal stored as an
 * `automation_drafts` row that only the run-as person decides; applying it creates the automation through
 * `service.create`. Until then nothing registers, and `POST /automations` refuses `fromApprovalId` (400
 * `approval_not_found`).
 */
export function registerAutomationApprovalKind(
  _approvals: ApprovalService,
  _service: AutomationService,
): void {}

/** Closes the proposal an edited form was created from ("Created with changes", R5). Nothing to close until 12. */
export async function closeDraft(
  _tx: Tx,
  _deps: { core: Core; approvals: ApprovalService },
  _p: { approvalId: string; actorUserId: string; automationId: string },
): Promise<void> {}
