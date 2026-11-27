import {
  type AssignPreview,
  type AssignWorkSessionResult,
  EventTypes,
  type WorkSession,
  type WorkSessionDetail,
  type WorkSessionList,
} from "@ocw/contracts";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import {
  applySessionFrame,
  assignPreviewOptions,
  assignSessionOptions,
  mergeSessionSnapshot,
  renameSessionOptions,
  sessionListStale,
  wzKeys,
} from "./workzone-queries";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() },
}));

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

  it("keeps the viewer's canRename across a ws: snapshot; a snapshot that carries it wins (WR-03)", () => {
    const mine = session(A, prev.updatedAt, { canRename: true });
    expect(mergeSessionSnapshot(mine, session(A, "2026-10-22T10:05:00.000Z")).canRename).toBe(true);
    expect(
      mergeSessionSnapshot(mine, session(A, "2026-10-22T10:05:00.000Z", { canRename: false })).canRename,
    ).toBe(false);
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

/**
 * 07.13.1.1-06 (D-03, D-06, PD-02, PD-07): Assign to me and the manual rename go through the API only. The hooks are
 * thin wrappers over these option builders, so the request and the cache effects are tested without a DOM.
 */
describe("Assign to me and rename requests (07.13.1.1)", () => {
  const ID = A;
  const get = vi.mocked(api.get);
  const post = vi.mocked(api.post);
  const patch = vi.mocked(api.patch);
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    patch.mockReset();
  });

  const detail = (s: WorkSession): WorkSessionDetail => ({
    session: s,
    prompts: [],
    approvals: [],
    events: [],
    lastSeq: 4,
    viewerCan: ["work_session.read"],
    assign: { allowed: true, reason: null },
  });

  it("the preview is a GET of /assign under the session's key, never kept fresh", async () => {
    const preview: AssignPreview = {
      allowed: true,
      reason: null,
      previousOwnerLosesAccess: false,
      othersLosingAccess: 0,
      cancelledPrompts: 0,
      turnRunning: false,
    };
    get.mockResolvedValueOnce(preview);
    const opts = assignPreviewOptions(ID, true);
    expect(opts.queryKey.slice(0, 3)).toEqual([...wzKeys.session(ID)]);
    expect(opts.staleTime).toBe(0);
    expect(opts.enabled).toBe(true);
    expect(assignPreviewOptions(ID, false).enabled).toBe(false);
    const signal = new AbortController().signal;
    await expect(opts.queryFn({ signal })).resolves.toEqual(preview);
    expect(get).toHaveBeenCalledWith(
      `/api/v1/work-sessions/${ID}/assign`,
      expect.objectContaining({ signal }),
    );
  });

  it("the take-over is one POST of /assign; its success refreshes the session detail and the list", async () => {
    const qc = new QueryClient();
    const before = session(ID, "2026-10-22T10:00:00.000Z");
    qc.setQueryData(wzKeys.session(ID), detail(before));
    qc.setQueryData(wzKeys.sessions, list(before));
    const result: AssignWorkSessionResult = {
      session: session(ID, "2026-10-22T10:05:00.000Z", { createdBy: B, createdByName: "Luis" }),
      removedCount: 1,
      cancelledPrompts: 0,
      settingsDowngraded: false,
    };
    post.mockResolvedValueOnce(result);
    const opts = assignSessionOptions(qc, ID);
    await expect(opts.mutationFn()).resolves.toEqual(result);
    expect(post).toHaveBeenCalledWith(
      `/api/v1/work-sessions/${ID}/assign`,
      expect.objectContaining({ body: {} }),
    );
    opts.onSuccess(result);
    expect(qc.getQueryState(wzKeys.session(ID))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(wzKeys.sessions)?.isInvalidated).toBe(true);
    // The list shows the new owner at once; the refetch confirms it.
    expect(qc.getQueryData<WorkSessionList>(wzKeys.sessions)?.sessions[0]?.createdBy).toBe(B);
  });

  it("a rename PATCHes the session with { title } and writes the answer into the list", async () => {
    const qc = new QueryClient();
    const before = session(ID, "2026-10-22T10:00:00.000Z", { title: "Old title" });
    const cached = detail(before);
    qc.setQueryData(wzKeys.session(ID), cached);
    qc.setQueryData(wzKeys.sessions, list(before));
    const renamed = session(ID, "2026-10-22T10:05:00.000Z", { title: "New title", titleSource: "user" });
    patch.mockResolvedValueOnce(renamed);
    const opts = renameSessionOptions(qc, ID);
    await expect(opts.mutationFn("New title")).resolves.toEqual(renamed);
    expect(patch).toHaveBeenCalledWith(
      `/api/v1/work-sessions/${ID}`,
      expect.objectContaining({ body: { title: "New title" } }),
    );
    opts.onSuccess(renamed);
    expect(qc.getQueryData<WorkSessionList>(wzKeys.sessions)?.sessions[0]?.title).toBe("New title");
    // The open view takes the title from its `ws:` stream (every viewer at once). Its REST snapshot is left alone: a
    // rewrite would re-seed the live view from the snapshot it loaded and drop the events received since.
    expect(qc.getQueryData(wzKeys.session(ID))).toBe(cached);
    expect(qc.getQueryState(wzKeys.session(ID))?.isInvalidated).toBe(false);
  });

  it("the answer keeps the list row's per-viewer fields, also after the shaped `user:` frame (WR-02)", () => {
    const qc = new QueryClient();
    const TEAM = { id: "4d4d4d4d-4444-4444-8444-444444444444", name: "Payroll" };
    const attention = { approval: true, lastTurnEndedAt: "2026-10-22T10:04:00.000Z" };
    // The shaped `user:` frame landed first, at the same updatedAt as the PATCH answer.
    qc.setQueryData(
      wzKeys.sessions,
      list(session(ID, "2026-10-22T10:05:00.000Z", { title: "New title", teamProject: TEAM, attention })),
    );
    renameSessionOptions(qc, ID).onSuccess(session(ID, "2026-10-22T10:05:00.000Z", { title: "New title" }));
    let row = qc.getQueryData<WorkSessionList>(wzKeys.sessions)?.sessions[0];
    expect(row?.teamProject).toEqual(TEAM);
    expect(row?.attention).toEqual(attention);
    assignSessionOptions(qc, ID).onSuccess({
      session: session(ID, "2026-10-22T10:06:00.000Z", { createdBy: B }),
      removedCount: 0,
      cancelledPrompts: 0,
      settingsDowngraded: false,
    });
    row = qc.getQueryData<WorkSessionList>(wzKeys.sessions)?.sessions[0];
    expect(row?.createdBy).toBe(B);
    expect(row?.teamProject).toEqual(TEAM);
    expect(row?.attention).toEqual(attention);
  });

  it("an older answer never replaces a newer row in the list", () => {
    const qc = new QueryClient();
    qc.setQueryData(wzKeys.sessions, list(session(ID, "2026-10-22T10:10:00.000Z", { title: "Newer" })));
    renameSessionOptions(qc, ID).onSuccess(session(ID, "2026-10-22T10:05:00.000Z", { title: "Older" }));
    expect(qc.getQueryData<WorkSessionList>(wzKeys.sessions)?.sessions[0]?.title).toBe("Newer");
  });
});
