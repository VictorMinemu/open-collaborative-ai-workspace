import { describe, expect, it } from "vitest";
import type { Directory, DirectoryEntry } from "./directory";
import { resolveMentions } from "./mentions";

const user = (id: string, handle: string): DirectoryEntry => ({
  kind: "user",
  id,
  handle,
  displayName: handle,
  avatarUrl: null,
});
const agent = (id: string, handle: string): DirectoryEntry => ({
  ...user(id, handle),
  kind: "agent",
  status: "ready",
});

function dir(entries: DirectoryEntry[]): Directory {
  return {
    users: new Map(entries.filter((e) => e.kind === "user").map((e) => [e.id, e])),
    agents: new Map(entries.filter((e) => e.kind === "agent").map((e) => [e.id, e])),
    byHandle: new Map(entries.map((e) => [e.handle, e])),
  };
}

const d = dir([user("u1", "victor"), user("u2", "alex.kim"), agent("a1", "archie")]);

describe("resolveMentions", () => {
  it("resolves users and agents by handle, case-insensitively, once each", () => {
    expect(resolveMentions("@Archie ping @victor and @archie again, cc @alex.kim.", d)).toEqual([
      { kind: "agent", id: "a1" },
      { kind: "user", id: "u1" },
      { kind: "user", id: "u2" },
    ]);
  });

  it("ignores unknown handles, emails and inline code-ish tokens", () => {
    expect(resolveMentions("mail victor@archie.dev or @nobody", d)).toEqual([]);
  });

  it("accepts mentions after punctuation and at line starts", () => {
    expect(resolveMentions("(@archie)\n@victor: hi", d)).toEqual([
      { kind: "agent", id: "a1" },
      { kind: "user", id: "u1" },
    ]);
  });
});
