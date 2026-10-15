import type { SandboxdOrgPolicy } from "@ocw/contracts";

const MiB = 1024 * 1024;

/**
 * An organization policy as the API pushes it (07.8-11), for unit tests. sandboxd has no default policy, so a test that
 * ensures, execs or writes pushes one first (`sandboxes.setPolicy(testPolicy(ORG))`), as the API does.
 */
export function testPolicy(orgId: string, over: Partial<SandboxdOrgPolicy> = {}): SandboxdOrgPolicy {
  return {
    orgId,
    sandboxEgress: "off",
    browserEgress: "off",
    allowHosts: [],
    privateHosts: [],
    limits: {
      nanoCpus: 1_000_000_000,
      memoryBytes: 1024 * MiB,
      pids: 256,
      diskQuotaBytes: 2048 * MiB,
      idleStopMs: 900_000,
    },
    browserLimits: {
      nanoCpus: 1_000_000_000,
      memoryBytes: 2048 * MiB,
      pids: 512,
      diskQuotaBytes: 2048 * MiB,
      idleStopMs: 300_000,
    },
    killed: false,
    version: 1,
    ...over,
  };
}
