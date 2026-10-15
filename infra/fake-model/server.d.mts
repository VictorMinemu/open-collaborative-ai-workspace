import type { IncomingHttpHeaders, Server } from "node:http";

/** Types for the TypeScript tests that run the fake model in-process (implementation: server.mjs). */

export interface FakeModelRequest {
  /** `search`: the fake SearXNG (`path` carries the query string, `body` is null). */
  kind: "models" | "responses" | "openai" | "anthropic" | "search";
  path: string;
  headers: IncomingHttpHeaders;
  // biome-ignore lint/suspicious/noExplicitAny: request bodies are loose JSON so tests can inspect any field
  body: Record<string, any> | null;
}

export function createFakeModelServer(opts?: {
  /** Mounts the fake sandboxd at `/__sandboxd` behind this bearer (default FAKE_SANDBOX_TOKEN; "" = not mounted). */
  sandboxToken?: string;
  mcpToken?: string;
  clawhubArtifactDir?: string;
  onRequest?: (request: FakeModelRequest) => void;
}): Server;
