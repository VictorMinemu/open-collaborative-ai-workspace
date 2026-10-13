import type { Metadata } from "next";

export const metadata: Metadata = { title: "Memory" };

/**
 * `/memory/<scopeId>` and `/memory/<scopeId>/<…path>`: the layout's shell reads the segments, re-joins and re-parses
 * them with the shared path grammar before any request (an invalid path is the not-found state).
 */
export default function MemoryFilePage() {
  return null;
}
