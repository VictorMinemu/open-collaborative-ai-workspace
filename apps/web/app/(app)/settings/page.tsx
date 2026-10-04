import { Users } from "lucide-react";
import type { Metadata } from "next";
import { MembersSettings } from "@/components/settings/members-settings";
import { PageHeader } from "@/components/shell/page-header";

export const metadata: Metadata = { title: "Members" };

export default function SettingsMembersPage() {
  return (
    <>
      <PageHeader title="Members & invitations" icon={<Users />} />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <MembersSettings />
      </div>
    </>
  );
}
