import { EventTypes, type WorkPrompt, type WorkSession } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { lastTurnEndOf, turnEndedAt } from "./use-live-session";

/**
 * The seen-map writer of the session view's data hook (07.10-04, UI-SPEC § 3, R10, PD-09): which stream frames end a
 * turn the open view just watched, and the latest turn end a freshly opened view knows. Both return the server's time,
 * so a client clock behind the API never leaves "Your turn" behind once the viewer has seen the turn.
 */

const SID = "01a11635-d6e7-7c87-9f17-0000000000c1";
const UID = "01a11635-d6e7-7c87-9f17-0000000000a1";

function prompt(over: Partial<WorkPrompt> = {}): WorkPrompt {
  return {
    id: "01a11635-d6e7-7c87-9f17-0000000000e1",
    workSessionId: SID,
    authorUserId: UID,
    authorName: "Ana",
    originDeviceId: null,
    body: "Do it",
    status: "running",
    position: 1,
    createdAt: "2026-10-27T11:00:00.000Z",
    dispatchedAt: "2026-10-27T11:00:01.000Z",
    completedAt: null,
    attachments: [],
    proposedBy: null,
    ...over,
  } as WorkPrompt;
}

function session(over: Partial<WorkSession> = {}): WorkSession {
  return {
    id: SID,
    conversationId: SID,
    projectId: "01a11635-d6e7-7c87-9f17-0000000000b1",
    projectName: "web-app",
    deviceId: "01a11635-d6e7-7c87-9f17-0000000000d1",
    deviceName: "Mac",
    deviceOnline: true,
    runtime: "claude-code",
    model: null,
    permissionMode: "default",
    worktree: false,
    branch: "main",
    status: "running",
    title: "A session",
    titleSource: "user",
    createdBy: UID,
    createdByName: "Ana",
    queuedCount: 0,
    pendingApprovals: 0,
    lastError: null,
    settings: {} as WorkSession["settings"],
    fullAccess: false,
    runningSince: null,
    diffStat: null,
    createdAt: "2026-10-27T10:00:00.000Z",
    updatedAt: "2026-10-27T11:05:00.000Z",
    teamProject: null,
    ...over,
  };
}

const ev = (type: string, data: unknown) => ({ op: "ev" as const, topic: `ws:${SID}`, seq: 7, type, data });

describe("turnEndedAt", () => {
  it("a prompt that completes or fails ends a turn, at its completion time", () => {
    const at = "2026-10-27T11:04:00.000Z";
    expect(turnEndedAt(ev(EventTypes.promptUpdated, prompt({ status: "completed", completedAt: at })))).toBe(
      Date.parse(at),
    );
    expect(turnEndedAt(ev(EventTypes.promptUpdated, prompt({ status: "failed", completedAt: at })))).toBe(
      Date.parse(at),
    );
  });

  it("the session turning idle ends a turn, at its update time", () => {
    expect(turnEndedAt(ev(EventTypes.workSessionUpdated, session({ status: "idle" })))).toBe(
      Date.parse("2026-10-27T11:05:00.000Z"),
    );
  });

  it("anything else does not: a running or queued prompt, a busy session, an ephemeral or unparsable frame", () => {
    expect(turnEndedAt(ev(EventTypes.promptUpdated, prompt({ status: "running" })))).toBeNull();
    expect(turnEndedAt(ev(EventTypes.promptUpdated, prompt({ status: "queued" })))).toBeNull();
    expect(turnEndedAt(ev(EventTypes.workSessionUpdated, session({ status: "running" })))).toBeNull();
    expect(turnEndedAt(ev(EventTypes.workSessionEvent, {}))).toBeNull();
    expect(turnEndedAt(ev(EventTypes.promptUpdated, { nope: true }))).toBeNull();
    expect(turnEndedAt({ op: "eph", topic: `ws:${SID}`, type: "assistant.delta", data: {} })).toBeNull();
  });
});

describe("lastTurnEndOf", () => {
  it("is the latest of the viewer's last turn end and the prompts' completion times", () => {
    const s = session({ attention: { approval: false, lastTurnEndedAt: "2026-10-27T11:02:00.000Z" } });
    const prompts = [
      prompt({ status: "completed", completedAt: "2026-10-27T11:03:00.000Z" }),
      prompt({ status: "running", completedAt: null }),
    ];
    expect(lastTurnEndOf({ session: s, prompts })).toBe(Date.parse("2026-10-27T11:03:00.000Z"));
    expect(lastTurnEndOf({ session: s, prompts: [] })).toBe(Date.parse("2026-10-27T11:02:00.000Z"));
    expect(lastTurnEndOf({ session: session(), prompts: [] })).toBe(0);
  });
});
