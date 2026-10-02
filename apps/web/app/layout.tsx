import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { toRuntimeConfig } from "@/lib/runtime-config";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "OCW", template: "%s · OCW" },
  description: "Open Collaborative AI Workspace: where people and AI agents work together.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0f0f12" },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Read the API URL per request (not inlined at build time) so one image serves any deployment.
  await connection();
  const config = toRuntimeConfig(process.env.OCW_PUBLIC_API_URL ?? "http://localhost:4000");

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh font-sans">
        <Providers config={config}>{children}</Providers>
      </body>
    </html>
  );
}
