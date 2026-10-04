import { Laptop } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";
import { DevicesSettings } from "@/components/settings/devices-settings";
import { PageHeader } from "@/components/shell/page-header";

export const metadata: Metadata = { title: "Devices" };

export default function SettingsDevicesPage() {
  return (
    <>
      <PageHeader
        title="Devices"
        icon={<Laptop />}
        description="Pair computers that run your coding agents"
      />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <Suspense>
          <DevicesSettings />
        </Suspense>
      </div>
    </>
  );
}
