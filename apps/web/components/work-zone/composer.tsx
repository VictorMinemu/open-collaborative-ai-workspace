"use client";

import { WORK_PROMPT_MAX_ATTACHMENTS, type WorkSession } from "@ocw/contracts";
import { ArrowUp, ListPlus, Paperclip } from "lucide-react";
import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import {
  AttachmentTray,
  type QueueItem,
  useAttachmentQueue,
} from "@/components/chat/attachments/attachment-tray";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { ApiRequestError, errorMessage } from "@/lib/api";
import { useAttachmentsConfig } from "@/lib/attachment-queries";
import { cn } from "@/lib/utils";
import { useQueuePrompt, useSessionCommand, useSessionControls } from "@/lib/workzone-queries";
import { useSheetSurface } from "./control-surface";
import { attachmentGate, SLASH_REASON, TOO_MANY_REASON } from "./image-gate";
import { RUNTIMES } from "./meta";
import { currentModelControl, ModelPicker } from "./model-picker";
import { PermissionMenu } from "./permission-menu";
import { ReasoningMenu } from "./reasoning-menu";

/** Thin divider between the composer chips (ref-1). */
const ChipDivider = () => <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />;

/**
 * ADR-0045: the paperclip takes any file. Images the model reads go to it inline; every other file is copied into the
 * session's working tree (`.ocw/uploads/`) before the turn, and the runtime is told where.
 */
const ATTACH_HINT = `Attach files · up to ${WORK_PROMPT_MAX_ATTACHMENTS}`;
/** How many files the tray holds at once: what one prompt may carry. */
const TRAY_MAX = WORK_PROMPT_MAX_ATTACHMENTS;

/** The attachment a refusal of the API names (`details.attachmentId`), so its chip says why. */
function refusedAttachment(err: unknown): string | null {
  if (!(err instanceof ApiRequestError)) return null;
  const id = (err.details as { attachmentId?: unknown } | null | undefined)?.attachmentId;
  return typeof id === "string" ? id : null;
}

/** What the session pane can hand the composer (a drop on it, 06.1). */
export interface ComposerApi {
  addFiles(files: File[]): void;
}

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
 * Adds prompts to the session's SHARED queue; they run one at a time on the host device. Files (06.1 D-06, ADR-0045):
 * a paste (Ctrl/Cmd+V), a drop on the session pane or the paperclip put them in the tray above the text, where they
 * upload at once through the Phase 4 pipeline into the session's conversation; Send waits until every upload is ready
 * and posts their ids with the prompt.
 */
export function Composer({
  session,
  queued,
  canConfigure = true,
  canPrompt = true,
  apiRef,
  above,
  below,
}: {
  /** Receives `addFiles` for drops on the session pane. */
  apiRef?: RefObject<ComposerApi | null>;
  session: WorkSession;
  queued: number;
  /** The viewer may change the session's settings (`work_session.configure`). */
  canConfigure?: boolean;
  /** The viewer may prompt the session (`work_session.prompt`): attaching files needs it too. */
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
    () => (canAttach && maxBytes ? { maxBytes, maxPerMessage: TRAY_MAX } : null),
    [canAttach, maxBytes],
  );
  // The API refuses the same cases (the device, the deny list, the size, the slash guard); this only says why early.
  const model = currentModelControl(session, controls.data);
  const filesControl = controls.data?.files;
  /** Refusals the API gave for files already uploaded (by attachment id), until the file is removed or sent. */
  const [serverRefusals, setServerRefusals] = useState<Record<string, string>>({});
  const tray = useAttachmentQueue(session.conversationId, limits, {
    tooManyText: TOO_MANY_REASON,
    // Before any upload: what never changes with the file's place in the tray (an image counts as inline here; its
    // place decides in `refusalOf`).
    precheck: (file, accepted) => {
      if (accepted >= TRAY_MAX) return TOO_MANY_REASON;
      const gate = attachmentGate({
        model,
        files: filesControl,
        file: { contentType: file.type, name: file.name, size: file.size },
      });
      return gate.ok ? null : gate.reason;
    },
  });
  // Re-run on every render: a file is marked refused when the model or the device changes, and an image past the
  // inline cap is decided as a file. The first `WORK_PROMPT_MAX_IMAGES` images the model reads go inline.
  const refusals = new Map<string, string | null>();
  let inlineBefore = 0;
  for (const item of tray.items) {
    if (item.status === "error") continue;
    const fromServer = item.attachment ? serverRefusals[item.attachment.id] : undefined;
    const gate = attachmentGate({
      model,
      files: filesControl,
      inlineBefore,
      file: { contentType: item.contentType, name: item.name, size: item.size },
    });
    if (gate.ok && gate.route === "inline") inlineBefore++;
    refusals.set(item.localId, fromServer ?? (gate.ok ? null : gate.reason));
  }
  const refusalOf = (item: QueueItem): string | null => refusals.get(item.localId) ?? null;
  const refused = tray.items.some((i) => i.status !== "error" && refusalOf(i) !== null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploading = tray.busy || tray.blocked || refused;
  // D-13 / P-06: a `/command` goes to the session controls and never carries files.
  const slashWithFiles = text.trimStart().startsWith("/") && tray.items.length > 0;
  // The tray's chips clamp their reason; the hint under the card says it in full (390 included).
  const firstRefusal = tray.items
    .map((i) => ({ name: i.name, reason: i.status === "error" ? i.error : refusalOf(i) }))
    .find((r) => r.reason);
  const trayProblem = firstRefusal ? `${firstRefusal.name}: ${firstRefusal.reason}` : null;
  const sendBlockedReason = slashWithFiles
    ? SLASH_REASON
    : tray.busy
      ? "Waiting for the files to upload"
      : tray.blocked || refused
        ? "Remove the files that can't be sent"
        : undefined;
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
    if (!body || sending || uploading || slashWithFiles) return;
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
      setServerRefusals({});
      if (willQueue) toast.success(`Queued #${queued + 1}`, { description: "Runs after the current turn" });
    } catch (err) {
      // ADR-0045: a refusal that names one file (too large, a reserved name) marks that file's chip with the reason.
      const attachmentId = refusedAttachment(err);
      const reason = errorMessage(err);
      if (attachmentId) {
        setServerRefusals((prev) => ({ ...prev, [attachmentId]: reason.replace(/^[^:]*: /, "") }));
      }
      toast.error(reason);
    }
  }

  function addFiles(files: File[]) {
    if (!canAttach || files.length === 0) return;
    tray.add(files);
    ref.current?.focus({ preventScroll: true });
  }
  if (apiRef) apiRef.current = { addFiles };

  /** Pasted files (a screenshot) join the tray; the text of the paste still goes into the prompt. */
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
  const problem = slashWithFiles ? SLASH_REASON : trayProblem;
  const hint = problem
    ? problem
    : session.status === "host_offline"
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
            <AttachmentTray queue={tray} refusalOf={refusalOf} />
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
                      className="relative rounded-full text-muted-foreground hover:text-foreground disabled:opacity-45 max-md:after:absolute max-md:after:-inset-1"
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
              disabled={!text.trim() || sending || archived || uploading || slashWithFiles}
              title={sendBlockedReason}
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
          {hint ? (
            <span
              data-problem={problem ? "true" : undefined}
              className={cn(problem ? "min-w-0 break-words text-destructive" : "truncate")}
            >
              {hint}
            </span>
          ) : null}
        </p>
      ) : null}
    </form>
  );
}
