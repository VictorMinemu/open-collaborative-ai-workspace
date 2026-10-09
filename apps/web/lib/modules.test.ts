import { MODULE_CATALOG, ModuleId, type Permission } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { grainStatus, moduleStatus, permissionsFailed, withoutBotDms } from "./modules";

const perms = (...permissions: Permission[]) => ({ permissions });
const everyEntry = perms(...ModuleId.options.map((m) => MODULE_CATALOG[m].entry));

describe("moduleStatus (P-08: only an `off` decision hides anything)", () => {
  it("is loading while /me/permissions has not answered", () => {
    for (const id of ModuleId.options) expect(moduleStatus(undefined, false, id)).toBe("loading");
  });

  it("is on when the module's entry grain is held", () => {
    expect(moduleStatus(perms("ai_chat.read"), false, "ai_chats")).toBe("on");
    expect(moduleStatus(perms("work_session.read"), false, "work_zone")).toBe("on");
    expect(moduleStatus(perms("bot.read"), false, "bots")).toBe("on");
  });

  it("is off when the entry grain is missing, per module", () => {
    expect(moduleStatus(perms("work_session.read", "bot.read"), false, "ai_chats")).toBe("off");
    expect(moduleStatus(perms("ai_chat.read", "bot.read"), false, "work_zone")).toBe("off");
    expect(moduleStatus(perms("ai_chat.read", "work_session.read"), false, "bots")).toBe("off");
    // A plain `ai_chat.use` is not the entry: reading decides whether the module is there at all.
    expect(moduleStatus(perms("ai_chat.use"), false, "ai_chats")).toBe("off");
  });

  it("counts a failed fetch as on for every module (the API stays the authority)", () => {
    for (const id of ModuleId.options) expect(moduleStatus(undefined, true, id)).toBe("on");
  });

  it("keeps the last decision when a refetch fails after it", () => {
    expect(moduleStatus(perms("bot.read"), true, "ai_chats")).toBe("off");
    expect(moduleStatus(everyEntry, true, "ai_chats")).toBe("on");
  });
});

describe("permissionsFailed", () => {
  it("stays failed while a refetch after an error is pending (the query drops back to pending without data)", () => {
    expect(permissionsFailed({ isError: true, errorUpdateCount: 1 })).toBe(true);
    expect(permissionsFailed({ isError: false, errorUpdateCount: 1 })).toBe(true);
    expect(
      moduleStatus(undefined, permissionsFailed({ isError: false, errorUpdateCount: 2 }), "ai_chats"),
    ).toBe("on");
  });

  it("is not failed before the first error (the first fetch and its retry are still loading)", () => {
    expect(permissionsFailed({ isError: false, errorUpdateCount: 0 })).toBe(false);
  });
});

describe("grainStatus", () => {
  it("decides any single grain the same way", () => {
    expect(grainStatus(undefined, false, "device.pair")).toBe("loading");
    expect(grainStatus(undefined, true, "device.pair")).toBe("on");
    expect(grainStatus(perms("device.pair"), false, "device.pair")).toBe("on");
    expect(grainStatus(perms("device.read"), false, "device.pair")).toBe("off");
  });
});

type Dm = { id: string; counterpart: { kind: "agent" | "user" | "group" } };
const dms: Dm[] = [
  { id: "person", counterpart: { kind: "user" } },
  { id: "bot-1", counterpart: { kind: "agent" } },
  { id: "group", counterpart: { kind: "group" } },
  { id: "bot-2", counterpart: { kind: "agent" } },
];

describe("withoutBotDms", () => {
  it("keeps every DM when bots are shown", () => {
    expect(withoutBotDms(dms, true).map((d) => d.id)).toEqual(["person", "bot-1", "group", "bot-2"]);
  });

  it("drops only 1:1 bot DMs when bots are hidden, keeping people, groups and order", () => {
    expect(withoutBotDms(dms, false).map((d) => d.id)).toEqual(["person", "group"]);
  });

  it("keeps the bot DM while permissions load and after a failed fetch", () => {
    const loading = withoutBotDms(dms, moduleStatus(undefined, false, "bots") !== "off");
    const failed = withoutBotDms(dms, moduleStatus(undefined, true, "bots") !== "off");
    expect(loading.map((d) => d.id)).toContain("bot-1");
    expect(failed.map((d) => d.id)).toContain("bot-1");
  });

  it("hides the bot DM once Bots is decided off", () => {
    const off = withoutBotDms(dms, moduleStatus(perms("ai_chat.read"), false, "bots") !== "off");
    expect(off.map((d) => d.id)).toEqual(["person", "group"]);
  });
});
