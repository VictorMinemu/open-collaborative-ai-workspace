"use client";

import type { WorkApproval, WorkPrompt, WorkSession } from "@ocw/contracts";
import {
  Check,
  ChevronRight,
  CircleAlert,
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
import { UserAvatar } from "@/components/ui/avatar";
import { Spinner } from "@/components/ui/spinner";
import type { LiveSession } from "@/lib/use-live-session";
import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";
import { RUNTIMES, RuntimeLogo } from "./meta";

type Item =
  | { kind: "prompt"; key: string; prompt: WorkPrompt | undefined; pending?: boolean }
  | { kind: "assistant"; key: string; text: string; streaming?: boolean }
  | {
      kind: "tool";
      key: string;
      name: string;
      summary: string;
      done: { ok: boolean; summary: string; output?: string | undefined } | null;
    }
  | { kind: "approval"; key: string; approval: WorkApproval | undefined; tool: string; summary: string }
  | { kind: "turn"; key: string; label: string; tone: "ok" | "warn" | "error" }
  | { kind: "system"; key: string; text: string }
  | { kind: "error"; key: string; message: string };

function buildItems(state: LiveSession): Item[] {
  const prompts = new Map(state.prompts.map((p) => [p.id, p]));
  const approvals = new Map(state.approvals.map((a) => [a.id, a]));
  const items: Item[] = [];
  const tools = new Map<string, Extract<Item, { kind: "tool" }>>();
  const started = new Set<string>();
  const finals = new Set<string>();

  for (const { seq, event: e } of state.events) {
    const key = `e${seq}`;
    switch (e.type) {
      case "session.started":
        items.push({
          kind: "system",
          key,
          text: `Session started${e.runtimeVersion ? ` · ${e.runtimeVersion}` : ""}${e.model ? ` · ${e.model}` : ""}`,
        });
        break;
      case "prompt.started":
        started.add(e.promptId);
        items.push({ kind: "prompt", key, prompt: prompts.get(e.promptId) });
        break;
      case "assistant.message":
        finals.add(e.messageId);
        if (e.text.trim()) items.push({ kind: "assistant", key, text: e.text });
        break;
      case "tool.started": {
        const t: Extract<Item, { kind: "tool" }> = {
          kind: "tool",
          key,
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
        else items.push({ kind: "tool", key, name: "Tool", summary: e.summary, done });
        break;
      }
      case "approval.requested":
        items.push({
          kind: "approval",
          key,
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
        items.push({ kind: "turn", key, label, tone: e.interrupted ? "warn" : e.isError ? "error" : "ok" });
        break;
      }
      case "session.error":
        items.push({ kind: "error", key, message: e.message });
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

export function EventStream({ state, session }: { state: LiveSession; session: WorkSession }) {
  const items = buildItems(state);
  const busy = session.status === "running" || session.status === "provisioning";
  const lastIsStreaming =
    items.at(-1)?.kind === "assistant" && (items.at(-1) as { streaming?: boolean }).streaming;

  return (
    <div
      data-testid="event-stream"
      className="mx-auto grid w-full max-w-3xl grid-cols-[minmax(0,1fr)] gap-4 px-4 py-6 sm:px-6"
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
      {items.map((item) => (
        <StreamItem key={item.key} item={item} session={session} />
      ))}
      {busy && !lastIsStreaming ? (
        <div className="flex items-center gap-2.5 pl-0.5 text-muted-foreground text-sm" data-testid="working">
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

function StreamItem({ item, session }: { item: Item; session: WorkSession }) {
  switch (item.kind) {
    case "prompt": {
      const p = item.prompt;
      const name = p?.authorName ?? "Someone";
      return (
        <div className="flex gap-3" data-testid="prompt-bubble">
          <UserAvatar name={name} seed={p?.authorUserId} className="mt-0.5 size-7" />
          <div className="min-w-0 flex-1">
            <p className="mb-1 flex items-center gap-2 text-muted-foreground text-xs">
              <span className="font-medium text-foreground">{name}</span>
              {p
                ? new Date(p.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                : null}
              {item.pending ? (
                <span className="inline-flex items-center gap-1">
                  <Spinner className="size-3" /> sending to {session.deviceName}
                </span>
              ) : null}
            </p>
            <div className="whitespace-pre-wrap break-words rounded-2xl rounded-tl-md bg-muted px-3.5 py-2.5 text-[14px] leading-relaxed">
              {p?.body ?? "…"}
            </div>
          </div>
        </div>
      );
    }
    case "assistant":
      return (
        <div className="flex gap-3" data-testid="assistant-message">
          <RuntimeLogo runtime={session.runtime} className="mt-0.5 size-7 rounded-lg" />
          <div className="min-w-0 flex-1 pt-0.5">
            <Markdown text={item.text} />
            {item.streaming ? (
              <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-primary/70" />
            ) : null}
          </div>
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
    <div className="ml-10 overflow-hidden rounded-lg border bg-card" data-testid="tool-card">
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
        "ml-10 flex items-center gap-2 rounded-lg border px-3 py-2 text-[13px]",
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
