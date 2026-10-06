/**
 * The ocw channel's own status snapshot (`status.buildAccountSnapshot`). Without it, OpenClaw 2026.9.7 projects the
 * account through `projectSafeChannelAccountSnapshotFields`, which drops `lastError`: `channels.status` then shows a
 * stopped account with no reason, and the restart-loop breaker guard could not tell why (CI cell-smoke, run 37411421709).
 */
import { describe, expect, it } from "vitest";
import { resolveOcwAccount } from "./account.js";
import { buildOcwAccountSnapshot } from "./channel-status.js";

const BREAKER =
  "gateway restart-loop breaker tripped: 3 unclean boot(s) within 300000ms; suppressing channel/provider account auto-start.";
const account = resolveOcwAccount(
  {},
  { OCW_API_URL: "http://api:4000", OCW_CELL_TOKEN: "secret-cell-token" },
);

describe("buildOcwAccountSnapshot", () => {
  it("keeps the runtime's lastError (a breaker refusal) next to the lifecycle fields", () => {
    expect(
      buildOcwAccountSnapshot({
        account,
        runtime: {
          accountId: "default",
          running: false,
          lifecycle: "stopped",
          restartPending: false,
          lastError: BREAKER,
        },
      }),
    ).toEqual({
      accountId: "default",
      enabled: true,
      configured: true,
      running: false,
      lifecycle: "stopped",
      restartPending: false,
      lastError: BREAKER,
    });
  });

  it("a running account: no error, connection fields kept", () => {
    expect(
      buildOcwAccountSnapshot({
        account,
        runtime: { accountId: "default", running: true, connected: true, lastStartAt: 5, lastError: null },
      }),
    ).toEqual({
      accountId: "default",
      enabled: true,
      configured: true,
      running: true,
      connected: true,
      lastStartAt: 5,
      lastError: null,
    });
  });

  it("never carries the account's token reader or unknown runtime fields, and bounds the error", () => {
    const snap = buildOcwAccountSnapshot({
      account,
      runtime: { accountId: "default", running: false, lastError: "x".repeat(2000), secret: "nope" },
    });
    expect(JSON.stringify(snap)).not.toContain("secret-cell-token");
    expect(snap).not.toHaveProperty("secret");
    expect(snap).not.toHaveProperty("readToken");
    expect((snap.lastError as string).length).toBe(500);
    expect(buildOcwAccountSnapshot({ account })).toEqual({
      accountId: "default",
      enabled: true,
      configured: true,
      running: false,
      lastError: null,
    });
  });
});
