import type { Permission } from "@ocw/contracts";
import { Bot, type LucideIcon, MessagesSquare, NotebookText, Settings, SquareTerminal } from "lucide-react";

/**
 * Primary navigation. To add a section: add ONE entry here and create `app/(app)/<href>/page.tsx`.
 * The rail, the mobile drawer and the mobile top-bar title all derive from this array.
 */
export interface NavItem {
  /** Stable id; also used for `data-testid="nav-<id>"`. */
  id: string;
  label: string;
  href: `/${string}`;
  icon: LucideIcon;
  /** Pinned to the bottom group of the rail (e.g. Settings). */
  secondary?: boolean;
  /** Shown only to callers holding this organization-scope permission (decided by the API). */
  permission?: Permission;
  /** Other path prefixes that belong to this section (e.g. a shared AI chat reads inside Chat). */
  also?: readonly `/${string}`[];
  /** A live count shown with the label (07.2-13: proposals waiting for the viewer). Only items that declare it. */
  badge?: "pendingApprovals";
}

export const NAV_ITEMS: readonly NavItem[] = [
  { id: "chat", label: "Chat", href: "/chat", icon: MessagesSquare, also: ["/share/ai"] },
  { id: "bots", label: "Bots", href: "/bots", icon: Bot, permission: "bot.read" },
  {
    id: "memory",
    label: "Memory",
    href: "/memory",
    icon: NotebookText,
    permission: "memory.read",
    badge: "pendingApprovals",
  },
  {
    id: "work-zone",
    label: "Work Zone",
    href: "/work-zone",
    icon: SquareTerminal,
    permission: "work_session.read",
  },
  { id: "settings", label: "Settings", href: "/settings", icon: Settings, secondary: true },
];

const under = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

export function isActive(item: NavItem, pathname: string): boolean {
  return under(pathname, item.href) || (item.also ?? []).some((p) => under(pathname, p));
}

export function activeItem(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find((i) => isActive(i, pathname));
}
