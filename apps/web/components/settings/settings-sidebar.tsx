"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SectionSidebar, sectionItemClass } from "@/components/shell/section-sidebar";
import { grainStatus, permissionsFailed } from "@/lib/modules";
import { usePermissionCheck, usePermissions } from "@/lib/permissions";
import { ACCOUNT_SECTIONS } from "./account-nav";
import { SETTINGS_SECTIONS, type SettingsSection } from "./settings-nav";

export function SettingsSidebar() {
  const pathname = usePathname();
  const can = usePermissionCheck();
  const perms = usePermissions();
  const workspace = SETTINGS_SECTIONS.filter((s) => !s.permission || can(s.permission));
  // Account entries are everyone's: one of a module (AI chat) leaves only once its grain is decided off, never while
  // permissions load or after a failed fetch (P-08), so it never flashes in or out on a normal load.
  const account = ACCOUNT_SECTIONS.filter(
    (s) => !s.permission || grainStatus(perms.data, permissionsFailed(perms), s.permission) !== "off",
  );
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
