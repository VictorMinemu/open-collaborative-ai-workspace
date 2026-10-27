import { EventTypes, type WorkSession, type WorkSessionList } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { applySessionFrame, mergeSessionSnapshot, sessionListStale } from "./workzone-queries";

/**
 * Phase 07.9-07 (D-08, P-08): the session list follows the member's own `user:` topic. The API delivers a session's
 * DTO only to the people who may see it (`work_session.updated`) and tells the people an audience change removed
 * (`work_session.removed { id }`); the browser applies what it was sent and never decides access itself.
 */

const session = (id: string, updatedAt: string, extra: Partial<WorkSession> = {}): WorkSession => ({
  id,
  conversationId: "0b9f6a52-8c1e-4d3a-9b2f-5c6d7e8f9a01",
  projectId: "0b9f6a52-8c1e-4d3a-9b2f-5c6d7e8f9a02",
  projectName: "ocw",
  deviceId: "0b9f6a52-8c1e-4d3a-9b2f-5c6d7e8f9a03",
  deviceName: "Ana's MacBook",
  deviceOnline: true,
  runtime: "claude-code",
  model: null,
  permissionMode: "default",
  worktree: false,
  branch: null,
  status: "idle",
  title: `Session ${id.slice(0, 4)}`,
  titleSource: "user",
  createdBy: "0b9f6a52-8c1e-4d3a-9b2f-5c6d7e8f9a04",
  createdByName: "Ana",
  queuedCount: 0,
  pendingApprovals: 0,
  lastError: null,
  settings: { requested: {}, effective: null, pending: false },
  fullAccess: false,
  runningSince: null,
  diffStat: null,
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt,
  ...extra,
});

const A = "1a1a1a1a-1111-4111-8111-111111111111";
const B = "2b2b2b2b-2222-4222-8222-222222222222";
const C = "3c3c3c3c-3333-4333-8333-333333333333";

const list = (...sessions: WorkSession[]): WorkSessionList => ({ sessions });
const ids = (l: WorkSessionList | undefined) => l?.sessions.map((s) => s.id);
const updated = (s: unknown) => ({ type: EventTypes.workSessionUpdated, data: s });
const removed = (id: string) => ({ type: EventTypes.workSessionRemoved, data: { id } });

describe("applySessionFrame (D-08: the list from the member's own topic)", () => {
  const old = list(session(A, "2026-10-22T10:00:00.000Z"), session(B, "2026-10-22T09:00:00.000Z"));

  it("inserts a session it did not have, in recency order", () => {
    const next = applySessionFrame(old, updated(session(C, "2026-10-22T09:30:00.000Z")));
    expect(ids(next)).toEqual([A, C, B]);
  });

  it("replaces a session by id and moves it to its new place", () => {
    const next = applySessionFrame(
      old,
      updated(session(B, "2026-10-22T11:00:00.000Z", { title: "Renamed" })),
    );
    expect(ids(next)).toEqual([B, A]);
    expect(next?.sessions[0]?.title).toBe("Renamed");
  });

  it("keeps the newer copy when an older frame arrives late", () => {
    const next = applySessionFrame(old, updated(session(A, "2026-10-22T08:00:00.000Z", { title: "Stale" })));
    expect(next?.sessions.find((s) => s.id === A)?.title).toBe(`Session ${A.slice(0, 4)}`);
  });

  it("drops an archived session", () => {
    const next = applySessionFrame(
      old,
      updated(session(A, "2026-10-22T12:00:00.000Z", { status: "archived" })),
    );
    expect(ids(next)).toEqual([B]);
  });

  it("drops a session on work_session.removed", () => {
    expect(ids(applySessionFrame(old, removed(B)))).toEqual([A]);
    expect(ids(applySessionFrame(old, removed(C)))).toEqual([A, B]);
  });

  it("ignores payloads that do not parse (a redacted `{}`) and other event types", () => {
    expect(applySessionFrame(old, updated({}))).toBe(old);
    expect(applySessionFrame(old, { type: EventTypes.workSessionRemoved, data: { id: "nope" } })).toBe(old);
    expect(applySessionFrame(old, { type: EventTypes.deviceUpdated, data: { deviceId: A } })).toBe(old);
  });

  it("leaves an unloaded list alone (the first fetch brings it)", () => {
    expect(applySessionFrame(undefined, updated(session(A, "2026-10-22T10:00:00.000Z")))).toBeUndefined();
  });
});

describe("sessionListStale (D-08, P-08: when an org event may have changed which sessions I can read)", () => {
  const me = "4d4d4d4d-4444-4444-8444-444444444444";
  const other = "5e5e5e5e-5555-4555-8555-555555555555";

  it("refetches on my own role or status change (an ex-admin's list drops the rows they no longer read)", () => {
    expect(
      sessionListStale({ type: EventTypes.memberUpdated, data: { userId: me, changed: ["role"] } }, me),
    ).toBe(true);
  });

  it("ignores another member's change and a malformed payload", () => {
    expect(
      sessionListStale({ type: EventTypes.memberUpdated, data: { userId: other, changed: ["role"] } }, me),
    ).toBe(false);
    expect(sessionListStale({ type: EventTypes.memberUpdated, data: null }, me)).toBe(false);
    expect(sessionListStale({ type: EventTypes.memberUpdated, data: { userId: me } }, null)).toBe(false);
  });

  it("still refetches on every structural access change and nothing else", () => {
    for (const type of [
      EventTypes.deviceUpdated,
      EventTypes.unitsUpdated,
      EventTypes.permissionRulesUpdated,
      EventTypes.workProjectUpdated,
    ]) {
      expect(sessionListStale({ type, data: {} }, me), type).toBe(true);
    }
    expect(sessionListStale({ type: EventTypes.messageCreated, data: {} }, me)).toBe(false);
    expect(sessionListStale({ type: EventTypes.projectUpdated, data: {} }, me)).toBe(false);
  });
});

describe("mergeSessionSnapshot (07.10, PD-03: the session view keeps its per-viewer fields)", () => {
  const PROJECT = { id: "4d4d4d4d-4444-4444-8444-444444444444", name: "Payroll" };
  const prev = session(A, "2026-10-22T10:00:00.000Z", { teamProject: PROJECT, title: "Before" });

  it("a ws: snapshot without the team project keeps the previous one; every other field comes from it", () => {
    const next = session(A, "2026-10-22T10:05:00.000Z", { title: "After", queuedCount: 2 });
    const merged = mergeSessionSnapshot(prev, next);
    expect(merged.teamProject).toEqual(PROJECT);
    expect(merged.title).toBe("After");
    expect(merged.queuedCount).toBe(2);
    expect(merged.updatedAt).toBe("2026-10-22T10:05:00.000Z");
  });

  it("keeps a hidden project as hidden", () => {
    const hidden = session(A, "2026-10-22T10:00:00.000Z", { teamProject: null, teamProjectHidden: true });
    const merged = mergeSessionSnapshot(hidden, session(A, "2026-10-22T10:05:00.000Z"));
    expect(merged.teamProject).toBeNull();
    expect(merged.teamProjectHidden).toBe(true);
  });

  it("a snapshot that carries the team project wins, null included, and its pair flag with it", () => {
    expect(
      mergeSessionSnapshot(prev, session(A, prev.updatedAt, { teamProject: null })).teamProject,
    ).toBeNull();
    const hidden = session(A, prev.updatedAt, { teamProject: null, teamProjectHidden: true });
    const named = mergeSessionSnapshot(hidden, session(A, prev.updatedAt, { teamProject: PROJECT }));
    expect(named.teamProject).toEqual(PROJECT);
    expect("teamProjectHidden" in named).toBe(false);
  });

  it("a session without the fields stays without them", () => {
    const bare = session(A, prev.updatedAt);
    const merged = mergeSessionSnapshot(bare, session(A, "2026-10-22T10:05:00.000Z"));
    expect("teamProject" in merged).toBe(false);
    expect("teamProjectHidden" in merged).toBe(false);
    expect("attention" in merged).toBe(false);
  });

  it("keeps the viewer's attention across a ws: snapshot; a snapshot that carries attention wins", () => {
    const waiting = { approval: true, lastTurnEndedAt: "2026-10-22T09:59:00.000Z" };
    const withAttention = session(A, prev.updatedAt, { teamProject: PROJECT, attention: waiting });
    const kept = mergeSessionSnapshot(withAttention, session(A, "2026-10-22T10:05:00.000Z"));
    expect(kept.attention).toEqual(waiting);
    expect(kept.teamProject).toEqual(PROJECT);
    const cleared = { approval: false, lastTurnEndedAt: null };
    const replaced = mergeSessionSnapshot(withAttention, session(A, prev.updatedAt, { attention: cleared }));
    expect(replaced.attention).toEqual(cleared);
    // The project pair is kept independently of attention.
    expect(replaced.teamProject).toEqual(PROJECT);
  });
});
