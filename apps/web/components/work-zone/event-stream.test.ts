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

  // 07.17.1 (PD-18): the hold is the OCW runtime's own restart, not the session's CLI.
  it("says the OCW runtime is restarting when the hold is its own update", () => {
    const [item] = buildItems(
      live([{ type: "runtime.update", runtime: "codex", phase: "waiting", subject: "ocw-runtime" }]),
    );
    expect(item).toEqual({
      kind: "system",
      key: "e1",
      at: AT,
      text: "Restarting the OCW runtime on this device… your turn starts when it is back",
      testId: "runtime-update-line",
    });
  });

  it("review IN-04: takes the restart line back when the OCW runtime update did not run", () => {
    const [item] = buildItems(
      live([{ type: "runtime.update", runtime: "codex", phase: "failed", subject: "ocw-runtime" }]),
    );
    expect(item).toMatchObject({
      kind: "system",
      text: "The OCW runtime update did not run; your turn continues",
      testId: "runtime-update-line",
    });
  });
});

/**
 * The account switch line (07.18-12, D-08, PD-14): the API appends `account.switched` to the stored stream when a
 * session moves to another pool account, so every viewer sees when and why, also after a reload. The time is the
 * viewer's own (the formatter the timeline uses); the tests pass a fixed one.
 */
describe("buildItems › account.switched", () => {
  const UNTIL = "2026-10-28T15:40:00.000Z";
  const at1540 = (iso: string) => (iso === UNTIL ? "15:40" : `?${iso}`);
  const switched = (
    over: Partial<Extract<SessionEvent, { type: "account.switched" }>> = {},
  ): SessionEvent => ({
    type: "account.switched",
    fromLabel: "A",
    toLabel: "B",
    reason: "limit",
    until: UNTIL,
    ...over,
  });

  it("says which account the session moved to, why and until when", () => {
    expect(buildItems(live([switched()]), at1540)).toEqual([
      {
        kind: "system",
        key: "e1",
        at: AT,
        text: "Switched to account B: A reached its limit until 15:40",
        testId: "account-switch-line",
      },
    ]);
  });

  it("names the device's own login when no pool account was left", () => {
    const [item] = buildItems(live([switched({ toLabel: null })]), at1540);
    expect(item).toMatchObject({
      text: "Switched to this device's login: A reached its limit until 15:40",
    });
  });

  it("says an account that was removed or disabled is no longer available", () => {
    const [item] = buildItems(live([switched({ reason: "unavailable", until: null })]), at1540);
    expect(item).toMatchObject({ text: "Switched to account B: A is no longer available" });
  });

  it("drops the until part when the reset time is unknown", () => {
    const [item] = buildItems(live([switched({ until: null })]), at1540);
    expect(item).toMatchObject({ text: "Switched to account B: A reached its limit" });
  });

  it("gives one line per switch, in order, and leaves the other events alone", () => {
    const items = buildItems(
      live([update("done", "2.1.300"), switched(), switched({ fromLabel: "B", toLabel: "C" })]),
      at1540,
    );
    expect(items.map((i) => (i.kind === "system" ? i.text : i.kind))).toEqual([
      "Claude Code updated to 2.1.300",
      "Switched to account B: A reached its limit until 15:40",
      "Switched to account C: B reached its limit until 15:40",
    ]);
  });

  it("uses the viewer's clock by default", () => {
    const [item] = buildItems(live([switched()]));
    const local = new Date(UNTIL).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    expect(item).toMatchObject({ text: `Switched to account B: A reached its limit until ${local}` });
  });
});
