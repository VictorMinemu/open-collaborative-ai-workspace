import type { Metadata } from "next";
import { MemoryKindRedirect } from "@/components/approvals/approval-review";

export const metadata: Metadata = { title: "Proposal" };

/**
 * `/memory/proposals/<id>`: one proposal's review beside the inbox (see ../layout.tsx). A request that is not a memory
 * proposal (07.5: a tool call or a Work Zone proposal) is sent to `/approvals/<id>` (UI-SPEC R1).
 */
export default function ProposalPage() {
  return <MemoryKindRedirect />;
}
