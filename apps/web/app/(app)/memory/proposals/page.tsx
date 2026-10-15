import type { Metadata } from "next";

export const metadata: Metadata = { title: "Proposals" };

/**
 * `/memory/proposals?box=review|requested|decided`: the inbox (see layout.tsx). Every tab lists only `memory.write`
 * requests (07.5 UI-SPEC R1, `useProposalBox` → `useApprovals(role, { status, kinds: "memory.write" })`); tool calls
 * and Work Zone proposals live in `/approvals`.
 */
export default function ProposalsPage() {
  return null;
}
