import { Suspense } from "react";
import { ChannelView } from "@/components/chat/channel-view";

export default async function ChannelPage({ params }: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await params;
  return (
    <Suspense>
      <ChannelView key={channelId} channelId={channelId} />
    </Suspense>
  );
}
