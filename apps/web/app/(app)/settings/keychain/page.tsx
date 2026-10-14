import { KeyRound } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";
import { KeychainSettings } from "@/components/keychain/keychain-settings";
import { PageHeader } from "@/components/shell/page-header";

export const metadata: Metadata = { title: "Keychain" };

/**
 * Settings › Keychain (07.4-13, UI-SPEC § 3): the keys the member's bots (and, for unit leads and admins, the unit's
 * bots) use by handle without seeing them. Not module-gated: a member keeps managing and deleting their own keys even
 * when Bots are off (07.4-07), and the API decides every action.
 */
export default function SettingsKeychainPage() {
  return (
    <>
      <PageHeader title="Keychain" icon={<KeyRound />} description="Keys your bots use without seeing them" />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <Suspense fallback={null}>
          <KeychainSettings />
        </Suspense>
      </div>
    </>
  );
}
