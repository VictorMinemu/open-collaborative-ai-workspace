import type { ReactNode } from "react";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SettingsSidebar />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </>
  );
}
