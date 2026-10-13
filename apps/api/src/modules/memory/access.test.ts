import { describe, expect, it } from "vitest";
import type { MemoryScopeFacts, RuleFact } from "../organization";
import {
  type AudienceFacts,
  anyReadDeny,
  audienceVerdict,
  isPersonalLike,
  organizationWide,
  personalOwnerOf,
} from "./access";

/**
 * 07.2-08 (MEM-04 support, D-08, Pitfall 5): the audience rule as a pure table. An agent may quote memory in a turn only
 * when every human who will read the turn may read it: private memory only to its owner alone, an unbounded audience
 * only organization-wide memory nobody is denied, a listed audience only when each reader holds `memory.read`.
 */

const SAM = "00000000-0000-4000-8000-000000000001";
const X = "00000000-0000-4000-8000-000000000002";
const A = "00000000-0000-4000-8000-000000000003";
const LA = "00000000-0000-4000-8000-000000000004";
const BM = "00000000-0000-4000-8000-000000000005";

const base = (over: Partial<AudienceFacts>): AudienceFacts => ({
  personalLike: false,
  ownerUserId: null,
  askingUserId: A,
  audience: { userIds: [], unbounded: false },
  allowedReaders: new Set(),
  openToEveryone: false,
  ...over,
});

const ALLOWED = { allowed: true };
const TOO_WIDE = { allowed: false, reason: "audience_too_wide" };

describe("audienceVerdict", () => {
  it.each<[string, AudienceFacts, object]>([
    [
      "private memory, the owner alone",
      base({
        personalLike: true,
        ownerUserId: SAM,
        askingUserId: SAM,
        audience: { userIds: [SAM], unbounded: false },
      }),
      ALLOWED,
    ],
    [
      "private memory, the owner alone (audience left empty: the asker is the reader)",
      base({ personalLike: true, ownerUserId: SAM, askingUserId: SAM }),
      ALLOWED,
    ],
    [
      "private memory with a second reader",
      base({
        personalLike: true,
        ownerUserId: SAM,
        askingUserId: SAM,
        audience: { userIds: [SAM, X], unbounded: false },
        allowedReaders: new Set([SAM, X]),
      }),
      TOO_WIDE,
    ],
    [
      "private memory, an unbounded audience",
      base({
        personalLike: true,
        ownerUserId: SAM,
        askingUserId: SAM,
        audience: { userIds: [], unbounded: true },
      }),
      TOO_WIDE,
    ],
    [
      "private memory asked for by someone else",
      base({
        personalLike: true,
        ownerUserId: SAM,
        askingUserId: X,
        audience: { userIds: [X], unbounded: false },
      }),
      TOO_WIDE,
    ],
    [
      "private memory without an owner",
      base({ personalLike: true, ownerUserId: null, askingUserId: SAM }),
      TOO_WIDE,
    ],
    [
      "unit memory, every reader may read",
      base({ audience: { userIds: [A, LA], unbounded: false }, allowedReaders: new Set([A, LA]) }),
      ALLOWED,
    ],
    [
      "unit memory, one reader may not",
      base({ audience: { userIds: [A, BM], unbounded: false }, allowedReaders: new Set([A]) }),
      TOO_WIDE,
    ],
    [
      "unit memory, the asker may not (the asker is always a reader)",
      base({ askingUserId: BM, audience: { userIds: [A], unbounded: false }, allowedReaders: new Set([A]) }),
      TOO_WIDE,
    ],
    [
      "unbounded, organization-wide and nobody denied",
      base({ audience: { userIds: [], unbounded: true }, openToEveryone: true }),
      ALLOWED,
    ],
    [
      "unbounded, not open to everyone (a unit scope, or a deny on the path)",
      base({
        audience: { userIds: [A], unbounded: true },
        allowedReaders: new Set([A]),
        openToEveryone: false,
      }),
      TOO_WIDE,
    ],
  ])("%s", (_name, facts, verdict) => {
    expect(audienceVerdict(facts)).toEqual(verdict);
  });
});

const bot = (scope: "team" | "personal", unitPath: string[] = [], ownerUserId: string | null = null) => ({
  id: "00000000-0000-4000-8000-0000000000b0",
  scope,
  ownerUserId,
  disabled: false,
  unitPath,
});

const scopes: Record<string, MemoryScopeFacts> = {
  personal: { kind: "personal", ownerUserId: SAM, agent: bot("personal", [], SAM), unitPath: [] },
  personalNotebook: { kind: "agent", ownerUserId: null, agent: bot("personal", [], SAM), unitPath: [] },
  orgNotebook: { kind: "agent", ownerUserId: null, agent: bot("team"), unitPath: [] },
  unitNotebook: { kind: "agent", ownerUserId: null, agent: bot("team", ["d", "a"]), unitPath: ["d", "a"] },
  unit: { kind: "unit", ownerUserId: null, agent: null, unitPath: ["d", "a"] },
  org: { kind: "org", ownerUserId: null, agent: null, unitPath: [] },
};

describe("scope classification", () => {
  it("private memory is a personal scope or a personal bot's notebook, owned by that person", () => {
    expect(
      Object.entries(scopes)
        .filter(([, s]) => isPersonalLike(s))
        .map(([k]) => k),
    ).toEqual(["personal", "personalNotebook"]);
    expect(personalOwnerOf(scopes.personal as MemoryScopeFacts)).toBe(SAM);
    expect(personalOwnerOf(scopes.personalNotebook as MemoryScopeFacts)).toBe(SAM);
    expect(personalOwnerOf(scopes.unit as MemoryScopeFacts)).toBeNull();
  });

  it("organization-wide memory is the org scope and an organization bot's notebook", () => {
    expect(
      Object.entries(scopes)
        .filter(([, s]) => organizationWide(s))
        .map(([k]) => k),
    ).toEqual(["orgNotebook", "org"]);
  });
});

const rule = (over: Partial<RuleFact>): RuleFact => ({
  id: "r1",
  scopeUnitId: null,
  subjectKind: "everyone",
  subjectId: null,
  permission: "memory.read",
  tool: null,
  pathPrefix: null,
  effect: "deny",
  ...over,
});

describe("anyReadDeny (unbounded audiences)", () => {
  const file = (path: string) => ({
    type: "memory" as const,
    unitPath: [],
    relations: new Set<never>(),
    state: new Set<never>(),
    path,
  });

  it("any human-subject deny of memory.read on the path counts, wherever it is scoped", () => {
    expect(anyReadDeny([rule({ pathPrefix: "private/" })], file("private/x.md"))).toBe(true);
    expect(anyReadDeny([rule({ pathPrefix: "private/" })], file("PRIVATE/x.md"))).toBe(true);
    expect(anyReadDeny([rule({ scopeUnitId: "a", subjectKind: "user", subjectId: "u" })], file("x.md"))).toBe(
      true,
    );
    expect(anyReadDeny([rule({ permission: "memory.*" })], file("x.md"))).toBe(true);
  });

  it("allows, other folders, other grains and agent subjects do not", () => {
    expect(anyReadDeny([rule({ pathPrefix: "private/" })], file("handbook.md"))).toBe(false);
    expect(anyReadDeny([rule({ pathPrefix: "private/" })], file("private-notes/x.md"))).toBe(false);
    expect(anyReadDeny([rule({ effect: "allow" })], file("x.md"))).toBe(false);
    expect(anyReadDeny([rule({ permission: "memory.write" })], file("x.md"))).toBe(false);
    expect(anyReadDeny([rule({ subjectKind: "agent", subjectId: "b" })], file("x.md"))).toBe(false);
  });
});
