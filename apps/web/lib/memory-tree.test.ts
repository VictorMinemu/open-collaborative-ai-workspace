import type { MemoryFileMeta, MemoryScope } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import {
  buildMemoryTree,
  fileNodeId,
  folderNodeId,
  type MemoryNode,
  memoryAncestorIds,
  memoryHref,
  pathFromSegments,
  pathMarks,
  resolveMemoryLink,
  scopeAccessibleName,
  scopeNodeId,
} from "./memory-tree";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function scope(
  n: number,
  kind: MemoryScope["kind"],
  label: string,
  unitKind: MemoryScope["unitKind"] = null,
) {
  return {
    id: id(n),
    kind,
    label,
    agentId: kind === "personal" || kind === "agent" ? id(900 + n) : null,
    unitId: kind === "unit" ? id(800 + n) : null,
    unitKind,
    viewerCan: ["read"],
  } satisfies MemoryScope;
}

function file(scopeId: string, path: string, n = path.length): MemoryFileMeta {
  return {
    id: id(500 + n),
    scopeId,
    path,
    version: 1,
    bytes: 10,
    updatedAt: "2026-10-13T10:00:00.000Z",
    updatedBy: { kind: "system", id: null, displayName: "Workspace", onBehalfOf: null },
  };
}

const names = (nodes: readonly MemoryNode[] | undefined) => (nodes ?? []).map((n) => n.name);

describe("buildMemoryTree", () => {
  const org = scope(1, "org", "Organization");
  const ventas = scope(2, "unit", "Ventas", "team");
  const sales = scope(3, "unit", "Sales", "department");
  const notebook = scope(4, "agent", "Scout notebook");
  const notebookA = scope(5, "agent", "Atlas notebook");
  const privateScout = scope(6, "personal", "You & Scout");
  const privateAtlas = scope(7, "personal", "You & Atlas");

  it("orders scopes private → notebooks → units in the API's org-chart order → organization", () => {
    // The API lists units in organization-chart order (Sales, then its team Ventas); the client keeps that order.
    const tree = buildMemoryTree(
      [org, notebook, sales, privateScout, ventas, notebookA, privateAtlas],
      new Map(),
    );
    expect(names(tree)).toEqual([
      "You & Atlas",
      "You & Scout",
      "Atlas notebook",
      "Scout notebook",
      "Sales",
      "Ventas",
      "Organization",
    ]);
    expect(tree.every((n) => n.kind === "scope" && n.id === scopeNodeId(n.scopeId))).toBe(true);
  });

  it("derives folders from paths and pins MEMORY.md first, then folders, then files (base, numeric)", () => {
    const files = [
      file(ventas.id, "zeta.md", 1),
      file(ventas.id, "clients/globex/INDEX.md", 2),
      file(ventas.id, "clients/acme.md", 3),
      file(ventas.id, "Alpha.md", 4),
      file(ventas.id, "MEMORY.md", 5),
      file(ventas.id, "notes 10.md", 6),
      file(ventas.id, "notes 9.md", 7),
      file(ventas.id, "archive/old.md", 8),
      file(ventas.id, "beta.md", 9),
    ];
    const [root] = buildMemoryTree([ventas], new Map([[ventas.id, files]]));
    expect(root?.loaded).toBe(true);
    expect(root?.fileCount).toBe(9);
    expect(names(root?.children)).toEqual([
      "MEMORY.md",
      "archive",
      "clients",
      "Alpha.md",
      "beta.md",
      "notes 9.md",
      "notes 10.md",
      "zeta.md",
    ]);
    const clients = root?.children?.find((n) => n.name === "clients");
    expect(clients).toMatchObject({
      kind: "folder",
      path: "clients",
      id: folderNodeId(ventas.id, "clients"),
    });
    expect(names(clients?.children)).toEqual(["globex", "acme.md"]);
    const globex = clients?.children?.[0];
    expect(globex).toMatchObject({ kind: "folder", path: "clients/globex" });
    expect(globex?.children?.[0]).toMatchObject({
      kind: "file",
      name: "INDEX.md",
      path: "clients/globex/INDEX.md",
      id: fileNodeId(ventas.id, "clients/globex/INDEX.md"),
      fileId: id(502),
    });
  });

  it("pins only the root MEMORY.md and groups folders whose names differ only in case", () => {
    const files = [
      file(ventas.id, "Clients/a.md", 1),
      file(ventas.id, "clients/b.md", 2),
      file(ventas.id, "clients/MEMORY.md", 3),
      file(ventas.id, "clients/aa.md", 4),
    ];
    const [root] = buildMemoryTree([ventas], new Map([[ventas.id, files]]));
    expect(names(root?.children)).toEqual(["Clients"]);
    expect(names(root?.children?.[0]?.children)).toEqual(["a.md", "aa.md", "b.md", "MEMORY.md"]);
  });

  it("marks a scope whose files are not loaded yet, and an empty loaded scope", () => {
    const tree = buildMemoryTree([org, ventas], new Map([[org.id, []]]));
    expect(tree[0]).toMatchObject({ name: "Ventas", loaded: false, children: [] });
    expect(tree[1]).toMatchObject({ name: "Organization", loaded: true, fileCount: 0, children: [] });
  });
});

describe("memoryAncestorIds", () => {
  it("lists the scope and every folder above a file", () => {
    expect(memoryAncestorIds("s", "clients/globex/INDEX.md")).toEqual([
      scopeNodeId("s"),
      folderNodeId("s", "clients"),
      folderNodeId("s", "clients/globex"),
    ]);
    expect(memoryAncestorIds("s", "MEMORY.md")).toEqual([scopeNodeId("s")]);
    expect(memoryAncestorIds("s")).toEqual([scopeNodeId("s")]);
  });

  it("matches the tree's ids case-insensitively", () => {
    expect(folderNodeId("s", "Clients")).toBe(folderNodeId("s", "clients"));
    expect(fileNodeId("s", "Clients/Acme.md")).toBe(fileNodeId("s", "clients/acme.md"));
  });
});

describe("memoryHref", () => {
  it("encodes spaces and accents per segment", () => {
    expect(memoryHref(id(2))).toBe(`/memory/${id(2)}`);
    expect(memoryHref(id(2), "clients/acme.md")).toBe(`/memory/${id(2)}/clients/acme.md`);
    expect(memoryHref(id(2), "clients/Ana Pérez.md")).toBe(`/memory/${id(2)}/clients/Ana%20P%C3%A9rez.md`);
  });
});

describe("pathFromSegments", () => {
  it("decodes each segment and re-parses the joined path", () => {
    expect(pathFromSegments(["clients", "Ana%20P%C3%A9rez.md"])).toEqual({
      ok: true,
      path: "clients/Ana Pérez.md",
    });
    // Next may hand segments already decoded: decoding again is a no-op (a path never holds "%").
    expect(pathFromSegments(["clients", "Ana Pérez.md"])).toEqual({ ok: true, path: "clients/Ana Pérez.md" });
  });

  it("refuses traversal, encoded traversal, empty input and broken escapes", () => {
    expect(pathFromSegments(["..", "x.md"])).toEqual({ ok: false, reason: "dot_segment" });
    expect(pathFromSegments(["%2e%2e", "x.md"])).toEqual({ ok: false, reason: "dot_segment" });
    expect(pathFromSegments([])).toEqual({ ok: false, reason: "empty" });
    expect(pathFromSegments(["a%E0%A4%A.md"])).toEqual({ ok: false, reason: "percent" });
    expect(pathFromSegments(["notes.txt"])).toEqual({ ok: false, reason: "extension" });
  });
});

describe("scopeAccessibleName", () => {
  it("names each kind per the UI-SPEC", () => {
    expect(scopeAccessibleName(scope(6, "personal", "You & Scout"))).toBe("You and Scout, private memory");
    expect(scopeAccessibleName(scope(4, "agent", "Scout notebook"))).toBe("Scout notebook, bot memory");
    expect(scopeAccessibleName(scope(2, "unit", "Ventas", "team"))).toBe("Ventas, team memory");
    expect(scopeAccessibleName(scope(3, "unit", "Sales", "department"))).toBe("Sales, department memory");
    expect(scopeAccessibleName(scope(1, "org", "Organization"))).toBe("Organization, memory for everyone");
  });
});

describe("resolveMemoryLink", () => {
  it("resolves relative .md links against the current file's folder", () => {
    expect(resolveMemoryLink("policies/expenses.md", "vacations.md")).toBe("policies/vacations.md");
    expect(resolveMemoryLink("policies/expenses.md", "./vacations.md")).toBe("policies/vacations.md");
    expect(resolveMemoryLink("policies/expenses.md", "../MEMORY.md")).toBe("MEMORY.md");
    expect(resolveMemoryLink("MEMORY.md", "clients/acme.md")).toBe("clients/acme.md");
    expect(resolveMemoryLink("a/b/c.md", "../x/y.md#top")).toBe("a/x/y.md");
    expect(resolveMemoryLink("clients/acme.md", "people/Ana%20P%C3%A9rez.md")).toBe(
      "clients/people/Ana Pérez.md",
    );
  });

  it("leaves everything else to the renderer (null)", () => {
    expect(resolveMemoryLink("policies/expenses.md", "../../x.md")).toBeNull();
    expect(resolveMemoryLink("policies/expenses.md", "https://x.org")).toBeNull();
    expect(resolveMemoryLink("policies/expenses.md", "mailto:a@b.c")).toBeNull();
    expect(resolveMemoryLink("policies/expenses.md", "javascript:alert(1)")).toBeNull();
    expect(resolveMemoryLink("policies/expenses.md", "notes.txt")).toBeNull();
    expect(resolveMemoryLink("policies/expenses.md", "/abs.md")).toBeNull();
    expect(resolveMemoryLink("policies/expenses.md", "//evil.example/x.md")).toBeNull();
    expect(resolveMemoryLink("policies/expenses.md", "#section")).toBeNull();
    expect(resolveMemoryLink("policies/expenses.md", "..\\x.md")).toBeNull();
    expect(resolveMemoryLink("policies/expenses.md", "folder/")).toBeNull();
    expect(resolveMemoryLink("policies/expenses.md", "%E0%A4%A.md")).toBeNull();
  });
});

describe("pathMarks", () => {
  const marked = (runs: { text: string; mark: boolean }[]) => runs.filter((r) => r.mark).map((r) => r.text);

  it("marks the query's words in a path, ignoring case and accents", () => {
    expect(pathMarks("expense-rules.md", "expense")).toEqual([
      { text: "expense", mark: true },
      { text: "-rules.md", mark: false },
    ]);
    expect(marked(pathMarks("Ana Pérez.md", "perez"))).toEqual(["Pérez"]);
    expect(marked(pathMarks("VACACIONES.md", "vacaciones turnos"))).toEqual(["VACACIONES"]);
  });

  it("ignores one-character words and leaves an unmatched path unmarked", () => {
    expect(pathMarks("a.md", "a")).toEqual([{ text: "a.md", mark: false }]);
    expect(pathMarks("notes.md", "budget")).toEqual([{ text: "notes.md", mark: false }]);
  });
});
