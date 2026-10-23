import type { Metadata } from "next";
import { ProjectPage } from "@/components/work-zone/projects/project-page";
import { projectTabOf } from "@/lib/work-zone-routes";

export const metadata: Metadata = { title: "Project · Work Zone" };

/** `/work-zone/projects/<unitId>[?tab=settings]` (UI-SPEC § 4.2): an unknown tab falls back to Sessions. */
export default async function WorkZoneProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ unitId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ unitId }, query] = await Promise.all([params, searchParams]);
  return <ProjectPage key={unitId} unitId={unitId} tab={projectTabOf(query.tab)} />;
}
