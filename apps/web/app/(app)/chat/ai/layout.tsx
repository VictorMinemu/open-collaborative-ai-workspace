import type { ReactNode } from "react";
import { ModuleGate } from "@/components/shell/module-gate";

/**
 * `/chat/ai`, `/chat/ai/new` and `/chat/ai/<id>` (07.3, ADR-0024): a member whose AI chats are turned off sees the
 * in-place off state; the chat layout keeps the sidebar beside it. The API refuses on its own.
 */
export default function AiChatsLayout({ children }: { children: ReactNode }) {
  return <ModuleGate module="ai_chats">{children}</ModuleGate>;
}
