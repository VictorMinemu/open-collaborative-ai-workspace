import { UserRound } from "lucide-react";
import type { Metadata } from "next";
import { ProfileForm } from "@/components/account/profile-form";
import { PageHeader } from "@/components/shell/page-header";

export const metadata: Metadata = { title: "Profile" };

export default function SettingsProfilePage() {
  return (
    <>
      <PageHeader title="Profile" icon={<UserRound />} description="How you appear to your team" />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <ProfileForm />
      </div>
    </>
  );
}
