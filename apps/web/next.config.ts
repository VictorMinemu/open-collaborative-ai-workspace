import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Trace files from the monorepo root so workspace packages end up in the standalone bundle.
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  // Workspace packages export raw TypeScript (`exports: ./src/index.ts`).
  transpilePackages: ["@ocw/contracts", "@ocw/realtime-client"],
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
