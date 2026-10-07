"use client";

import {
  type AiChatDetail,
  type AiChatTools,
  type AiModelOption,
  type Attachment,
  type ModelRef,
  modelRefKey,
} from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Gauge, Paperclip, Square } from "lucide-react";
import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  AttachmentTray,
  type QueueItem,
  useAttachmentQueue,
} from "@/components/chat/attachments/attachment-tray";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useAiChatModel } from "@/lib/ai-chat-model-store";
import { limitNoticeText } from "@/lib/ai-format";
import { orgAnswersLeft, reachedLimit, refreshAiUsageToday, useAiUsageToday } from "@/lib/ai-usage-queries";
import { useAttachmentsConfig } from "@/lib/attachment-queries";
import type { UploadTarget } from "@/lib/upload";
import { cn } from "@/lib/utils";
import { attachmentGate, readableSummary } from "./attachment-gate";
import { ModelPicker } from "./model-picker";
import { PlanUsageLine } from "./plan-usage-line";
import { ToolsMenu, useWebReason, WebChip } from "./tools-menu";

/**
 * The model a chat falls back to: the first of `preferred` that is still available (the chat's last model, the
 * member's default), else the list's default, else any available model.
 */
export function pickModel(
  models: AiModelOption[] | undefined,
  preferred: (ModelRef | null | undefined)[],
): AiModelOption | null {
  const list = models ?? [];
  for (const ref of preferred) {
    if (!ref) continue;
    const found = list.find((m) => m.available && modelRefKey(m.ref) === modelRefKey(ref));
    if (found) return found;
  }
  return list.find((m) => m.available && m.isDefault) ?? list.find((m) => m.available) ?? null;
}

/** The composer's textarea: menus around the chat hand focus back to it when they close (05-14). */
export const AI_COMPOSER_ID = "ai-composer-input";
export const composerElement = (): HTMLElement | null =>
  typeof document === "undefined" ? null : document.getElementById(AI_COMPOSER_ID);

/** The files a send carries (05-12): the verified uploads, in tray order. */
export interface AiSendFiles {
  ids: string[];
  attachments: Attachment[];
}

/** What the AI chat pane can hand the composer (a drop on the conversation, 05-12). */
export interface AiComposerApi {
  addFiles(files: File[]): void;
  /** Puts `text` in the composer (a New chat starter, 05-14) and focuses it with the caret at the end. */
  fill(text: string): void;
}

/** Whether this member can attach files at all (storage configured and reachable, `attachment.upload`). */
export function useAiAttachmentsEnabled(): boolean {
  return useAttachmentsConfig().data?.enabled === true;
}

/**
 * The AI chat composer (P-09): an auto-growing textarea (Enter sends, Shift+Enter is a new line), the model picker
 * chip and the send button, in the Work Zone composer card. While an answer is being written the send button is
 * Stop (05-06, D-05: one generation per chat): the textarea keeps taking text, Enter does not send, Esc stops. The model is chosen per chat (`chatKey`) and per
 * message: the selection survives sends and only ever applies to the next answer. Plan models carry "Using ChatGPT
 * plan · Manage usage" under the card (P-11); organization models carry METERED on the chip. At a daily cap of the
 * selected model's backend (05-08, D-06) a notice above the card says which cap and when it resets (local time) and,
 * on organization models, offers the member's own ChatGPT plan when it is connected; the server stays the authority
 * (a send at the cap is refused before any model call and keeps its text). The "+" button opens the tools (05-11):
 * Web is the next answer's choice (sticky per chat on the server), shown as an active "Web" chip while it is on and
 * usable with the selected model. Files (05-12): the paperclip, a paste or a drop on the pane (`apiRef`) put files in
 * the tray above the text, where they upload at once through the Phase 4 pipeline into `uploadTarget` (the chat, or
 * on New chat a draft created on the first file); a message can be text, files or both once every upload finished.
 */
export function AiComposer({
  chatKey,
  models,
  preferred,
  modelsLoading,
  busy,
  onSend,
  onStop,
  onTyping,
  autoFocus,
  className,
  chat = null,
  initialTools = { web: false },
  uploadTarget = null,
  apiRef,
}: {
  /** Where files upload (the chat id, or a stable function creating New chat's draft); null = text only. */
  uploadTarget?: UploadTarget | null;
  /** Receives `addFiles` for drops on the conversation pane. */
  apiRef?: RefObject<AiComposerApi | null>;
  /** The chat id, or "new" on `/chat/ai/new`. */
  chatKey: string;
  /** The open chat (its tool states and settings), null on `/chat/ai/new`. */
  chat?: AiChatDetail | null;
  /** The tools the composer starts with: the chat's setting, or the member's default on a new chat. */
  initialTools?: AiChatTools;
  models: AiModelOption[] | undefined;
  /** Fallbacks before the member picks: the chat's last model, then the member's default. */
  preferred: (ModelRef | null | undefined)[];
  modelsLoading: boolean;
  /** An answer is being written: one generation per chat, so Stop replaces Send. */
  busy: boolean;
  /** Stops the answer being written (absent while the chat has none to stop). */
  onStop?: () => Promise<void>;
  /** The member is typing (06-11, multiplayer chats only; throttled by the caller). */
  onTyping?: () => void;
  /** Resolves once the API accepted the send; rejects to keep the text and the files. */
  onSend: (text: string, model: AiModelOption, tools: AiChatTools, files: AiSendFiles) => Promise<void>;
  autoFocus?: boolean;
  className?: string;
}) {
  const fallback = pickModel(models, preferred);
  const [selected, setSelected] = useAiChatModel(chatKey, fallback?.ref ?? null);
  // A pick the admin has since removed (or that became unavailable) falls back instead of failing the send.
  const model = pickModel(models, [selected, fallback?.ref]);
  const [text, setText] = useState("");
  const [tools, setTools] = useState<AiChatTools>(initialTools);
  // The chat's setting changed elsewhere (chat settings, another tab): follow it.
  useEffect(() => {
    setTools({ web: initialTools.web });
  }, [initialTools.web]);
  const webReason = useWebReason(chat, model);
  const webActive = tools.web && webReason === null;
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const qc = useQueryClient();
  const today = useAiUsageToday();
  const reached = model ? reachedLimit(today.data, model.ref.backend) : null;
  const planModel =
    reached?.backendClass === "org_key"
      ? (models?.find((m) => m.available && m.group === "chatgpt_plan" && m.isDefault) ??
        models?.find((m) => m.available && m.group === "chatgpt_plan") ??
        null)
      : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  // A new answer clears the "stopping" state of the previous one.
  useEffect(() => {
    if (!busy) setStopping(false);
  }, [busy]);

  const noModel = !model && !modelsLoading;
  const showStop = busy && !!onStop;
  const filesConfig = useAttachmentsConfig();
  const canAttach = uploadTarget !== null && filesConfig.data?.enabled === true && !noModel;
  const queue = useAttachmentQueue(uploadTarget ?? "", canAttach ? filesConfig.data : null);
  const fileInput = useRef<HTMLInputElement>(null);
  // What the selected model can't read is marked in the tray with the reason, re-checked whenever the model changes
  // (05-12); the API refuses the same files (400 attachment_not_supported), it stays the authority.
  const refusalOf = (item: QueueItem): string | null => {
    const gate = attachmentGate(model, { contentType: item.contentType, size: item.size });
    return gate.ok ? null : gate.reason;
  };
  const refused = queue.items.some((i) => i.status !== "error" && refusalOf(i) !== null);
  const hasContent = text.trim().length > 0 || queue.readyIds.length > 0;
  // Never while a file is still uploading, failed, or can't go to this model (remove it, retry it or switch models).
  const canSend = hasContent && !!model && !busy && !sending && !queue.busy && !queue.blocked && !refused;

  function addFiles(files: File[]) {
    if (!canAttach || files.length === 0) return;
    queue.add(files);
    ref.current?.focus({ preventScroll: true });
  }
  function fill(next: string) {
    setText(next);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.length, next.length);
    });
  }
  if (apiRef) apiRef.current = { addFiles, fill };

  /** Pasted files (a screenshot) join the tray; the text of the paste still goes into the message. */
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (!canAttach) return;
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    const pasted = e.clipboardData.getData("text/plain").trim();
    if (!pasted || files.some((f) => f.name === pasted)) e.preventDefault();
    addFiles(files);
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const body = text.trim();
    if (!canSend || !model) return;
    const files: AiSendFiles = { ids: queue.readyIds, attachments: queue.ready };
    setSending(true);
    setText("");
    try {
      await onSend(body, model, tools, files);
      queue.reset();
    } catch {
      setText(body); // the caller reported the error; nothing typed or attached is lost
    } finally {
      setSending(false);
      // Counted (or refused at a cap): today's usage moved either way.
      refreshAiUsageToday(qc);
      ref.current?.focus();
    }
  }

  async function stop() {
    if (!onStop || stopping) return;
    setStopping(true);
    try {
      await onStop();
    } catch {
      setStopping(false); // the caller reported the error; Stop stays available
    }
    // The Stop button gives way to Send: keep the keyboard in the composer, not on a removed button.
    ref.current?.focus({ preventScroll: true });
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape" && showStop) {
      e.preventDefault();
      void stop();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <form
      onSubmit={submit}
      data-testid="ai-composer-form"
      className={cn(
        "mx-auto grid w-full max-w-3xl gap-1.5 px-3 pb-[max(0.625rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-3",
        className,
      )}
    >
      {reached ? (
        <div
          role="status"
          data-testid="ai-limit-notice"
          data-limit={reached.kind}
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-amber-500/30 bg-amber-500/[0.07] px-3.5 py-2.5 text-[13px] leading-5 dark:border-amber-400/25 dark:bg-amber-400/[0.07]"
        >
          <span className="flex min-w-0 flex-1 basis-56 items-start gap-2">
            <Gauge aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300" />
            <span className="min-w-0 text-foreground/85">{limitNoticeText(reached)}</span>
          </span>
          {planModel ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="ai-limit-use-plan"
              onClick={() => {
                setSelected(planModel.ref);
                ref.current?.focus();
              }}
              className="ml-auto h-8 rounded-full bg-background"
            >
              Use your ChatGPT plan
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="relative rounded-[22px] border bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-12px_rgb(0_0_0/0.12)] transition-[border-color,box-shadow] focus-within:border-ring/50 dark:shadow-none">
        {canAttach && queue.items.length > 0 ? (
          <div className="px-3 pt-3">
            <AttachmentTray queue={queue} refusalOf={refusalOf} />
          </div>
        ) : null}
        <textarea
          ref={ref}
          id={AI_COMPOSER_ID}
          data-testid="ai-composer"
          rows={1}
          value={text}
          // biome-ignore lint/a11y/noAutofocus: a new chat opens ready to type, like ChatGPT and Claude.ai
          autoFocus={autoFocus}
          disabled={noModel}
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value) onTyping?.();
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={noModel ? "No model is available to you yet" : "Ask anything"}
          aria-label="Message"
          className="block max-h-[240px] min-h-[56px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-6 outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed"
        />
        <div className="flex min-w-0 items-center gap-1 px-2 pb-2">
          <ToolsMenu
            chat={chat}
            model={model}
            value={tools}
            onChange={setTools}
            finalFocus={composerElement}
          />
          {canAttach ? (
            <>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                tabIndex={-1}
                data-testid="ai-attach-file"
                onChange={(e) => {
                  addFiles(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                aria-label={`Attach files. ${readableSummary(model)}`}
                title={readableSummary(model)}
                data-testid="ai-attach-button"
                onClick={() => fileInput.current?.click()}
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/30"
              >
                <Paperclip aria-hidden className="size-[18px]" />
              </button>
            </>
          ) : null}
          {webActive ? <WebChip onRemove={() => setTools({ ...tools, web: false })} /> : null}
          {model ? (
            <ModelPicker
              chatKey={chatKey}
              value={model.ref}
              onChange={setSelected}
              finalFocus={composerElement}
            />
          ) : modelsLoading ? (
            <span className="h-4 w-24 animate-pulse rounded bg-muted" />
          ) : null}
          {showStop ? (
            <Button
              type="button"
              size="icon"
              onClick={() => void stop()}
              disabled={stopping}
              aria-label="Stop writing"
              title="Stop writing (Esc)"
              data-testid="ai-stop"
              className="ml-auto rounded-full"
            >
              {stopping ? <Spinner /> : <Square aria-hidden className="size-3.5 fill-current" />}
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon"
              disabled={!canSend}
              aria-label="Send"
              data-testid="ai-send"
              className="ml-auto rounded-full"
            >
              {sending ? <Spinner /> : <ArrowUp className="size-[18px]" />}
            </Button>
          )}
        </div>
      </div>
      {model?.group === "chatgpt_plan" ? <PlanUsageLine /> : null}
      {model && model.ref.backend !== "chatgpt_plan" && !reached ? (
        <OrgAnswersLeft left={orgAnswersLeft(today.data)} />
      ) : null}
    </form>
  );
}

/** "3 of 200 answers left today on organization models", only once the daily cap is close (05-08). */
function OrgAnswersLeft({ left }: { left: { left: number; max: number } | null }) {
  if (!left) return null;
  return (
    <p
      data-testid="ai-org-answers-left"
      className="px-3 text-center text-[11.5px] text-muted-foreground leading-5 tabular-nums"
    >
      {left.left} of {left.max} {left.max === 1 ? "answer" : "answers"} left today on organization models
    </p>
  );
}
