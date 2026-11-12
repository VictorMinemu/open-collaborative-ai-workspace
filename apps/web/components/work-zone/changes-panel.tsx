"use client";

import type { DiffFile, WorkSessionChanges, WorkSessionDiff } from "@ocw/contracts";
import { ChevronRight, FileDiff, GitBranch, RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api";
import { cn, relativeTime } from "@/lib/utils";
import { useDiff } from "@/lib/workzone-queries";

const STATUS_LETTER: Record<DiffFile["status"], { letter: string; tone: string }> = {
  added: { letter: "A", tone: "text-success-text" },
  untracked: { letter: "U", tone: "text-success-text" },
  modified: { letter: "M", tone: "text-warning" },
  deleted: { letter: "D", tone: "text-destructive" },
  renamed: { letter: "R", tone: "text-primary" },
  copied: { letter: "C", tone: "text-primary" },
  unmerged: { letter: "!", tone: "text-destructive" },
};

/** Files changed on the device's working tree + unified diff (fetched live from the device). */
export function ChangesPanel({
  sessionId,
  live,
  deviceOnline,
}: {
  sessionId: string;
  live: WorkSessionChanges | null;
  deviceOnline: boolean;
}) {
  const diff = useDiff(sessionId, deviceOnline);
  const { refetch } = diff;
  // A turn finished and the device reported a different set of changes: refresh the patch. (Comparing the
  // summaries avoids a loop: our own refresh also produces a `changes` event.)
  const liveKey = live ? filesKey(live.files) : null;
  const dataKey = diff.data ? filesKey(diff.data.files) : null;
  useEffect(() => {
    if (liveKey !== null && dataKey !== null && liveKey !== dataKey && deviceOnline) void refetch();
  }, [liveKey, dataKey, deviceOnline, refetch]);

  const files = diff.data?.files ?? live?.files ?? [];
  const parsed = useMemo(() => parsePatch(diff.data?.patch ?? ""), [diff.data?.patch]);
  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);
  const noGit = projectHasNoGit(diff.data, live);

  return (
    <div className="grid gap-3" data-testid="changes-panel">
      <div className="flex items-center gap-2">
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-[12px] text-muted-foreground">
          <GitBranch className="size-3.5 shrink-0" />
          <span className="truncate">{noGit ? "No git" : (diff.data?.branch ?? live?.branch ?? "—")}</span>
        </span>
        {files.length > 0 ? (
          <span className="font-mono text-[12px]">
            <span className="text-success-text">+{adds}</span>{" "}
            <span className="text-destructive">−{dels}</span>
          </span>
        ) : null}
        <Button
          size="icon-xs"
          variant="ghost"
          className="ml-auto"
          aria-label="Refresh changes"
          data-testid="refresh-diff"
          disabled={!deviceOnline || diff.isFetching}
          onClick={() => void refetch()}
        >
          <RefreshCw className={cn(diff.isFetching && "animate-spin")} />
        </Button>
      </div>

      {!deviceOnline ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-muted-foreground text-sm">
          The device is offline. Changes appear when it reconnects.
        </p>
      ) : diff.isLoading ? (
        <div className="grid gap-2">
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
          <Skeleton className="h-40" />
        </div>
      ) : diff.isError ? (
        <p className="rounded-lg bg-destructive/8 px-3 py-2 text-destructive text-sm">
          {errorMessage(diff.error)}
        </p>
      ) : noGit ? (
        <NoGitState />
      ) : files.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-6 text-center">
          <FileDiff className="mx-auto mb-2 size-5 text-muted-foreground" />
          <p className="font-medium text-sm">No changes yet</p>
          <p className="mt-0.5 text-muted-foreground text-xs">
            Edits the agent makes show up here as a diff.
          </p>
        </div>
      ) : (
        <>
          <ul className="grid gap-0.5 rounded-lg border p-1">
            {files.map((f) => {
              const s = STATUS_LETTER[f.status];
              return (
                <li key={f.path}>
                  <a
                    href={`#diff-${encodeURIComponent(f.path)}`}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 font-mono text-[12px] hover:bg-accent/60"
                    data-testid="changed-file"
                  >
                    <span className={cn("w-3 font-semibold", s.tone)}>{s.letter}</span>
                    <span className="min-w-0 flex-1 truncate">{f.path}</span>
                    <span className="text-success-text">+{f.additions}</span>
                    <span className="text-destructive">−{f.deletions}</span>
                  </a>
                </li>
              );
            })}
          </ul>
          {diff.data?.truncated ? (
            <p className="text-muted-foreground text-xs">The diff is large; showing the first part.</p>
          ) : null}
          <div className="grid gap-3">
            {parsed.map((f) => (
              <FileDiffView key={f.path} file={f} />
            ))}
          </div>
          {diff.data ? (
            <p className="text-center text-muted-foreground text-xs">
              Updated {relativeTime(diff.data.generatedAt)}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** The device said the project has no git repository (the latest diff wins over the last live changes). */
export function projectHasNoGit(diff: WorkSessionDiff | undefined, live: WorkSessionChanges | null): boolean {
  return diff ? diff.git === false : live?.git === false;
}

/** A project without git: the session works, its changes are not tracked. */
export function NoGitState() {
  return (
    <div className="rounded-lg border border-dashed px-4 py-6 text-center" data-testid="changes-no-git">
      <FileDiff className="mx-auto mb-2 size-5 text-muted-foreground" />
      <p className="font-medium text-sm">No git</p>
      <p className="mt-0.5 text-muted-foreground text-xs">
        This project has no git repository, so changes are not tracked here. Run git init in it to see diffs.
      </p>
    </div>
  );
}

function filesKey(files: DiffFile[]): string {
  return files.map((f) => `${f.path}:${f.additions}:${f.deletions}`).join("|");
}

interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk" | "meta";
  text: string;
  oldNo?: number;
  newNo?: number;
}

interface ParsedFile {
  path: string;
  lines: DiffLine[];
}

export function parsePatch(patch: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  let cur: ParsedFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
      cur = { path: m?.[2] ?? raw.slice(11), lines: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (
      /^(index |new file mode|deleted file mode|similarity index|rename from|rename to|--- |\+\+\+ )/.test(
        raw,
      )
    ) {
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
      oldNo = Number(m?.[1] ?? 0);
      newNo = Number(m?.[2] ?? 0);
      cur.lines.push({ kind: "hunk", text: raw });
    } else if (raw.startsWith("+")) {
      cur.lines.push({ kind: "add", text: raw.slice(1), newNo: newNo++ });
    } else if (raw.startsWith("-")) {
      cur.lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++ });
    } else if (raw.startsWith("\\")) {
      cur.lines.push({ kind: "meta", text: raw });
    } else if (raw.length > 0 || cur.lines.length > 0) {
      cur.lines.push({ kind: "ctx", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  for (const f of files) {
    while (f.lines.at(-1)?.kind === "ctx" && f.lines.at(-1)?.text === "") f.lines.pop();
  }
  return files;
}

const TOKEN_RE =
  /(\/\/.*$|#(?!include).*$)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(const|let|var|function|return|import|export|from|default|if|else|for|while|class|interface|type|extends|async|await|new|true|false|null|undefined|def|self|public|private|static)\b|\b(\d+(?:\.\d+)?)\b/g;

function highlight(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    const cls = m[1]
      ? "text-muted-foreground italic"
      : m[2]
        ? "text-emerald-700 dark:text-emerald-300"
        : m[3]
          ? "text-violet-700 dark:text-violet-300"
          : "text-amber-700 dark:text-amber-300";
    out.push(
      <span key={i} className={cls}>
        {m[0]}
      </span>,
    );
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function FileDiffView({ file }: { file: ParsedFile }) {
  const [open, setOpen] = useState(true);
  return (
    <div
      id={`diff-${encodeURIComponent(file.path)}`}
      className="overflow-hidden rounded-lg border"
      data-testid="file-diff"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 border-b bg-muted/40 px-3 py-2 text-left font-mono text-[12px] hover:bg-muted/70"
        aria-expanded={open}
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        <span className="truncate">{file.path}</span>
      </button>
      {open ? (
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full border-collapse font-mono text-[12px] leading-[1.55]">
            <tbody>
              {file.lines.map((l, i) =>
                l.kind === "hunk" || l.kind === "meta" ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static diff lines
                  <tr key={i} className="bg-primary/6 text-muted-foreground">
                    <td colSpan={3} className="px-3 py-0.5">
                      {l.text}
                    </td>
                  </tr>
                ) : (
                  <tr
                    // biome-ignore lint/suspicious/noArrayIndexKey: static diff lines
                    key={i}
                    className={cn(
                      l.kind === "add" && "bg-success/10",
                      l.kind === "del" && "bg-destructive/10",
                    )}
                  >
                    <td className="w-10 select-none border-r px-2 text-right text-muted-foreground/70">
                      {l.oldNo ?? ""}
                    </td>
                    <td className="w-10 select-none border-r px-2 text-right text-muted-foreground/70">
                      {l.newNo ?? ""}
                    </td>
                    <td className="whitespace-pre px-3">
                      <span
                        className={cn(
                          "mr-2 select-none",
                          l.kind === "add" && "text-success-text",
                          l.kind === "del" && "text-destructive",
                          l.kind === "ctx" && "text-transparent",
                        )}
                      >
                        {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                      </span>
                      {highlight(l.text)}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
