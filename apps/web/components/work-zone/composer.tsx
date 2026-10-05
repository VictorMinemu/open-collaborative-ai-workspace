"use client";

import type { WorkSession } from "@ocw/contracts";
import { ArrowUp, ListPlus, Square } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/api";
import { useInterrupt, useQueuePrompt, useSessionCommand } from "@/lib/workzone-queries";
import { RUNTIMES } from "./meta";
import { ModelPicker } from "./model-picker";

/** Adds prompts to the session's SHARED queue; they run one at a time on the host device. */
export function Composer({
  session,
  queued,
  canConfigure = true,
}: {
  session: WorkSession;
  queued: number;
  /** The viewer may change the session's settings (`work_session.configure`). */
  canConfigure?: boolean;
}) {
  const queue = useQueuePrompt(session.id);
  const command = useSessionCommand(session.id);
  const interrupt = useInterrupt(session.id);
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const busy = session.status === "running" || session.status === "waiting_approval";
  const willQueue =
    busy || session.status === "provisioning" || session.status === "host_offline" || queued > 0;
  const archived = session.status === "archived";
  const sending = queue.isPending || command.isPending;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  });

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    try {
      // D-13: a leading `/command` goes to the session controls on the server, never to the queue raw.
      if (body.startsWith("/")) {
        const result = await command.mutateAsync(body);
        setText("");
        if (result.kind === "refused") toast.warning(result.notice);
        else toast.success(result.notice);
        return;
      }
      await queue.mutateAsync(body);
      setText("");
      if (willQueue) toast.success(`Queued #${queued + 1}`, { description: "Runs after the current turn" });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  }

  const hint = session.settings.pending
    ? "Applies to the next turn"
    : session.status === "host_offline"
      ? `${session.deviceName} is offline — prompts wait in the queue`
      : willQueue
        ? `Will run after the current turn · #${queued + 1} in queue`
        : `Runs on ${session.deviceName} · ${RUNTIMES[session.runtime].subscription.replace(" on this device", "")}`;

  return (
    <form
      onSubmit={submit}
      className="mx-auto w-full max-w-3xl px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6"
    >
      <div className="rounded-2xl border bg-card shadow-sm transition-[border-color,box-shadow] focus-within:border-ring/60 focus-within:ring-[3px] focus-within:ring-ring/15">
        <textarea
          ref={ref}
          data-testid="composer"
          rows={1}
          value={text}
          disabled={archived}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={archived ? "This session is archived" : `Ask ${RUNTIMES[session.runtime].label} to…`}
          aria-label="Prompt"
          className="block max-h-[220px] min-h-[52px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[14px] outline-none placeholder:text-muted-foreground/70"
        />
        <div className="flex items-center gap-1.5 px-2.5 pb-2.5">
          <ModelPicker session={session} disabled={archived || !canConfigure} />
          <p
            data-testid="composer-hint"
            className="min-w-0 flex-1 truncate pl-1 text-[11.5px] text-muted-foreground"
          >
            {hint}
          </p>
          {busy ? (
            <Tooltip content="Interrupt the current turn">
              <Button
                type="button"
                size="icon-sm"
                variant="outline"
                aria-label="Interrupt"
                data-testid="interrupt"
                disabled={interrupt.isPending}
                onClick={() =>
                  interrupt.mutate(undefined, { onError: (err) => toast.error(errorMessage(err)) })
                }
                className="rounded-full"
              >
                {interrupt.isPending ? <Spinner /> : <Square className="size-3.5 fill-current" />}
              </Button>
            </Tooltip>
          ) : null}
          <Button
            type="submit"
            size={willQueue ? "sm" : "icon-sm"}
            disabled={!text.trim() || sending || archived}
            aria-label={willQueue ? "Add to queue" : "Send"}
            data-testid="send-prompt"
            className="rounded-full"
          >
            {sending ? <Spinner /> : willQueue ? <ListPlus /> : <ArrowUp />}
            {willQueue ? "Queue" : null}
          </Button>
        </div>
      </div>
    </form>
  );
}
