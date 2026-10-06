import type { Metadata } from "next";
import { AllView } from "@/components/chat/views/all-view";

export const metadata: Metadata = { title: "All" };

export default function AllPage() {
  return <AllView />;
}
