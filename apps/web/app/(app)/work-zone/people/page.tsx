import type { Metadata } from "next";
import { Suspense } from "react";
import { PeopleView } from "@/components/work-zone/people/people-view";

export const metadata: Metadata = { title: "Sessions by person · Work Zone" };

/**
 * `/work-zone/people[?person=&project=&device=]` (07.13.1.1, D-01): a static segment, matched before the `[id]` session
 * route (as `/work-zone/projects`); `isSessionPath` excludes it, so the module-off gate never keeps it open. The view
 * reads its filters with `useSearchParams`, hence the Suspense boundary.
 */
export default function WorkZonePeoplePage() {
  return (
    <Suspense>
      <PeopleView />
    </Suspense>
  );
}
