import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // scripts/e2e-isolated.sh builds into `.next-e2e` so an e2e run never overwrites the demo's `.next`.
  distDir: process.env.OCW_NEXT_DIST_DIR || ".next",
  output: "standalone",
  // Trace files from the monorepo root so workspace packages end up in the standalone bundle.
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  // Workspace packages export raw TypeScript (`exports: ./src/index.ts`).
  transpilePackages: ["@ocw/contracts", "@ocw/realtime-client"],
  poweredByHeader: false,
  reactStrictMode: true,
  // The floating dev badge sits on top of the user menu in the bottom-left corner.
  devIndicators: false,
};

export default nextConfig;
