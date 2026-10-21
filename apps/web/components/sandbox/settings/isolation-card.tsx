import type { SandboxIsolationInfo } from "@ocw/contracts";
import { CircleAlert, type LucideIcon, ShieldAlert, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The isolation in use, exactly as the API reports it (07.8-19; D-11, D-14, U-12, UI-SPEC §4.2): gVisor, hardened
 * containers, the sandbox service down, or a Docker Engine too old. Never a stronger claim than the report: an "ok"
 * status without a runtime reads as hardened. The same sentence goes into the organization switch's turn-on dialog, so
 * an admin never turns the capability on without seeing which boundary the server gives (T-07.8-19-04).
 */

export type IsolationVariant = "gvisor" | "hardened" | "down" | "docker_old";

export function isolationVariant(iso: SandboxIsolationInfo): IsolationVariant {
  if (iso.status === "service_down") return "down";
  if (iso.status === "docker_too_old") return "docker_old";
  return iso.runtime === "gvisor" ? "gvisor" : "hardened";
}

export const SERVICE_DOWN_REASON = "The sandbox service isn't running on this server.";
export const DOCKER_OLD_REASON = "This server needs Docker Engine 26 or later.";

/** Why nothing can run on this server right now, or null when the service answers with a usable Docker. */
export function unavailableReason(iso: SandboxIsolationInfo): string | null {
  const v = isolationVariant(iso);
  if (v === "down") return SERVICE_DOWN_REASON;
  if (v === "docker_old") return DOCKER_OLD_REASON;
  return null;
}

/** The one-sentence isolation statement of the turn-on dialog (UI-SPEC §4.1), or null when nothing can run. */
export function isolationSentence(iso: SandboxIsolationInfo): string | null {
  const v = isolationVariant(iso);
  if (v === "gvisor") return "Each sandbox is isolated with gVisor.";
  if (v === "hardened") {
    return "This server has no gVisor, so sandboxes use hardened containers that share the server's kernel.";
  }
  return null;
}

/** D-14: Chromium runs without its own sandbox on this host (restricted user namespaces); said, never hidden. */
export const CONTAINER_ONLY_BROWSER =
  "Browsers run without Chromium's own sandbox on this server, so their container is the only boundary.";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 sandboxes · 1 browser" running now. */
export const runningLine = (running: SandboxIsolationInfo["running"]) =>
  `${plural(running.sandboxes, "sandbox", "sandboxes")} · ${plural(running.browsers, "browser", "browsers")}`;

const TONES = {
  card: "border bg-card",
  warning:
    "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200",
  blocking:
    "border-red-200 bg-red-50 text-red-800 dark:border-red-400/25 dark:bg-red-400/10 dark:text-red-300",
} as const;

const TILES = {
  emerald: "bg-emerald-100 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-300",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
  red: "bg-red-100 text-red-800 dark:bg-red-400/15 dark:text-red-300",
} as const;

const Code = ({ children }: { children: ReactNode }) => (
  <code className="break-all rounded bg-background/70 px-1 py-0.5 font-mono text-xs">{children}</code>
);

const COPY: Record<
  IsolationVariant,
  { icon: LucideIcon; tile: keyof typeof TILES; tone: keyof typeof TONES; title: string; body: ReactNode }
> = {
  gvisor: {
    icon: ShieldCheck,
    tile: "emerald",
    tone: "card",
    title: "gVisor",
    body: "Each bot's sandbox and browser run on gVisor, a separate kernel in user space, on their own private network.",
  },
  hardened: {
    icon: ShieldAlert,
    tile: "amber",
    tone: "warning",
    title: "Hardened containers (no gVisor)",
    body: (
      <>
        Sandboxes run as non-root containers without privileges, on their own private network, but they share
        this server's kernel. A kernel flaw could let a bot reach the server. Install gVisor to close this
        gap: see <Code>infra/sandbox/README.md</Code>.
      </>
    ),
  },
  down: {
    icon: CircleAlert,
    tile: "red",
    tone: "blocking",
    title: "The sandbox service isn't running",
    body: (
      <>
        Start it with <Code>docker compose --profile sandbox up -d</Code>, then reload this page.
      </>
    ),
  },
  docker_old: {
    icon: CircleAlert,
    tile: "red",
    tone: "blocking",
    title: "Docker Engine 26 or later is needed",
    body: "Older versions let sandboxes leak DNS queries. Update Docker on the server.",
  },
};

export function IsolationCard({ isolation }: { isolation: SandboxIsolationInfo }) {
  const variant = isolationVariant(isolation);
  const c = COPY[variant];
  const Icon = c.icon;
  const muted = c.tone === "card";
  return (
    <div
      data-testid="isolation-card"
      data-runtime={variant}
      className={cn("flex items-start gap-3 rounded-xl p-4 shadow-xs", TONES[c.tone])}
    >
      <span
        aria-hidden
        className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", TILES[c.tile])}
      >
        <Icon className="size-[18px]" />
      </span>
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <p className="font-semibold text-sm" data-testid="isolation-title">
            {c.title}
          </p>
          {variant === "gvisor" || variant === "hardened" ? (
            <p
              className={cn("text-xs", muted ? "text-muted-foreground" : "opacity-90")}
              data-testid="isolation-running"
            >
              {runningLine(isolation.running)} running now
            </p>
          ) : null}
        </div>
        <p className={cn("text-sm leading-5", muted && "text-muted-foreground")}>{c.body}</p>
        {isolation.browserSandbox === "container-only" && (variant === "gvisor" || variant === "hardened") ? (
          <p
            className={cn("text-sm leading-5", muted && "text-muted-foreground")}
            data-testid="isolation-browser"
          >
            {CONTAINER_ONLY_BROWSER}
          </p>
        ) : null}
      </div>
    </div>
  );
}
