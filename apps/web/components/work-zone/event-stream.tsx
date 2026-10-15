"use client";

import type { WorkApproval, WorkPrompt, WorkSession } from "@ocw/contracts";
import {
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  FilePen,
  FileText,
  Globe,
  Hand,
  ListTodo,
  Search,
  ShieldCheck,
  ShieldX,
  Sparkles,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { MessageAttachments } from "@/components/chat/attachments/attachment-grid";
import { Lightbox } from "@/components/chat/attachments/lightbox";
import { UserAvatar } from "@/components/ui/avatar";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { useCopy } from "@/hooks/use-copy";
import type { LiveSession } from "@/lib/use-live-session";
import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";
import { RUNTIMES, RuntimeLogo } from "./meta";
import { ProposedByLine } from "./proposed-by-line";
import { groupTurns, type Turn, TurnSummary } from "./turn-summary";

/** One rendered stream entry. `at` is the event time (absent for live text and prompts not started yet). */
export type Item = { key: string; at?: string } & (
  | { kind: "prompt"; prompt: WorkPrompt | undefined; promptId?: string; pending?: boolean }
  | { kind: "assistant"; text: string; streaming?: boolean }
  | {
      kind: "tool";
      name: string;
      summary: string;
      done: { ok: boolean; summary: string; output?: string | undefined } | null;
    }
  | { kind: "approval"; approval: WorkApproval | undefined; tool: string; summary: string }
  | {
      kind: "turn";
      promptId: string;
      label: string;
      tone: "ok" | "warn" | "error";
      tokens: string | null;
    }
  | { kind: "system"; text: string }
  | { kind: "error"; message: string }
);

export function buildItems(state: LiveSession): Item[] {
  const prompts = new Map(state.prompts.map((p) => [p.id, p]));
  const approvals = new Map(state.approvals.map((a) => [a.id, a]));
  const items: Item[] = [];
  const tools = new Map<string, Extract<Item, { kind: "tool" }>>();
  const started = new Set<string>();
  const finals = new Set<string>();

  for (const { seq, at, event: e } of state.events) {
    const key = `e${seq}`;
    switch (e.type) {
      case "session.started":
        items.push({
          kind: "system",
          key,
          at,
          text: `Session started${e.runtimeVersion ? ` · ${e.runtimeVersion}` : ""}${e.model ? ` · ${e.model}` : ""}`,
        });
        break;
      case "prompt.started":
        started.add(e.promptId);
        items.push({ kind: "prompt", key, at, promptId: e.promptId, prompt: prompts.get(e.promptId) });
        break;
      case "assistant.message":
        finals.add(e.messageId);
        if (e.text.trim()) items.push({ kind: "assistant", key, at, text: e.text });
        break;
      case "tool.started": {
        const t: Extract<Item, { kind: "tool" }> = {
          kind: "tool",
          key,
          at,
          name: e.name,
          summary: e.summary,
          done: null,
        };
        tools.set(e.toolUseId, t);
        items.push(t);
        break;
      }
      case "tool.completed": {
        const t = tools.get(e.toolUseId);
        const done = { ok: e.ok, summary: e.summary, output: e.output };
        if (t) t.done = done;
        else items.push({ kind: "tool", key, at, name: "Tool", summary: e.summary, done });
        break;
      }
      case "approval.requested":
        items.push({
          kind: "approval",
          key,
          at,
          approval: approvals.get(e.approvalId),
          tool: e.tool,
          summary: e.summary,
        });
        break;
      case "prompt.completed": {
        const tokens = e.usage.inputTokens + e.usage.outputTokens;
        const label = e.interrupted
          ? "Interrupted"
          : e.isError
            ? "Turn failed"
            : `Turn finished${tokens > 0 ? ` · ${formatTokens(tokens)} tokens` : ""}`;
        items.push({
          kind: "turn",
          key,
          at,
          promptId: e.promptId,
          label,
          tone: e.interrupted ? "warn" : e.isError ? "error" : "ok",
          tokens: tokens > 0 ? formatTokens(tokens) : null,
        });
        break;
      }
      case "session.error":
        items.push({ kind: "error", key, at, message: e.message });
        break;
      default:
        break;
    }
  }
  // Prompts handed to the device that have not started yet.
  for (const p of state.prompts) {
    if ((p.status === "dispatched" || p.status === "running") && !started.has(p.id)) {
      items.push({ kind: "prompt", key: `p${p.id}`, prompt: p, pending: true });
    }
  }
  for (const [id, text] of Object.entries(state.streaming)) {
    if (!finals.has(id) && text) items.push({ kind: "assistant", key: `s${id}`, text, streaming: true });
  }
  return items;
}

function formatTokens(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

const TOOL_ICONS: Array<[RegExp, typeof Wrench]> = [
  [/^(read|view|notebookread)$/i, FileText],
  [/^(write|edit|multiedit|notebookedit|apply_patch|filechange)$/i, FilePen],
  [/^(bash|shell|command|exec|commandexecution)/i, Terminal],
  [/^(grep|glob|search|ls|find)/i, Search],
  [/^(webfetch|websearch)/i, Globe],
  [/^(todowrite|task)/i, ListTodo],
];

/** Runtimes often prefix the summary with the tool name ("Read README.md"); the card already shows it. */
function stripToolName(name: string, summary: string): string {
  return summary.startsWith(`${name} `) ? summary.slice(name.length + 1) : summary;
}

function toolIcon(name: string) {
  return TOOL_ICONS.find(([re]) => re.test(name))?.[1] ?? Wrench;
}

export function EventStream({
  state,
  session,
  changesCard,
}: {
  state: LiveSession;
  session: WorkSession;
  /** The "N changed files · Open diff" card, shown after the latest completed turn (ref-4). */
  changesCard?: ReactNode;
}) {
  const items = buildItems(state);
  const turns = groupTurns(items, state.prompts);
  const busy = session.status === "running" || session.status === "provisioning";
  const lastIsStreaming =
    items.at(-1)?.kind === "assistant" && (items.at(-1) as { streaming?: boolean }).streaming;
  const latestDone = turns.findLastIndex((t) => t.promptId !== null && t.done);

  return (
    <div
      data-testid="event-stream"
      className="mx-auto grid w-full max-w-3xl grid-cols-[minmax(0,1fr)] gap-5 px-4 py-6 sm:px-6 sm:py-8"
    >
      {items.length === 0 && !busy ? (
        <div className="rounded-xl border border-dashed px-6 py-10 text-center">
          <Sparkles className="mx-auto mb-3 size-5 text-primary" />
          <p className="font-medium text-sm">Ready when you are</p>
          <p className="mt-1 text-muted-foreground text-sm">
            Write a prompt below. Anyone in the workspace can add to the queue.
          </p>
        </div>
      ) : null}
      {turns.map((turn, i) =>
        turn.promptId === null ? (
          turn.items.map((item) => <StreamItem key={item.key} item={item} session={session} />)
        ) : (
          <TurnBlock
            key={turn.prompt?.key ?? turn.promptId}
            turn={turn}
            session={session}
            changesCard={i === latestDone ? changesCard : null}
          />
        ),
      )}
      {busy && !lastIsStreaming ? (
        <div className="flex items-center gap-2.5 text-muted-foreground text-sm" data-testid="working">
          <RuntimeLogo runtime={session.runtime} className="size-6 rounded-md" />
          <span className="animate-pulse">
            {session.status === "provisioning"
              ? `Starting ${RUNTIMES[session.runtime].label} on ${session.deviceName}…`
              : `${RUNTIMES[session.runtime].label} is working…`}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** A turn of ref-4: prompt bubble, then the work (collapsed once done), the final message and its footer. */
function TurnBlock({
  turn,
  session,
  changesCard,
}: {
  turn: Turn;
  session: WorkSession;
  changesCard: ReactNode;
}) {
  const work = (
    <TurnItems items={turn.items.filter((i) => i.kind !== "error")} session={session} running={!turn.done} />
  );
  const errors = turn.items.filter((i) => i.kind === "error");
  return (
    <section
      className="grid grid-cols-[minmax(0,1fr)] gap-4"
      data-turn={turn.promptId}
      data-turn-running={turn.done ? undefined : ""}
    >
      {turn.prompt ? <StreamItem item={turn.prompt} session={session} /> : null}
      {turn.done ? (
        <TurnSummary turn={turn} session={session}>
          {work}
        </TurnSummary>
      ) : (
        work
      )}
      {turn.done ? errors.map((item) => <StreamItem key={item.key} item={item} session={session} />) : null}
      {turn.finalMessage ? <StreamItem item={turn.finalMessage} session={session} /> : null}
      {changesCard}
      {turn.finalMessage ? <MessageFooter item={turn.finalMessage} /> : null}
    </section>
  );
}

/** A turn's items with consecutive tool calls (and their approvals) grouped behind one row. */
function TurnItems({ items, session, running }: { items: Item[]; session: WorkSession; running: boolean }) {
  const out: ReactNode[] = [];
  let run: Item[] = [];
  const flush = () => {
    const tools = run.filter((i) => i.kind === "tool").length;
    if (run.length > 1 && tools > 1) {
      out.push(
        <ToolGroup
          key={`g-${run[0]?.key}`}
          items={run}
          tools={tools}
          defaultOpen={running}
          session={session}
        />,
      );
    } else {
      for (const item of run) out.push(<StreamItem key={item.key} item={item} session={session} />);
    }
    run = [];
  };
  for (const item of items) {
    if (item.kind === "tool" || item.kind === "approval") {
      run.push(item);
      continue;
    }
    flush();
    out.push(<StreamItem key={item.key} item={item} session={session} />);
  }
  flush();
  return <>{out}</>;
}

function ToolGroup({
  items,
  tools,
  defaultOpen,
  session,
}: {
  items: Item[];
  tools: number;
  defaultOpen: boolean;
  session: WorkSession;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const approvals = items.length - tools;
  const pending = items.some(
    (i) => (i.kind === "tool" && !i.done) || (i.kind === "approval" && i.approval?.status === "pending"),
  );
  return (
    <div data-testid="tool-group" className="grid grid-cols-[minmax(0,1fr)] gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-fit items-center gap-2 rounded-md py-0.5 text-[13.5px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
      >
        {pending ? <Spinner className="size-3.5" /> : <Wrench aria-hidden className="size-3.5" />}
        <span>
          {tools} tool calls
          {approvals > 0 ? ` · ${approvals} approval${approvals === 1 ? "" : "s"}` : ""}
        </span>
        <ChevronRight aria-hidden className={cn("size-3.5 transition-transform", open && "rotate-90")} />
      </button>
      <div hidden={!open} className={cn("grid-cols-[minmax(0,1fr)] gap-2 pl-5", open ? "grid" : "hidden")}>
        {items.map((item) => (
          <StreamItem key={item.key} item={item} session={session} />
        ))}
      </div>
    </div>
  );
}

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** Copy + time under a turn's final message (ref-4). */
function MessageFooter({ item }: { item: Extract<Item, { kind: "assistant" }> }) {
  const { copy, copied } = useCopy();
  return (
    <div className="-mt-1 flex items-center gap-2 text-[12.5px] text-muted-foreground">
      <Tooltip content={copied ? "Copied" : "Copy message"}>
        <button
          type="button"
          data-testid="copy-message"
          aria-label="Copy message"
          onClick={() => void copy(item.text)}
          className="inline-flex size-7 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground"
        >
          {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
        </button>
      </Tooltip>
      {item.at ? (
        <time data-testid="message-time" dateTime={item.at} className="tabular-nums">
          {hhmm(item.at)}
        </time>
      ) : null}
    </div>
  );
}

/**
 * A prompt in the stream: author, time and text, with its images above the text (06.1, WZ-IMG-04) as in Phase 4
 * messages, right-aligned; a click opens the large rendition. Every controller gets the same bubble live.
 */
function PromptBubble({ item, session }: { item: Extract<Item, { kind: "prompt" }>; session: WorkSession }) {
  const [open, setOpen] = useState<number | null>(null);
  const p = item.prompt;
  const name = p?.authorName ?? "Someone";
  const attachments = p?.attachments ?? [];
  const images = attachments.filter((a) => a.isImage && a.previewUrl);
  // Multiplayer attribution stays on every prompt (an intentional difference from ref-4).
  return (
    <div className="flex flex-col items-end gap-1.5 pl-8 sm:pl-20" data-testid="prompt-bubble">
      <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
        {item.pending ? (
          <span className="inline-flex items-center gap-1">
            <Spinner className="size-3" /> sending to {session.deviceName}
          </span>
        ) : null}
        {p ? <span className="tabular-nums">{hhmm(p.createdAt)}</span> : null}
        <span className="font-medium text-foreground">{name}</span>
        {p?.proposedBy ? <ProposedByLine agent={p.proposedBy} /> : null}
        <UserAvatar name={name} seed={p?.authorUserId} className="size-5 text-[9px]" />
      </p>
      {attachments.length > 0 ? (
        <MessageAttachments
          attachments={attachments}
          onOpenImage={setOpen}
          className="mt-0 w-full items-end"
        />
      ) : null}
      <div className="max-w-full whitespace-pre-wrap break-words rounded-2xl bg-muted px-3.5 py-2.5 text-[14.5px] leading-relaxed">
        {p?.body ?? "…"}
      </div>
      {open !== null && images.length > 0 ? (
        <Lightbox images={images} index={open} onClose={() => setOpen(null)} />
      ) : null}
    </div>
  );
}

function StreamItem({ item, session }: { item: Item; session: WorkSession }) {
  switch (item.kind) {
    case "prompt":
      return <PromptBubble item={item} session={session} />;
    case "assistant":
      return (
        <div className="min-w-0 text-[14.5px]" data-testid="assistant-message">
          <Markdown text={item.text} streaming={item.streaming} />
          {item.streaming ? (
            <span
              data-testid="streaming-caret"
              className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-primary/70"
            />
          ) : null}
        </div>
      );
    case "tool":
      return <ToolCard item={item} />;
    case "approval":
      return <ApprovalLine item={item} />;
    case "turn":
      return (
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          <span
            className={cn(
              "inline-flex items-center gap-1",
              item.tone === "warn" && "text-warning",
              item.tone === "error" && "text-destructive",
            )}
          >
            {item.tone === "ok" ? <Check className="size-3" /> : <CircleAlert className="size-3" />}
            {item.label}
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>
      );
    case "system":
      return <p className="text-center text-[11px] text-muted-foreground">{item.text}</p>;
    case "error":
      return (
        <div className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-destructive text-sm">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-words">{item.message}</span>
        </div>
      );
  }
}

function ToolCard({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(item.name);
  const output = item.done?.output;
  const status: ReactNode = !item.done ? (
    <Spinner className="size-3.5" />
  ) : item.done.ok ? (
    <Check className="size-3.5 text-success" />
  ) : (
    <X className="size-3.5 text-destructive" />
  );
  return (
    <div className="overflow-hidden rounded-lg border bg-card" data-testid="tool-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-accent/40"
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Icon className="size-3.5" />
        </span>
        <span className="shrink-0 font-medium text-[13px]">{item.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">
          {stripToolName(item.name, item.summary || item.done?.summary || "")}
        </span>
        {status}
        <ChevronRight
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
      </button>
      {open ? (
        <div className="border-t bg-muted/30 px-3 py-2">
          <p className="mb-1.5 whitespace-pre-wrap break-words font-mono text-[12px] text-muted-foreground">
            {item.summary}
          </p>
          {output ? (
            <pre className="scrollbar-thin max-h-72 overflow-auto rounded-md bg-background p-2.5 font-mono text-[12px] leading-relaxed dark:bg-black/30">
              {output.length > 8000 ? `${output.slice(0, 8000)}\n…` : output}
            </pre>
          ) : (
            <p className="text-muted-foreground text-xs">{item.done ? "No output" : "Running…"}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ApprovalLine({ item }: { item: Extract<Item, { kind: "approval" }> }) {
  const a = item.approval;
  const status = a?.status ?? "pending";
  const who = a?.decidedByName ?? (status === "expired" ? null : "the device");
  const text =
    status === "pending"
      ? `Waiting for approval to use ${item.tool}`
      : status === "approved"
        ? `${item.tool} approved ${a?.decision === "session" ? "for this session" : "once"}${who ? ` by ${who}` : ""}`
        : status === "denied"
          ? `${item.tool} denied${who ? ` by ${who}` : ""}${a?.comment ? ` — “${a.comment}”` : ""}`
          : `${item.tool} request expired`;
  const Icon = status === "pending" ? Hand : status === "approved" ? ShieldCheck : ShieldX;
  return (
    <div
      data-testid="approval-line"
      data-status={status}
      className={cn(
        "flex items-center gap-2 rounded-lg border px-3 py-2 text-[13px]",
        status === "pending" && "border-warning/40 bg-warning/8",
        status === "approved" && "border-success/30 bg-success/6",
        (status === "denied" || status === "expired") && "border-destructive/25 bg-destructive/6",
      )}
    >
      <Icon
        className={cn(
          "size-4 shrink-0",
          status === "pending" && "text-warning",
          status === "approved" && "text-success",
          (status === "denied" || status === "expired") && "text-destructive",
        )}
      />
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <span className="hidden max-w-[40%] truncate font-mono text-[11.5px] text-muted-foreground sm:inline">
        {item.summary.split("\n")[0]}
      </span>
    </div>
  );
}
