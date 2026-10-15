"use client";

import { MODULE_CATALOG, type ModuleId, type Permission } from "@ocw/contracts";
import {
  Bot,
  Container,
  type LucideIcon,
  MonitorPlay,
  NotebookText,
  Sparkles,
  SquareTerminal,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useRef } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { grainStatus, type ModuleStatus, moduleStatus, permissionsFailed } from "@/lib/modules";
import { usePermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";

/**
 * Module access in the web (Phase 07.3, ADR-0024, P-08). Every entry of a module hides only when `useModule(id)` is
 * `off`; while `/me/permissions` loads or after it failed nothing hides (the API stays the authority). The status is
 * live: `usePermissions` refetches on `permission_rules.updated`, `units.updated` and the member's own update.
 */
export function useModule(id: ModuleId): ModuleStatus {
  const q = usePermissions();
  return moduleStatus(q.data, permissionsFailed(q), id);
}

/** The same three-way status for one grain (e.g. `device.pair`). */
export function useGrain(permission: Permission): ModuleStatus {
  const q = usePermissions();
  return grainStatus(q.data, permissionsFailed(q), permission);
}

/** Icon (the module's rail icon), verb agreeing with the catalog label, and the module's reassurance. */
const OFF_COPY: Record<ModuleId, { icon: LucideIcon; verb: "is" | "are"; extra: string }> = {
  work_zone: { icon: SquareTerminal, verb: "is", extra: " Your devices stay in Settings › Devices." },
  ai_chats: {
    icon: Sparkles,
    verb: "are",
    extra: " Your chats are kept and come back when it is turned on again.",
  },
  bots: { icon: Bot, verb: "are", extra: "" },
  memory: {
    icon: NotebookText,
    verb: "is",
    extra: " Memory files are kept and come back when it is turned on again.",
  },
  // Phase 07.8 (UI-SPEC §4.1).
  sandbox: {
    icon: Container,
    verb: "is",
    extra: " Files are kept and come back when it is turned on again.",
  },
  browser: { icon: MonitorPlay, verb: "is", extra: " Saved sign-ins stay in Settings › Keychain." },
};

/** The in-place explanation shown instead of a denied module's page (never a redirect). */
export function ModuleOff({ module, className }: { module: ModuleId; className?: string }) {
  const copy = OFF_COPY[module];
  return (
    <div
      data-testid="module-off"
      data-module={module}
      className={cn("flex min-w-0 flex-1 flex-col", className)}
    >
      <EmptyState
        icon={copy.icon}
        title={`${MODULE_CATALOG[module].label} ${copy.verb} turned off for you`}
        description={`An admin or your team lead turned this off. Ask them if you need it.${copy.extra}`}
      >
        <Button variant="outline" render={<Link href="/chat" />}>
          Go to Chat
        </Button>
      </EmptyState>
    </div>
  );
}

/** A content-shaped placeholder while the decision loads: a title bar and three rows. */
export function ModuleSkeleton() {
  return (
    <div data-testid="module-loading" aria-busy className="flex min-w-0 flex-1 flex-col">
      <div className="flex min-h-14 shrink-0 items-center gap-2.5 border-b px-4 py-2.5 sm:px-6">
        <Skeleton className="size-[18px] rounded-[5px]" />
        <Skeleton className="h-4 w-36" />
      </div>
      <div className="mx-auto grid w-full max-w-3xl gap-2 p-4 sm:p-6">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>
    </div>
  );
}

/**
 * Renders `children` when the module is on, the off state when it is off, a skeleton while the decision loads.
 * `keepOpen`: a key (the current path) for a page that explains a lost access itself; when the module goes off while
 * that page is open it stays mounted until the member leaves it (every other page swaps to the off state live).
 */
export function ModuleGate({
  module,
  keepOpen = null,
  children,
}: {
  module: ModuleId;
  keepOpen?: string | null;
  children: ReactNode;
}) {
  const status = useModule(module);
  // The page last shown while the module was on (idempotent across re-renders).
  const openOn = useRef<string | null>(null);
  if (status === "on") openOn.current = keepOpen;
  if (status === "loading") return <ModuleSkeleton />;
  if (status === "off" && !(keepOpen !== null && openOn.current === keepOpen)) {
    return <ModuleOff module={module} />;
  }
  return <>{children}</>;
}
