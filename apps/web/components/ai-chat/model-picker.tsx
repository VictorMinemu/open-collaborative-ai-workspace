"use client";

import {
  type AiModelGroup,
  type AiModelOption,
  type ModelRef,
  type ModelUnavailableReason,
  modelRefKey,
} from "@ocw/contracts";
import { ArrowRight, Check, ChevronDown, Sparkles } from "lucide-react";
import { useState } from "react";
import { ControlChip, ControlSurface } from "@/components/work-zone/control-surface";
import { useAiModels } from "@/lib/ai-chat-queries";
import { cn } from "@/lib/utils";
import { ChatgptConnectDialog } from "./chatgpt-connect-dialog";
import { ChatgptWelcomeModal } from "./chatgpt-welcome-modal";

/**
 * The AI chat model picker (AICHAT-02, P-09, P-11): the composer chip opens the Work Zone control surface (a popover
 * above the chip on a desktop, a bottom sheet at 390) with three groups — the member's own ChatGPT plan, the
 * organization's models (every one METERED: billed to the organization) and the E2E mock. Rows the member cannot
 * use stay visible, disabled, with the reason in plain words. When the member's own plan can be (re)connected, the plan
 * group's row is the OpenAI-required entry point instead: "Continue with ChatGPT" / "Reconnect ChatGPT" (05-07, D-02).
 */

const REASON_TEXT: Record<ModelUnavailableReason, string> = {
  not_connected: "Not connected",
  needs_reconnect: "Sign in to ChatGPT again",
  not_eligible: "Your ChatGPT account isn't eligible here — use an organization model",
  plan_usage_disabled: "Plan usage is turned off",
  plan_disabled_by_org: "Turned off by your admin",
  org_keys_disabled: "Turned off by your admin",
  no_key: "Provider not configured",
  not_allowed: "Not allowed by your admin",
  not_in_catalog: "Not in your plan",
};

export function reasonText(reason: ModelUnavailableReason): string {
  return REASON_TEXT[reason];
}

const GROUPS: ReadonlyArray<{ group: AiModelGroup; title: string; note?: string }> = [
  { group: "chatgpt_plan", title: "Your ChatGPT plan" },
  { group: "organization", title: "Organization models", note: "METERED · billed to your organization" },
  { group: "mock", title: "Testing" },
];

/** The quiet METERED label every organization model carries (P-11). */
export function MeteredBadge({ className }: { className?: string }) {
  return (
    <span
      data-testid="ai-model-metered"
      title="Billed to your organization"
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center rounded-[5px] border border-amber-600/40 px-1 font-semibold text-[10px] text-amber-700 leading-none tracking-wide dark:border-amber-400/35 dark:text-amber-300/90",
        className,
      )}
    >
      METERED
    </span>
  );
}

/** Plan states the member fixes by signing in to ChatGPT (again): the row opens the connect dialog. */
const PLAN_ACTIONS: Partial<Record<ModelUnavailableReason, { label: string; note: string; testId: string }>> =
  {
    not_connected: {
      label: "Continue with ChatGPT",
      note: "Use your own ChatGPT plan in AI chats",
      testId: "ai-model-continue-chatgpt",
    },
    needs_reconnect: {
      label: "Reconnect ChatGPT",
      note: "Your ChatGPT sign-in expired",
      testId: "ai-model-reconnect-chatgpt",
    },
    plan_usage_disabled: {
      label: "Reconnect ChatGPT",
      note: "Allow plan usage when you sign in",
      testId: "ai-model-reconnect-chatgpt",
    },
  };

/** Secondary line of a row: why it is disabled, else the provider (and "not metered" for the mock). */
function secondary(m: AiModelOption): string {
  if (!m.available && m.reason) return reasonText(m.reason);
  return m.group === "mock" ? `${m.providerLabel} · not metered` : m.providerLabel;
}

/**
 * The grouped rows (no hooks, so it renders and unit-tests on its own). Choosing an available row calls `onChange`
 * with its `ModelRef`; disabled rows stay focusable and explain themselves.
 */
export function ModelPickerList({
  models,
  value,
  onChange,
  onConnect,
}: {
  models: AiModelOption[];
  value: ModelRef | null;
  onChange: (ref: ModelRef) => void;
  /** Opens the ChatGPT connect dialog; without it the plan's sign-in states stay disabled explanations. */
  onConnect?: () => void;
}) {
  const selectedKey = value ? modelRefKey(value) : null;
  return (
    <div role="listbox" aria-label="Models" className="grid gap-0.5 pb-1">
      {GROUPS.map(({ group, title, note }) => {
        const rows = models.filter((m) => m.group === group);
        if (rows.length === 0) return null;
        return (
          <div
            key={group}
            role="group"
            aria-label={title}
            data-testid={`ai-model-group-${group}`}
            className="grid gap-0.5 py-1 [&+&]:mt-0.5 [&+&]:border-t [&+&]:pt-1.5"
          >
            <div className="flex flex-wrap items-baseline gap-x-2 px-2.5 pt-1 pb-1">
              <span className="font-medium text-[12px] text-muted-foreground">{title}</span>
              {note ? <span className="text-[11px] text-muted-foreground/80">{note}</span> : null}
            </div>
            {rows.map((m) => {
              const key = modelRefKey(m.ref);
              const action = !m.available && m.reason && onConnect ? PLAN_ACTIONS[m.reason] : undefined;
              if (m.group === "chatgpt_plan" && action && onConnect) {
                return (
                  <button
                    key={key}
                    type="button"
                    role="option"
                    aria-selected={false}
                    data-surface-item
                    data-testid={action.testId}
                    onClick={onConnect}
                    className="flex w-full min-w-0 items-center gap-2.5 rounded-lg py-2 pr-2.5 pl-3 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/30"
                  >
                    <span
                      aria-hidden
                      className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[#10a37f] font-bold text-[9px] text-white tracking-tight"
                    >
                      GPT
                    </span>
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="truncate font-medium text-[13.5px] text-foreground leading-5">
                        {action.label}
                      </span>
                      <span className="truncate text-[12px] text-muted-foreground leading-4">
                        {action.note}
                      </span>
                    </span>
                    <ArrowRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                );
              }
              const selected = key === selectedKey;
              return (
                <button
                  key={key}
                  type="button"
                  role="option"
                  data-surface-item
                  data-testid={`ai-model-${key}`}
                  aria-selected={selected}
                  aria-disabled={!m.available}
                  onClick={() => {
                    if (m.available) onChange(m.ref);
                  }}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 rounded-lg py-2 pr-2.5 pl-3 text-left outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/30",
                    selected ? "bg-accent" : "hover:bg-accent/60",
                    !m.available && "cursor-not-allowed hover:bg-transparent",
                  )}
                >
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span
                      className={cn(
                        "flex min-w-0 items-center gap-1.5 text-[13.5px] leading-5",
                        m.available ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      <span className="truncate">{m.label}</span>
                      {m.metered ? <MeteredBadge /> : null}
                    </span>
                    <span
                      className={cn(
                        "text-[12px] text-muted-foreground leading-4",
                        // A reason may be a full sentence: it wraps instead of being cut off.
                        m.available ? "truncate" : "text-pretty break-words",
                      )}
                    >
                      {secondary(m)}
                    </span>
                  </span>
                  {selected ? <Check aria-hidden className="size-4 shrink-0 text-foreground/80" /> : null}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The composer chip (model label + METERED for organization models) and its surface. `chatKey` names the chat the
 * selection belongs to ("new" on `/chat/ai/new`); the caller owns the value (lib/ai-chat-model-store.ts).
 */
export function ModelPicker({
  chatKey,
  value,
  onChange,
  disabled = false,
  trigger = "chip",
  finalFocus,
}: {
  /** Where focus goes when the desktop popover closes (the composer in a chat); default the chip. */
  finalFocus?: () => HTMLElement | null;
  chatKey: string;
  value: ModelRef | null;
  onChange: (ref: ModelRef) => void;
  disabled?: boolean;
  trigger?: "chip" | "menu-item";
}) {
  const models = useAiModels();
  const [open, setOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const list = models.data?.models ?? [];
  const current = value ? list.find((m) => modelRefKey(m.ref) === modelRefKey(value)) : undefined;
  const label = current?.label ?? "Choose a model";

  const chip = (
    <ControlChip
      disabled={disabled || list.length === 0}
      data-testid="ai-model-chip"
      data-chat-key={chatKey}
      data-model={value ? modelRefKey(value) : ""}
      aria-label={`Model: ${label}${current?.metered ? " (metered)" : ""}`}
      title={current ? `${current.label} · ${current.providerLabel}` : undefined}
      className={cn("max-w-full text-foreground/85", trigger === "menu-item" && "w-full justify-start")}
    >
      <Sparkles aria-hidden className="size-3.5 shrink-0 text-primary" />
      <span className="truncate">{label}</span>
      {current?.metered ? <MeteredBadge /> : null}
      <ChevronDown aria-hidden className="size-3.5 shrink-0 opacity-70" />
    </ControlChip>
  );

  return (
    <>
      <ControlSurface
        trigger={chip}
        title="Model"
        testId="ai-model-picker"
        open={open}
        onOpenChange={setOpen}
        className="w-[min(21rem,calc(100vw-1.5rem))]"
        {...(finalFocus ? { finalFocus } : {})}
      >
        <ModelPickerList
          models={list}
          value={value}
          onChange={(ref) => {
            setOpen(false);
            onChange(ref);
          }}
          onConnect={() => {
            setOpen(false);
            setConnectOpen(true);
          }}
        />
      </ControlSurface>
      <ChatgptConnectDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        onConnected={(status) => {
          if (status.state === "connected" && !status.welcomeSeen) setWelcomeOpen(true);
        }}
      />
      <ChatgptWelcomeModal open={welcomeOpen} onDone={() => setWelcomeOpen(false)} />
    </>
  );
}
