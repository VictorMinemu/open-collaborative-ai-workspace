import { Store } from "lucide-react";
import type { Metadata } from "next";
import { MarketplaceSettings } from "@/components/marketplace/marketplace-settings";
import { PageHeader } from "@/components/shell/page-header";

export const metadata: Metadata = { title: "Marketplace" };

export default function SettingsMarketplacePage() {
  return (
    <>
      <PageHeader title="Marketplace" icon={<Store />} description="OpenClaw plugins for your bots" />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <MarketplaceSettings />
      </div>
    </>
  );
}
