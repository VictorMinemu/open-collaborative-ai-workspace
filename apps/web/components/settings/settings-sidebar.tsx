"use client";

import type { Permission } from "@ocw/contracts";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SectionSidebar, sectionItemClass } from "@/components/shell/section-sidebar";
import { useConnectors, useShares } from "@/lib/connector-queries";
import { useKeychain } from "@/lib/keychain-queries";
import { grainStatus, permissionsFailed } from "@/lib/modules";
import { usePermissionCheck, usePermissions } from "@/lib/permissions";
import { accountSections } from "./account-nav";
import { SETTINGS_SECTIONS, type SettingsSection } from "./settings-nav";

export function SettingsSidebar() {
  const pathname = usePathname();
  const can = usePermissionCheck();
  const perms = usePermissions();
  const workspace = SETTINGS_SECTIONS.filter((s) => !s.permission || can(s.permission));
  // Account entries are everyone's: one of a module (AI chat) leaves only once its grain is decided off, never while
  // permissions load or after a failed fetch (P-08), so it never flashes in or out on a normal load.
  const grainOff = (p: Permission) => grainStatus(perms.data, permissionsFailed(perms), p) === "off";
  // Connections stays while the member still has a connection or an allowed conversation to withdraw, even with
  // connecting off (Bots off; 07.4-14, WINDOWS #196): the page then offers Disconnect and Revoke only.
  const connectOff = grainOff("connector.connect");
  const ownConnections = useConnectors(connectOff);
  const ownShares = useShares(connectOff);
  const withdrawable =
    (ownConnections.data?.connectors.length ?? 0) > 0 || (ownShares.data?.shares.length ?? 0) > 0;
  // Keychain stays while the member has keys to manage, even with keychain use off (Bots off; 07.4 verification): the
  // page and the API keep letting them edit and delete their own keys, so they must be able to find them.
  const keysOff = grainOff("vault.use");
  const ownKeys = useKeychain(keysOff);
  const manageable = (ownKeys.data?.personal.length ?? 0) > 0 || (ownKeys.data?.unit.length ?? 0) > 0;
  const account = accountSections(grainOff, { connections: withdrawable, keychain: manageable });
  return (
    <SectionSidebar title="Settings">
      <nav aria-label="Settings" className="grid gap-4">
        <NavGroup label="Account" sections={account} pathname={pathname} />
        {workspace.length > 0 ? (
          <NavGroup label="Workspace" sections={workspace} pathname={pathname} />
        ) : null}
      </nav>
    </SectionSidebar>
  );
}

function NavGroup({
  label,
  sections,
  pathname,
}: {
  label: string;
  sections: readonly SettingsSection[];
  pathname: string;
}) {
  const id = `settings-group-${label.toLowerCase()}`;
  return (
    <div role="group" aria-labelledby={id} className="grid gap-0.5">
      <div
        id={id}
        className="px-2.5 pb-1 font-medium text-[11px] text-muted-foreground/80 uppercase tracking-wider"
      >
        {label}
      </div>
      {sections.map((s) => {
        const active = pathname === s.href;
        const Icon = s.icon;
        return (
          <Link
            key={s.id}
            href={s.href}
            data-testid={`settings-nav-${s.id}`}
            aria-current={active ? "page" : undefined}
            className={sectionItemClass(active)}
          >
            <Icon className="size-4 text-muted-foreground" />
            {s.label}
          </Link>
        );
      })}
    </div>
  );
}
