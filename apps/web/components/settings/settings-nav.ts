import { Cpu, type LucideIcon, Server, Users } from "lucide-react";

/** Settings sections. Add ONE entry here and create `app/(app)/settings/<slug>/page.tsx`. */
export interface SettingsSection {
  id: string;
  label: string;
  href: `/settings${string}`;
  icon: LucideIcon;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: "members", label: "Members", href: "/settings", icon: Users },
  { id: "models", label: "Models", href: "/settings/models", icon: Cpu },
  { id: "bots-runtime", label: "Bots runtime", href: "/settings/bots-runtime", icon: Server },
];
