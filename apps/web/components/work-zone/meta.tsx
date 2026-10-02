import type { PermissionMode, RuntimeId, WorkSessionStatus } from "@ocw/contracts";
import {
  Archive,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CloudOff,
  Hand,
  Loader,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export const RUNTIMES: Record<
  RuntimeId,
  { label: string; vendor: string; subscription: string; models: Array<{ value: string; label: string }> }
> = {
  "claude-code": {
    label: "Claude Code",
    vendor: "Anthropic",
    subscription: "Uses your Claude subscription on this device",
    models: [
      { value: "default", label: "Default" },
      { value: "opus", label: "Opus" },
      { value: "sonnet", label: "Sonnet" },
      { value: "haiku", label: "Haiku" },
    ],
  },
  codex: {
    label: "Codex",
    vendor: "OpenAI",
    subscription: "Uses your ChatGPT subscription on this device",
    models: [{ value: "default", label: "Default (from your Codex config)" }],
  },
};

export const PERMISSION_MODES: Array<{ value: PermissionMode; label: string; hint: string }> = [
  { value: "default", label: "Ask", hint: "Approve every edit and command" },
  { value: "acceptEdits", label: "Auto-edit", hint: "File edits run; commands still ask" },
  { value: "plan", label: "Plan", hint: "Read-only: proposes a plan, changes nothing" },
];

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
  idle: { label: "Ready", icon: CircleCheck, tone: "text-success bg-success/12", dot: "bg-success" },
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
    tone: "text-warning bg-warning/15",
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
    tone: "text-destructive bg-destructive/12",
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
