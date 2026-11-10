import { TEAM_MENTION_LIMITS, userHandle } from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import { describe, expect, it } from "vitest";
import type { Directory, DirectoryEntry, UnitDirectoryEntry } from "./directory";
import { resolveMentions, unitMentionGate } from "./mentions";

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

function dir(entries: DirectoryEntry[], units: UnitDirectoryEntry[] = []): Directory {
  return {
    users: new Map(entries.filter((e) => e.kind === "user").map((e) => [e.id, e])),
    agents: new Map(entries.filter((e) => e.kind === "agent").map((e) => [e.id, e])),
    byHandle: new Map(entries.map((e) => [e.handle, e])),
    unitsByHandle: new Map(units.map((u) => [u.handle, u])),
  };
}

const unit = (id: string, handle: string, kind: "team" | "department" = "team"): UnitDirectoryEntry => ({
  kind,
  id,
  name: handle,
  handle,
  path: [id],
});

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

describe("resolveMentions and units (07.17 D-07, D-18, PD-13)", () => {
  const units = [unit("t1", "logistics"), unit("t2", "ops"), unit("t3", "billing"), unit("t4", "support")];
  const withUnits = dir(
    [user("u1", "victor"), user("u7", "sales"), agent("a1", "archie")],
    [
      ...units,
      unit("d1", "it", "department"),
      // A handle held by a person or a bot resolves the person or the bot, never the unit.
      unit("t5", "sales"),
      unit("t6", "archie"),
    ],
  );
  const all = { units: { allowed: () => true } };

  it("without options a unit handle stays text (today's behaviour, P5)", () => {
    expect(resolveMentions("@logistics hi @victor", withUnits)).toEqual([{ kind: "user", id: "u1" }]);
  });

  it("with options a team or department resolves as a unit, in text order, once", () => {
    expect(resolveMentions("@logistics hi @victor, @it and @Logistics again", withUnits, all)).toEqual([
      { kind: "unit", id: "t1" },
      { kind: "user", id: "u1" },
      { kind: "unit", id: "d1" },
    ]);
  });

  it("precedence: a bot's or a person's handle never resolves the unit holding it (D-18)", () => {
    expect(resolveMentions("@sales @archie", withUnits, all)).toEqual([
      { kind: "user", id: "u7" },
      { kind: "agent", id: "a1" },
    ]);
  });

  it("only units the gate allows resolve", () => {
    const opts = { units: { allowed: (id: string) => id !== "t2" } };
    expect(resolveMentions("@logistics @ops", withUnits, opts)).toEqual([{ kind: "unit", id: "t1" }]);
  });

  it("max keeps the first distinct units in text order; people are never capped (D-17)", () => {
    const opts = { units: { allowed: () => true, max: TEAM_MENTION_LIMITS.botUnitsPerMessage } };
    expect(
      resolveMentions("@logistics @ops @logistics @billing @support done @victor @sales", withUnits, opts),
    ).toEqual([
      { kind: "unit", id: "t1" },
      { kind: "unit", id: "t2" },
      { kind: "unit", id: "t3" },
      { kind: "user", id: "u1" },
      { kind: "user", id: "u7" },
    ]);
  });

  it("a project unit is never in the directory, and reserved handles never resolve as units", () => {
    // loadDirectory reads only team and department units; a (wrongly) planted reserved handle still never resolves.
    const tricky = dir([], [unit("t9", "here"), unit("t8", "channel")]);
    expect(resolveMentions("@ops-project @here @channel", tricky, all)).toEqual([]);
  });
});

describe("unitMentionGate (07.17 PD-13)", () => {
  const units = [unit("t1", "logistics"), unit("t2", "ops"), unit("t3", "sales")];
  const d2 = dir([user("u7", "sales")], units);
  const tx = {} as Tx;
  const asked: string[] = [];
  const perms = {
    async decide(_tx: Tx, principal: unknown, permission: string, resource: unknown) {
      const r = resource as { type: string; unitPath: readonly string[] };
      const p = principal as { kind: string; userId: string };
      asked.push(`${p.kind}:${p.userId}:${permission}:${r.unitPath.at(-1)}`);
      return { allowed: r.unitPath.at(-1) !== "t2" };
    },
  };
  const base = {
    body: "@logistics @ops @sales",
    dir: d2,
    humanUserId: "u1",
    agentAuthor: false,
    parentKind: null,
  };

  it("resolves units only on channels and channel threads", async () => {
    for (const conversationKind of ["dm", "group", "ai_chat", "work_session"]) {
      expect(await unitMentionGate(tx, perms, { ...base, conversationKind })).toBeUndefined();
    }
    expect(
      await unitMentionGate(tx, perms, { ...base, conversationKind: "thread", parentKind: "dm" }),
    ).toBeUndefined();
    expect(
      await unitMentionGate(tx, perms, { ...base, conversationKind: "thread", parentKind: "channel" }),
    ).toBeDefined();
  });

  it("no human means no units", async () => {
    expect(
      await unitMentionGate(tx, perms, { ...base, conversationKind: "channel", humanUserId: null }),
    ).toBeUndefined();
  });

  it("decides unit.read for the human, only on the named units not shadowed by a person or a bot", async () => {
    asked.length = 0;
    const opts = await unitMentionGate(tx, perms, { ...base, conversationKind: "channel" });
    expect(asked).toEqual(["user:u1:unit.read:t1", "user:u1:unit.read:t2"]);
    expect(resolveMentions(base.body, d2, opts)).toEqual([
      { kind: "unit", id: "t1" },
      { kind: "user", id: "u7" },
    ]);
    expect(opts?.units?.max).toBeUndefined();
  });

  it("a bot author is capped at three units per message (D-17)", async () => {
    const opts = await unitMentionGate(tx, perms, {
      ...base,
      conversationKind: "channel",
      agentAuthor: true,
    });
    expect(opts?.units?.max).toBe(TEAM_MENTION_LIMITS.botUnitsPerMessage);
  });

  it("a body without unit handles asks nothing", async () => {
    asked.length = 0;
    await unitMentionGate(tx, perms, { ...base, body: "@sales hi", conversationKind: "channel" });
    expect(asked).toEqual([]);
  });
});
