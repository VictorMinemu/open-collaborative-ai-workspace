import type { ChannelSummary, ChannelUnit } from "@ocw/contracts";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { groupChannelsByUnit, SidebarSections } from "./sidebar-sections";

/**
 * The header pin (07.10-03, PD-10, R8) renders a section collapsed: the collapse map is read from localStorage in an
 * effect, which static markup never runs, so the pin swaps in the collapsed keys through the hook's `useState`
 * initializer (the only Set-valued state in the module). Every other hook is React's own.
 */
const forced = vi.hoisted(() => ({ collapsed: null as string[] | null }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const useState = ((init: unknown) => {
    const keys = forced.collapsed;
    const swap = keys !== null && typeof init === "function" && (init as () => unknown)() instanceof Set;
    return actual.useState((swap ? () => new Set(keys) : init) as never);
  }) as unknown as typeof actual.useState;
  return { ...actual, default: { ...actual, useState }, useState };
});
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode } & Record<string, unknown>) =>
    createElement("a", { href, ...rest }, children),
}));

const PRODUCT = "00000000-0000-4000-8000-0000000000a1";
const MOBILE = "00000000-0000-4000-8000-0000000000a2";
const FINANCE = "00000000-0000-4000-8000-0000000000b1";
const DESIGN_OPS = "00000000-0000-4000-8000-0000000000a3";
const APPS = "00000000-0000-4000-8000-0000000000a4";

const units: Record<string, ChannelUnit> = {
  product: { id: PRODUCT, name: "Product", kind: "department", path: [PRODUCT], pathNames: ["Product"] },
  mobile: {
    id: MOBILE,
    name: "Mobile",
    kind: "team",
    path: [PRODUCT, MOBILE],
    pathNames: ["Product", "Mobile"],
  },
  apps: {
    id: APPS,
    name: "Apps",
    kind: "project",
    path: [PRODUCT, MOBILE, APPS],
    pathNames: ["Product", "Mobile", "Apps"],
  },
  designOps: {
    id: DESIGN_OPS,
    name: "Design Ops",
    kind: "team",
    path: [PRODUCT, DESIGN_OPS],
    pathNames: ["Product", "Design Ops"],
  },
  finance: { id: FINANCE, name: "Finance", kind: "department", path: [FINANCE], pathNames: ["Finance"] },
};

let n = 0;
function channel(
  name: string,
  unit: ChannelUnit | null,
  extra: Partial<ChannelSummary> = {},
): ChannelSummary {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    organizationId: "00000000-0000-4000-8000-ffffffffffff",
    kind: "channel",
    name,
    slug: name,
    topic: null,
    visibility: "public",
    parentConversationId: null,
    rootMessageId: null,
    createdBy: null,
    archivedAt: null,
    createdAt: "2026-10-06T10:00:00.000Z",
    lastSeq: 0,
    isMember: true,
    memberCount: 1,
    latestMessageSeq: 0,
    lastReadSeq: 0,
    lastMessageAt: null,
    isDefault: false,
    unit,
    ...extra,
  };
}

describe("groupChannelsByUnit (CHAT-02, D-08)", () => {
  it("Organization first, then the member's own departments, then the rest alphabetically", () => {
    const sections = groupChannelsByUnit(
      [
        channel("budget", units.finance ?? null),
        channel("general", null, { isDefault: true }),
        channel("design", units.product ?? null),
        channel("random", null),
      ],
      new Set([PRODUCT]),
    );
    expect(sections.map((s) => s.title)).toEqual(["Organization", "Product", "Finance"]);
    expect(sections[0]?.key).toBe("org");
    expect(sections[0]?.unit).toBeNull();
    expect(sections[0]?.channels.map((c) => c.name)).toEqual(["general", "random"]);
    expect(sections[1]?.unit).toMatchObject({ id: PRODUCT, name: "Product", kind: "department" });
  });

  it("orders departments the member does not belong to alphabetically after their own", () => {
    const sections = groupChannelsByUnit(
      [channel("ops", units.finance ?? null), channel("design", units.product ?? null)],
      new Set(),
    );
    expect(sections.map((s) => s.title)).toEqual(["Finance", "Product"]);
  });

  it("nests team channels under their department with the deepest unit as a sub-label (two levels at most)", () => {
    const sections = groupChannelsByUnit(
      [
        channel("mobile-dev", units.mobile ?? null),
        channel("design", units.product ?? null),
        channel("app-store", units.apps ?? null),
        channel("design-ops", units.designOps ?? null),
      ],
      new Set([PRODUCT, MOBILE]),
    );
    expect(sections).toHaveLength(1);
    const product = sections[0];
    expect(product?.title).toBe("Product");
    expect(product?.channels.map((c) => [c.name, c.subLabel])).toEqual([
      ["app-store", "Apps"],
      ["design", null],
      ["design-ops", "Design Ops"],
      ["mobile-dev", "Mobile"],
    ]);
  });

  it("joined channels come before suggestions in a section", () => {
    const sections = groupChannelsByUnit(
      [channel("alpha", units.product ?? null, { isMember: false }), channel("beta", units.product ?? null)],
      new Set([PRODUCT]),
    );
    expect(sections[0]?.channels.map((c) => c.name)).toEqual(["beta", "alpha"]);
  });

  it("leaves out empty sections and keeps #general first in Organization", () => {
    const sections = groupChannelsByUnit(
      [channel("aaa", null), channel("general", null, { isDefault: true })],
      new Set([PRODUCT]),
    );
    expect(sections.map((s) => s.title)).toEqual(["Organization"]);
    expect(sections[0]?.channels.map((c) => c.name)).toEqual(["general", "aaa"]);
  });
});

describe("the chat section header is pinned (07.10-03, PD-10, R8)", () => {
  /** Each section's opening tag and header row, up to its first channel row. */
  function headers(collapsed: string[] | null): string[] {
    forced.collapsed = collapsed;
    try {
      const html = renderToStaticMarkup(
        createElement(SidebarSections, {
          channels: [
            channel("general", null, { isDefault: true }),
            channel("design", units.product ?? null),
            channel("mobile-dev", units.mobile ?? null),
            channel("budget", units.finance ?? null),
          ].map((c, i) => ({ ...c, id: `00000000-0000-4000-8000-00000000010${i}` })),
          activeId: null,
          memberUnitIds: new Set([PRODUCT]),
          onCreate: () => {},
          canPlace: (unitId: string | null) => unitId !== null,
        }),
      );
      return html
        .split("<section")
        .slice(1)
        .map((s) => `<section${s.split("<a ")[0]?.split("</section>")[0] ?? ""}`);
    } finally {
      forced.collapsed = null;
    }
  }

  it("expanded: toggle, chevron turned, title, the create action where it may place", () => {
    expect(headers(null)).toMatchInlineSnapshot(`
      [
        "<section aria-labelledby="section-org" data-testid="sidebar-section" data-unit-id="org" class="grid grid-cols-1 gap-px"><div class="group/section flex h-7 items-center gap-1 pr-1"><button type="button" id="section-org" data-testid="section-toggle" aria-expanded="true" class="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-left outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-right size-3.5 shrink-0 text-muted-foreground/70 transition-transform rotate-90" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg><span class="truncate font-semibold text-[11.5px] text-muted-foreground uppercase tracking-wider">Organization</span></button></div>",
        "<section aria-labelledby="section-00000000-0000-4000-8000-0000000000a1" data-testid="sidebar-section" data-unit-id="00000000-0000-4000-8000-0000000000a1" class="grid grid-cols-1 gap-px"><div class="group/section flex h-7 items-center gap-1 pr-1"><button type="button" id="section-00000000-0000-4000-8000-0000000000a1" data-testid="section-toggle" aria-expanded="true" class="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-left outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-right size-3.5 shrink-0 text-muted-foreground/70 transition-transform rotate-90" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg><span class="truncate font-semibold text-[11.5px] text-muted-foreground uppercase tracking-wider">Product</span></button><button type="button" aria-label="Create a channel in Product" data-testid="section-create" class="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/40 group-hover/section:opacity-100 [@media(hover:none)]:hidden" id="base-ui-_R_v6_" data-base-ui-tooltip-trigger=""><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus size-3.5" aria-hidden="true"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg></button></div>",
        "<section aria-labelledby="section-00000000-0000-4000-8000-0000000000b1" data-testid="sidebar-section" data-unit-id="00000000-0000-4000-8000-0000000000b1" class="grid grid-cols-1 gap-px"><div class="group/section flex h-7 items-center gap-1 pr-1"><button type="button" id="section-00000000-0000-4000-8000-0000000000b1" data-testid="section-toggle" aria-expanded="true" class="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-left outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-right size-3.5 shrink-0 text-muted-foreground/70 transition-transform rotate-90" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg><span class="truncate font-semibold text-[11.5px] text-muted-foreground uppercase tracking-wider">Finance</span></button><button type="button" aria-label="Create a channel in Finance" data-testid="section-create" class="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/40 group-hover/section:opacity-100 [@media(hover:none)]:hidden" id="base-ui-_R_v7_" data-base-ui-tooltip-trigger=""><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus size-3.5" aria-hidden="true"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg></button></div>",
      ]
    `);
  });

  it("collapsed: the chevron at rest and the count of hidden channels", () => {
    expect(headers([PRODUCT])).toMatchInlineSnapshot(`
      [
        "<section aria-labelledby="section-org" data-testid="sidebar-section" data-unit-id="org" class="grid grid-cols-1 gap-px"><div class="group/section flex h-7 items-center gap-1 pr-1"><button type="button" id="section-org" data-testid="section-toggle" aria-expanded="true" class="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-left outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-right size-3.5 shrink-0 text-muted-foreground/70 transition-transform rotate-90" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg><span class="truncate font-semibold text-[11.5px] text-muted-foreground uppercase tracking-wider">Organization</span></button></div>",
        "<section aria-labelledby="section-00000000-0000-4000-8000-0000000000a1" data-testid="sidebar-section" data-unit-id="00000000-0000-4000-8000-0000000000a1" data-collapsed="true" class="grid grid-cols-1 gap-px"><div class="group/section flex h-7 items-center gap-1 pr-1"><button type="button" id="section-00000000-0000-4000-8000-0000000000a1" data-testid="section-toggle" aria-expanded="false" class="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-left outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-right size-3.5 shrink-0 text-muted-foreground/70 transition-transform" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg><span class="truncate font-semibold text-[11.5px] text-muted-foreground uppercase tracking-wider">Product</span><span data-testid="section-count" class="ml-1 rounded-full bg-muted px-1.5 text-[10.5px] text-muted-foreground tabular-nums">2</span></button><button type="button" aria-label="Create a channel in Product" data-testid="section-create" class="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/40 group-hover/section:opacity-100 [@media(hover:none)]:hidden" id="base-ui-_R_v6_" data-base-ui-tooltip-trigger=""><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus size-3.5" aria-hidden="true"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg></button></div>",
        "<section aria-labelledby="section-00000000-0000-4000-8000-0000000000b1" data-testid="sidebar-section" data-unit-id="00000000-0000-4000-8000-0000000000b1" class="grid grid-cols-1 gap-px"><div class="group/section flex h-7 items-center gap-1 pr-1"><button type="button" id="section-00000000-0000-4000-8000-0000000000b1" data-testid="section-toggle" aria-expanded="true" class="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-left outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-right size-3.5 shrink-0 text-muted-foreground/70 transition-transform rotate-90" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg><span class="truncate font-semibold text-[11.5px] text-muted-foreground uppercase tracking-wider">Finance</span></button><button type="button" aria-label="Create a channel in Finance" data-testid="section-create" class="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/40 group-hover/section:opacity-100 [@media(hover:none)]:hidden" id="base-ui-_R_v7_" data-base-ui-tooltip-trigger=""><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus size-3.5" aria-hidden="true"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg></button></div>",
      ]
    `);
  });
});
