import type { Permission } from "@ocw/contracts";
import {
  Blocks,
  Container,
  Cpu,
  Hand,
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
  /**
   * Shown only when the API's access probe says the caller manages something here, at any scope (07.5 R4: unit leads
   * manage approval policies on the units they lead, so an organization-scope permission cannot gate it).
   */
  access?: "approval_policies";
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
  // 07.8-19 (D-12): the organization switch, isolation, limits, network and the kill switch.
  {
    id: "sandbox",
    label: "Sandbox & Browser",
    href: "/settings/sandbox",
    icon: Container,
    permission: "bot.manage",
  },
  {
    id: "work-zone-policy",
    label: "Work Zone policy",
    href: "/settings/work-zone-policy",
    icon: LockKeyhole,
    permission: "work_zone.manage",
  },
  // Admins (organization) and unit leads (the units they lead): `GET /tool-approval-policies/access` decides (07.5 R4).
  {
    id: "approval-policies",
    label: "Approval policies",
    href: "/settings/approval-policies",
    icon: Hand,
    access: "approval_policies",
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
