import { Blocks } from "lucide-react";
import type { Metadata } from "next";
import { OrganizationModulesCard } from "@/components/organization/module-access-card";
import { PageHeader } from "@/components/shell/page-header";

export const metadata: Metadata = { title: "Modules" };

/**
 * Settings › Modules (07.3-04, ADR-0024, P-07): Work Zone, AI chats and Bots on or off for the whole organization and
 * per person, plus the units where something is off. Admins only: the nav entry needs the organization-scope
 * `unit.modules.manage` and the API refuses anyone else. Departments and teams live in Settings › Organization.
 */
export default function SettingsModulesPage() {
  return (
    <>
      <PageHeader
        title="Modules"
        icon={<Blocks />}
        description="Turn modules on or off for the whole organization or for one person. Departments and teams: Settings › Organization."
      />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-3xl gap-10 px-4 py-6 sm:px-6 sm:py-8">
          <OrganizationModulesCard />
        </div>
      </div>
    </>
  );
}
