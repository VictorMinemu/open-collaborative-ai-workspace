import { Network } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";
import { OrgStructure } from "@/components/organization/org-structure";
import { PageHeader } from "@/components/shell/page-header";

export const metadata: Metadata = { title: "Organization" };

export default function SettingsOrganizationPage() {
  return (
    <>
      <PageHeader title="Organization" icon={<Network />} description="Departments, teams and projects" />
      {/* Below lg the whole column scrolls; at lg and up the tree and the detail scroll independently. */}
      <div className="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto lg:overflow-hidden">
        <Suspense>
          <OrgStructure />
        </Suspense>
      </div>
    </>
  );
}
