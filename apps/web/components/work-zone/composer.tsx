"use client";

import { INLINE_IMAGE_TYPES, WORK_PROMPT_MAX_IMAGES, type WorkSession } from "@ocw/contracts";
import { ArrowUp, ListPlus, Paperclip } from "lucide-react";
import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { AttachmentTray, useAttachmentQueue } from "@/components/chat/attachments/attachment-tray";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/api";
import { useAttachmentsConfig } from "@/lib/attachment-queries";
import { useQueuePrompt, useSessionCommand, useSessionControls } from "@/lib/workzone-queries";
import { useSheetSurface } from "./control-surface";
import { RUNTIMES } from "./meta";
import { ModelPicker } from "./model-picker";
import { PermissionMenu } from "./permission-menu";
import { ReasoningMenu } from "./reasoning-menu";

/** Thin divider between the composer chips (ref-1). */
const ChipDivider = () => <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />;

/** What the paperclip's picker offers (06.1): the four image types a runtime reads. */
const IMAGE_ACCEPT = INLINE_IMAGE_TYPES.join(",");
const ATTACH_HINT = `Attach images · PNG, JPEG, GIF or WebP, up to ${WORK_PROMPT_MAX_IMAGES}`;

/** The files of a paste: clipboard file items (an OS screenshot is an `image/png` item), else `files`. */
function pastedFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const fromItems = Array.from(data.items ?? [])
    .filter((i) => i.kind === "file")
    .map((i) => i.getAsFile())
    .filter((f): f is File => f !== null);
  return fromItems.length > 0 ? fromItems : Array.from(data.files ?? []);
}

/**
 * Adds prompts to the session's SHARED queue; they run one at a time on the host device. Images (06.1, D-06): a paste
 * (Ctrl/Cmd+V), a drop on the session pane or the paperclip put them in the tray above the text, where they upload at
 * once through the Phase 4 pipeline into the session's conversation; Send waits until every upload is ready and posts
 * their ids with the prompt.
 */
export function Composer({
  session,
  queued,
  canConfigure = true,
  canPrompt = true,
  above,
  below,
}: {
  session: WorkSession;
  queued: number;
  /** The viewer may change the session's settings (`work_session.configure`). */
  canConfigure?: boolean;
  /** The viewer may prompt the session (`work_session.prompt`): attaching images needs it too. */
  canPrompt?: boolean;
  /** Attached on top of the card (ref-4 agent bar). */
  above?: ReactNode;
  /** Attached under the card (ref-4 footer strip). */
  below?: ReactNode;
}) {
  const queue = useQueuePrompt(session.id);
  const command = useSessionCommand(session.id);
  const controls = useSessionControls(session.id);
  const phone = useSheetSurface();
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const busy = session.status === "running" || session.status === "waiting_approval";
  const willQueue =
    busy || session.status === "provisioning" || session.status === "host_offline" || queued > 0;
  const archived = session.status === "archived";
  const sending = queue.isPending || command.isPending;
  // Phase 4 rule: storage not configured (or `attachment.upload` refused) hides the paperclip; the API decides again.
  const filesConfig = useAttachmentsConfig();
  const attachable = filesConfig.data?.enabled === true && canPrompt;
  const canAttach = attachable && !archived;
  const maxBytes = filesConfig.data?.maxBytes;
  const limits = useMemo(
    () => (canAttach && maxBytes ? { maxBytes, maxPerMessage: WORK_PROMPT_MAX_IMAGES } : null),
    [canAttach, maxBytes],
  );
  const tray = useAttachmentQueue(session.conversationId, limits);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploading = tray.busy || tray.blocked;
  // A `/command` never joins the queue (D-13): the button says Queue only for a prompt that will wait.
  const queueLabel = willQueue && !text.trimStart().startsWith("/");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  });

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const body = text.trim();
    if (!body || sending || uploading) return;
    try {
      // D-13: a leading `/command` goes to the session controls on the server, never to the queue raw.
      if (body.startsWith("/")) {
        const result = await command.mutateAsync(body);
        setText("");
        if (result.kind === "refused") toast.warning(result.notice);
        else toast.success(result.notice);
        return;
      }
      await queue.mutateAsync({ body, attachmentIds: tray.readyIds });
      setText("");
      tray.reset();
      if (willQueue) toast.success(`Queued #${queued + 1}`, { description: "Runs after the current turn" });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  function addFiles(files: File[]) {
    if (!canAttach || files.length === 0) return;
    tray.add(files);
    ref.current?.focus({ preventScroll: true });
  }

  /** Pasted images (a screenshot) join the tray; the text of the paste still goes into the prompt. */
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (!canAttach) return;
    const files = pastedFiles(e.clipboardData);
    if (files.length === 0) return;
    const pasted = e.clipboardData.getData("text/plain").trim();
    if (!pasted || files.some((f) => f.name === pasted)) e.preventDefault();
    addFiles(files);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  }

  // Where the prompt runs is in the footer strip (ref-4); the hint line only appears when something is notable.
  const hint =
    session.status === "host_offline"
      ? `${session.deviceName} is offline — prompts wait in the queue`
      : willQueue
        ? `Will run after the current turn · #${queued + 1} in queue`
        : null;
  const showPending = session.settings.pending && phone;

  // D-14: a change accepted while a turn runs waits for the next one; every controller sees it until the device reports.
  const pendingMarker = (
    <span
      data-testid="settings-pending"
      className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-warning/12 px-2 font-medium text-[11.5px] text-amber-800 dark:text-amber-300"
    >
      <span aria-hidden className="size-1.5 rounded-full bg-warning" />
      Applies to the next turn
    </span>
  );

  return (
    <form
      onSubmit={submit}
      data-testid="composer-form"
      className="mx-auto w-full max-w-3xl px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-4"
    >
      {above}
      <div className="relative rounded-[22px] border bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-12px_rgb(0_0_0/0.12)] transition-[border-color,box-shadow] focus-within:border-ring/50 dark:shadow-none">
        {canAttach && tray.items.length > 0 ? (
          <div className="px-3 pt-3">
            <AttachmentTray queue={tray} />
          </div>
        ) : null}
        <textarea
          ref={ref}
          data-testid="composer"
          rows={1}
          value={text}
          disabled={archived}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={archived ? "This session is archived" : `Ask ${RUNTIMES[session.runtime].label} to…`}
          aria-label="Prompt"
          className="block max-h-[220px] min-h-[56px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[14px] outline-none placeholder:text-muted-foreground/70"
        />
        {/* Session controls (D-16, ref-1): model · reasoning · permission, driven only by GET /controls. On a phone
            the bar takes two rows (model · reasoning, then permission and the actions) so no chip is cut. */}
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-2 pb-2">
          <div
            data-testid="composer-controls"
            className="flex min-w-0 basis-full items-center sm:basis-auto sm:flex-1"
          >
            <ModelPicker session={session} disabled={archived || !canConfigure} />
            {controls.data ? (
              <>
                {/* Renders nothing (divider included) for a model without efforts, windows or fast mode. */}
                <ReasoningMenu
                  session={session}
                  controls={controls.data}
                  disabled={archived || !canConfigure}
                  leading={<ChipDivider />}
                />
                {phone ? null : (
                  <>
                    <ChipDivider />
                    <PermissionMenu
                      session={session}
                      controls={controls.data}
                      disabled={archived || !canConfigure}
                    />
                  </>
                )}
              </>
            ) : null}
          </div>
          {phone && controls.data ? (
            <PermissionMenu session={session} controls={controls.data} disabled={archived || !canConfigure} />
          ) : null}
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {session.settings.pending && !phone ? pendingMarker : null}
            {attachable ? (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  accept={IMAGE_ACCEPT}
                  multiple
                  hidden
                  tabIndex={-1}
                  data-testid="attach-file"
                  onChange={(e) => {
                    addFiles(Array.from(e.target.files ?? []));
                    e.target.value = "";
                  }}
                />
                <Tooltip content={ATTACH_HINT}>
                  <span className="inline-flex">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      disabled={!canAttach}
                      data-testid="attach"
                      aria-label={ATTACH_HINT}
                      onClick={() => fileInput.current?.click()}
                      className="rounded-full text-muted-foreground hover:text-foreground disabled:opacity-45"
                    >
                      <Paperclip className="size-[18px]" />
                    </Button>
                  </span>
                </Tooltip>
              </>
            ) : null}
            {/* Stop lives in the agent bar above the card (ref-4): same `interrupt` mutation and test id. */}
            <Button
              type="submit"
              size={queueLabel ? "default" : "icon"}
              disabled={!text.trim() || sending || archived || uploading}
              aria-label={queueLabel ? "Add to queue" : "Send"}
              data-testid="send-prompt"
              className="rounded-full"
            >
              {sending ? <Spinner /> : queueLabel ? <ListPlus /> : <ArrowUp className="size-[18px]" />}
              {queueLabel ? "Queue" : null}
            </Button>
          </div>
        </div>
      </div>
      {below}
      {hint || showPending ? (
        <p
          data-testid="composer-hint"
          className="flex min-w-0 items-center gap-2 px-3 pt-1.5 text-[11.5px] text-muted-foreground"
        >
          {showPending ? pendingMarker : null}
          {hint ? <span className="truncate">{hint}</span> : null}
        </p>
      ) : null}
    </form>
  );
}
