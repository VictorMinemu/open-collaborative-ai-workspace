import type { Metadata } from "next";
import { WorkZoneHome } from "@/components/work-zone/work-zone-home";

export const metadata: Metadata = { title: "Work Zone" };

export default function WorkZonePage() {
  return <WorkZoneHome />;
}
