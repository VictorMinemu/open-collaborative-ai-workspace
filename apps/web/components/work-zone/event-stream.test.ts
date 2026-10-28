import type { SessionEvent, WorkSession } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import type { LiveSession } from "@/lib/use-live-session";
import { buildItems } from "./event-stream";

/**
 * The session timeline's runtime update line (07.11-10, D-03): a turn held while the device updates its coding CLI says
 * why it waits, then how the update ended. The events come from the stored stream, so a reload shows the same lines.
 */

const AT = "2026-10-28T12:00:00.000Z";

function live(events: SessionEvent[]): LiveSession {
  return {
    session: {} as WorkSession,
    prompts: [],
    approvals: [],
    events: events.map((event, i) => ({ seq: i + 1, at: AT, event })),
    streaming: {},
    changes: null,
    lastSeq: events.length,
  };
}

const update = (
  phase: "waiting" | "done" | "failed",
  version?: string,
  runtime: "claude-code" | "codex" = "claude-code",
): SessionEvent => ({
  type: "runtime.update",
  runtime,
  phase,
  ...(version ? { version } : {}),
});

describe("buildItems › runtime.update", () => {
  it("says the turn waits for the update, then which version it got", () => {
    const items = buildItems(live([update("waiting"), update("done", "2.1.300")]));
    expect(items).toEqual([
      {
        kind: "system",
        key: "e1",
        at: AT,
        text: "Updating Claude Code… your turn starts when it finishes",
        testId: "runtime-update-line",
      },
      {
        kind: "system",
        key: "e2",
        at: AT,
        text: "Claude Code updated to 2.1.300",
        testId: "runtime-update-line",
      },
    ]);
  });

  it("says a failed update leaves the turn on the installed version", () => {
    const [item] = buildItems(live([update("failed", undefined, "codex")]));
    expect(item).toMatchObject({
      kind: "system",
      text: "Codex update failed · your turn runs on the installed version",
    });
  });
});
