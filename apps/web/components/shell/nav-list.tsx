"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import {
  countLabel,
  pendingLabel,
  toReviewLabel,
  usePendingActionApprovalCount,
  usePendingApprovalCount,
} from "@/lib/approval-queries";
import { usePermissionCheck } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { isActive, NAV_ITEMS, type NavItem } from "./nav";

/** The count of a nav item that declares a badge (07.2-13, 07.5): live, `Badge brand`, hidden at 0. */
export function useNavCount(item: NavItem): number {
  const memory = usePendingApprovalCount(item.badge === "pendingMemoryProposals");
  const actions = usePendingActionApprovalCount(item.badge === "pendingActionApprovals");
  return item.badge === "pendingActionApprovals"
    ? actions
    : item.badge === "pendingMemoryProposals"
      ? memory
      : 0;
}

/** "Memory, 3 proposals to review" (07.2-13) · "Approvals, 2 to review" (07.5 UI-SPEC "Nav badge"). */
export const countedName = (item: NavItem, n: number) =>
  item.badge === "pendingActionApprovals" ? toReviewLabel(item.label, n) : pendingLabel(item.label, n);

function NavLink(props: { item: NavItem; collapsed: boolean; onNavigate?: () => void }) {
  return props.item.badge ? <CountedNavLink {...props} /> : <NavLinkView {...props} count={0} />;
}

function CountedNavLink(props: { item: NavItem; collapsed: boolean; onNavigate?: () => void }) {
  const count = useNavCount(props.item);
  return <NavLinkView {...props} count={count} />;
}

function NavLinkView({
  item,
  collapsed,
  onNavigate,
  count,
}: {
  item: NavItem;
  collapsed: boolean;
  onNavigate?: () => void;
  count: number;
}) {
  const pathname = usePathname();
  const active = isActive(item, pathname);
  const Icon = item.icon;
  const link = (
    <Link
      href={item.href}
      data-testid={`nav-${item.id}`}
      aria-current={active ? "page" : undefined}
      aria-label={count > 0 ? countedName(item, count) : collapsed ? item.label : undefined}
      onClick={onNavigate}
      className={cn(
        "group relative flex h-9 items-center gap-3 rounded-lg px-2.5 font-medium text-[13.5px] outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/40",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
        collapsed && "justify-center px-0",
      )}
    >
      {active ? (
        <span
          aria-hidden
          className="absolute top-2 bottom-2 -left-2 w-[3px] rounded-r-full bg-sidebar-primary"
        />
      ) : null}
      <Icon
        className={cn(
          "size-[18px] shrink-0 transition-colors",
          active
            ? "text-sidebar-primary"
            : "text-muted-foreground group-hover:text-sidebar-accent-foreground",
        )}
        strokeWidth={1.9}
      />
      {collapsed ? null : <span className="truncate">{item.label}</span>}
      {count > 0 ? (
        <Badge
          variant="brand"
          aria-hidden
          data-testid={`nav-${item.id}-count`}
          className={cn(
            "rounded-full tabular-nums",
            collapsed
              ? "absolute top-0.5 right-0.5 h-4 min-w-4 px-1 text-[10px]"
              : "ml-auto h-5 min-w-5 px-1.5",
          )}
        >
          {countLabel(count)}
        </Badge>
      ) : null}
    </Link>
  );
  return collapsed ? (
    <Tooltip content={item.label} side="right">
      {link}
    </Tooltip>
  ) : (
    link
  );
}

export function NavList({
  collapsed = false,
  secondary = false,
  onNavigate,
}: {
  collapsed?: boolean;
  /** Render the bottom group (items with `secondary: true`) instead of the main group. */
  secondary?: boolean;
  onNavigate?: () => void;
}) {
  const can = usePermissionCheck();
  const items = NAV_ITEMS.filter((i) => !!i.secondary === secondary && (!i.permission || can(i.permission)));
  return (
    <nav aria-label={secondary ? "Secondary" : "Main"} className="grid gap-0.5">
      {items.map((item) => (
        <NavLink key={item.id} item={item} collapsed={collapsed} onNavigate={onNavigate} />
      ))}
    </nav>
  );
}
