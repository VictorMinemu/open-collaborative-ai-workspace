import type { Metadata } from "next";
import { ShareView } from "@/components/ai-chat/share-view";

/**
 * A shared AI chat snapshot (05-13, AICHAT-09). Inside the signed-in app group: the layout's guard sends a signed-out
 * visitor to sign in (and back here afterwards); the API decides who may read it. Never public.
 */
export const metadata: Metadata = { title: "Shared AI chat", robots: { index: false, follow: false } };

export default async function SharedAiChatPage({ params }: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await params;
  return <ShareView key={shareId} shareId={shareId} />;
}
