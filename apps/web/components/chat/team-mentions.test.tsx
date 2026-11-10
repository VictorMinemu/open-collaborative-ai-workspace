import { type Notification, type OrgUnit, TEAM_MENTION_LIMITS } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildTree } from "../organization/unit-meta";
import { UnitTree } from "../organization/unit-tree";
import {
  buildMentionSuggestions,
  type MentionCandidate,
  MentionSuggestions,
  mentionConfirmation,
  rankUnitMention,
  type SpecialMention,
  teamReachOf,
} from "./composer";
import { actionOf } from "./inbox";
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

// ---------------------------------------------------------------- Task 2: confirmation, inbox, organization page

describe("teamReachOf and the reach confirmation (07.17 D-18)", () => {
  const units = (reach: number): UnitMentionCandidate[] => [
    { id: OPS.id, kind: "department", name: "Operations", handle: "ops", reach, viewerInReach: false },
    { id: BLOG.id, kind: "team", name: "Blog team", handle: "blog-team", reach: 3, viewerInReach: false },
  ];

  it("the largest reach among the units the body names; 0 when none", () => {
    expect(teamReachOf("ship it @ops and @blog-team", units(24))).toBe(24);
    expect(teamReachOf("only @blog-team.", units(24))).toBe(3);
    expect(teamReachOf("@OPS shouting", units(24))).toBe(24);
    expect(teamReachOf("no team here, @sam", units(24))).toBe(0);
    expect(teamReachOf("@ops", undefined)).toBe(0);
    expect(teamReachOf("mail ops@example.com", units(24))).toBe(0);
  });

  it("21 people opens the confirmation, 20 sends at once (TEAM_MENTION_LIMITS.confirmAbove)", () => {
    expect(TEAM_MENTION_LIMITS.confirmAbove).toBe(20);
    expect(mentionConfirmation("@ops", { unitMentions: units(21) })).not.toBeNull();
    expect(mentionConfirmation("@ops", { unitMentions: units(20) })).toBeNull();
    // No unit mentions passed (DMs, group DMs, AI chats): never a team confirmation.
    expect(mentionConfirmation("@ops", {})).toBeNull();
  });

  it("the team dialog reads Notify 24 people? / @ops reaches 24 people who can read this channel.", () => {
    expect(mentionConfirmation("@ops look", { unitMentions: units(24) })).toEqual({
      kind: "team",
      title: "Notify 24 people?",
      description: "@ops reaches 24 people who can read this channel.",
    });
  });

  it("@channel and a large team in one body: one dialog, the @channel one", () => {
    const opts = { unitMentions: units(24), specialMentions: [CHANNEL], memberCount: 40 };
    expect(mentionConfirmation("@channel and @ops", opts)).toEqual({
      kind: "all",
      title: "Notify 40 people?",
      description: "@channel notifies all 40 members of this channel, wherever they are.",
    });
    // The @channel confirmation is unchanged: it needs the permission and more than 20 members.
    expect(mentionConfirmation("@channel", { specialMentions: [CHANNEL], memberCount: 20 })).toBeNull();
    expect(mentionConfirmation("@channel", { memberCount: 40 })).toBeNull();
    expect(mentionConfirmation("@here", { specialMentions: [CHANNEL], memberCount: 40 })?.description).toBe(
      "@here notifies everyone in this channel who is online now, out of 40 members.",
    );
  });
});

describe("the inbox line of a team mention (07.17 D-07, PD-19)", () => {
  const item = (over: Partial<Notification>): Notification => ({
    id: "00000000-0000-4000-8000-0000000000d1",
    kind: "team_mention",
    conversation: {
      id: "00000000-0000-4000-8000-0000000000d2",
      kind: "channel",
      name: "fleet",
      label: "#fleet",
      visibility: "public",
      archived: false,
    },
    messageId: "00000000-0000-4000-8000-0000000000d3",
    threadRootId: null,
    actor: { kind: "agent", id: ATLAS.id, displayName: "Atlas" },
    snippet: "Done: order 1042 @logistics",
    createdAt: NOW,
    readAt: null,
    ...over,
  });

  it("names the team that reached the reader; falls back when the unit is gone", () => {
    expect(actionOf(item({ unit: { id: LOGISTICS.id, handle: "logistics", name: "Logistics" } }))).toBe(
      "mentioned @logistics",
    );
    expect(actionOf(item({ unit: null }))).toBe("mentioned your team");
    expect(actionOf(item({}))).toBe("mentioned your team");
  });

  it("other kinds keep their labels", () => {
    expect(actionOf(item({ kind: "mention" }))).toBe("mentioned you");
    expect(actionOf(item({ kind: "channel" }))).toBe("notified @channel");
  });
});

describe("the handle on Settings › Organization (07.17 D-14)", () => {
  const tree = (units: OrgUnit[]) =>
    renderToStaticMarkup(
      <UnitTree
        roots={buildTree(units).roots}
        selectedId={null}
        collapsed={new Set()}
        onSelect={() => {}}
        onToggle={() => {}}
      />,
    );
  const DEPT = "00000000-0000-4000-8000-0000000000e0";
  const TEAM = "00000000-0000-4000-8000-0000000000e1";
  const PROJ = "00000000-0000-4000-8000-0000000000e2";

  it("a team and a department show their @handle in muted mono; a project shows none", () => {
    const html = tree([
      unit({ id: DEPT, path: [DEPT], kind: "department", name: "Operations", handle: "ops" }),
      unit({
        id: TEAM,
        parentId: DEPT,
        path: [DEPT, TEAM],
        kind: "team",
        name: "Logistics",
        handle: "logistics",
      }),
      unit({
        id: PROJ,
        parentId: TEAM,
        path: [DEPT, TEAM, PROJ],
        kind: "project",
        name: "Portal",
        handle: "portal",
      }),
    ]);
    const handles = [...html.matchAll(/<span[^>]*data-testid="unit-handle"[^>]*>([^<]*)</g)];
    expect(handles.map((m) => m[1])).toEqual(["@ops", "@logistics"]);
    const tag = handles[0]?.[0] ?? "";
    expect(tag).toContain('title="Mention handle"');
    expect(tag).toContain("font-mono");
    expect(tag).toContain("text-muted-foreground");
    expect(tag).toContain("truncate");
    expect(tag).toContain("min-w-0");
    expect(html).toContain("Portal");
  });

  it("a unit from an older server (no handle) shows none", () => {
    expect(tree([unit({ kind: "team", name: "Legacy" })])).not.toContain("unit-handle");
  });
});
