import type { Metadata } from "next";
import { BotsGallery } from "@/components/bots/bots-gallery";

export const metadata: Metadata = { title: "Bots" };

export default function BotsPage() {
  return <BotsGallery />;
}
