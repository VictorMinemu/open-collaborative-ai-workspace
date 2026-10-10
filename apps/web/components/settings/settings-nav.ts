import type { Permission } from "@ocw/contracts";
import {
  Blocks,
  Cpu,
  Laptop,
  LockKeyhole,
  type LucideIcon,
  Network,
  Plug,
  Server,
  ShieldCheck,
  Store,
  Users,
} from "lucide-react";

/** Settings sections. Add ONE entry here and create `app/(app)/settings/<slug>/page.tsx`. */
export interface SettingsSection {
  id: string;
  label: string;
  href: `/settings${string}`;
  icon: LucideIcon;
  /** Shown only to callers holding this organization-scope permission (decided by the API). */
  permission?: Permission;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: "members", label: "Members", href: "/settings", icon: Users, permission: "member.read" },
  {
    id: "organization",
    label: "Organization",
    href: "/settings/organization",
    icon: Network,
    permission: "unit.read",
  },
  // Organization scope `unit.modules.manage`: admins only (leads manage their units in Settings › Organization).
  {
    id: "modules",
    label: "Modules",
    href: "/settings/modules",
    icon: Blocks,
    permission: "unit.modules.manage",
  },
  { id: "models", label: "Models", href: "/settings/models", icon: Cpu, permission: "provider.manage" },
  {
    id: "bot-policy",
    label: "Bot policy",
    href: "/settings/bot-policy",
    icon: ShieldCheck,
    permission: "bot.manage",
  },
  {
    id: "work-zone-policy",
    label: "Work Zone policy",
    href: "/settings/work-zone-policy",
    icon: LockKeyhole,
    permission: "work_zone.manage",
  },
  {
    id: "marketplace",
    label: "Marketplace",
    href: "/settings/marketplace",
    icon: Store,
    permission: "plugin.manage",
  },
  {
    id: "mcp-servers",
    label: "MCP servers",
    href: "/settings/mcp-servers",
    icon: Plug,
    permission: "mcp.manage",
  },
  {
    id: "bots-runtime",
    label: "Bots runtime",
    href: "/settings/bots-runtime",
    icon: Server,
    permission: "cell.manage",
  },
  { id: "devices", label: "Devices", href: "/settings/devices", icon: Laptop, permission: "device.read" },
];
