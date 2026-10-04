"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SectionSidebar, sectionItemClass } from "@/components/shell/section-sidebar";
import { usePermissionCheck } from "@/lib/permissions";
import { SETTINGS_SECTIONS } from "./settings-nav";

export function SettingsSidebar() {
  const pathname = usePathname();
  const can = usePermissionCheck();
  const sections = SETTINGS_SECTIONS.filter((s) => !s.permission || can(s.permission));
  return (
    <SectionSidebar title="Settings">
      <nav aria-label="Settings" className="grid gap-0.5">
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
      </nav>
    </SectionSidebar>
  );
}
