import type {
  ControlOption,
  PermissionMode,
  PermissionModeControl,
  RuntimeId,
  WorkSessionStatus,
} from "@ocw/contracts";
import { PERMISSION_MODE_RANK } from "@ocw/contracts";
import {
  Archive,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CloudOff,
  Hand,
  ListChecks,
  Loader,
  Lock,
  LockOpen,
  type LucideIcon,
  Pencil,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";

export const RUNTIMES: Record<
  RuntimeId,
  {
    label: string;
    /** Provider name under each model row of the picker (ref-3: "Claude"). */
    provider: string;
    vendor: string;
    subscription: string;
  }
> = {
  "claude-code": {
    label: "Claude Code",
    provider: "Claude",
    vendor: "Anthropic",
    subscription: "Uses your Claude subscription on this device",
  },
  codex: {
    label: "Codex",
    provider: "Codex",
    vendor: "OpenAI",
    subscription: "Uses your ChatGPT subscription on this device",
  },
};

/**
 * Permission modes in the order of the owner's reference (ref-1) plus Plan (D-12). Labels per P-03, one-line
 * descriptions per ref-1. Full access carries the warning tone (D-04).
 */
export const PERMISSION_MODES: Array<{
  value: PermissionMode;
  label: string;
  hint: string;
  icon: LucideIcon;
  tone?: "warning";
}> = [
  { value: "default", label: "Supervised", hint: "Ask before commands and file changes.", icon: Lock },
  {
    value: "acceptEdits",
    label: "Auto-accept edits",
    hint: "Auto-approve edits, ask before other actions.",
    icon: Pencil,
  },
  {
    value: "auto",
    label: "Auto",
    hint: "Supported providers approve routine actions; others still ask.",
    icon: Sparkles,
  },
  {
    value: "fullAccess",
    label: "Full access",
    hint: "Allow commands and edits without prompts.",
    icon: LockOpen,
    tone: "warning",
  },
  { value: "plan", label: "Plan", hint: "Read-only: proposes a plan, changes nothing.", icon: ListChecks },
];

export const permissionModeMeta = (mode: string) => PERMISSION_MODES.find((m) => m.value === mode);

/** What a runtime-reported reason code means, in words (D-11). Unknown codes stay as the runtime wrote them. */
const RUNTIME_DETAIL_TEXT: Record<string, string> = {
  extra_usage_disabled: "Needs paid usage credits",
  model_not_allowed: "Not available for this model",
  sdk_opt_in_required: "Not turned on for this runtime",
};

/**
 * Why an option is unavailable, in one sentence (P-08). One place for every composer menu and the New session
 * dialog. `not_confirmed` returns null: such options are hidden, never shown (WZC-06).
 */
export function controlReasonText(
  option: Pick<ControlOption, "reason" | "detail">,
  ctx: { runtime: RuntimeId; modes?: PermissionModeControl[] },
): string | null {
  switch (option.reason) {
    case null:
      return null;
    case "org_policy":
      return "Not allowed by your organization";
    case "device_opt_in":
      return "Full access is off on this device. Its owner can turn it on in the desktop app.";
    case "device_grant": {
      const top = (ctx.modes ?? [])
        .filter((m) => m.available)
        .sort((a, b) => PERMISSION_MODE_RANK[b.value] - PERMISSION_MODE_RANK[a.value])[0];
      return top
        ? `Your access to this device allows up to ${permissionModeMeta(top.value)?.label ?? top.value}`
        : "Your access to this device does not allow this";
    }
    case "denied_for_you":
      return "Not allowed for you";
    case "runtime": {
      const detail = option.detail ? (RUNTIME_DETAIL_TEXT[option.detail] ?? option.detail) : null;
      return detail ?? `${RUNTIMES[ctx.runtime].label} does not offer this here`;
    }
    case "not_in_catalog":
      return "Not reported by this device";
    case "not_confirmed":
      return null;
    case "bot_profile":
      return "Above this bot's Work Zone profile";
    default:
      return null;
  }
}

/** The option exists for this caller (possibly disabled); `not_confirmed` options are never shown. */
export const isShown = (option: Pick<ControlOption, "reason">) => option.reason !== "not_confirmed";

/** "200k" | "1M" (D-10). */
export function contextWindowLabel(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1000)}k`;
}

export const STATUS: Record<
  WorkSessionStatus,
  { label: string; icon: LucideIcon; tone: string; dot: string; spin?: boolean }
> = {
  provisioning: {
    label: "Starting",
    icon: Loader,
    tone: "text-muted-foreground bg-muted",
    dot: "bg-muted-foreground",
    spin: true,
  },
  idle: {
    label: "Ready",
    icon: CircleCheck,
    // The Badge success pill (AA in both themes); the semantic token on its own tint measured 2.5:1 (07.9-11, as #197).
    tone: "bg-emerald-100 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-300",
    dot: "bg-success",
  },
  running: {
    label: "Working",
    icon: Loader,
    tone: "text-primary bg-primary/12",
    dot: "bg-primary",
    spin: true,
  },
  waiting_approval: {
    label: "Needs approval",
    icon: Hand,
    // The Badge warning pill (AA in both themes); the semantic token on its own tint measured 1.9:1 (WINDOWS #197).
    tone: "bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
    dot: "bg-warning",
  },
  host_offline: {
    label: "Device offline",
    icon: CloudOff,
    tone: "text-muted-foreground bg-muted",
    dot: "bg-muted-foreground/60",
  },
  completed: {
    label: "Ended",
    icon: CirclePause,
    tone: "text-muted-foreground bg-muted",
    dot: "bg-muted-foreground/60",
  },
  failed: {
    label: "Failed",
    icon: CircleAlert,
    // The Badge destructive pill (AA in both themes); the semantic token on its own tint measured 3.8:1 (07.9 polish).
    tone: "bg-red-100 text-red-800 dark:bg-red-400/15 dark:text-red-300",
    dot: "bg-destructive",
  },
  archived: {
    label: "Archived",
    icon: Archive,
    tone: "text-muted-foreground bg-muted",
    dot: "bg-muted-foreground/40",
  },
};

export function StatusChip({ status, className }: { status: WorkSessionStatus; className?: string }) {
  const s = STATUS[status] ?? { label: status, icon: CircleDashed, tone: "bg-muted", dot: "bg-muted" };
  const Icon = s.icon;
  return (
    <span
      data-testid="session-status"
      data-status={status}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 font-medium text-xs",
        s.tone,
        className,
      )}
    >
      <Icon className={cn("size-3.5", s.spin && "animate-spin [animation-duration:2s]")} />
      {s.label}
    </span>
  );
}

export function StatusDot({ status, className }: { status: WorkSessionStatus; className?: string }) {
  const s = STATUS[status];
  return (
    <span role="img" className={cn("relative inline-flex size-2 shrink-0", className)} aria-label={s?.label}>
      {status === "running" || status === "waiting_approval" ? (
        <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60", s?.dot)} />
      ) : null}
      <span className={cn("relative inline-flex size-2 rounded-full", s?.dot)} />
    </span>
  );
}

export function OnlineDot({ online, className }: { online: boolean; className?: string }) {
  return (
    <span
      role="img"
      aria-label={online ? "Online" : "Offline"}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        online ? "bg-success shadow-[0_0_0_3px] shadow-success/20" : "bg-muted-foreground/40",
        className,
      )}
    />
  );
}

/** The runtime glyph alone, in its provider colour (composer chips, picker rail and rows — ref-1..3). */
export function RuntimeMark({ runtime, className }: { runtime: RuntimeId; className?: string }) {
  return (
    <span
      data-runtime-mark={runtime}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center",
        runtime === "claude-code" ? "text-[#D97757]" : "text-foreground",
        className,
      )}
      aria-hidden
    >
      {runtime === "claude-code" ? (
        <svg viewBox="0 0 24 24" className="size-full" fill="currentColor" aria-hidden>
          <title>Claude Code</title>
          {Array.from({ length: 12 }, (_, i) => (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: static decorative rays
              key={i}
              x="11.1"
              y="1"
              width="1.8"
              height="10.5"
              rx="0.9"
              transform={`rotate(${i * 30} 12 12)`}
            />
          ))}
        </svg>
      ) : (
        <svg
          viewBox="0 0 24 24"
          className="size-full"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden
        >
          <title>Codex</title>
          <rect x="2.5" y="3.5" width="19" height="17" rx="4.5" />
          <path d="M7.5 9.5l3 2.5-3 2.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M12.5 15h4" strokeLinecap="round" />
        </svg>
      )}
    </span>
  );
}

/** Stylised runtime marks (not official logos). */
export function RuntimeLogo({ runtime, className }: { runtime: RuntimeId; className?: string }) {
  if (runtime === "claude-code") {
    return (
      <span
        className={cn(
          "inline-flex size-5 shrink-0 items-center justify-center rounded-md bg-[#D97757] text-white",
          className,
        )}
        aria-hidden
      >
        <svg viewBox="0 0 24 24" className="size-[70%]" fill="currentColor" aria-hidden>
          <title>Claude Code</title>
          {Array.from({ length: 8 }, (_, i) => (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: static decorative rays
              key={i}
              x="11"
              y="2"
              width="2"
              height="9"
              rx="1"
              transform={`rotate(${i * 45} 12 12)`}
            />
          ))}
        </svg>
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-md bg-foreground text-background",
        className,
      )}
      aria-hidden
    >
      <svg
        viewBox="0 0 24 24"
        className="size-[68%]"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        aria-hidden
      >
        <title>Codex</title>
        <path d="M6 8l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M12.5 16.5H18" strokeLinecap="round" />
      </svg>
    </span>
  );
}
