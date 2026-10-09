import type { Metadata } from "next";
import { BotsGallery } from "@/components/bots/bots-gallery";
import { ModuleGate } from "@/components/shell/module-gate";

export const metadata: Metadata = { title: "Bots" };

/** A member whose Bots module is turned off (07.3) sees the in-place off state, live. */
export default function BotsPage() {
  return (
    <ModuleGate module="bots">
      <BotsGallery />
    </ModuleGate>
  );
}
