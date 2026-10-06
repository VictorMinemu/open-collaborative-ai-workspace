import type { Metadata } from "next";
import { Suspense } from "react";
import { SearchPageView } from "@/components/search/search-results";

export const metadata: Metadata = { title: "Search" };

export default function SearchPage() {
  return (
    <Suspense>
      <SearchPageView />
    </Suspense>
  );
}
