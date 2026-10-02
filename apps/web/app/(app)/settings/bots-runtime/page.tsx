import { Server } from "lucide-react";
import type { Metadata } from "next";
import { BotsRuntimeSettings } from "@/components/bots/bots-runtime-settings";
import { PageHeader } from "@/components/shell/page-header";

export const metadata: Metadata = { title: "Bots runtime" };

export default function SettingsBotsRuntimePage() {
  return (
    <>
      <PageHeader title="Bots runtime" icon={<Server />} />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <BotsRuntimeSettings />
      </div>
    </>
  );
}
