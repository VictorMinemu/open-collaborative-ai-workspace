import type { CapabilityDenialReason } from "@ocw/contracts";

const REASONS: Record<CapabilityDenialReason, string> = {
  org_policy: "Turned off by your organization",
  personal_policy: "Turned off for personal bots by your organization",
  not_configured: "Not set up yet — ask an admin",
  denied_for_you: "Not available to you",
  source_unavailable: "Source unavailable",
  dangerous: "Blocked for safety",
  dm_only: "Personal bots only answer in your private chat",
};

/** One short sentence explaining why a capability or tool is not available (API reason → UI text). */
export function reasonText(r: CapabilityDenialReason): string {
  return REASONS[r];
}
