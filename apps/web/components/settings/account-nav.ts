import { Bell, KeyRound, Link2, ShieldCheck, Sparkles, UserRound } from "lucide-react";
import type { SettingsSection } from "./settings-nav";

/**
 * The signed-in user's own settings. Every member manages their own account; an entry with a permission belongs to a
 * module (07.3, ADR-0024) and leaves only once the API decided that grain off.
 */
export const ACCOUNT_SECTIONS: readonly SettingsSection[] = [
  { id: "profile", label: "Profile", href: "/settings/profile", icon: UserRound },
  { id: "security", label: "Security", href: "/settings/security", icon: ShieldCheck },
  { id: "notifications", label: "Notifications", href: "/settings/notifications", icon: Bell },
  { id: "ai-chat", label: "AI chat", href: "/settings/ai-chat", icon: Sparkles, permission: "ai_chat.use" },
  // Phase 07.4 (UI-SPEC Layout › Navigation): the member's own accounts and keys, both in the Bots module (ADR-0024).
  {
    id: "connections",
    label: "Connections",
    href: "/settings/connections",
    icon: Link2,
    permission: "connector.connect",
  },
  { id: "keychain", label: "Keychain", href: "/settings/keychain", icon: KeyRound, permission: "vault.use" },
];
