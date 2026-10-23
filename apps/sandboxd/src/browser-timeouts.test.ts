import { readFileSync } from "node:fs";
import { BROWSER_TIMEOUTS_MS } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { AGENT_REQUEST_TIMEOUT_MS } from "./agent-link";
import { BROWSER_READY_MS } from "./browser";

/**
 * CI p64/p66: sandboxd's place in the browser's timeout chain (contracts BROWSER_TIMEOUTS_MS, innermost first). The
 * brw agent bounds every op itself (`timeout`), sandboxd's link outwaits it, and the API's op budget outwaits the link,
 * so the answer with the reason always comes from the layer that has it. agent.mjs runs in the `brw` image without the
 * contracts package: its own numbers are pinned here.
 */

const agentSource = readFileSync(
  new URL("../../../infra/sandbox/browser/agent.mjs", import.meta.url),
  "utf8",
);
const agentNumber = (re: RegExp): number => {
  const m = re.exec(agentSource);
  if (!m?.[1]) throw new Error(`agent.mjs: ${re} not found`);
  return Number(m[1].replace(/_/gu, ""));
};

describe("sandboxd and brw in the browser's timeout chain", () => {
  it("brw's page load, op cap and Chromium launch are the contracts'", () => {
    expect(agentNumber(/navigationTimeoutMs:\s*([\d_]+)/u)).toBe(BROWSER_TIMEOUTS_MS.navigation);
    expect(agentNumber(/opTimeoutMs:\s*([\d_]+)/u)).toBe(BROWSER_TIMEOUTS_MS.agentOp);
    expect(agentNumber(/chromiumSandbox: sandbox,\s*timeout:\s*([\d_]+)/u)).toBe(BROWSER_TIMEOUTS_MS.launch);
  });

  it("the link outwaits brw's op cap, and the ready gate outwaits Chromium's launch", () => {
    expect(AGENT_REQUEST_TIMEOUT_MS).toBe(BROWSER_TIMEOUTS_MS.agentLink);
    expect(AGENT_REQUEST_TIMEOUT_MS).toBeGreaterThan(BROWSER_TIMEOUTS_MS.agentOp);
    expect(BROWSER_READY_MS).toBe(BROWSER_TIMEOUTS_MS.ready);
    expect(BROWSER_READY_MS).toBeGreaterThan(BROWSER_TIMEOUTS_MS.launch);
  });
});
