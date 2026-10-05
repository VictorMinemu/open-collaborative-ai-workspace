import type { IncomingMessage, ServerResponse } from "node:http";

/** Types for the TypeScript tests that run the fake ClawHub in-process (implementation: fake-clawhub.mjs). */

export interface FakeClawhubRequest {
  method: string | undefined;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
}

/** Loose JSON fixture record (mutable: tests edit it to simulate a release changing on ClawHub). */
// biome-ignore lint/suspicious/noExplicitAny: fixture JSON is deliberately untyped so tests can reshape it
export type FakeClawhubRecord = Record<string, any>;

export interface FakeClawhub {
  (req: IncomingMessage, res: ServerResponse, url: URL): boolean;
  readonly requests: FakeClawhubRequest[];
  pkg(name: string): FakeClawhubRecord | null;
  version(name: string, version: string): FakeClawhubRecord | null;
  setOutage(outage: { status?: number; delayMs?: number } | null): void;
  reset(): void;
}

export function createFakeClawhub(opts?: { artifactDir?: string }): FakeClawhub;
