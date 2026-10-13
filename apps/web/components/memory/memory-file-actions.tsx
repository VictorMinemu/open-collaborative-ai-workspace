"use client";

import {
  MEMORY_ROOT_FILE,
  type MemoryFileMeta,
  type MemoryScope,
  memoryPathKey,
  parseMemoryPath,
} from "@ocw/contracts";
import { Copy, Ellipsis, FilePlus, FolderInput, FolderPlus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { describedBy, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { isApiError } from "@/lib/api";
import {
  fileName,
  folderIndexPath,
  moveKind,
  newFileContent,
  PATH_EXISTS,
  parentFolder,
  pathErrorText,
  ROOT_FILE_NOTE,
  saveErrorText,
} from "@/lib/memory-edit";
import {
  useCreateMemoryFile,
  useDeleteMemoryFile,
  useMemoryFiles,
  useRenameMemoryFile,
} from "@/lib/memory-queries";
import { folderNodeId, memoryAncestorIds, memoryHref, scopeNodeId } from "@/lib/memory-tree";
import { cn } from "@/lib/utils";
import { useMemoryTreeState } from "./memory-tree";

/**
 * File and folder actions (Phase 07.2, 07.2-12, MEM-01, MEM-02, D-08, UI-SPEC "File actions"): New file, New folder
 * (created with its `INDEX.md`), Rename or move, Delete, Copy path. Paths are validated live with the shared grammar
 * (`parseMemoryPath`) and against the scope's listing; the API re-checks everything. `MEMORY.md` can be edited but
 * never renamed or deleted. Triggers only open a request; one `MemoryActionDialogs` host (in the shell) runs it.
 */

export type MemoryActionRequest =
  | { kind: "new-file"; scope: MemoryScope; folder: string }
  | { kind: "new-folder"; scope: MemoryScope; folder: string }
  | { kind: "rename"; scope: MemoryScope; file: MemoryFileMeta }
  | { kind: "delete"; scope: MemoryScope; file: MemoryFileMeta };

interface ActionsState {
  request: MemoryActionRequest | null;
  open: (r: MemoryActionRequest) => void;
  close: () => void;
}

export const useMemoryActions = create<ActionsState>()((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

export const canWriteScope = (scope: MemoryScope | null | undefined) => !!scope?.viewerCan.includes("write");
export const isRootFile = (path: string) => path === MEMORY_ROOT_FILE;

// ---------------------------------------------------------------- triggers

/** The tree column's New file / New folder buttons (writers of the target scope only). */
export function MemoryCreateButtons({ scope, folder }: { scope: MemoryScope | null; folder: string }) {
  const open = useMemoryActions((s) => s.open);
  if (!scope || !canWriteScope(scope)) return null;
  return (
    <span className="flex items-center gap-0.5">
      <Tooltip content="New file">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="New file"
          onClick={() => open({ kind: "new-file", scope, folder })}
        >
          <FilePlus />
        </Button>
      </Tooltip>
      <Tooltip content="New folder">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="New folder"
          onClick={() => open({ kind: "new-folder", scope, folder })}
        >
          <FolderPlus />
        </Button>
      </Tooltip>
    </span>
  );
}

/** The file header's ⋯ menu: Rename or move…, Delete… (writers), Copy path (everyone). */
export function MemoryFileMenu({
  scope,
  file,
  canWrite,
  compact,
}: {
  scope: MemoryScope;
  file: MemoryFileMeta;
  canWrite: boolean;
  compact: boolean;
}) {
  const open = useMemoryActions((s) => s.open);
  const root = isRootFile(file.path);
  const name = fileName(file.path);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(file.path);
      toast.success("Path copied");
    } catch {
      toast.error("Couldn't copy the path.");
    }
  };
  const guarded = (label: string, icon: React.ReactNode, onClick: () => void, destructive = false) => {
    const item = (
      <DropdownMenuItem
        variant={destructive ? "destructive" : "default"}
        disabled={root}
        className={cn(root && "data-disabled:pointer-events-auto", compact && "min-h-11")}
        onClick={root ? undefined : onClick}
      >
        {icon}
        {label}
        {root ? <span className="sr-only">. {ROOT_FILE_NOTE}</span> : null}
      </DropdownMenuItem>
    );
    return root ? (
      <Tooltip content={ROOT_FILE_NOTE} side="left">
        {item}
      </Tooltip>
    ) : (
      item
    );
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size={compact ? "icon" : "icon-sm"}
            className={cn(compact && "size-11")}
            aria-label={`Actions for ${name}`}
          />
        }
      >
        <Ellipsis />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="memory-file-menu">
        {canWrite ? (
          <>
            {guarded("Rename or move…", <FolderInput />, () => open({ kind: "rename", scope, file }))}
            {guarded("Delete…", <Trash2 />, () => open({ kind: "delete", scope, file }), true)}
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem className={cn(compact && "min-h-11")} onClick={() => void copy()}>
          <Copy />
          Copy path
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------- the dialogs host

/** Runs the open request; after a change it opens the right file (UI-SPEC "File actions" and "Focus management"). */
export function MemoryActionDialogs() {
  const request = useMemoryActions((s) => s.request);
  const close = useMemoryActions((s) => s.close);
  const onOpenChange = (o: boolean) => {
    if (!o) close();
  };
  if (!request) return null;
  if (request.kind === "delete") return <DeleteDialog request={request} onOpenChange={onOpenChange} />;
  return <PathDialog key={request.kind} request={request} onOpenChange={onOpenChange} />;
}

const LIVE_DELAY = 400;

function PathDialog({
  request,
  onOpenChange,
}: {
  request: Exclude<MemoryActionRequest, { kind: "delete" }>;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const reveal = useMemoryTreeState((s) => s.reveal);
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const files = useMemoryFiles(request.scope.id).data?.files ?? [];
  const createFile = useCreateMemoryFile();
  const rename = useRenameMemoryFile();
  const pending = createFile.isPending || rename.isPending;

  const initial = request.kind === "rename" ? request.file.path : request.folder;
  const [value, setValue] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // The error shows after the first blur or 400 ms without typing (UI-SPEC "File actions").
  useEffect(() => {
    if (value === initial) return;
    const t = window.setTimeout(() => setTouched(true), LIVE_DELAY);
    return () => window.clearTimeout(t);
  }, [value, initial]);

  // Rename selects the stem; New file and New folder put the caret at the end.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      if (request.kind === "rename") {
        const start = el.value.lastIndexOf("/") + 1;
        const end = el.value.endsWith(".md") ? el.value.length - 3 : el.value.length;
        el.setSelectionRange(start, end);
      } else {
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [request.kind]);

  const folderResult = request.kind === "new-folder" ? folderIndexPath(value) : null;
  const pathResult = request.kind === "new-folder" ? null : parseMemoryPath(value);
  const target = folderResult?.ok ? folderResult.path : pathResult?.ok ? pathResult.path : null;
  const ownId = request.kind === "rename" ? request.file.id : null;
  const exists =
    !!target && files.some((f) => f.id !== ownId && memoryPathKey(f.path) === memoryPathKey(target));
  const parseError =
    folderResult && !folderResult.ok
      ? folderResult.reason
      : pathResult && !pathResult.ok
        ? pathResult.reason
        : null;
  const localError = parseError ? pathErrorText(parseError) : exists ? PATH_EXISTS : null;
  const error = serverError ?? (touched ? (localError ?? undefined) : undefined);

  const kind = request.kind === "rename" && target ? moveKind(request.file.path, target) : null;
  const title =
    request.kind === "new-file"
      ? "New file"
      : request.kind === "new-folder"
        ? "New folder"
        : "Rename or move";
  const submit =
    request.kind === "new-file"
      ? "Create"
      : request.kind === "new-folder"
        ? "Create folder"
        : kind === "move"
          ? "Move"
          : "Rename";
  const label = request.kind === "new-folder" ? "Folder" : "Path";
  const folderShown = folderResult?.ok
    ? folderResult.folder.slice(0, -1)
    : value.replace(/\/+$/u, "") || "folder";
  const hint =
    request.kind === "new-file"
      ? "Folders are created from the path. Names end in .md."
      : request.kind === "new-folder"
        ? `Creates ${folderShown}/INDEX.md so the folder isn't empty.`
        : undefined;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!target || localError || pending || kind === "same") return;
    const scopeId = request.scope.id;
    const onError = (err: unknown) => {
      setServerError(isApiError(err) && err.code === "memory_path_exists" ? PATH_EXISTS : saveErrorText(err));
      inputRef.current?.focus();
    };
    if (request.kind === "rename") {
      const from = request.file.path;
      rename.mutate(
        { fileId: request.file.id, path: target, expectedVersion: request.file.version, from },
        {
          onSuccess: (file) => {
            onOpenChange(false);
            toast.success(kind === "move" ? `Moved to ${file.path}` : `Renamed to ${fileName(file.path)}`);
            reveal(memoryAncestorIds(scopeId, file.path));
            router.replace(memoryHref(scopeId, file.path));
          },
          onError,
        },
      );
      return;
    }
    const content =
      request.kind === "new-folder" && folderResult?.ok
        ? `# ${fileName(folderResult.folder.slice(0, -1))}\n`
        : newFileContent(target);
    createFile.mutate(
      { scopeId, path: target, content },
      {
        onSuccess: (file) => {
          onOpenChange(false);
          toast.success(`Created ${fileName(file.path)}`);
          reveal(memoryAncestorIds(scopeId, file.path));
          router.push(`${memoryHref(scopeId, file.path)}${request.kind === "new-file" ? "?tab=edit" : ""}`);
        },
        onError,
      },
    );
  };

  return (
    <Dialog open onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent data-testid="memory-path-dialog" initialFocus={inputRef}>
        <form onSubmit={onSubmit} className="grid gap-5" noValidate>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {request.kind === "rename" ? (
              <DialogDescription>
                {request.scope.label} · {request.file.path}
              </DialogDescription>
            ) : (
              <DialogDescription>{request.scope.label}</DialogDescription>
            )}
          </DialogHeader>
          <FormField id={id} label={label} hint={hint} error={error}>
            <Input
              ref={inputRef}
              id={id}
              value={value}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!error}
              aria-describedby={describedBy(id, error, hint)}
              className="font-mono max-lg:h-11"
              onBlur={() => setTouched(true)}
              onChange={(e) => {
                setValue(e.target.value);
                setServerError(null);
              }}
            />
          </FormField>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="max-lg:h-11"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" className="max-lg:h-11" disabled={pending || kind === "same"}>
              {pending ? <Spinner /> : null}
              {submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  request,
  onOpenChange,
}: {
  request: Extract<MemoryActionRequest, { kind: "delete" }>;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const reveal = useMemoryTreeState((s) => s.reveal);
  const requestFocus = useMemoryTreeState((s) => s.requestFocus);
  const files = useMemoryFiles(request.scope.id).data?.files ?? [];
  const remove = useDeleteMemoryFile();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | null>(null);
  const { file, scope } = request;

  const confirm = () =>
    remove.mutate(
      { fileId: file.id, scopeId: scope.id, path: file.path, expectedVersion: file.version },
      {
        onSuccess: () => {
          onOpenChange(false);
          toast.success(`Deleted ${fileName(file.path)}`);
          // The parent folder's INDEX.md when it still exists, else the scope's MEMORY.md; focus the parent row.
          const folder = parentFolder(file.path);
          const index = `${folder}INDEX.md`;
          const next =
            folder && files.some((f) => f.id !== file.id && memoryPathKey(f.path) === memoryPathKey(index))
              ? index
              : MEMORY_ROOT_FILE;
          const remaining = folder && files.some((f) => f.id !== file.id && f.path.startsWith(folder));
          reveal(memoryAncestorIds(scope.id, next));
          requestFocus(remaining ? folderNodeId(scope.id, folder.slice(0, -1)) : scopeNodeId(scope.id));
          router.replace(memoryHref(scope.id, next));
        },
        onError: (err) => setError(saveErrorText(err)),
      },
    );

  return (
    <Dialog open onOpenChange={(o) => !remove.isPending && onOpenChange(o)}>
      <DialogContent data-testid="memory-delete-dialog" initialFocus={cancelRef}>
        <DialogHeader>
          <DialogTitle className="break-all">Delete {file.path}?</DialogTitle>
          <DialogDescription>
            Everyone with access to {scope.label} memory loses this file, bots included.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-sm"
          >
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            ref={cancelRef}
            variant="outline"
            className="max-lg:h-11"
            disabled={remove.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button variant="destructive" className="max-lg:h-11" disabled={remove.isPending} onClick={confirm}>
            {remove.isPending ? <Spinner /> : <Trash2 />}
            Delete file
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
