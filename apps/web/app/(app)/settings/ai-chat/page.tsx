import { Sparkles } from "lucide-react";
import type { Metadata } from "next";
import { ChatgptPlanCard } from "@/components/ai-chat/settings/chatgpt-plan-card";
import { UsageCard } from "@/components/ai-chat/settings/usage-card";
import { PageHeader } from "@/components/shell/page-header";

export const metadata: Metadata = { title: "AI chat" };

/** Settings › AI chat: the member's own ChatGPT plan first, then their own usage (05-09); later plans add sections below. */
export default function SettingsAiChatPage() {
  return (
    <>
      <PageHeader
        title="AI chat"
        icon={<Sparkles />}
        description="Your ChatGPT plan, usage and AI chat preferences"
      />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-3xl gap-10 px-4 py-6 sm:px-6 sm:py-8">
          <ChatgptPlanCard />
          <UsageCard />
        </div>
      </div>
    </>
  );
}
