import type { Metadata } from "next";
import { Inbox } from "@/components/chat/inbox";

export const metadata: Metadata = { title: "Mentions" };

export default function MentionsPage() {
  return <Inbox />;
}
