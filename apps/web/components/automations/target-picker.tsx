"use client";

import type { AutomationTargetOptions } from "@ocw/contracts";
import { Hash, MessageSquare, SquareKanban } from "lucide-react";
import { CategoryIcon } from "@/components/chat/board/column-header";
import { describedBy, FormField } from "@/components/ui/form-field";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { useTargetOptions } from "@/lib/automation-queries";
import { cn } from "@/lib/utils";

/** The editor's delivery target (channel, a board's column, the run-as person's DM; a thread kept from a proposal). */
export interface TargetValue {
  kind: "channel" | "board" | "dm" | "thread";
  conversationId: string;
  columnId: string;
  threadRootMessageId: string;
  /** The server's label of a stored target (`#sales`, `Thread in #sales`), shown until the options load. */
  label: string;
}

export const EMPTY_TARGET: TargetValue = {
  kind: "channel",
  conversationId: "",
  columnId: "",
  threadRootMessageId: "",
  label: "",
};

export type TargetErrors = Partial<Record<"conversation" | "column", string>>;

type Conversation = AutomationTargetOptions["conversations"][number];

/** "#sales · Scout isn't a member" / "· you can't post here": a disabled option keeps its reason in its text. */
export function conversationOptionLabel(c: Conversation, bot: string): string {
  const name = c.layout === "board" ? c.name : `#${c.name}`;
  if (c.disabledReason === "agent_not_member") return `${name} · ${bot} isn't a member`;
  if (c.disabledReason === "target_not_postable") return `${name} · you can't post here`;
  return name;
}

const KINDS = [
  { kind: "channel", label: "Channel", icon: Hash },
  { kind: "board", label: "Board", icon: SquareKanban },
  { kind: "dm", label: "Direct message", icon: MessageSquare },
] as const;

const TOUCH = "max-md:h-11";

/**
 * Deliver to (07.6-15, D-07, R2, UI-SPEC Surface 2): Channel · Board · Direct message as radio cards (the 07.4
 * Transport markup). Channels and boards come from the API's target options for the chosen bot, where an option the
 * bot or the person cannot use stays listed, disabled, with its reason in its text. A personal bot delivers only to the
 * person's DM, so Channel and Board are disabled and say why.
 */
export function TargetPicker({
  agent,
  value,
  onChange,
  errors,
  disabled,
}: {
  agent: { id: string; displayName: string; personal: boolean } | null;
  value: TargetValue;
  onChange: (next: TargetValue) => void;
  errors: TargetErrors;
  disabled?: boolean;
}) {
  const options = useTargetOptions(disabled ? null : (agent?.id ?? null));
  const bot = agent?.displayName ?? "The bot";
  const all = options.data?.conversations ?? [];
  const channels = all.filter((c) => c.layout === "text");
  const boards = all.filter((c) => c.layout === "board");
  const selectedKind = value.kind === "thread" ? "channel" : value.kind;
  const board = boards.find((b) => b.conversationId === value.conversationId) ?? null;
  const column = board?.columns.find((c) => c.id === value.columnId) ?? null;
  const loading = !disabled && !!agent && options.isPending;
  const id = (k: string) => `automation-target-${k}`;

  const pick = (kind: TargetValue["kind"]) => {
    if (kind === selectedKind) return;
    onChange({ ...EMPTY_TARGET, kind });
  };

  /** The stored target while the options load (or for a read-only viewer, who gets no options). */
  const storedLabel = value.label || null;

  return (
    <div className="grid gap-4" data-testid="target-picker">
      <fieldset className="grid gap-2">
        <legend className="sr-only">Deliver to</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {KINDS.map((k) => {
            const selected = selectedKind === k.kind;
            const personalBlocked = !!agent?.personal && k.kind !== "dm";
            const off = disabled || personalBlocked;
            const Icon = k.icon;
            return (
              <label
                key={k.kind}
                data-testid={`target-kind-${k.kind}`}
                className={cn(
                  "flex cursor-pointer items-start gap-2.5 rounded-lg border bg-card p-2.5 transition-colors max-md:min-h-11 sm:flex-col sm:gap-1",
                  selected && "border-primary/50 bg-brand-soft/40 ring-1 ring-primary/30",
                  off && "cursor-not-allowed opacity-60",
                  "has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/40",
                )}
              >
                <input
                  type="radio"
                  name="automation-target-kind"
                  value={k.kind}
                  checked={selected}
                  disabled={off}
                  onChange={() => pick(k.kind)}
                  className="mt-0.5 size-4 shrink-0 accent-primary sm:sr-only"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 font-medium text-[13px]">
                    <Icon className="size-3.5 text-muted-foreground" aria-hidden />
                    {k.label}
                  </span>
                  {personalBlocked ? (
                    <span className="block text-[11.5px] text-muted-foreground leading-snug">
                      Personal bots deliver only to your DMs.
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {selectedKind === "channel" ? (
        <FormField
          id={id("channel")}
          label="Channel"
          hint={
            value.kind === "thread"
              ? `Each run replies in a thread of ${storedLabel?.replace(/^Thread in /, "") ?? "the channel"}; ${bot} answers in it.`
              : `Each run starts a thread; ${bot} answers in it.`
          }
          error={errors.conversation}
        >
          <ConversationSelect
            id={id("channel")}
            testId="target-channel"
            list={channels}
            bot={bot}
            value={value.conversationId}
            placeholder={loading ? "Loading channels…" : (storedLabel ?? "Pick a channel")}
            loading={loading}
            disabled={disabled || !agent}
            error={errors.conversation}
            onChange={(conversationId) =>
              onChange({ ...EMPTY_TARGET, kind: "channel", conversationId, label: "" })
            }
          />
        </FormField>
      ) : null}

      {selectedKind === "board" ? (
        <>
          <FormField id={id("board")} label="Board" error={errors.conversation}>
            <ConversationSelect
              id={id("board")}
              testId="target-board"
              list={boards}
              bot={bot}
              value={value.conversationId}
              placeholder={loading ? "Loading boards…" : (storedLabel?.split(" · ")[0] ?? "Pick a board")}
              loading={loading}
              disabled={disabled || !agent}
              error={errors.conversation}
              onChange={(conversationId) => {
                const b = boards.find((x) => x.conversationId === conversationId);
                onChange({
                  ...EMPTY_TARGET,
                  kind: "board",
                  conversationId,
                  columnId: b?.columns[0]?.id ?? "",
                });
              }}
            />
          </FormField>
          <FormField
            id={id("column")}
            label="Column"
            hint={
              column ? `Each run adds a card to ${column.name}; ${bot} answers in its thread.` : undefined
            }
            error={errors.column}
          >
            <Select
              items={(board?.columns ?? []).map((c) => ({ value: c.id, label: c.name }))}
              value={value.columnId || null}
              onValueChange={(v) => v && onChange({ ...value, columnId: String(v), label: "" })}
              disabled={disabled || !board}
            >
              <SelectTrigger
                id={id("column")}
                data-testid="target-column"
                placeholder={storedLabel?.split(" · ")[1] ?? "Pick a column"}
                aria-invalid={!!errors.column}
                aria-describedby={describedBy(id("column"), errors.column)}
                className={TOUCH}
              />
              <SelectContent>
                {(board?.columns ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id} className="max-md:min-h-11">
                    <span className="flex items-center gap-2">
                      <CategoryIcon category={c.category} decorative />
                      {c.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </>
      ) : null}

      {selectedKind === "dm" ? (
        <p className="text-[13px] text-muted-foreground" data-testid="target-dm">
          Delivered in your direct messages with {bot}.
        </p>
      ) : null}
    </div>
  );
}

function ConversationSelect({
  id,
  testId,
  list,
  bot,
  value,
  placeholder,
  loading,
  disabled,
  error,
  onChange,
}: {
  id: string;
  testId: string;
  list: Conversation[];
  bot: string;
  value: string;
  placeholder: string;
  loading: boolean;
  disabled: boolean;
  error: string | undefined;
  onChange: (conversationId: string) => void;
}) {
  return (
    <div className="relative">
      <Select
        items={list.map((c) => ({ value: c.conversationId, label: conversationOptionLabel(c, bot) }))}
        value={list.some((c) => c.conversationId === value) ? value : null}
        onValueChange={(v) => v && onChange(String(v))}
        disabled={disabled || loading}
      >
        <SelectTrigger
          id={id}
          data-testid={testId}
          placeholder={placeholder}
          aria-invalid={!!error}
          aria-describedby={describedBy(id, error)}
          className={TOUCH}
        />
        <SelectContent>
          {list.length === 0 ? (
            <p className="px-2 py-1.5 text-muted-foreground text-sm">Nothing here yet</p>
          ) : (
            list.map((c) => (
              <SelectItem
                key={c.conversationId}
                value={c.conversationId}
                disabled={c.disabledReason !== null}
                data-testid={`${testId}-option`}
                className="max-md:min-h-11"
              >
                {conversationOptionLabel(c, bot)}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
      {loading ? <Spinner className="absolute top-1/2 right-9 size-3.5 -translate-y-1/2" /> : null}
    </div>
  );
}
