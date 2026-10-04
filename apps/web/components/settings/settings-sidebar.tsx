"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SectionSidebar, sectionItemClass } from "@/components/shell/section-sidebar";
import { SETTINGS_SECTIONS } from "./settings-nav";

export function SettingsSidebar() {
  const pathname = usePathname();
  return (
    <SectionSidebar title="Settings">
      <nav aria-label="Settings" className="grid gap-0.5">
        {SETTINGS_SECTIONS.map((s) => {
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
