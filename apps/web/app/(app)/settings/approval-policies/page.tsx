import type { Metadata } from "next";
import { Suspense } from "react";
import { ApprovalPoliciesSettings } from "@/components/settings/approval-policies-settings";

export const metadata: Metadata = { title: "Approval policies" };

/**
 * Settings › Approval policies (07.5-09; APPROVE-01, D-01, UI-SPEC Surface 4): which bot actions need a person first,
 * per tool or per server, and who approves. Admins and unit leads; the API decides access and every change. The page
 * header lives in the component (its Change history action needs the scope).
 */
export default function SettingsApprovalPoliciesPage() {
  return (
    <Suspense fallback={null}>
      <ApprovalPoliciesSettings />
    </Suspense>
  );
}
