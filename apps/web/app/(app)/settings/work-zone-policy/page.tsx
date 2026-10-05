import { LockKeyhole } from "lucide-react";
import type { Metadata } from "next";
import { WorkZonePolicySettings } from "@/components/settings/work-zone-policy-settings";
import { PageHeader } from "@/components/shell/page-header";

export const metadata: Metadata = { title: "Work Zone policy" };

export default function SettingsWorkZonePolicyPage() {
  return (
    <>
      <PageHeader title="Work Zone policy" icon={<LockKeyhole />} />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-5xl gap-10 px-4 py-6 sm:px-6 sm:py-8">
          <WorkZonePolicySettings />
        </div>
      </div>
    </>
  );
}
