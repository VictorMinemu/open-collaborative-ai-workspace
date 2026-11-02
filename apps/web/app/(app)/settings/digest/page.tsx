import { Newspaper } from "lucide-react";
import type { Metadata } from "next";
import { DigestSettings } from "@/components/digest/digest-settings";
import { ModuleGate } from "@/components/shell/module-gate";
import { PageHeader } from "@/components/shell/page-header";

export const metadata: Metadata = { title: "Digest" };

/**
 * Settings › Digest (07.6-16, AUTO-05; UI-SPEC Surface 6): the member's own digest, delivered by a bot in their DMs.
 * A digest is the member's own automation, so with Bots turned off for them (07.3, ADR-0024) the page shows the
 * module's off state instead.
 */
export default function SettingsDigestPage() {
  return (
    <ModuleGate module="bots">
      <PageHeader
        title="Digest"
        icon={<Newspaper />}
        description="A short message with what needs you, on the days you choose"
      />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-3xl gap-10 px-4 py-6 sm:px-6 sm:py-8">
          <DigestSettings />
        </div>
      </div>
    </ModuleGate>
  );
}
