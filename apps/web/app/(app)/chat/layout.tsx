import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ChatSidebar } from "@/components/chat/chat-sidebar";
import "./chat.css";

export const metadata: Metadata = { title: "Chat" };

/** Channel sidebar persists while switching channels; pages render the content column. */
export default function ChatLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <ChatSidebar />
      {children}
    </>
  );
}
