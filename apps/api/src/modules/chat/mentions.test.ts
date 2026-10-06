import { userHandle } from "@ocw/contracts";
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

describe("resolveMentions and reserved handles (Pitfall 6)", () => {
  it("never resolves @here, @channel or @everyone as a person or a bot", () => {
    // Even a directory that (wrongly) held entries under reserved handles resolves only Sam.
    const tricky = dir([
      user("u3", "sam"),
      user("u4", "here"),
      agent("a2", "channel"),
      user("u5", "everyone"),
    ]);
    expect(resolveMentions("@here @channel @everyone @sam", tricky)).toEqual([{ kind: "user", id: "u3" }]);
  });

  it("a member whose email starts with a reserved word is reachable as here-1", () => {
    const handle = userHandle({ displayName: "Here Person", email: "here@acme.test" });
    expect(handle).toBe("here-1");
    const d2 = dir([user("u6", handle)]);
    expect(resolveMentions("ping @here-1 and @here", d2)).toEqual([{ kind: "user", id: "u6" }]);
  });
});
