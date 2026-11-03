import { ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import { AgentConsultSettings } from "@/components/settings/agent-consult-settings";
import { BotPolicySettings } from "@/components/settings/bot-policy-settings";
import { PersonalBotsTable } from "@/components/settings/personal-bots-table";
import { PageHeader } from "@/components/shell/page-header";

export const metadata: Metadata = { title: "Bot policy" };

export default function SettingsBotPolicyPage() {
  return (
    <>
      <PageHeader title="Bot policy" icon={<ShieldCheck />} />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-5xl gap-10 px-4 py-6 sm:px-6 sm:py-8">
          <BotPolicySettings />
          <AgentConsultSettings />
          <PersonalBotsTable />
        </div>
      </div>
    </>
  );
}
