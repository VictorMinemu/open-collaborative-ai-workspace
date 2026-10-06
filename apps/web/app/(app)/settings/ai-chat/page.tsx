import { Sparkles } from "lucide-react";
import type { Metadata } from "next";
import { ChatgptPlanCard } from "@/components/ai-chat/settings/chatgpt-plan-card";
import { PageHeader } from "@/components/shell/page-header";

export const metadata: Metadata = { title: "AI chat" };

/** Settings › AI chat: the member's own ChatGPT plan first; later plans add sections below it. */
export default function SettingsAiChatPage() {
  return (
    <>
      <PageHeader
        title="AI chat"
        icon={<Sparkles />}
        description="Your ChatGPT plan and AI chat preferences"
      />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-3xl gap-10 px-4 py-6 sm:px-6 sm:py-8">
          <ChatgptPlanCard />
        </div>
      </div>
    </>
  );
}
