import { Suspense } from "react";
import { DmView } from "@/components/chat/dm-view";

export default async function DmPage({ params }: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await params;
  return (
    <Suspense>
      <DmView key={conversationId} conversationId={conversationId} />
    </Suspense>
  );
}
