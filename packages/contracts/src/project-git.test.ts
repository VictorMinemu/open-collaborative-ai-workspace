import { describe, expect, it } from "vitest";
import { DeviceProjectAnnouncement, DiffResultFrame } from "./device-link";
import { WorkSessionChanges, WorkSessionDiff } from "./work-session";

// Work Zone projects without git: an optional `git` flag, absent on older devices and servers.
describe("the optional git flag (projects without git)", () => {
  const announced = { localId: "lp_1", name: "notes", gitRemote: null, defaultBranch: null };

  it("a project announcement parses with and without it", () => {
    expect(DeviceProjectAnnouncement.parse(announced)).toEqual(announced);
    expect(DeviceProjectAnnouncement.parse({ ...announced, git: false })).toEqual({
      ...announced,
      git: false,
    });
    expect(DeviceProjectAnnouncement.safeParse({ ...announced, git: "no" }).success).toBe(false);
  });

  it("a diff.result parses with and without it", () => {
    const frame = { type: "diff.result", requestId: "d1", files: [], patch: "" };
    expect(DiffResultFrame.parse(frame)).toEqual(frame);
    expect(DiffResultFrame.parse({ ...frame, git: false, branch: null, headSha: null }).git).toBe(false);
  });

  it("the session diff and changes payloads parse with and without it", () => {
    const at = "2026-11-06T00:00:00.000Z";
    const diff = { files: [], patch: "", truncated: false, branch: null, headSha: null, generatedAt: at };
    expect(WorkSessionDiff.parse(diff)).toEqual(diff);
    expect(WorkSessionDiff.parse({ ...diff, git: false }).git).toBe(false);
    const changes = { files: [], branch: null, headSha: null, truncated: false, at };
    expect(WorkSessionChanges.parse(changes)).toEqual(changes);
    expect(WorkSessionChanges.parse({ ...changes, git: false }).git).toBe(false);
  });
});
