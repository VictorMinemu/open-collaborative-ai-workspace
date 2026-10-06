import type { ChannelSummary, ChannelUnit } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { groupChannelsByUnit } from "./sidebar-sections";

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
