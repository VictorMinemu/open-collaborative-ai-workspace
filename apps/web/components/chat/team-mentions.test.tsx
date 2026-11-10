import type { OrgUnit } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  buildMentionSuggestions,
  type MentionCandidate,
  MentionSuggestions,
  rankUnitMention,
  type SpecialMention,
} from "./composer";
import { MentionChip, MentionContext, type MentionContextValue, type MentionTarget } from "./markdown";
import { mentionUnitsOf, type UnitMentionCandidate } from "./use-chat-directory";

/**
 * 07.17-13 (D-07, PD-19, AFO-04): `@team` in the web. The directory keeps team and department units with a handle
 * no person or bot holds; the composer offers them in a "Teams" group after people and bots, only where the caller
 * passes them (channels and their threads); the chip names the unit. Static markup and pure functions in node.
 */

const NOW = "2026-11-10T10:00:00.000Z";
let seq = 0;
function unit(over: Partial<OrgUnit> & Pick<OrgUnit, "kind" | "name">): OrgUnit {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  return {
    id,
    parentId: null,
    path: [id],
    memberCount: 0,
    leadCount: 0,
    viewerCan: ["unit.read"],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

const LOGISTICS = unit({
  kind: "team",
  name: "Logistics",
  handle: "logistics",
  reach: 6,
  viewerInReach: true,
});
const BLOG = unit({ kind: "team", name: "Blog team", handle: "blog-team", reach: 3, viewerInReach: false });
const OPS = unit({ kind: "department", name: "Operations", handle: "ops", reach: 24, viewerInReach: false });
const PORTAL = unit({ kind: "project", name: "Logistics portal", handle: "logistics-portal", reach: 2 });
const SAMS = unit({ kind: "team", name: "Sam's team", handle: "sam", reach: 4 });
const OLD = unit({ kind: "team", name: "Legacy" });

const SAM: MentionCandidate = {
  kind: "user",
  id: "00000000-0000-4000-8000-0000000000a1",
  displayName: "Sam Lee",
  handle: "sam",
  avatarUrl: null,
  subtitle: "sam@example.com",
  inChannel: true,
};
const LOU: MentionCandidate = {
  kind: "user",
  id: "00000000-0000-4000-8000-0000000000a2",
  displayName: "Lou Logan",
  handle: "lou",
  avatarUrl: null,
  subtitle: null,
  inChannel: true,
};
const ATLAS: MentionCandidate = {
  kind: "agent",
  id: "00000000-0000-4000-8000-0000000000b1",
  displayName: "Atlas",
  handle: "atlas",
  avatarUrl: null,
  subtitle: null,
  inChannel: false,
};
const CHANNEL: SpecialMention = { handle: "channel", label: "@channel", description: "Notify everyone here" };

const handles = new Map<string, MentionTarget>([
  ["sam", { kind: "user", displayName: "Sam Lee" }],
  ["atlas", { kind: "agent", displayName: "Atlas" }],
]);
const UNITS = mentionUnitsOf([LOGISTICS, BLOG, OPS, PORTAL, SAMS, OLD], handles);

function list(q: string, units: UnitMentionCandidate[] | undefined, special?: SpecialMention[]) {
  const suggestions = buildMentionSuggestions(q, [SAM, LOU, ATLAS], special, units);
  return renderToStaticMarkup(
    <MentionSuggestions suggestions={suggestions} active={0} onHover={() => {}} onPick={() => {}} />,
  );
}

describe("mentionUnitsOf (07.17 D-07, PD-19)", () => {
  it("keeps teams and departments with a handle, drops projects, shadowed handles and handle-less units", () => {
    expect(UNITS.map((u) => u.handle)).toEqual(["blog-team", "logistics", "ops"]);
    expect(UNITS.find((u) => u.handle === "logistics")).toEqual({
      id: LOGISTICS.id,
      kind: "team",
      name: "Logistics",
      handle: "logistics",
      reach: 6,
      viewerInReach: true,
    });
    expect(UNITS.find((u) => u.handle === "ops")).toMatchObject({ kind: "department", reach: 24 });
  });
});

describe("unit ranking", () => {
  it("handle prefix first, then name: @log ranks Logistics above Blog team", () => {
    const logistics = UNITS.find((u) => u.handle === "logistics");
    const blog = UNITS.find((u) => u.handle === "blog-team");
    if (!logistics || !blog) throw new Error("fixture");
    expect(rankUnitMention(logistics, "log")).toBeGreaterThan(rankUnitMention(blog, "log"));
    expect(rankUnitMention(blog, "log")).toBeGreaterThan(0);
    expect(rankUnitMention(logistics, "zz")).toBe(0);
    const units = buildMentionSuggestions("log", [SAM, LOU, ATLAS], undefined, UNITS).filter(
      (s) => s.type === "unit",
    );
    expect(units.map((s) => (s.type === "unit" ? s.u.handle : ""))).toEqual(["logistics", "blog-team"]);
  });

  it("people and bots come first, the Teams group last, the broadcasts where they always were", () => {
    const typed = buildMentionSuggestions("", [SAM, LOU, ATLAS], [CHANNEL], UNITS).map((s) => s.type);
    expect(typed).toEqual(["member", "member", "member", "special", "unit", "unit", "unit"]);
    const c = buildMentionSuggestions("c", [SAM, LOU, ATLAS], [CHANNEL], UNITS).map((s) => s.type);
    expect(c[0]).toBe("special");
    expect(buildMentionSuggestions("", [SAM, LOU, ATLAS], [CHANNEL], UNITS).length).toBeLessThanOrEqual(8);
  });
});

describe("the suggestion list (07.17 PD-19)", () => {
  it("with unit mentions, @log lists Logistics in a Teams group after people and bots", () => {
    const html = list("log", UNITS);
    expect(html).toContain(">Teams<");
    expect(html.match(/data-testid="mention-option-unit"/g)).toHaveLength(2);
    expect(html).toContain("Logistics");
    expect(html).toContain("@logistics");
    expect(html).toContain("Team · 6");
    // The person row (Lou Logan) is above the Teams header.
    expect(html.indexOf('data-testid="mention-option"')).toBeLessThan(html.indexOf(">Teams<"));
    expect(html.indexOf(">Teams<")).toBeLessThan(html.indexOf('data-testid="mention-option-unit"'));
  });

  it("a department reads Department · 24", () => {
    const html = list("op", UNITS);
    expect(html).toContain("Operations");
    expect(html).toContain("Department · 24");
  });

  it("without unit mentions (DMs, group DMs, AI chats) there is no Teams group", () => {
    const html = list("log", undefined);
    expect(html).not.toContain(">Teams<");
    expect(html).not.toContain("mention-option-unit");
    expect(html).toContain('data-testid="mention-option"');
  });

  it("a unit whose handle a person holds is never offered", () => {
    const html = list("sam", UNITS);
    expect(html).not.toContain("Sam&#x27;s team");
    expect(html).not.toContain("mention-option-unit");
  });

  it("the person rows render exactly as before (no Teams markup leaks in)", () => {
    expect(list("atl", UNITS)).toEqual(list("atl", undefined));
    expect(list("atl", UNITS)).toContain('data-testid="mention-option"');
  });

  it("unit rows are 44 px targets on phones and never scroll sideways", () => {
    const html = list("log", UNITS);
    const row = html.match(/<button[^>]*data-testid="mention-option-unit"[^>]*>/)?.[0] ?? "";
    expect(row).toContain("max-md:min-h-11");
    expect(row).toContain("w-full");
    expect(html).toMatch(/data-testid="mention-option-unit"[\s\S]*?min-w-0 truncate/);
  });
});

describe("the unit chip (07.17 PD-19)", () => {
  const ctx = (myHandle: string | null, extra: Array<[string, MentionTarget]> = []): MentionContextValue => ({
    handles: new Map<string, MentionTarget>([
      ["sam", { kind: "user", displayName: "Sam Lee" }],
      ["atlas", { kind: "agent", displayName: "Atlas" }],
      ...extra,
    ]),
    myHandle,
  });
  const chip = (handle: string, value: MentionContextValue) =>
    renderToStaticMarkup(
      <MentionContext.Provider value={value}>
        <MentionChip handle={handle}>@{handle}</MentionChip>
      </MentionContext.Provider>,
    );

  it("@logistics renders a mention chip titled Logistics · team, amber when the viewer is in it", () => {
    const inReach = chip(
      "logistics",
      ctx(null, [
        ["logistics", { kind: "unit", displayName: "Logistics", unitKind: "team", viewerInReach: true }],
      ]),
    );
    const outside = chip(
      "logistics",
      ctx(null, [
        ["logistics", { kind: "unit", displayName: "Logistics", unitKind: "team", viewerInReach: false }],
      ]),
    );
    expect(inReach).toContain('data-testid="mention"');
    expect(inReach).toContain('title="Logistics · team"');
    expect(inReach).toContain('data-mention-kind="unit"');
    expect(inReach).toContain("bg-amber-400/25");
    expect(outside).not.toContain("bg-amber-400/25");
    expect(outside).toContain("bg-primary/10");
  });

  it("a department chip says department; an unknown handle stays text", () => {
    const html = chip(
      "ops",
      ctx(null, [["ops", { kind: "unit", displayName: "Operations", unitKind: "department" }]]),
    );
    expect(html).toContain('title="Operations · department"');
    expect(chip("nobody", ctx(null))).toBe("@nobody");
  });

  it("person and bot chips are unchanged", () => {
    expect(chip("sam", ctx(null))).toBe(
      '<span data-testid="mention" title="Sam Lee" class="rounded-[4px] px-0.5 font-medium bg-primary/10 text-primary dark:bg-primary/20 dark:text-[oklch(0.8_0.11_278)]">@sam</span>',
    );
    expect(chip("atlas", ctx(null))).toContain('title="Atlas (bot)"');
    expect(chip("sam", ctx("sam"))).toContain("bg-amber-400/25");
  });
});
