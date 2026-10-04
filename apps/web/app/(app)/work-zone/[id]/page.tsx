import type { Metadata } from "next";
import { SessionView } from "@/components/work-zone/session-view";

export const metadata: Metadata = { title: "Work Zone" };

export default async function WorkSessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SessionView key={id} id={id} />;
}
