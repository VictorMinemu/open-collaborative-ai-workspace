import type { AiChatGrant, AiParticipant } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { accessLabel, audienceScope, audienceSummary } from "./ai-audience";

const person = (id: string, displayName: string, access: AiParticipant["access"]): AiParticipant => ({
  kind: "user",
  id,
  displayName,
  avatarUrl: null,
  access,
  orgRole: "developer",
  handle: null,
});
const agent = (id: string, handle: string): AiParticipant => ({
  kind: "agent",
  id,
  displayName: handle,
  avatarUrl: null,
  access: "agent",
  orgRole: null,
  handle,
});
const grant = (
  subject: AiChatGrant["subject"],
  label: string,
  level: AiChatGrant["level"] = "chat",
): AiChatGrant => ({
  id: `g-${label}`,
  chatId: "c",
  subject,
  label,
  unitKind: subject.kind === "unit" ? "team" : null,
  level,
  grantedBy: { kind: "user", id: "v", displayName: "Víctor Ruiz", avatarUrl: null },
  createdAt: "2026-10-07T10:00:00Z",
  updatedAt: "2026-10-07T10:00:00Z",
});

const victor = person("v", "Víctor Ruiz", "owner");
const alex = person("a", "Alex Kim", "chat");
const riley = person("r", "Riley Quinn", "view");
const sam = person("s", "Sam Lee", "chat");

describe("audienceSummary (the header chip)", () => {
  it("the owner reads the widest grant by name: the organization, else a unit, else people", () => {
    const base = { audience: "listed" as const, participants: [victor, alex], viewerId: "v" };
    expect(audienceSummary({ ...base, grants: [grant({ kind: "user", id: "a" }, "Alex Kim")] })).toBe(
      "Shared with Alex Kim",
    );
    expect(
      audienceSummary({
        ...base,
        audience: "units",
        grants: [grant({ kind: "user", id: "a" }, "Alex Kim"), grant({ kind: "unit", id: "u" }, "Backend")],
      }),
    ).toBe("Shared with Backend +1");
    expect(
      audienceSummary({ ...base, audience: "units", grants: [grant({ kind: "unit", id: "u" }, "Backend")] }),
    ).toBe("Shared with Backend");
    expect(
      audienceSummary({
        ...base,
        audience: "organization",
        grants: [
          grant({ kind: "org" }, "Everyone at Autofy Labs"),
          grant({ kind: "unit", id: "u" }, "Backend"),
        ],
      }),
    ).toBe("Shared with everyone");
    expect(
      audienceSummary({
        ...base,
        participants: [victor, alex, sam, riley],
        grants: [
          grant({ kind: "user", id: "a" }, "Alex Kim"),
          grant({ kind: "user", id: "s" }, "Sam Lee"),
          grant({ kind: "user", id: "r" }, "Riley Quinn", "view"),
        ],
      }),
    ).toBe("Shared with 3 people");
  });

  it("a grantee reads it from the participants: everyone, a name, you, or how many people are in it", () => {
    expect(audienceSummary({ audience: "organization", participants: [victor, alex], viewerId: "a" })).toBe(
      "Shared with everyone",
    );
    expect(audienceSummary({ audience: "listed", participants: [victor, alex], viewerId: "a" })).toBe(
      "Shared with you",
    );
    expect(audienceSummary({ audience: "listed", participants: [victor, alex], viewerId: "s" })).toBe(
      "Shared with Alex Kim",
    );
    expect(audienceSummary({ audience: "units", participants: [victor, alex, riley], viewerId: "r" })).toBe(
      "3 people",
    );
  });

  it("only agents besides the owner: says how many agents take part", () => {
    expect(
      audienceSummary({
        audience: "listed",
        participants: [victor, agent("b", "backend")],
        viewerId: "v",
        grants: [],
      }),
    ).toBe("You and @backend");
    expect(
      audienceSummary({
        audience: "listed",
        participants: [victor, agent("b", "backend"), agent("o", "ops")],
        viewerId: "v",
        grants: [],
      }),
    ).toBe("You and 2 agents");
  });
});

describe("audienceScope (the list's first line)", () => {
  it("the owner sees every grant with its level, widest first", () => {
    expect(
      audienceScope({
        audience: "units",
        orgName: "Autofy Labs",
        grants: [
          grant({ kind: "user", id: "a" }, "Alex Kim"),
          grant({ kind: "unit", id: "u" }, "Backend", "view"),
        ],
      }),
    ).toBe("Shared with Backend (Can view) and Alex Kim (Can chat)");
  });
  it("a grantee is told how wide it is without the owner's grant list", () => {
    expect(audienceScope({ audience: "organization", orgName: "Autofy Labs" })).toBe(
      "Everyone at Autofy Labs can open this chat",
    );
    expect(audienceScope({ audience: "units", orgName: "Autofy Labs" })).toBe(
      "Shared with a team or department: everyone in it can open this chat",
    );
    expect(audienceScope({ audience: "listed", orgName: "Autofy Labs" })).toBe(
      "Only the people below can open this chat",
    );
  });
});

describe("accessLabel", () => {
  it("names each access", () => {
    expect(["owner", "chat", "view", "agent"].map((a) => accessLabel(a as AiParticipant["access"]))).toEqual([
      "Owner",
      "Can chat",
      "Can view",
      "Agent",
    ]);
  });
});
