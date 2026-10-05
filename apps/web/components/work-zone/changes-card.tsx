"use client";

import type { DiffFile, DiffStat, WorkSessionChanges } from "@ocw/contracts";
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, FileDiff, FileText, Folder } from "lucide-react";
import { useMemo, useState } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface FolderRollup {
  /** Top-level folder, or null for files at the repository root. */
  name: string | null;
  additions: number;
  deletions: number;
  files: DiffFile[];
}

/** Pure: group repo-relative paths by their top-level folder (root files each stand alone, after the folders). */
export function rollupFolders(files: DiffFile[]): FolderRollup[] {
  const folders = new Map<string, FolderRollup>();
  const root: FolderRollup[] = [];
  for (const f of files) {
    const slash = f.path.indexOf("/");
    if (slash <= 0) {
      root.push({ name: null, additions: f.additions, deletions: f.deletions, files: [f] });
      continue;
    }
    const name = f.path.slice(0, slash);
    const g = folders.get(name) ?? { name, additions: 0, deletions: 0, files: [] };
    g.additions += f.additions;
    g.deletions += f.deletions;
    g.files.push(f);
    folders.set(name, g);
  }
  return [...[...folders.values()].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")), ...root];
}

const Stat = ({ add, del, className }: { add: number; del: number; className?: string }) => (
  <span className={cn("inline-flex shrink-0 items-center gap-1.5 font-mono tabular-nums", className)}>
    <span className="text-emerald-600 dark:text-emerald-400">+{add}</span>
    <span className="text-red-600 dark:text-red-400">−{del}</span>
  </span>
);

/**
 * "N changed files +a −b · Open diff" (ref-4, D-17) after the latest turn: the working tree's changes rolled up by
 * top-level folder (repo-relative paths only, as the server already filtered them). "Open diff" opens the
 * existing Changes panel.
 */
export function ChangesCard({
  changes,
  diffStat,
  onOpenDiff,
}: {
  changes: WorkSessionChanges | null;
  diffStat: DiffStat | null;
  onOpenDiff(): void;
}) {
  const files = changes?.files ?? [];
  const groups = useMemo(() => rollupFolders(files), [files]);
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set());
  const count = files.length || diffStat?.files || 0;
  if (count === 0) return null;
  const additions = files.length ? files.reduce((n, f) => n + f.additions, 0) : (diffStat?.additions ?? 0);
  const deletions = files.length ? files.reduce((n, f) => n + f.deletions, 0) : (diffStat?.deletions ?? 0);
  const folderNames = groups.flatMap((g) => (g.name ? [g.name] : []));
  const allOpen = folderNames.length > 0 && folderNames.every((n) => openFolders.has(n));
  const toggle = (name: string) =>
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <div
      data-testid="changes-card"
      className="overflow-hidden rounded-xl border border-border/60 bg-muted/45 dark:bg-muted/25"
    >
      <div className="flex h-10 items-center gap-2.5 pr-1.5 pl-3.5 text-[13px]">
        <span className="font-medium">
          {count} changed file{count === 1 ? "" : "s"}
        </span>
        <Stat add={additions} del={deletions} className="text-[12.5px]" />
        <span className="flex-1" />
        {folderNames.length > 0 ? (
          <Tooltip content={allOpen ? "Collapse all" : "Expand all"}>
            <button
              type="button"
              aria-label={allOpen ? "Collapse all folders" : "Expand all folders"}
              onClick={() => setOpenFolders(allOpen ? new Set() : new Set(folderNames))}
              className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-background/70 hover:text-foreground"
            >
              {allOpen ? <ChevronsDownUp className="size-3.5" /> : <ChevronsUpDown className="size-3.5" />}
            </button>
          </Tooltip>
        ) : null}
        <button
          type="button"
          data-testid="open-diff"
          onClick={onOpenDiff}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 font-medium text-[12.5px] text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground"
        >
          <FileDiff className="size-3.5" /> Open diff
        </button>
      </div>
      {groups.length > 0 ? (
        <ul className="grid gap-px px-1.5 pb-1.5">
          {groups.map((g) =>
            g.name ? (
              <li key={`d:${g.name}`}>
                <button
                  type="button"
                  aria-expanded={openFolders.has(g.name)}
                  onClick={() => toggle(g.name as string)}
                  className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left font-mono text-[12px] hover:bg-background/60"
                >
                  <ChevronRight
                    aria-hidden
                    className={cn(
                      "size-3.5 shrink-0 text-muted-foreground transition-transform",
                      openFolders.has(g.name) && "rotate-90",
                    )}
                  />
                  <Folder aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{g.name}</span>
                  <Stat add={g.additions} del={g.deletions} className="text-[11.5px]" />
                </button>
                {openFolders.has(g.name) ? (
                  <ul className="grid gap-px pb-1 pl-7">
                    {g.files.map((f) => (
                      <FileRow key={f.path} file={f} label={f.path.slice(g.name!.length + 1)} />
                    ))}
                  </ul>
                ) : null}
              </li>
            ) : (
              <FileRow key={`f:${g.files[0]!.path}`} file={g.files[0]!} label={g.files[0]!.path} root />
            ),
          )}
        </ul>
      ) : null}
    </div>
  );
}

function FileRow({ file, label, root }: { file: DiffFile; label: string; root?: boolean }) {
  return (
    <li
      className={cn(
        "flex h-7 items-center gap-2 rounded-md px-2 font-mono text-[12px] text-muted-foreground",
        root && "pl-[30px]",
      )}
    >
      <FileText aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-foreground/85">{label}</span>
      <Stat add={file.additions} del={file.deletions} className="text-[11.5px]" />
    </li>
  );
}
