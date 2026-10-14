import type { Permission } from "@ocw/contracts";
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

/**
 * The account entries to show. A module's entry leaves once its grain is decided off, except where the member still has
 * something of their own there that the page and the API let them withdraw: Connections while they have a connection
 * or an allowed conversation (07.4-14, WINDOWS #196), Keychain while they have keys to manage (07.4 verification).
 */
export function accountSections(
  grainOff: (permission: Permission) => boolean,
  keep: { connections: boolean; keychain: boolean },
): SettingsSection[] {
  return ACCOUNT_SECTIONS.filter((s) => {
    if (!s.permission || !grainOff(s.permission)) return true;
    return (s.id === "connections" && keep.connections) || (s.id === "keychain" && keep.keychain);
  });
}
