import type { Metadata } from "next";
import { ProjectsIndex } from "@/components/work-zone/projects/projects-index";

export const metadata: Metadata = { title: "Projects · Work Zone" };

/** `/work-zone/projects` (UI-SPEC § 4.1): a static segment, matched before the `[id]` session route (R8). */
export default function WorkZoneProjectsPage() {
  return <ProjectsIndex />;
}
