import { Sparkles } from "lucide-react";
import type { Metadata } from "next";
import { ChatgptPlanCard } from "@/components/ai-chat/settings/chatgpt-plan-card";
import { PreferencesCard } from "@/components/ai-chat/settings/preferences-card";
import { UsageCard } from "@/components/ai-chat/settings/usage-card";
import { ModuleGate } from "@/components/shell/module-gate";
import { PageHeader } from "@/components/shell/page-header";

export const metadata: Metadata = { title: "AI chat" };

/**
 * Settings › AI chat: the member's own ChatGPT plan first, then their AI chat preferences (05-11: personal
 * instructions, default model, Web default), then their own usage (05-09). With AI chats turned off for the member
 * (07.3, ADR-0024) the page shows the module's off state instead.
 */
export default function SettingsAiChatPage() {
  return (
    <ModuleGate module="ai_chats">
      <PageHeader
        title="AI chat"
        icon={<Sparkles />}
        description="Your ChatGPT plan, usage and AI chat preferences"
      />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-3xl gap-10 px-4 py-6 sm:px-6 sm:py-8">
          <ChatgptPlanCard />
          <PreferencesCard />
          <UsageCard />
        </div>
      </div>
    </ModuleGate>
  );
}
