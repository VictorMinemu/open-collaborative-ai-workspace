import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Types for the TypeScript tests that run the in-memory sandboxd in-process (implementation: fake-sandboxd.mjs,
 * 07.8-05; browser ops 07.8-08). Every answer has the shape of `SANDBOXD_ROUTES` in `@ocw/contracts`.
 */

export interface FakeSandboxdOptions {
  /** The bearer token every op requires (≥ 32 chars, like `OCW_SANDBOX_TOKEN`). */
  token?: string;
  /** The namespace `info` reports. */
  namespace?: string;
}

/** One browser context as the fake holds it: ids, host and flags only; input counted by event type, never kept. */
export interface FakeBrowserContextStats {
  contextId: string;
  agentId: string;
  host: string | null;
  signedIn: boolean;
  siteLock: string | null;
  takeover: boolean;
  held: boolean;
  /** Open frame streams (`contextFrames` subscribers). */
  viewers: number;
  /** Takeover input events per `type`; payloads are dropped on arrival. */
  inputs: Partial<Record<string, number>>;
}

export interface FakeSandboxdStats {
  /** Calls per op name (`ensure`, `exec`, `killOrg`, `contextAct`, …), counted after the token check; never bodies. */
  calls: Partial<Record<string, number>>;
  /** The same counts per organization id. */
  orgs: Record<string, Partial<Record<string, number>>>;
  down: boolean;
  browser: { contexts: FakeBrowserContextStats[] };
}

export interface FakeSandboxdTarget {
  orgId: string;
  agentId: string;
}

export interface FakePackageCoords {
  source: "npm" | "pypi" | "debian" | "clawhub";
  name: string;
  version: string;
}

export interface FakePackageControls {
  topChanged?: boolean;
  depChanged?: boolean;
  sha1?: boolean;
  badTreeHash?: boolean;
  license?: string | null;
  hasInstallScript?: boolean;
  publisher?: string | null;
}

export interface FakeSandboxd {
  /** The node:http handler: answers every request (404 for an op it does not serve). */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  token: string;
  stats(): FakeSandboxdStats;
  /** While true every op answers 503 `docker_unavailable` (the service is down). */
  setDown(value: boolean): void;
  /** Forgets every sandbox, process, event and counter. */
  reset(): void;
  /** A sandboxd restart: a new boot id, an empty feed, no policy and no process; the sandboxes stay. */
  reboot(): void;
  /** Queues one sandboxd event (seq and time added); returns its seq. */
  emit(event: Record<string, unknown>): number;
  /** A bot's sandbox state ("absent" when never ensured). */
  stateOf(target: FakeSandboxdTarget): string;
  /**
   * Changes what the fake registries serve for one release (07.8-18): `topChanged` republishes the artifact,
   * `depChanged` its dependency, `sha1` gives the dependency sha1-only integrity, `badTreeHash` makes the review report a
   * tree hash that does not match its entries.
   */
  setPackage(coords: FakePackageCoords, patch: FakePackageControls): void;
  /** The package ids installed in one bot's packages volume. */
  packagesOf(target: FakeSandboxdTarget): string[];
  /** The organization policy held now (only `killed` is shown), or null when none was pushed since the last boot. */
  policyOf(orgId: string): { killed: boolean } | null;
}

export function createFakeSandboxd(opts?: FakeSandboxdOptions): FakeSandboxd;
