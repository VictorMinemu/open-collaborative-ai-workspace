import { describe, expect, it } from "vitest";
import {
  AgentChannelMemoryList,
  AgentChannelMemoryListResponse,
  AgentChannelMemoryPropose,
  AgentChannelMemoryProposeResponse,
  AgentChannelMemoryRead,
  AgentChannelMemoryReadResponse,
  AgentChannelMemoryWrite,
  AgentChannelMemoryWriteResponse,
  MemoryToolRefusal,
} from "./agent-channel";
import { BUILTIN_TOOLS, isDangerousToolName, TurnContext } from "./bot-capabilities";
import {
  CreateMemoryFileRequest,
  isUnderFolder,
  MEMORY_LIMITS,
  MEMORY_ROOT_FILE,
  MEMORY_ROOT_TEMPLATE,
  MemoryChangedEvent,
  MemoryErrorCode,
  MemoryFile,
  MemoryFolder,
  MemoryPath,
  type MemoryPathError,
  MemoryProposalView,
  maskSample,
  memoryPathKey,
  parseMemoryFolder,
  parseMemoryPath,
  SensitiveFinding,
  SensitiveSpan,
  UpdateMemoryFileRequest,
} from "./memory";
import { CreatePermissionRuleRequest, PermissionRule } from "./organization";
import { EventTypes } from "./realtime";

const id = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e5f";
const now = "2026-10-12T10:00:00.000Z";

describe("parseMemoryPath (MEM-01, D-01, Pitfall 4)", () => {
  it.each([
    "MEMORY.md",
    "clients/acme.md",
    "people/Ana Pérez.md",
    "a/b/c/d/e/f/g/h.md",
    "topics/2026-10_q4.md",
  ])("accepts %j unchanged", (input) => {
    expect(parseMemoryPath(input)).toEqual({ ok: true, path: input });
  });

  it("returns the NFC spelling for an NFD input", () => {
    const nfc = "café.md".normalize("NFC");
    const nfd = "café.md".normalize("NFD");
    expect(nfd).not.toBe(nfc);
    expect(parseMemoryPath(nfd)).toEqual({ ok: true, path: nfc });
    expect(parseMemoryPath(nfc)).toEqual({ ok: true, path: nfc });
  });

  const nine = "a/b/c/d/e/f/g/h/i.md";
  // Five valid segments, 255 + 1 characters in total (no segment over 64, depth 5).
  const long = `${["x".repeat(60), "y".repeat(60), "z".repeat(60), "w".repeat(60)].join("/")}/${"v".repeat(9)}.md`;

  it.each<[string, string, MemoryPathError]>([
    ["empty", "", "empty"],
    ["absolute", "/a.md", "absolute"],
    ["backslash", "a\\b.md", "backslash"],
    ["parent in the middle", "a/../b.md", "dot_segment"],
    ["current dir", "./a.md", "dot_segment"],
    ["parent first", "../x.md", "dot_segment"],
    ["dots only", ".../x.md", "dot_segment"],
    ["encoded parent", "%2e%2e/a.md", "percent"],
    ["encoded space", "a%20b.md", "percent"],
    ["double slash", "a//b.md", "empty_segment"],
    ["trailing slash", "a/", "trailing_slash"],
    ["leading space", " a.md", "segment_space"],
    ["trailing space in a folder", "a /b.md", "segment_space"],
    ["NUL", "a\u0000.md", "control"],
    ["line feed", "a\n.md", "control"],
    ["bidi override", "a‮b.md", "control"],
    ["colon", "a/b:c.md", "segment_charset"],
    ["angle brackets", "a/<b>.md", "segment_charset"],
    ["65-character segment", `${"s".repeat(62)}.md`, "segment_length"],
    ["nine levels", nine, "depth"],
    ["256 characters", long, "length"],
    ["not markdown", "notes.txt", "extension"],
    ["uppercase extension", "notes.MD", "extension"],
  ])("rejects %s with %j", (_label, input, reason) => {
    expect(parseMemoryPath(input)).toEqual({ ok: false, reason });
  });

  it("the fixtures above have the shape their names claim", () => {
    expect(`${"s".repeat(62)}.md`).toHaveLength(65);
    expect(long).toHaveLength(MEMORY_LIMITS.pathChars + 1);
    for (const seg of long.split("/")) expect(seg.length).toBeLessThanOrEqual(MEMORY_LIMITS.segmentChars);
    expect(nine.split("/")).toHaveLength(MEMORY_LIMITS.depth + 1);
  });

  it("never repairs and is deterministic", () => {
    for (const input of ["a//b.md", " a.md", "a/../b.md", "people/Ana Pérez.md"]) {
      expect(parseMemoryPath(input)).toEqual(parseMemoryPath(input));
    }
    const ok = parseMemoryPath("people/Ana Pérez.md");
    expect(ok.ok && ok.path).toBe("people/Ana Pérez.md");
  });

  it("MemoryPath wraps the parser: canonical output, the reason as the issue message", () => {
    expect(MemoryPath.parse("café.md".normalize("NFD"))).toBe("café.md".normalize("NFC"));
    const bad = MemoryPath.safeParse("a/../b.md");
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toBe("dot_segment");
  });

  it("MEMORY.md is the root file and its template is a heading", () => {
    expect(MEMORY_ROOT_FILE).toBe("MEMORY.md");
    expect(MEMORY_ROOT_TEMPLATE).toBe("# Memory\n");
    expect(parseMemoryPath(MEMORY_ROOT_FILE).ok).toBe(true);
  });
});

describe("folder prefixes for rules (MEM-07, D-04)", () => {
  it("parses folder forms", () => {
    expect(parseMemoryFolder("hr/")).toEqual({ ok: true, folder: "hr/" });
    expect(parseMemoryFolder("hr/payroll/")).toEqual({ ok: true, folder: "hr/payroll/" });
    expect(parseMemoryFolder("hr")).toEqual({ ok: false, reason: "missing_slash" });
    expect(parseMemoryFolder("/hr/")).toEqual({ ok: false, reason: "absolute" });
    expect(parseMemoryFolder("../")).toEqual({ ok: false, reason: "dot_segment" });
    expect(parseMemoryFolder("hr//")).toEqual({ ok: false, reason: "empty_segment" });
    expect(parseMemoryFolder("")).toEqual({ ok: false, reason: "empty" });
    expect(MemoryFolder.parse("HR/")).toBe("HR/");
    expect(MemoryFolder.safeParse("hr").error?.issues[0]?.message).toBe("missing_slash");
  });

  it("matches case-insensitively on segment boundaries only", () => {
    expect(isUnderFolder("HR/a.md", "hr/")).toBe(true);
    expect(isUnderFolder("hr/x/b.md", "hr/")).toBe(true);
    expect(isUnderFolder("hr/a.md", "HR/")).toBe(true);
    expect(isUnderFolder("hr-public/a.md", "hr/")).toBe(false);
    expect(isUnderFolder("hr.md", "hr/")).toBe(false);
    expect(isUnderFolder("x/hr/a.md", "hr/")).toBe(false);
  });

  it("memoryPathKey is the lowercase uniqueness key", () => {
    expect(memoryPathKey("Clients/Acme.md")).toBe("clients/acme.md");
    expect(memoryPathKey("café.md".normalize("NFD"))).toBe("café.md".normalize("NFC"));
  });
});

describe("memory file DTOs (MEM-01)", () => {
  const actor = { kind: "user", id, displayName: "Ana Pérez", onBehalfOf: null } as const;

  it("a MemoryFile round-trips", () => {
    const file = {
      id,
      scopeId: id,
      path: "clients/acme.md",
      version: 3,
      bytes: 12,
      updatedAt: now,
      updatedBy: actor,
      content: "# Acme\nhello",
      viewerCan: ["read", "write"],
    };
    expect(MemoryFile.parse(file)).toEqual(file);
    const agentEdit = {
      ...file,
      updatedBy: { kind: "agent", id, displayName: "Scout", onBehalfOf: { id, displayName: "Sam Lee" } },
    };
    expect(MemoryFile.parse(agentEdit)).toEqual(agentEdit);
    expect(MemoryFile.safeParse({ ...file, path: "../x.md" }).success).toBe(false);
  });

  it("content limits count UTF-8 bytes, not characters", () => {
    const max = MEMORY_LIMITS.fileBytes;
    expect(max).toBe(262_144);
    const fits = "é".repeat(max / 2); // 2 bytes each
    const over = "é".repeat(max / 2 + 1); // still far fewer characters than `max`
    expect(over.length).toBeLessThan(max);
    expect(UpdateMemoryFileRequest.safeParse({ content: fits, expectedVersion: 1 }).success).toBe(true);
    expect(UpdateMemoryFileRequest.safeParse({ content: over, expectedVersion: 1 }).success).toBe(false);
    expect(CreateMemoryFileRequest.safeParse({ path: "a.md", content: over }).success).toBe(false);
    expect(CreateMemoryFileRequest.safeParse({ path: "a.txt", content: "" }).success).toBe(false);
  });
});

describe("sensitive findings and the proposal view (MEM-05, UI-SPEC R5)", () => {
  const finding = {
    kind: "email",
    severity: "warn",
    source: "builtin",
    count: 2,
    samples: ["a•••@acme.com"],
    lines: [3],
  };

  it("a finding holds at most three masked samples and twenty lines", () => {
    expect(SensitiveFinding.parse(finding)).toEqual(finding);
    expect(SensitiveFinding.safeParse({ ...finding, samples: ["a", "b", "c", "d"] }).success).toBe(false);
    expect(
      SensitiveFinding.safeParse({ ...finding, lines: Array.from({ length: 21 }, (_, i) => i + 1) }).success,
    ).toBe(false);
    expect(SensitiveFinding.safeParse({ ...finding, severity: "critical" }).success).toBe(false);
    expect(
      SensitiveFinding.parse({
        kind: "extended_scan_unavailable",
        severity: "info",
        source: "presidio",
        count: 0,
        samples: [],
        lines: [],
      }).kind,
    ).toBe("extended_scan_unavailable");
  });

  it("spans are offsets into the scanned text", () => {
    expect(SensitiveSpan.parse({ kind: "iban", start: 0, end: 4 })).toEqual({
      kind: "iban",
      start: 0,
      end: 4,
    });
    expect(SensitiveSpan.safeParse({ kind: "iban", start: 4, end: 4 }).success).toBe(false);
    expect(SensitiveSpan.safeParse({ kind: "iban", start: -1, end: 4 }).success).toBe(false);
  });

  const view = {
    proposalId: id,
    scope: { id, kind: "org", label: "Autofy Labs" },
    path: "policies/travel.md",
    op: "create",
    baseVersion: null,
    currentVersion: null,
    base: null,
    proposed: "Ask ana@acme.com",
    linesAdded: 1,
    linesRemoved: 0,
    findings: [finding],
    spans: [{ kind: "email", start: 4, end: 16 }],
    readerCount: 40,
    tainted: true,
    reason: null,
    requestedBy: { agent: { id, displayName: "Scout" }, forUser: { id, displayName: "Sam Lee" } },
  };

  it("a proposal view needs its spans", () => {
    expect(MemoryProposalView.parse(view)).toEqual(view);
    const { spans: _spans, ...noSpans } = view;
    expect(MemoryProposalView.safeParse(noSpans).success).toBe(false);
    expect(MemoryProposalView.safeParse({ ...view, spans: Array(201).fill(view.spans[0]) }).success).toBe(
      false,
    );
    expect(MemoryProposalView.safeParse({ ...view, reason: "x".repeat(281) }).success).toBe(false);
  });

  it.each<[Parameters<typeof maskSample>[0], string, string, string]>([
    ["iban", "ES91 2100 0418 4502 0005 1332", "ES91 •••• 1332", "0418"],
    ["iban", "ES9121000418450200051332", "ES91 •••• 1332", "0418"],
    ["payment_card", "4111 1111 1111 1111", "•••• 1111", "1111 1111 1111"],
    ["es_nif", "12345678Z", "•••••678Z", "12345"],
    ["es_nie", "X1234567L", "•••••567L", "X1234"],
    ["email", "ana@acme.com", "a•••@acme.com", "ana"],
    ["phone", "+34 612 345 678", "+34 ••• ••• 678", "612"],
    ["phone", "612345678", "••• ••• 678", "612"],
    ["person", "Ana Pérez", "A••• P•••", "Pérez"],
    ["secret", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "sk-a••••", "api03"],
  ])("maskSample(%s, %j) is %j and hides the middle", (kind, value, masked, middle) => {
    const out = maskSample(kind, value);
    expect(out).toBe(masked);
    expect(out).not.toContain(middle);
    expect(out).not.toBe(value);
  });

  it("maskSample never returns a short value in full", () => {
    for (const kind of ["secret", "person", "location", "ip_address", "email", "phone"] as const) {
      for (const v of ["ab", "x@y", "1"]) expect(maskSample(kind, v), `${kind} ${v}`).not.toContain(v);
    }
    expect(maskSample("ip_address", "192.168.10.42")).toBe("192.•••.•••.•••");
    expect(maskSample("extended_scan_unavailable", "anything")).toBe("");
  });

  it("memory.changed carries ids and a version only; error codes are fixed", () => {
    expect(EventTypes.memoryChanged).toBe("memory.changed");
    expect(MemoryChangedEvent.parse({ scopeId: id, fileId: id, version: 3 })).toEqual({
      scopeId: id,
      fileId: id,
      version: 3,
    });
    expect(MemoryErrorCode.options).toEqual([
      "memory_path_invalid",
      "memory_version_conflict",
      "memory_path_exists",
      "memory_root_file",
      "memory_file_too_large",
      "memory_scope_full",
      "secret_detected",
      "memory_not_found",
    ]);
  });
});

describe("turn memory files and memory tools (MEM-04, D-02)", () => {
  const turn = {
    tools: ["ocw_memory_read"],
    toolFlags: {},
    memory: [],
    now: null,
    maxToolCalls: 8,
    maxWebCalls: 5,
  };
  const file = {
    scopeKind: "personal",
    scopeId: id,
    path: "MEMORY.md",
    version: 2,
    content: "# Memory\n- likes tea\n",
    truncated: false,
  };

  it("an old turn without memoryFiles parses; a new one carries up to two files of at most 8 KiB", () => {
    expect(TurnContext.parse(turn).memoryFiles).toBeUndefined();
    const two = { ...turn, memoryFiles: [file, { ...file, scopeKind: "agent" }] };
    expect(TurnContext.parse(two)).toEqual(two);
    expect(TurnContext.safeParse({ ...turn, memoryFiles: [file, file, file] }).success).toBe(false);
    const big = { ...file, content: "é".repeat(MEMORY_LIMITS.turnFileBytes / 2 + 1) };
    expect(TurnContext.safeParse({ ...turn, memoryFiles: [big] }).success).toBe(false);
  });

  it("the four memory tools are built-ins that are never flagged dangerous", () => {
    expect(BUILTIN_TOOLS).toMatchObject({
      memorySave: "ocw_memory_save",
      memoryList: "ocw_memory_list",
      memoryRead: "ocw_memory_read",
      memoryWrite: "ocw_memory_write",
      memoryPropose: "ocw_memory_propose",
    });
    for (const t of ["ocw_memory_list", "ocw_memory_read", "ocw_memory_write", "ocw_memory_propose"]) {
      expect(isDangerousToolName(t), t).toBe(false);
    }
    // The word filter still catches a filesystem-looking name (why the tools are not called *_write_file).
    expect(isDangerousToolName("ocw_memory_write_file")).toBe(true);
  });

  const base = { eventId: id, agentId: id };

  it("requests never carry an owner or user id", () => {
    const requests = [
      [AgentChannelMemoryList, { ...base }],
      [AgentChannelMemoryRead, { ...base, scope: "personal", path: "MEMORY.md" }],
      [
        AgentChannelMemoryWrite,
        { ...base, scope: "personal", path: "MEMORY.md", mode: "append", content: "- x" },
      ],
      [AgentChannelMemoryPropose, { ...base, scope: id, path: "a.md", op: "create", content: "x" }],
    ] as const;
    for (const [schema, body] of requests) {
      expect(schema.safeParse(body).success, JSON.stringify(body)).toBe(true);
      expect(schema.safeParse({ ...body, userId: id }).success).toBe(false);
      expect(schema.safeParse({ ...body, ownerUserId: id }).success).toBe(false);
    }
  });

  it("write targets only the agent's own scopes; paths go through MemoryPath", () => {
    const write = { ...base, path: "notes/a.md", mode: "replace", content: "x", expectedVersion: 2 };
    expect(AgentChannelMemoryWrite.safeParse({ ...write, scope: "agent" }).success).toBe(true);
    expect(AgentChannelMemoryWrite.safeParse({ ...write, scope: id }).success).toBe(false);
    expect(AgentChannelMemoryRead.safeParse({ ...base, scope: id, path: "../x.md" }).success).toBe(false);
    expect(AgentChannelMemoryList.safeParse({ ...base, scope: "agent", folder: "notes" }).success).toBe(
      false,
    );
    expect(AgentChannelMemoryList.safeParse({ ...base, scope: "agent", folder: "notes/" }).success).toBe(
      true,
    );
    expect(AgentChannelMemoryList.safeParse({ ...base, scope: "everyone" }).success).toBe(false);
    expect(
      AgentChannelMemoryPropose.safeParse({
        ...base,
        scope: id,
        path: "a.md",
        op: "create",
        content: "x",
        reason: "x".repeat(281),
      }).success,
    ).toBe(false);
  });

  it("responses are a result or a named refusal", () => {
    expect(AgentChannelMemoryReadResponse.parse({ refused: "audience_too_wide" })).toEqual({
      refused: "audience_too_wide",
    });
    expect(
      AgentChannelMemoryReadResponse.parse({ file: { path: "a.md", version: 1, content: "x" } }),
    ).toEqual({
      file: { path: "a.md", version: 1, content: "x" },
    });
    expect(AgentChannelMemoryWriteResponse.parse({ fileId: id, version: 2 })).toEqual({
      fileId: id,
      version: 2,
    });
    expect(AgentChannelMemoryProposeResponse.parse({ approvalId: id, findings: [], readerCount: 3 })).toEqual(
      {
        approvalId: id,
        findings: [],
        readerCount: 3,
      },
    );
    expect(AgentChannelMemoryListResponse.parse({ refused: "memory_off" })).toEqual({
      refused: "memory_off",
    });
    expect(AgentChannelMemoryListResponse.safeParse({ refused: "nope" }).success).toBe(false);
    expect(MemoryToolRefusal.options).toContain("own_scope_only");
    expect(MemoryToolRefusal.options).toHaveLength(17);
  });
});

describe("per-folder rules (MEM-07, D-04)", () => {
  const rule = { subjectKind: "everyone", effect: "deny" } as const;

  it("a path prefix is a folder and applies only to memory permissions", () => {
    expect(
      CreatePermissionRuleRequest.parse({ ...rule, permission: "memory.read", pathPrefix: "hr/" }).pathPrefix,
    ).toBe("hr/");
    expect(
      CreatePermissionRuleRequest.safeParse({ ...rule, permission: "memory.*", pathPrefix: "hr/x/" }).success,
    ).toBe(true);
    expect(
      CreatePermissionRuleRequest.safeParse({ ...rule, permission: "bot.read", pathPrefix: "hr/" }).success,
    ).toBe(false);
    expect(
      CreatePermissionRuleRequest.safeParse({ ...rule, permission: "memory.read", pathPrefix: "hr" }).success,
    ).toBe(false);
    expect(
      CreatePermissionRuleRequest.safeParse({ ...rule, permission: "memory.read", pathPrefix: "../" })
        .success,
    ).toBe(false);
    // Without a path the rule is unchanged (and defaults to the whole scope).
    expect(CreatePermissionRuleRequest.parse({ ...rule, permission: "bot.read" }).pathPrefix).toBeNull();
  });

  it("the rule DTO carries pathPrefix and still reads rows without it", () => {
    const row = {
      id,
      scopeUnitId: null,
      subjectKind: "everyone",
      subjectId: null,
      permission: "memory.read",
      tool: null,
      effect: "deny",
      createdBy: null,
      createdAt: now,
    };
    expect(PermissionRule.parse(row).pathPrefix).toBeNull();
    expect(PermissionRule.parse({ ...row, pathPrefix: "hr/" }).pathPrefix).toBe("hr/");
  });
});
