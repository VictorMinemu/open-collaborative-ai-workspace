"use client";

import {
  AI_TOOL_LABELS,
  type AiChatDetail,
  type AiChatTools,
  type AiModelOption,
  type AiToolKey,
  type AiToolUnavailableReason,
} from "@ocw/contracts";
import { BookOpen, Globe, Plug, Plus, Wand2, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { ControlSurface } from "@/components/work-zone/control-surface";
import { useAiModels } from "@/lib/ai-chat-queries";
import { TOOL_ORDER, TOOL_REASON_TEXT, webToolReason } from "@/lib/ai-tools";
import { cn } from "@/lib/utils";

/**
 * The composer's tools (05-11, AICHAT-06): a "+" button opens Web, Company Knowledge, MCP and Skills as switches
 * (a popover on a desktop, a bottom sheet at 390). Only Web works in Phase 5; the other three are visibly disabled
 * with "Not available yet", and a Web that cannot run says why in words (admin, role, search service, model). The
 * server re-checks everything at each answer: nothing here is trusted.
 */

const ICONS: Record<AiToolKey, typeof Globe> = {
  web: Globe,
  companyKnowledge: BookOpen,
  mcp: Plug,
  skills: Wand2,
};

const DESCRIPTIONS: Record<AiToolKey, string> = {
  web: "Search the web and cite sources",
  companyKnowledge: "Answer from your organization's documents",
  mcp: "Use your organization's MCP tools",
  skills: "Use your workspace's skills",
};

/** Where a working Web search runs: on the member's plan, or the organization's self-hosted SearXNG. */
function webWhere(model: AiModelOption | null): string | null {
  if (!model) return null;
  if (model.caps.webSearch === "hosted") return "Runs on your ChatGPT plan";
  if (model.caps.webSearch === "function") return "Self-hosted search (SearXNG) · not metered";
  return null;
}

/** The reason Web is off for this chat and model (null = it can be turned on). */
export function useWebReason(
  chat: AiChatDetail | null,
  model: AiModelOption | null,
): AiToolUnavailableReason | null {
  const models = useAiModels();
  return webToolReason(models.data?.tools, chat?.tools, model);
}

/** The four rows (no surface), shared by the composer menu and the chat settings sheet. */
export function ToolsList({
  value,
  onChange,
  webReason,
  model,
  disabled = false,
}: {
  value: AiChatTools;
  onChange: (t: AiChatTools) => void;
  webReason: AiToolUnavailableReason | null;
  model: AiModelOption | null;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label="Tools" className="grid gap-0.5 py-0.5">
      {TOOL_ORDER.map((key) => {
        const reason = key === "web" ? webReason : "not_available_yet";
        const available = reason === null;
        return (
          <ToolRow
            key={key}
            tool={key}
            checked={key === "web" && available && value.web}
            available={available}
            disabled={disabled}
            onCheckedChange={(on) => {
              if (key === "web") onChange({ ...value, web: on });
            }}
            note={
              reason ? (
                <span
                  data-testid="ai-tool-reason"
                  className={
                    reason === "not_available_yet"
                      ? "text-muted-foreground"
                      : "text-amber-700 dark:text-amber-300/90"
                  }
                >
                  {TOOL_REASON_TEXT[reason]}
                </span>
              ) : key === "web" ? (
                (webWhere(model) ?? DESCRIPTIONS.web)
              ) : (
                DESCRIPTIONS[key]
              )
            }
          />
        );
      })}
    </div>
  );
}

function ToolRow({
  tool,
  checked,
  available,
  disabled,
  onCheckedChange,
  note,
}: {
  tool: AiToolKey;
  checked: boolean;
  available: boolean;
  disabled: boolean;
  onCheckedChange: (on: boolean) => void;
  note: ReactNode;
}) {
  const Icon = ICONS[tool];
  const id = `ai-tool-${tool}`;
  return (
    <label
      htmlFor={`${id}-switch`}
      data-testid={id}
      data-available={available}
      className={cn(
        "flex min-h-14 w-full items-center gap-3 rounded-xl px-2.5 py-2 transition-colors",
        available && !disabled ? "cursor-pointer hover:bg-accent/60" : "cursor-not-allowed",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background",
          available ? "text-foreground/80" : "text-muted-foreground/60",
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span
          className={cn(
            "font-medium text-[13.5px] leading-5",
            available ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {AI_TOOL_LABELS[tool]}
        </span>
        <span className="text-pretty text-[12px] text-muted-foreground leading-4">{note}</span>
      </span>
      <Switch
        id={`${id}-switch`}
        data-surface-item
        data-testid={`${id}-switch`}
        aria-label={AI_TOOL_LABELS[tool]}
        checked={checked}
        disabled={!available || disabled}
        onCheckedChange={(on) => onCheckedChange(on)}
      />
    </label>
  );
}

/** The composer's "+" button and its surface; `value` is the next answer's tool choice. */
export function ToolsMenu({
  chat,
  model,
  value,
  onChange,
  finalFocus,
}: {
  chat: AiChatDetail | null;
  model: AiModelOption | null;
  value: AiChatTools;
  onChange: (t: AiChatTools) => void;
  /** Where focus goes when the desktop popover closes (the composer). */
  finalFocus?: () => HTMLElement | null;
}) {
  const [open, setOpen] = useState(false);
  const webReason = useWebReason(chat, model);
  return (
    <ControlSurface
      trigger={
        <button
          type="button"
          aria-label="Tools"
          title="Tools"
          data-testid="ai-tools-button"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/30 data-popup-open:bg-accent data-popup-open:text-foreground"
        >
          <Plus className="size-[18px]" />
        </button>
      }
      title="Tools"
      testId="ai-tools-menu"
      open={open}
      onOpenChange={setOpen}
      className="w-[min(22rem,calc(100vw-1.5rem))]"
      {...(finalFocus ? { finalFocus } : {})}
    >
      <ToolsList value={value} onChange={onChange} webReason={webReason} model={model} />
    </ControlSurface>
  );
}

/** The active "Web" chip next to the tools button; its × turns Web off for the next answer. */
export function WebChip({ onRemove }: { onRemove: () => void }) {
  return (
    <span
      data-testid="ai-tool-chip-web"
      className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-primary/10 pr-1 pl-2.5 font-medium text-[13px] text-primary"
    >
      <Globe aria-hidden className="size-3.5" />
      Web
      <button
        type="button"
        aria-label="Turn off web search"
        title="Turn off web search"
        onClick={onRemove}
        className="inline-flex size-6 items-center justify-center rounded-full outline-none transition-colors hover:bg-primary/15 focus-visible:ring-[3px] focus-visible:ring-ring/30"
      >
        <X className="size-3.5" />
      </button>
    </span>
  );
}
