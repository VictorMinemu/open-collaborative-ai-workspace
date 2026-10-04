"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Tooltip } from "@/components/ui/tooltip";
import { usePermissionCheck } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { isActive, NAV_ITEMS, type NavItem } from "./nav";

function NavLink({
  item,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const active = isActive(item, pathname);
  const Icon = item.icon;
  const link = (
    <Link
      href={item.href}
      data-testid={`nav-${item.id}`}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? item.label : undefined}
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
