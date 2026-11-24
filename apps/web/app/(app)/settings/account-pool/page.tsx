import { KeySquare } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";
import { AccountPoolSettings } from "@/components/settings/account-pool-settings";
import { PageHeader } from "@/components/shell/page-header";

export const metadata: Metadata = { title: "Account pool" };

/**
 * Settings › Account pool (Phase 07.18, D-10): the Claude and ChatGPT subscription accounts the organization's Work
 * Zone sessions and bots share. Admins only (`provider.manage`); the API decides every route.
 */
export default function SettingsAccountPoolPage() {
  return (
    <>
      <PageHeader
        title="Account pool"
        icon={<KeySquare />}
        description="Claude and ChatGPT accounts your Work Zone and bots share"
      />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-4xl gap-8 px-4 py-6 sm:px-6 sm:py-8">
          <Suspense fallback={null}>
            <AccountPoolSettings />
          </Suspense>
        </div>
      </div>
    </>
  );
}
