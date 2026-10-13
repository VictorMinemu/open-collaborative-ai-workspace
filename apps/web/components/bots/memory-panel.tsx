"use client";

import { MEMORY_ROOT_FILE } from "@ocw/contracts";
import { ArrowUpRight, Lock, NotebookPen, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { useModule } from "@/components/shell/module-gate";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/api";
import { useBotMemories, useClearBotMemory } from "@/lib/capability-queries";
import { useEnsureMemoryScope, useMemoryScopes } from "@/lib/memory-queries";
import { memoryHref } from "@/lib/memory-tree";
import { cn, formatDate } from "@/lib/utils";

const plural = (n: number) => `${n} ${n === 1 ? "note" : "notes"}`;

/**
 * "What <bot> remembers about you" (D-10, D-16; SC5): the caller's own notes with this bot, newest first, each
 * with a delete button, plus Clear all behind a confirmation. Only the caller ever sees this list; the API has
 * no read path for anyone else. `memoryOn` false explains that the notes are kept but unused.
 *
 * 07.2-14 (D-02, UI-SPEC "DM memory panel", additions only): the notes are the bullets of the caller's private
 * `MEMORY.md` with this bot; the panel says so and "Open in Memory" opens that file in the viewer (the private scope
 * is created on first use). The empty state offers it only when the private scope already exists.
 */
export function MemoryPanel({
  agentId,
  botName,
  open,
  onOpenChange,
  memoryOn = true,
}: {
  agentId: string;
  botName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  memoryOn?: boolean;
}) {
  const q = useBotMemories(open ? agentId : null);
  const clear = useClearBotMemory(agentId);
  const [confirmAll, setConfirmAll] = useState(false);
  const items = q.data?.items ?? [];

  async function forget(memoryId?: string) {
    try {
      await clear.mutateAsync(memoryId);
      if (!memoryId) {
        setConfirmAll(false);
        toast.success(`${botName} forgot everything about you`);
      }
    } catch (err) {
      toast.error("Could not delete", { description: errorMessage(err) });
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-full sm:w-[28rem]" data-testid="memory-panel">
        <div className="flex items-start gap-3 border-b px-5 py-4 pr-14">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50">
            <NotebookPen className="size-4 text-primary" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <SheetTitle className="text-balance leading-snug">What {botName} remembers about you</SheetTitle>
            <SheetDescription className="mt-1 inline-flex items-center gap-1.5 text-xs">
              <Lock className="size-3 shrink-0" aria-hidden />
              Only you can see this. Admins can't.
            </SheetDescription>
          </div>
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!memoryOn ? (
            <p
              className="mb-4 rounded-lg border bg-muted/40 px-3 py-2 text-muted-foreground text-xs"
              data-testid="memory-off"
            >
              Memory is off for {botName}. These notes are kept, but {botName} doesn't use them or save new
              ones.
            </p>
          ) : null}

          {q.isPending ? (
            <div className="grid gap-2" aria-busy>
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-14 rounded-lg" />
              ))}
            </div>
          ) : q.isError ? (
            <div className="grid justify-items-start gap-3 py-6 text-sm">
              <p className="text-muted-foreground">Couldn't load the notes. {errorMessage(q.error)}</p>
              <Button variant="outline" size="sm" onClick={() => void q.refetch()}>
                Try again
              </Button>
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center px-4 py-14 text-center">
              <div className="mb-4 flex size-12 items-center justify-center rounded-2xl border bg-card shadow-sm">
                <NotebookPen className="size-5 text-muted-foreground" strokeWidth={1.75} aria-hidden />
              </div>
              <p className="max-w-64 text-balance text-muted-foreground text-sm" data-testid="memory-empty">
                Nothing yet. Ask {botName} to remember something.
              </p>
              <OpenInMemory agentId={agentId} variant="outline" onlyIfExists className="mt-4" />
            </div>
          ) : (
            <ul className="grid gap-2" aria-label={`Notes ${botName} keeps about you`}>
              {items.map((item) => (
                <li
                  key={item.id}
                  className="group flex items-start gap-3 rounded-lg border bg-card px-3.5 py-3"
                  data-testid="memory-item"
                >
                  <div className="min-w-0 flex-1">
                    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{item.text}</p>
                    <p className="mt-1 text-muted-foreground text-xs">Saved {formatDate(item.createdAt)}</p>
                  </div>
                  <Tooltip content="Forget this">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="-mt-1 -mr-1.5 shrink-0 text-muted-foreground hover:text-destructive"
                      aria-label="Forget this note"
                      data-testid="memory-delete"
                      disabled={clear.isPending}
                      onClick={() => void forget(item.id)}
                    >
                      <X />
                    </Button>
                  </Tooltip>
                </li>
              ))}
            </ul>
          )}
          {items.length > 0 ? (
            <p className="mt-4 text-balance text-muted-foreground text-xs leading-relaxed">
              {botName} saves a note when you ask it to remember something, and uses your notes only in this
              private chat.
            </p>
          ) : null}
          {items.length > 0 ? (
            <p className="mt-2 text-balance text-muted-foreground text-xs" data-testid="memory-file-note">
              Kept in your private memory file with {botName}.
            </p>
          ) : null}
        </div>

        {items.length > 0 ? (
          <div
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t bg-muted/30 px-5 py-3 pb-[max(env(safe-area-inset-bottom),12px)]"
            data-testid="memory-footer"
          >
            <span className="mr-auto text-muted-foreground text-xs tabular-nums" data-testid="memory-count">
              {plural(items.length)}
            </span>
            <OpenInMemory agentId={agentId} variant="ghost" className="max-lg:h-11" />
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive max-lg:h-11"
              onClick={() => setConfirmAll(true)}
              data-testid="memory-clear-all"
            >
              <Trash2 /> Clear all
            </Button>
          </div>
        ) : null}

        <Dialog open={confirmAll} onOpenChange={setConfirmAll}>
          <DialogContent data-testid="memory-clear-confirm">
            <DialogHeader>
              <DialogTitle>Clear everything {botName} remembers?</DialogTitle>
              <DialogDescription>
                {plural(items.length)} will be deleted. {botName} won't see them in future chats. This can't
                be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmAll(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => void forget()}
                disabled={clear.isPending}
                data-testid="memory-clear-confirm-action"
              >
                {clear.isPending ? <Spinner /> : <Trash2 />}
                Clear all
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SheetContent>
    </Sheet>
  );
}

/**
 * "Open in Memory": the caller's private `MEMORY.md` with this bot in the viewer. The scope is ensured first (it is
 * created on first use); `onlyIfExists` renders nothing until the API lists it. Hidden while the Memory module is off.
 */
function OpenInMemory({
  agentId,
  variant,
  onlyIfExists = false,
  className,
}: {
  agentId: string;
  variant: "ghost" | "outline";
  onlyIfExists?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const memoryModule = useModule("memory");
  const scopes = useMemoryScopes();
  const ensure = useEnsureMemoryScope();
  const exists = scopes.data?.scopes.some((s) => s.kind === "personal" && s.agentId === agentId) ?? false;
  if (memoryModule === "off" || scopes.isError) return null;
  if (onlyIfExists && !exists) return null;
  return (
    <Button
      variant={variant}
      size="sm"
      className={cn(className)}
      disabled={ensure.isPending}
      data-testid="memory-open-in-memory"
      onClick={() =>
        ensure.mutate(
          { kind: "personal", agentId },
          {
            onSuccess: (scope) => router.push(memoryHref(scope.id, MEMORY_ROOT_FILE)),
            onError: (err) => toast.error("Could not open memory", { description: errorMessage(err) }),
          },
        )
      }
    >
      {ensure.isPending ? <Spinner /> : null}
      Open in Memory
      <ArrowUpRight />
    </Button>
  );
}
