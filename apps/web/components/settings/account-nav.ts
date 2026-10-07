import { Bell, ShieldCheck, Sparkles, UserRound } from "lucide-react";
import type { SettingsSection } from "./settings-nav";

/** The signed-in user's own settings. No permission: every member manages their own account. */
export const ACCOUNT_SECTIONS: readonly SettingsSection[] = [
  { id: "profile", label: "Profile", href: "/settings/profile", icon: UserRound },
  { id: "security", label: "Security", href: "/settings/security", icon: ShieldCheck },
  { id: "notifications", label: "Notifications", href: "/settings/notifications", icon: Bell },
  { id: "ai-chat", label: "AI chat", href: "/settings/ai-chat", icon: Sparkles },
];
