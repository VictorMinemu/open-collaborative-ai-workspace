"use client";

import type { Agent, SandboxFileEntry, SandboxStatusView } from "@ocw/contracts";
import { type QueryClient, type UseQueryResult, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import type { TreeOpenVia } from "@/components/common/tree-row";
import { Button } from "@/components/ui/button";
import { useIsDesktop, useMediaQuery } from "@/hooks/use-media-query";
import { errorMessage } from "@/lib/api";
import {
  downloadSandboxFile,
  fetchSandboxFolder,
  sandboxKeys,
  useDeleteSandboxPath,
  useSandboxLifecycle,
} from "@/lib/sandbox-queries";
import { DeleteDialog, type DeleteTarget, LifecycleDialog } from "./sandbox-dialogs";
import {
  PickAFile,
  type PreviewFile,
  previewFileOf,
  SandboxFilePane,
  SandboxFileSheet,
} from "./sandbox-file-preview";
import { SandboxStatusCard, SandboxStatusSkeleton } from "./sandbox-status-card";
import { SandboxTree, type SandboxTreeHandle, SandboxTreeSkeleton } from "./sandbox-tree";
import { UploadDialog } from "./upload-dialog";

/**
 * The bot page's Sandbox tab (07.8-15; SBX-05, D-04, UI-SPEC §3.1–3.5): the status card, then the files card. From
 * 1024 px the tree (320) sits next to the preview; from 768 a file opens in place of the tree ("All files" goes back);
 * on phones it opens a full-height sheet. Upload, download, delete, stop and restart run through the API's people's
 * routes; the tab exists only for people the API lets manage this bot's sandbox (the page decides from the status).
 */

const SPLIT_QUERY = "(min-width: 1024px)";

/**
 * Whether the bot page shows the Sandbox tab (the module is checked by the page). Shown once the API answered the
 * status, unless the organization has Sandbox & Browser off and this bot never had a sandbox (nothing to manage). A
 * deep link (`?tab=sandbox`) keeps the tab while the answers load or after a failure other than the refusal (a
 * skeleton, then Try again); a 404 (not a configurer, module off) always removes it.
 */
export function sandboxTabVisible(p: {
  asked: boolean;
  status: Pick<UseQueryResult<SandboxStatusView, unknown>, "isSuccess" | "isPending" | "isError" | "data">;
  refused: boolean;
  orgOff: boolean;
  capsSettled: boolean;
}): boolean {
  if (p.refused) return false;
  if (p.status.isSuccess && p.capsSettled) return !(p.orgOff && p.status.data?.state === "absent");
  return p.asked;
}

const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** Every folder from the root down to `folder` (for expanding after an upload). */
function ancestorsOf(folder: string): string[] {
  if (folder === "") return [];
  const parts = folder.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** Files under a folder, counted through the listing route (at most 50 folders read; the rest are estimated by `more`). */
async function countFiles(qc: QueryClient, agentId: string, folder: string): Promise<number> {
  let files = 0;
  let budget = 50;
  const queue = [folder];
  while (queue.length > 0 && budget > 0) {
    budget -= 1;
    const list = await fetchSandboxFolder(qc, agentId, queue.shift() ?? "");
    files += list.more;
    for (const e of list.entries) {
      if (e.kind === "file") files += 1;
      else queue.push(e.path);
    }
  }
  return files;
}

export function SandboxTab({
  agent,
  status,
}: {
  agent: Agent;
  status: UseQueryResult<SandboxStatusView, unknown>;
}) {
  const bot = agent.name;
  if (status.isPending) {
    return (
      <TabFrame>
        <SandboxStatusSkeleton />
        <div className="rounded-xl border bg-card p-2 shadow-xs">
          <SandboxTreeSkeleton stacked={false} />
        </div>
      </TabFrame>
    );
  }
  if (status.isError) {
    return (
      <TabFrame>
        <div
          role="alert"
          data-testid="sandbox-error"
          className="grid justify-items-start gap-2 rounded-xl border bg-card p-4 text-sm"
        >
          <p className="text-muted-foreground">Couldn't load {bot}'s sandbox.</p>
          <Button variant="outline" size="sm" className="max-md:h-11" onClick={() => void status.refetch()}>
            <RotateCcw /> Try again
          </Button>
        </div>
      </TabFrame>
    );
  }
  return <LoadedSandboxTab agent={agent} status={status.data} />;
}

function TabFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto" data-testid="sandbox-tab">
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-4 px-4 pt-4 pb-6 sm:px-6 sm:pt-6">
        {children}
      </div>
    </div>
  );
}

function LoadedSandboxTab({ agent, status }: { agent: Agent; status: SandboxStatusView }) {
  const bot = agent.name;
  const agentId = agent.id;
  const qc = useQueryClient();
  const split = useMediaQuery(SPLIT_QUERY, true);
  const desktop = useIsDesktop();
  const tree = useRef<SandboxTreeHandle>(null);

  const [expanded, setExpanded] = useState<string[]>([]);
  const [selected, setSelected] = useState<PreviewFile | null>(null);
  const [openedVia, setOpenedVia] = useState<TreeOpenVia>("pointer");
  /** A newer version the bot wrote while the file is open (from the 10 s refresh). */
  const [newer, setNewer] = useState<PreviewFile | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [lifecycleAction, setLifecycleAction] = useState<"stop" | "restart" | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ folder: string; files: File[] } | null>(null);
  const [existing, setExisting] = useState<ReadonlySet<string>>(new Set());

  const del = useDeleteSandboxPath(agentId);
  const lifecycle = useSandboxLifecycle(agentId);

  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const open = (entry: SandboxFileEntry, via: TreeOpenVia) => {
    setOpenedVia(via);
    setNewer(null);
    setSelected(previewFileOf(entry));
  };

  const onEntries = (entries: readonly SandboxFileEntry[]) => {
    const current = selectedRef.current;
    if (!current) return;
    const entry = entries.find((e) => e.path === current.path && e.kind === "file");
    if (entry && entry.modifiedAt !== current.modifiedAt) setNewer(previewFileOf(entry));
  };

  const reload = () => {
    if (newer) setSelected(newer);
    setNewer(null);
    if (selected) void qc.invalidateQueries({ queryKey: sandboxKeys.content(agentId, selected.path) });
  };

  const download = (path: string, name: string) => {
    setDownloading(true);
    downloadSandboxFile(agentId, path, name)
      .catch(() => toast.error(`Couldn't download ${name}. Try again.`))
      .finally(() => setDownloading(false));
  };

  const askDelete = (entry: { path: string; name: string; kind: "file" | "dir" }) => {
    setDeleteError(null);
    if (entry.kind === "file") {
      setDeleting({ path: entry.path, name: entry.name, folder: false });
      return;
    }
    countFiles(qc, agentId, entry.path).then(
      (files) => setDeleting({ path: entry.path, name: entry.name, folder: true, files }),
      (err) => toast.error(errorMessage(err)),
    );
  };

  const confirmDelete = () => {
    if (!deleting) return;
    const target = deleting;
    del.mutate(
      { path: target.path, folder: target.folder },
      {
        onSuccess: () => {
          toast.success(`${target.name} deleted`);
          setDeleting(null);
          const gone = (p: string) => p === target.path || p.startsWith(`${target.path}/`);
          if (selected && gone(selected.path)) setSelected(null);
          setExpanded((ids) => ids.filter((id) => !gone(id)));
          void tree.current?.refresh([parentOf(target.path)]);
        },
        onError: (err) => setDeleteError(errorMessage(err)),
      },
    );
  };

  const confirmLifecycle = () => {
    if (!lifecycleAction) return;
    const action = lifecycleAction;
    lifecycle.mutate(action, {
      onSuccess: () => {
        toast.success(action === "stop" ? `${bot}'s sandbox stopped` : `${bot}'s sandbox restarted`);
        setLifecycleAction(null);
      },
      onError: (err) => setLifecycleError(errorMessage(err)),
    });
  };

  const openUpload = (folder: string, files: File[] = []) => {
    setExisting(new Set());
    setUpload({ folder, files });
    fetchSandboxFolder(qc, agentId, folder).then(
      (list) => setExisting(new Set(list.entries.filter((e) => e.kind === "file").map((e) => e.name))),
      () => setExisting(new Set()),
    );
  };

  const onUploaded = async (folder: string, paths: string[]) => {
    void qc.invalidateQueries({ queryKey: sandboxKeys.status(agentId) });
    setExpanded((ids) => [...new Set([...ids, ...ancestorsOf(folder)])]);
    await tree.current?.refresh([folder]);
    const first = paths[0];
    if (!first) return;
    tree.current?.focusPath(first);
    if (!split) return;
    const entry = qc
      .getQueryData<{ entries: SandboxFileEntry[] }>(sandboxKeys.list(agentId, folder))
      ?.entries.find((e) => e.path === first);
    if (entry) open(entry, "pointer");
  };

  const free = Math.max(0, status.diskQuotaBytes - status.diskBytes);
  const showTree = split || !selected || !desktop;
  const inPlace = desktop && !split && selected;

  return (
    <TabFrame>
      <SandboxStatusCard
        status={status}
        bot={bot}
        actions={desktop ? "inline" : "row"}
        onStop={() => {
          setLifecycleError(null);
          setLifecycleAction("stop");
        }}
        onRestart={() => {
          setLifecycleError(null);
          setLifecycleAction("restart");
        }}
      />

      <section
        data-testid="sandbox-files"
        aria-label="Files"
        className="flex flex-col overflow-hidden rounded-xl border bg-card shadow-xs lg:min-h-[480px] lg:flex-1 lg:basis-0 lg:flex-row"
      >
        {showTree ? (
          <div className="flex min-h-0 flex-col lg:w-80 lg:shrink-0 lg:border-r">
            <div className="grid gap-2 border-b px-4 py-2 md:flex md:h-12 md:items-center md:py-0">
              <p className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
                  Files
                </span>
                <span className="truncate font-mono text-muted-foreground text-xs">/workspace</span>
              </p>
              <Button
                variant="outline"
                size="sm"
                className="max-md:h-11 max-md:w-full"
                data-testid="sandbox-upload"
                onClick={() => openUpload(tree.current?.uploadFolder() ?? "")}
              >
                <Upload /> Upload
              </Button>
            </div>
            <div className="scrollbar-thin min-h-0 flex-1 px-2 py-2 lg:overflow-y-auto">
              <SandboxTree
                ref={tree}
                agentId={agentId}
                bot={bot}
                stacked={!desktop}
                selectedPath={selected?.path ?? null}
                expanded={expanded}
                onExpandedChange={setExpanded}
                onOpen={open}
                onEntries={onEntries}
                onDownload={(e) => download(e.path, e.name)}
                onDelete={askDelete}
                onUploadHere={(folder) => openUpload(folder)}
                onDropFiles={(folder, files) => openUpload(folder, files)}
              />
            </div>
          </div>
        ) : null}
        {split ? (
          selected ? (
            <SandboxFilePane
              key={selected.path}
              agentId={agentId}
              file={selected}
              changed={newer !== null}
              focusHeading={openedVia === "keyboard"}
              downloading={downloading}
              onReload={reload}
              onDownload={() => download(selected.path, selected.name)}
              onDelete={() => askDelete({ path: selected.path, name: selected.name, kind: "file" })}
            />
          ) : (
            <div className="flex min-w-0 flex-1 items-center justify-center">
              <PickAFile />
            </div>
          )
        ) : inPlace && selected ? (
          <SandboxFilePane
            key={selected.path}
            agentId={agentId}
            file={selected}
            changed={newer !== null}
            focusHeading
            downloading={downloading}
            onReload={reload}
            onDownload={() => download(selected.path, selected.name)}
            onDelete={() => askDelete({ path: selected.path, name: selected.name, kind: "file" })}
            onBack={() => {
              const path = selected.path;
              setSelected(null);
              tree.current?.focusPath(path);
            }}
          />
        ) : null}
      </section>

      {!desktop ? (
        <SandboxFileSheet
          agentId={agentId}
          file={selected}
          changed={newer !== null}
          downloading={downloading}
          onReload={reload}
          onDownload={() => selected && download(selected.path, selected.name)}
          onDelete={() => selected && askDelete({ path: selected.path, name: selected.name, kind: "file" })}
          onClose={() => setSelected(null)}
        />
      ) : null}

      <DeleteDialog
        target={deleting}
        bot={bot}
        pending={del.isPending}
        error={deleteError}
        onCancel={() => setDeleting(null)}
        onConfirm={confirmDelete}
      />
      <LifecycleDialog
        action={lifecycleAction}
        bot={bot}
        pending={lifecycle.isPending}
        error={lifecycleError}
        onCancel={() => setLifecycleAction(null)}
        onConfirm={confirmLifecycle}
      />
      <UploadDialog
        open={upload !== null}
        agentId={agentId}
        bot={bot}
        teamBot={status.teamBot}
        folder={upload?.folder ?? ""}
        initialFiles={upload?.files ?? []}
        freeBytes={free}
        existingNames={existing}
        onClose={() => setUpload(null)}
        onUploaded={(folder, paths) => void onUploaded(folder, paths)}
      />
    </TabFrame>
  );
}
