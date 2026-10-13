import { describe, expect, it } from "vitest";
import {
  CreateMemoryFileRequest,
  isUnderFolder,
  MEMORY_LIMITS,
  MEMORY_ROOT_FILE,
  MEMORY_ROOT_TEMPLATE,
  MemoryFile,
  MemoryFolder,
  MemoryPath,
  type MemoryPathError,
  memoryPathKey,
  parseMemoryFolder,
  parseMemoryPath,
  UpdateMemoryFileRequest,
} from "./memory";

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
