"use client";

import { type MemoryFile, MemoryFile as MemoryFileSchema } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, RotateCcw, Save, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api, isApiError } from "@/lib/api";
import { isDirty, useMemoryDraft } from "@/lib/memory-draft";
import {
  actorLabel,
  formatSize,
  isNearFull,
  saveErrorText,
  secretFindings,
  secretHeadline,
  utf8Bytes,
} from "@/lib/memory-edit";
import { memoryKeys, useUpdateMemoryFile } from "@/lib/memory-queries";
import { goToLine, setSecretLines, useCodeMirror } from "@/lib/use-codemirror";
import { cn } from "@/lib/utils";
import { MemoryDiff } from "./memory-diff";

/**
 * Markdown-source editing of one memory file (Phase 07.2, 07.2-12, MEM-02, D-03, UI-SPEC "Desktop Edit mode",
 * "Version conflict", "Secret refused", "Edit, save and guard"). Loaded only through `next/dynamic` when a writer
 * enters Edit, so reading never loads CodeMirror.
 *
 * Save sends `{content, expectedVersion}` with the version the edit started from. A 409 opens the conflict view
 * (theirs vs yours: Keep mine / Use theirs), never a silent overwrite; a 422 secret shows the masked sample and marks
 * the lines; every other failure keeps the draft. The draft lives in `useMemoryDraft`, so the shell can guard every
 * way out of Edit and the text survives this component unmounting.
 */

export interface MemoryEditorProps {
  file: MemoryFile;
  /** Stacked and split layouts: the action row sits under the tabs (h-14, 44 px buttons). */
  compact: boolean;
  /** Wide layout: the header row's slot for "Unsaved changes", Cancel and Save. */
  actionsSlot: HTMLElement | null;
  onSaved: (file: MemoryFile) => void;
  /** Leaves Edit (already confirmed when the draft was dirty). */
  onLeave: () => void;
}

type Problem =
  | { kind: "secret"; lines: number[]; samples: string[] }
  | { kind: "conflict"; theirs: MemoryFile }
  | { kind: "blocking"; text: string; retry: boolean };

const isApple = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

const WARNING =
  "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200";
const BLOCKING =
  "border-red-200 bg-red-50 text-red-800 dark:border-red-400/25 dark:bg-red-400/10 dark:text-red-300";

export function MemoryEditor({ file, compact, actionsSlot, onSaved, onLeave }: MemoryEditorProps) {
  const qc = useQueryClient();
  const draft = useMemoryDraft((s) => (s.draft?.fileId === file.id ? s.draft : null));
  const start = useMemoryDraft((s) => s.start);
  const update = useMemoryDraft((s) => s.update);
  const clear = useMemoryDraft((s) => s.clear);
  const guard = useMemoryDraft((s) => s.guard);
  const save = useUpdateMemoryFile();
  const [problem, setProblem] = useState<Problem | null>(null);

  // A draft for this file survives a remount (browser back and forward); otherwise one starts from the loaded version.
  const initial = useRef(draft?.content ?? file.content);
  useEffect(() => {
    const current = useMemoryDraft.getState().draft;
    if (current?.fileId === file.id) return;
    start({
      scopeId: file.scopeId,
      path: file.path,
      fileId: file.id,
      baseVersion: file.version,
      original: file.content,
    });
  }, [file.id, file.scopeId, file.path, file.version, file.content, start]);

  const host = useRef<HTMLDivElement>(null);
  const saveRef = useRef<() => void>(() => {});
  const { view } = useCodeMirror(host, {
    doc: initial.current,
    label: `Markdown source of ${file.path}`,
    readOnly: save.isPending,
    onChange: (doc) => update(doc),
    onSave: () => saveRef.current(),
  });

  // Entering Edit focuses the editor at the start of the document (UI-SPEC "Focus management").
  useEffect(() => {
    if (!view) return;
    view.dispatch({ selection: { anchor: 0 } });
    view.focus();
  }, [view]);

  const content = draft?.content ?? file.content;
  const dirty = isDirty(draft);
  const baseVersion = draft?.baseVersion ?? file.version;
  const conflict = problem?.kind === "conflict" ? problem.theirs : null;

  function persist(expectedVersion: number) {
    const current = useMemoryDraft.getState().draft;
    if (!current || current.fileId !== file.id || save.isPending) return;
    save.mutate(
      { fileId: file.id, content: current.content, expectedVersion },
      {
        onSuccess: (saved) => {
          setProblem(null);
          if (view) setSecretLines(view, []);
          clear();
          toast.success(`Saved version ${saved.version}`);
          onSaved(saved);
        },
        onError: async (err) => {
          if (isApiError(err, 409) && err.code === "memory_version_conflict") {
            try {
              const theirs = await api.get(`/api/v1/memory/files/${encodeURIComponent(file.id)}`, {
                schema: MemoryFileSchema,
              });
              qc.setQueryData(memoryKeys.file(theirs.scopeId, theirs.path), theirs);
              setProblem({ kind: "conflict", theirs });
            } catch (e) {
              setProblem({ kind: "blocking", text: saveErrorText(e), retry: true });
            }
            return;
          }
          const secret = secretFindings(err);
          if (secret) {
            setProblem({ kind: "secret", ...secret });
            if (view) setSecretLines(view, secret.lines);
            return;
          }
          const network = isApiError(err) && (err.isNetwork || err.status >= 500);
          setProblem({ kind: "blocking", text: saveErrorText(err), retry: network || !isApiError(err) });
        },
      },
    );
  }

  const onSave = () => {
    if (!dirty || conflict) return;
    persist(baseVersion);
  };
  saveRef.current = onSave;

  // Cmd/Ctrl+S also works while focus is on the toolbar (the editor's own keymap handles it inside the editor).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      saveRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Closing or reloading the tab with unsaved changes asks the browser's own question.
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);

  // The conflict heading takes focus when the view opens (the alert is announced).
  const conflictHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (conflict) conflictHeading.current?.focus();
  }, [conflict]);

  const keepMine = () => {
    if (!conflict) return;
    persist(conflict.version);
  };
  const useTheirs = () => {
    clear();
    setProblem(null);
    onLeave();
  };

  const bytes = utf8Bytes(content);
  const newer = !conflict && file.version > baseVersion ? file.version : null;

  const actions = (
    <div
      data-testid="memory-editor-actions"
      className={cn(
        "flex items-center gap-2",
        compact ? "h-14 shrink-0 justify-between border-b px-4" : "ml-auto shrink-0",
      )}
    >
      <span role="status" className="inline-flex items-center gap-1.5 text-muted-foreground text-xs">
        {dirty ? (
          <>
            <span aria-hidden className="size-1.5 rounded-full bg-amber-500" />
            Unsaved changes
          </>
        ) : null}
      </span>
      <span className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="max-lg:h-11"
          disabled={save.isPending}
          onClick={() => guard(onLeave)}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          className="max-lg:h-11"
          disabled={!dirty || save.isPending || !!conflict}
          onClick={onSave}
        >
          {save.isPending ? <Spinner /> : <Save />}
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </span>
    </div>
  );

  return (
    <div data-testid="memory-editor" className="flex min-h-0 min-w-0 flex-1 flex-col">
      {compact ? actions : actionsSlot ? createPortal(actions, actionsSlot) : null}

      {newer ? (
        <div
          role="status"
          className={cn(
            "flex min-h-8 shrink-0 items-center gap-2 border-b py-1.5 text-xs",
            compact ? "px-4" : "px-6",
            WARNING,
          )}
        >
          <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
          Version {newer} was saved while you were editing. You'll choose what to keep when you save.
        </div>
      ) : null}

      {problem?.kind === "secret" ? (
        <div
          role="alert"
          data-testid="memory-secret-notice"
          className={cn(
            "flex shrink-0 flex-wrap items-start gap-x-3 gap-y-2 border-b py-3 text-sm",
            compact ? "px-4" : "px-6",
            BLOCKING,
          )}
        >
          <KeyRound aria-hidden className="mt-0.5 size-4 shrink-0" />
          <div className={cn("grid min-w-0 flex-1 gap-1", compact && "basis-[calc(100%-1.75rem)]")}>
            <p className="font-semibold">{secretHeadline(problem.lines)}</p>
            <p className="text-xs">
              {problem.samples.length > 0 ? (
                <>
                  <span className="font-mono">{problem.samples.join(", ")}</span>
                  <span aria-hidden> · </span>
                </>
              ) : null}
              Secrets can't be stored in memory. Remove it and save again.
            </p>
          </div>
          {problem.lines[0] !== undefined && view ? (
            <Button
              variant="outline"
              size="sm"
              className={cn("max-lg:h-11", compact && "ml-7")}
              onClick={() => goToLine(view, problem.lines[0] ?? 1)}
            >
              Go to line {problem.lines[0]}
            </Button>
          ) : null}
        </div>
      ) : null}

      {problem?.kind === "blocking" ? (
        <div
          role="alert"
          data-testid="memory-save-error"
          className={cn(
            "flex shrink-0 flex-wrap items-center gap-3 border-b py-3 text-sm",
            compact ? "px-4" : "px-6",
            BLOCKING,
          )}
        >
          <TriangleAlert aria-hidden className="size-4 shrink-0" />
          <p className="min-w-0 flex-1">{problem.text}</p>
          {problem.retry ? (
            <Button variant="outline" size="sm" className="max-lg:h-11" onClick={() => persist(baseVersion)}>
              <RotateCcw /> Try again
            </Button>
          ) : null}
        </div>
      ) : null}

      {conflict ? (
        <ConflictView
          theirs={conflict}
          mine={content}
          compact={compact}
          headingRef={conflictHeading}
          saving={save.isPending}
          onKeepMine={keepMine}
          onUseTheirs={useTheirs}
        />
      ) : null}

      <div
        className={cn(
          "mx-auto flex min-h-0 w-full max-w-[760px] flex-1 flex-col",
          compact ? "px-4 py-4" : "px-6 py-6",
          conflict && "hidden",
        )}
      >
        <div
          ref={host}
          className="min-h-0 flex-1 overflow-hidden rounded-lg border bg-background font-sans focus-within:ring-[3px] focus-within:ring-ring/40"
        />
        <div className="mt-2 flex shrink-0 items-center justify-between gap-3 text-muted-foreground text-xs">
          <span>Markdown · {isApple() ? "⌘S" : "Ctrl+S"} to save</span>
          <span
            data-testid="memory-editor-size"
            className={cn("tabular-nums", isNearFull(bytes) && "text-red-700 dark:text-red-400")}
          >
            {formatSize(bytes)}
          </span>
        </div>
      </div>
    </div>
  );
}

function ConflictView({
  theirs,
  mine,
  compact,
  headingRef,
  saving,
  onKeepMine,
  onUseTheirs,
}: {
  theirs: MemoryFile;
  mine: string;
  compact: boolean;
  headingRef: React.Ref<HTMLHeadingElement>;
  saving: boolean;
  onKeepMine: () => void;
  onUseTheirs: () => void;
}) {
  const n = theirs.version;
  const name = actorLabel(theirs.updatedBy);
  return (
    <section
      data-testid="memory-conflict"
      aria-labelledby="memory-conflict-title"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div
        role="alert"
        className={cn(
          "flex shrink-0 items-start gap-2 border-b py-3 text-sm",
          compact ? "px-4" : "px-6",
          WARNING,
        )}
      >
        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
        <p>
          {name} saved version {n} while you were editing.
        </p>
      </div>
      <h2
        id="memory-conflict-title"
        ref={headingRef}
        tabIndex={-1}
        className={cn(
          "shrink-0 rounded-sm font-semibold text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
          compact ? "px-4 pt-4 pb-2" : "px-6 pt-4 pb-2",
        )}
      >
        Choose what to keep
      </h2>
      <MemoryDiff
        className={cn("min-h-0 flex-1 border-y", compact ? "mx-0" : "mx-6 rounded-lg border-x")}
        label={`Changes from version ${n} to your changes`}
        before={{ label: `Version ${n} (saved)`, doc: theirs.content }}
        after={{ label: "Your changes", doc: mine }}
      />
      <div
        className={cn(
          "grid shrink-0 gap-3",
          compact ? "px-4 py-4" : "grid-cols-[auto_1fr] items-center gap-x-3 px-6 py-4",
        )}
      >
        <Button className={cn(compact ? "h-11 w-full" : "")} disabled={saving} onClick={onKeepMine}>
          {saving ? <Spinner /> : null}
          Keep mine
        </Button>
        <p className={cn("text-muted-foreground text-xs", compact && "-mt-1 mb-1")}>
          Saves your text as version {n + 1}. Version {n} stays in History.
        </p>
        <Button
          variant="outline"
          className={cn(compact ? "h-11 w-full" : "")}
          disabled={saving}
          onClick={onUseTheirs}
        >
          Use theirs
        </Button>
        <p className={cn("text-muted-foreground text-xs", compact && "-mt-1")}>
          Discards your changes and shows version {n}.
        </p>
      </div>
    </section>
  );
}

export default MemoryEditor;
