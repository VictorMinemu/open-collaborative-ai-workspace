import { ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import { ChangePasswordForm } from "@/components/account/change-password-form";
import { SessionsList } from "@/components/account/sessions-list";
import { PageHeader } from "@/components/shell/page-header";

export const metadata: Metadata = { title: "Security" };

export default function SettingsSecurityPage() {
  return (
    <>
      <PageHeader title="Security" icon={<ShieldCheck />} description="Sessions and password" />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-3xl gap-10 px-4 py-6 sm:px-6 sm:py-8">
          <SessionsList />
          <ChangePasswordForm />
        </div>
      </div>
    </>
  );
}
