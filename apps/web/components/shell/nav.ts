import { Bot, type LucideIcon, MessagesSquare, Settings, SquareTerminal } from "lucide-react";

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
}

export const NAV_ITEMS: readonly NavItem[] = [
  { id: "chat", label: "Chat", href: "/chat", icon: MessagesSquare },
  { id: "bots", label: "Bots", href: "/bots", icon: Bot },
  { id: "work-zone", label: "Work Zone", href: "/work-zone", icon: SquareTerminal },
  { id: "settings", label: "Settings", href: "/settings", icon: Settings, secondary: true },
];

export function isActive(item: NavItem, pathname: string): boolean {
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function activeItem(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find((i) => isActive(i, pathname));
}
