import { Cpu } from "lucide-react";
import type { Metadata } from "next";
import { ModelsSettings } from "@/components/bots/models-settings";
import { PageHeader } from "@/components/shell/page-header";

export const metadata: Metadata = { title: "Models" };

export default function SettingsModelsPage() {
  return (
    <>
      <PageHeader title="Models" icon={<Cpu />} />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <ModelsSettings />
      </div>
    </>
  );
}
