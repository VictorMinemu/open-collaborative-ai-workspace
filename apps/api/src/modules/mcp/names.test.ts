import { describe, expect, it } from "vitest";
import { cellEnvName, openclawToolName, openclawToolNames, safeServerName } from "./names";

const ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
// sha256(ID) = 9c6e7f77 48b6f452 540fa127 …

describe("safeServerName (Pitfall P-B2)", () => {
  it("is m + 8 lowercase hex, stable for an id", () => {
    expect(safeServerName(ID, new Set())).toBe("m9c6e7f77");
    expect(safeServerName(ID, new Set())).toMatch(/^m[0-9a-f]{8}$/);
    expect(safeServerName(ID, new Set(["mffffffff"]))).toBe("m9c6e7f77");
  });

  it("takes the next 8-hex slice of the hash when the name is taken", () => {
    expect(safeServerName(ID, new Set(["m9c6e7f77"]))).toBe("m48b6f452");
    expect(safeServerName(ID, new Set(["m9c6e7f77", "m48b6f452"]))).toBe("m540fa127");
  });

  it("different ids give different names", () => {
    expect(safeServerName("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c", new Set())).not.toBe(
      safeServerName(ID, new Set()),
    );
  });
});

describe("openclawToolName (mirrors OpenClaw 2026.9.7 buildSafeToolName)", () => {
  it("joins with __ and sanitises the tool fragment", () => {
    expect(openclawToolName("m3f9a12c4", "search docs")).toBe("m3f9a12c4__search-docs");
    expect(openclawToolName("m3f9a12c4", "echo")).toBe("m3f9a12c4__echo");
    expect(openclawToolName("m3f9a12c4", "write_note")).toBe("m3f9a12c4__write_note");
    expect(openclawToolName("m3f9a12c4", "a.b/c")).toBe("m3f9a12c4__a-b-c");
  });

  it("prefixes fragments that do not start with a letter, falls back to `tool` when empty", () => {
    expect(openclawToolName("m3f9a12c4", "1st")).toBe("m3f9a12c4__tool-1st");
    expect(openclawToolName("m3f9a12c4", "   ")).toBe("m3f9a12c4__tool");
  });

  it("never exceeds 64 characters", () => {
    const name = openclawToolName("m3f9a12c4", "x".repeat(200));
    expect(name).toHaveLength(64);
    expect(name.startsWith("m3f9a12c4__xxx")).toBe(true);
  });

  it("a tool keeps its name when the server lists its tools in another order (OpenClaw sorts before suffixing)", () => {
    const listed = ["b.x", "b-x", "b x", "a"];
    const forward = openclawToolNames("m3f9a12c4", listed);
    const reversed = openclawToolNames("m3f9a12c4", [...listed].reverse()).reverse();
    expect(reversed).toEqual(forward);
    expect(new Set(forward).size).toBe(4);
    // OpenClaw 2026.9.7 materialises a server's tools sorted by name (localeCompare), then assigns suffixes.
    const sorted = [...listed].sort((x, y) => x.localeCompare(y));
    const bySorted = openclawToolNames("m3f9a12c4", sorted);
    expect(listed.map((t) => bySorted[sorted.indexOf(t)])).toEqual(forward);
    // The first of the colliding names in sorted order is the one without a suffix.
    const firstColliding = sorted.find((t) => t !== "a") as string;
    expect(forward[listed.indexOf(firstColliding)]).toBe(
      `m3f9a12c4__${firstColliding.replace(/[^A-Za-z0-9_-]/g, "-")}`,
    );
  });

  it("assigns collision suffixes in sorted order, case-insensitively", () => {
    expect(openclawToolNames("m3f9a12c4", ["a b", "a-b", "A-B", "c"])).toEqual([
      "m3f9a12c4__a-b",
      "m3f9a12c4__a-b-2",
      "m3f9a12c4__A-B-3",
      "m3f9a12c4__c",
    ]);
    const long = openclawToolNames("m3f9a12c4", ["y".repeat(80), "y".repeat(81)]);
    expect(long[1]).toHaveLength(64);
    expect(long[1]?.endsWith("-2")).toBe(true);
  });
});

describe("cellEnvName", () => {
  it("is OCW_MCP_<SAFE>_<index>", () => {
    expect(cellEnvName("m3f9a12c4", 0)).toBe("OCW_MCP_M3F9A12C4_0");
    expect(cellEnvName("m3f9a12c4", 7)).toBe("OCW_MCP_M3F9A12C4_7");
  });
});
