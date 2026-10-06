import type { Metadata } from "next";
import { ThreadsView } from "@/components/chat/views/threads-view";

export const metadata: Metadata = { title: "Threads" };

export default function ThreadsPage() {
  return <ThreadsView />;
}
