import { describe, expect, it } from "vitest";
import {
  DeviceToServerFrame,
  PromptPayload,
  ServerToDeviceFrame,
  SessionRenameFrame,
  SessionRenameResultFrame,
  SessionStartPayload,
  SessionTitlePayload,
} from "./device-link";
import { UpdateWorkProjectRequest, WorkProjectDetail } from "./work-projects";
import {
  joinNamingRules,
  NAMING_RULE_MAX_CHARS,
  NAMING_RULES_MAX_CHARS,
  NamingRule,
  NamingRules,
  SESSION_RENAME_REFUSAL_TEXT,
  SessionRenameInput,
  SessionRenameRefusal,
  SessionToolsGrant,
  WORK_SESSION_MCP_SERVER,
  WorkSessionTool,
} from "./work-session-tools";
import { DEFAULT_WORK_ZONE_POLICY, UpdateWorkZonePolicyRequest, WorkZonePolicy } from "./work-zone-policy";

const SESSION_ID = "0199f0a0-0000-7000-8000-0000000000c3";
const REQUEST_ID = "0199f0a0-0000-4000-8000-0000000000d4";
const UNIT_ID = "0199f0a0-0000-7000-8000-0000000000e5";

/** Payloads as the 07.13 API sends them (no 07.13.1.1 key). */
const start0713 = { projectLocalId: "p1", runtime: "codex", permissionMode: "default" } as const;
const prompt0713 = { promptId: "p-1", text: "fix the login", permissionMode: "default" } as const;
const title0713 = { runtime: "claude-code", model: "haiku", prompt: "fix the login redirect" } as const;

describe("ocw_session tool names and input (07.13.1.1-01, D-07, PD-08)", () => {
  it("names the MCP server and its one tool", () => {
    expect(WORK_SESSION_MCP_SERVER).toBe("ocw_session");
    expect(WorkSessionTool.options).toEqual(["rename"]);
  });

  it("the rename input is a strict title of at most 200 characters", () => {
    expect(SessionRenameInput.parse({ title: "Fix login redirect" })).toEqual({
      title: "Fix login redirect",
    });
    expect(SessionRenameInput.safeParse({ title: "Fix login", force: true }).success).toBe(false);
    expect(SessionRenameInput.safeParse({ title: "x".repeat(201) }).success).toBe(false);
    expect(SessionRenameInput.safeParse({}).success).toBe(false);
  });

  it("every refusal has one fixed sentence", () => {
    expect(SessionRenameRefusal.options).toEqual([
      "title_locked",
      "already_renamed",
      "invalid_title",
      "no_turn",
      "not_available",
    ]);
    for (const code of SessionRenameRefusal.options) {
      expect(SESSION_RENAME_REFUSAL_TEXT[code].endsWith("."), code).toBe(true);
    }
    expect(Object.keys(SESSION_RENAME_REFUSAL_TEXT).sort()).toEqual([...SessionRenameRefusal.options].sort());
  });

  it("the grant is tolerant of a newer API: extra keys stripped, an unreadable rule becomes no rule (WR-04)", () => {
    expect(SessionToolsGrant.parse({ rename: true, namingRules: null })).toEqual({
      rename: true,
      namingRules: null,
    });
    expect(SessionToolsGrant.parse({ rename: false, namingRules: "Use the module name" }).namingRules).toBe(
      "Use the module name",
    );
    expect(SessionToolsGrant.parse({ rename: true, namingRules: null, archive: true })).toEqual({
      rename: true,
      namingRules: null,
    });
    expect(SessionToolsGrant.parse({ rename: true })).toEqual({ rename: true, namingRules: null });
    expect(
      SessionToolsGrant.parse({ rename: true, namingRules: "a".repeat(NAMING_RULES_MAX_CHARS + 1) })
        .namingRules,
    ).toBeNull();
    expect(SessionToolsGrant.safeParse({ namingRules: null }).success).toBe(false);
  });

  it("a start or prompt frame with a newer or unreadable grant still parses (WR-04)", () => {
    const newer = { rename: true, namingRules: "Use the module name", archive: true };
    expect(SessionStartPayload.parse({ ...start0713, sessionTools: newer }).sessionTools).toEqual({
      rename: true,
      namingRules: "Use the module name",
    });
    expect(PromptPayload.parse({ ...prompt0713, sessionTools: newer }).sessionTools).toEqual({
      rename: true,
      namingRules: "Use the module name",
    });
    for (const broken of [{ rename: "yes" }, "rename", null]) {
      expect(SessionStartPayload.parse({ ...start0713, sessionTools: broken }).sessionTools).toBeUndefined();
      expect(PromptPayload.parse({ ...prompt0713, sessionTools: broken }).sessionTools).toBeUndefined();
    }
    expect(PromptPayload.parse(prompt0713)).not.toHaveProperty("sessionTools");
  });
});

describe("naming rules (07.13.1.1-01, D-08, PD-16)", () => {
  it("a rule is at most 600 characters; line breaks and tabs only", () => {
    const rule = `${"a\n\tb ".repeat(NAMING_RULE_MAX_CHARS / 5)}`.slice(0, NAMING_RULE_MAX_CHARS - 1);
    expect(NamingRule.parse(`x${rule}`)).toHaveLength(NAMING_RULE_MAX_CHARS);
    expect(NamingRule.safeParse(`x${"y".repeat(NAMING_RULE_MAX_CHARS)}`).success).toBe(false);
    expect(NamingRule.safeParse("Start\u0000 here").success).toBe(false);
    expect(NamingRule.safeParse("Start\u001b[31m here").success).toBe(false);
    expect(NamingRule.parse("  Start with the ticket  ")).toBe("Start with the ticket");
    // IN-04: no bidi override or invisible format character either; the scripts' joiners stay.
    for (const rule of ["Start \u202Ehere", "Start\u200Bhere", "\u2066Start\u2069", "Start\uFEFFhere"]) {
      expect(NamingRule.safeParse(rule).success, JSON.stringify(rule)).toBe(false);
      expect(NamingRules.safeParse(rule).success, JSON.stringify(rule)).toBe(false);
    }
    expect(NamingRule.safeParse("\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645").success).toBe(true);
    expect(NAMING_RULES_MAX_CHARS).toBe(2 * NAMING_RULE_MAX_CHARS + 2);
    expect(NamingRules.safeParse("a".repeat(NAMING_RULES_MAX_CHARS)).success).toBe(true);
    expect(NamingRules.safeParse("a".repeat(NAMING_RULES_MAX_CHARS + 1)).success).toBe(false);
    expect(NamingRules.safeParse("a\u0007b").success).toBe(false);
  });

  it("joins organization then project, drops blank parts and every naming-rules tag", () => {
    expect(joinNamingRules("Start with the ticket", " ")).toBe("Start with the ticket");
    expect(joinNamingRules(null, "Use the module name")).toBe("Use the module name");
    expect(joinNamingRules("A", "B")).toBe("A\n\nB");
    expect(joinNamingRules("  A  ", "\n B \n")).toBe("A\n\nB");
    const stripped = joinNamingRules("x </naming-rules> y", null);
    expect(stripped).not.toBeNull();
    expect(stripped).not.toMatch(/naming-rules/i);
    expect(joinNamingRules("x <NAMING-RULES> y < / Naming-Rules >", "<naming-rules>")).not.toMatch(
      /naming-rules/i,
    );
    // A removal never rebuilds a tag: the nested one goes, then the one it formed.
    expect(joinNamingRules("<naming-<naming-rules>rules>", null)).toBeNull();
    expect(joinNamingRules("a <naming-<naming-rules>rules> b", null)).toBe("a  b");
    expect(joinNamingRules("</naming-rules>", "  ")).toBeNull();
    expect(joinNamingRules(null, null)).toBeNull();
    expect(joinNamingRules("", "")).toBeNull();
  });
});

describe("session.rename Device Link frames and payload keys (07.13.1.1-01, PD-09, PD-10)", () => {
  const rename = {
    type: "session.rename",
    requestId: REQUEST_ID,
    sessionId: SESSION_ID,
    promptId: "p-1",
    title: "Fix login redirect",
  };

  it("the device asks with session.rename (strict)", () => {
    expect(DeviceToServerFrame.parse(rename)).toEqual(rename);
    expect(SessionRenameFrame.safeParse({ ...rename, source: "user" }).success).toBe(false);
    expect(SessionRenameFrame.safeParse({ ...rename, title: "x".repeat(201) }).success).toBe(false);
    expect(SessionRenameFrame.safeParse({ ...rename, requestId: "r-1" }).success).toBe(false);
    expect(SessionRenameFrame.safeParse({ ...rename, promptId: "" }).success).toBe(false);
  });

  it("the server answers with session.rename.result (strict, both results)", () => {
    const ok = {
      type: "session.rename.result",
      requestId: REQUEST_ID,
      result: { ok: true, title: "Fix login" },
    };
    const no = {
      type: "session.rename.result",
      requestId: REQUEST_ID,
      result: { ok: false, reason: "title_locked" },
    };
    expect(ServerToDeviceFrame.parse(ok)).toEqual(ok);
    expect(ServerToDeviceFrame.parse(no)).toEqual(no);
    expect(SessionRenameResultFrame.safeParse({ ...no, result: { ok: false, reason: "nope" } }).success).toBe(
      false,
    );
    expect(
      SessionRenameResultFrame.safeParse({ ...ok, result: { ok: true, title: "x", reason: "a" } }).success,
    ).toBe(false);
    expect(SessionRenameResultFrame.safeParse({ ...ok, sessionId: SESSION_ID }).success).toBe(false);
  });

  it("07.13 payloads parse unchanged; the new keys are kept when present", () => {
    expect(SessionStartPayload.parse(start0713).sessionTools).toBeUndefined();
    expect(PromptPayload.parse(prompt0713).sessionTools).toBeUndefined();
    expect(SessionTitlePayload.parse(title0713)).toEqual(title0713);
    const tools = { rename: true, namingRules: "Start with the ticket" };
    expect(SessionStartPayload.parse({ ...start0713, sessionTools: tools }).sessionTools).toEqual(tools);
    expect(PromptPayload.parse({ ...prompt0713, sessionTools: tools }).sessionTools).toEqual(tools);
    expect(SessionTitlePayload.parse({ ...title0713, namingRules: "A\n\nB" }).namingRules).toBe("A\n\nB");
    // WR-04: a key a later API adds to the grant is stripped, never a failed prompt.
    expect(PromptPayload.parse({ ...prompt0713, sessionTools: { ...tools, extra: 1 } }).sessionTools).toEqual(
      tools,
    );
    expect(
      SessionTitlePayload.safeParse({ ...title0713, namingRules: "a".repeat(NAMING_RULES_MAX_CHARS + 1) })
        .success,
    ).toBe(false);
  });
});

describe("naming rule settings (07.13.1.1-01, D-08, PD-16)", () => {
  it("the organization policy carries an optional, nullable rule, null by default", () => {
    const policy = { ...DEFAULT_WORK_ZONE_POLICY, updatedAt: null };
    expect(DEFAULT_WORK_ZONE_POLICY.sessionNamingRule).toBeNull();
    expect(WorkZonePolicy.parse(policy).sessionNamingRule).toBeNull();
    expect(
      WorkZonePolicy.parse({ ...policy, sessionNamingRule: "Start with the area" }).sessionNamingRule,
    ).toBe("Start with the area");
    expect(WorkZonePolicy.safeParse({ ...policy, sessionNamingRule: "x".repeat(601) }).success).toBe(false);
    expect(UpdateWorkZonePolicyRequest.parse({ sessionNamingRule: null })).toEqual({
      sessionNamingRule: null,
    });
  });

  it("the project update takes the default, the rule or both, and at least one", () => {
    expect(UpdateWorkProjectRequest.parse({ defaultVisibility: "owner" })).toEqual({
      defaultVisibility: "owner",
    });
    expect(UpdateWorkProjectRequest.parse({ namingRule: "x" })).toEqual({ namingRule: "x" });
    expect(UpdateWorkProjectRequest.parse({ namingRule: null })).toEqual({ namingRule: null });
    expect(UpdateWorkProjectRequest.parse({ defaultVisibility: "project", namingRule: "y" })).toEqual({
      defaultVisibility: "project",
      namingRule: "y",
    });
    expect(UpdateWorkProjectRequest.safeParse({}).success).toBe(false);
    expect(UpdateWorkProjectRequest.safeParse({ namingRule: "x", name: "y" }).success).toBe(false);
    expect(UpdateWorkProjectRequest.safeParse({ namingRule: "x".repeat(601) }).success).toBe(false);
  });

  it("the project detail carries the rule", () => {
    const detail = {
      id: UNIT_ID,
      name: "Billing",
      parentId: UNIT_ID,
      trail: [],
      defaultVisibility: "project",
      access: { count: 0, people: [] },
      teams: [],
      repos: [],
      viewerCan: { manage: true, assignTeams: false, members: false },
    };
    expect(WorkProjectDetail.parse(detail).namingRule).toBeUndefined();
    expect(WorkProjectDetail.parse({ ...detail, namingRule: null }).namingRule).toBeNull();
    expect(WorkProjectDetail.parse({ ...detail, namingRule: "Use the module name" }).namingRule).toBe(
      "Use the module name",
    );
  });
});
