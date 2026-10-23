import { Container } from "lucide-react";
import type { Metadata } from "next";
import { SandboxSettings } from "@/components/sandbox/settings/sandbox-settings";
import { PageHeader } from "@/components/shell/page-header";

export const metadata: Metadata = { title: "Sandbox & Browser" };

/**
 * Settings › Sandbox & Browser (07.8-19; D-09, D-11, D-12, UI-SPEC §4.2): the organization switch, the isolation in
 * use, limits, network rules and the kill switch. Admins only: the nav entry needs `bot.manage` and the API refuses
 * anyone else; a direct visit without it shows "You can't manage sandboxes".
 */
export default function SettingsSandboxPage() {
  return (
    <>
      <PageHeader
        title="Sandbox & Browser"
        icon={<Container />}
        description="Where bots run commands and browse, and the limits they share"
      />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <SandboxSettings />
      </div>
    </>
  );
}
