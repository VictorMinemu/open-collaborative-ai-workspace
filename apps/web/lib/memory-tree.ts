import {
  MEMORY_ROOT_FILE,
  type MemoryFileMeta,
  type MemoryPathResult,
  type MemoryScope,
  memoryPathKey,
  parseMemoryPath,
} from "@ocw/contracts";

/**
 * The memory viewer's pure model (Phase 07.2, MEM-02, UI-SPEC "Scopes in the tree"). Scopes are the top-level nodes
 * of one tree; folders exist only because a readable file lives under them (a `deny` path rule hides the folder
 * entirely, the API never lists its files). Everything here is pure so the ordering, ids and URLs are unit-tested.
 */

export type MemoryNodeKind = "scope" | "folder" | "file";

export interface MemoryNode {
  /** Stable tree id: `scope:<id>`, `folder:<scopeId>:<path key>`, `file:<scopeId>:<path key>`. */
  id: string;
  kind: MemoryNodeKind;
  /** Display name: the scope label, the folder's last segment, or the file name. */
  name: string;
  scopeId: string;
  /** Folder path without the trailing slash, or the file path. */
  path?: string;
  fileId?: string;
  scope?: MemoryScope;
  file?: MemoryFileMeta;
  children?: MemoryNode[];
  /** Scope nodes: whether its file list has arrived, and how many files the viewer may read. */
  loaded?: boolean;
  fileCount?: number;
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
const byName = (a: MemoryNode, b: MemoryNode) => collator.compare(a.name, b.name);

const SCOPE_RANK: Record<MemoryScope["kind"], number> = { personal: 0, agent: 1, unit: 2, org: 3 };

export const scopeNodeId = (scopeId: string) => `scope:${scopeId}`;
export const folderNodeId = (scopeId: string, folder: string) => `folder:${scopeId}:${memoryPathKey(folder)}`;
export const fileNodeId = (scopeId: string, path: string) => `file:${scopeId}:${memoryPathKey(path)}`;

/** The tree ids to expand so a file (or just its scope) is visible: the scope, then every folder above the file. */
export function memoryAncestorIds(scopeId: string, path?: string): string[] {
  const ids = [scopeNodeId(scopeId)];
  if (!path) return ids;
  const segments = path.split("/").slice(0, -1);
  for (let i = 1; i <= segments.length; i++) ids.push(folderNodeId(scopeId, segments.slice(0, i).join("/")));
  return ids;
}

/** Root `MEMORY.md` first, then folders, then files; each group case-insensitive and numeric. */
function sortChildren(nodes: MemoryNode[], atRoot: boolean): MemoryNode[] {
  const isRootFile = (n: MemoryNode) => atRoot && n.kind === "file" && n.name === MEMORY_ROOT_FILE;
  const rank = (n: MemoryNode) => (isRootFile(n) ? 0 : n.kind === "folder" ? 1 : 2);
  nodes.sort((a, b) => rank(a) - rank(b) || byName(a, b));
  for (const n of nodes) if (n.children) sortChildren(n.children, false);
  return nodes;
}

function filesToNodes(scopeId: string, files: readonly MemoryFileMeta[]): MemoryNode[] {
  const root: MemoryNode[] = [];
  const folders = new Map<string, MemoryNode>();
  for (const f of files) {
    const segments = f.path.split("/");
    let siblings = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const folderPath = segments.slice(0, i + 1).join("/");
      const id = folderNodeId(scopeId, folderPath);
      let folder = folders.get(id);
      if (!folder) {
        folder = { id, kind: "folder", name: segments[i] ?? "", scopeId, path: folderPath, children: [] };
        folders.set(id, folder);
        siblings.push(folder);
      }
      siblings = folder.children ?? [];
    }
    siblings.push({
      id: fileNodeId(scopeId, f.path),
      kind: "file",
      name: segments[segments.length - 1] ?? f.path,
      scopeId,
      path: f.path,
      fileId: f.id,
      file: f,
    });
  }
  return sortChildren(root, true);
}

/**
 * The whole tree in the UI-SPEC order: private scopes (by bot), bot notebooks (by bot), units in the order the API
 * lists them (organization chart, depth-first), then the organization. `files` holds each loaded scope's list.
 */
export function buildMemoryTree(
  scopes: readonly MemoryScope[],
  files: ReadonlyMap<string, readonly MemoryFileMeta[]>,
): MemoryNode[] {
  const ordered = scopes
    .map((s, index) => ({ s, index }))
    .sort((a, b) => {
      const rank = SCOPE_RANK[a.s.kind] - SCOPE_RANK[b.s.kind];
      if (rank !== 0) return rank;
      // Units keep the API's organization-chart order; private scopes and notebooks sort by bot name.
      if (a.s.kind === "unit") return a.index - b.index;
      return collator.compare(a.s.label, b.s.label) || a.index - b.index;
    });
  return ordered.map(({ s }) => {
    const list = files.get(s.id);
    return {
      id: scopeNodeId(s.id),
      kind: "scope",
      name: s.label,
      scopeId: s.id,
      scope: s,
      children: list ? filesToNodes(s.id, list) : [],
      loaded: list !== undefined,
      fileCount: list?.length ?? 0,
    };
  });
}

/** `/memory/<scopeId>/<segments>`, each segment URL-encoded on its own (spaces, accents). */
export function memoryHref(scopeId: string, path?: string): string {
  const base = `/memory/${encodeURIComponent(scopeId)}`;
  if (!path) return base;
  return `${base}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * The catch-all route's segments back to a memory path: each segment is decoded, the result is joined and re-parsed
 * with the shared grammar before any request (T-07.2-10-02). Encoded traversal (`%2e%2e`) decodes to `..` and fails.
 */
export function pathFromSegments(segments: readonly string[]): MemoryPathResult {
  const decoded: string[] = [];
  for (const s of segments) {
    try {
      decoded.push(decodeURIComponent(s));
    } catch {
      return { ok: false, reason: "percent" };
    }
  }
  return parseMemoryPath(decoded.join("/"));
}

/** The scope row's accessible name (UI-SPEC "Scopes in the tree"); the kind tag is `aria-hidden`. */
export function scopeAccessibleName(scope: MemoryScope): string {
  switch (scope.kind) {
    case "personal":
      return `You and ${scope.label.replace(/^You & /u, "")}, private memory`;
    case "agent":
      return `${scope.label}, bot memory`;
    case "unit":
      return `${scope.label}, ${scope.unitKind ?? "unit"} memory`;
    case "org":
      return `${scope.label}, memory for everyone`;
  }
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A link inside a memory file, resolved against that file's folder: a relative `.md` reference that stays inside the
 * scope → the normalized path; anything else (external, absolute, fragment-only, above the scope root, not `.md`,
 * invalid) → null, and the renderer decides (external links keep `safeUrl`, the rest renders as text).
 */
export function resolveMemoryLink(currentPath: string, href: string): string | null {
  const raw = href.trim();
  if (raw === "" || SCHEME.test(raw) || /^[/\\#?]/u.test(raw)) return null;
  let target = raw.split(/[?#]/u)[0] ?? "";
  try {
    target = decodeURIComponent(target);
  } catch {
    return null;
  }
  const out = currentPath.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  const parsed = parseMemoryPath(out.join("/"));
  return parsed.ok ? parsed.path : null;
}

export interface TextRun {
  text: string;
  mark: boolean;
}

/** One code point folded to one UTF-16 unit: lower case, without its diacritics. */
const foldChar = (c: string) => (c.normalize("NFD")[0] ?? c).toLowerCase()[0] ?? c;

/**
 * Marks the query's words inside a path, for hits the API found by path words only (their snippet has no marks,
 * 07.2-16). Case- and accent-insensitive; words shorter than 2 characters are ignored.
 */
export function pathMarks(path: string, q: string): TextRun[] {
  const chars = [...path];
  const hay = chars.map(foldChar).join("");
  const marked = chars.map(() => false);
  const words = q
    .split(/[\s"'()|+-]+/u)
    .map((w) => [...w].map(foldChar).join(""))
    .filter((w) => w.length >= 2);
  for (const w of words) {
    for (let at = hay.indexOf(w); at >= 0; at = hay.indexOf(w, at + w.length)) {
      for (let i = at; i < at + w.length; i++) marked[i] = true;
    }
  }
  const runs: TextRun[] = [];
  chars.forEach((c, i) => {
    const mark = marked[i] ?? false;
    const last = runs[runs.length - 1];
    if (last && last.mark === mark) last.text += c;
    else runs.push({ text: c, mark });
  });
  return runs;
}
