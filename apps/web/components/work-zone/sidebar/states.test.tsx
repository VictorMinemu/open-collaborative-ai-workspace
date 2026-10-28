import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SidebarSectionHeader } from "../../shell/sidebar-section-header";
import type { SettledModel } from "./model";
import { SettledSection } from "./settled-section";
import { NoSessionsLine, RetryButton } from "./states";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) => (
    <a href={href} {...(rest as object)}>
      {children as never}
    </a>
  ),
}));

/**
 * The UI review's contract fixes (07.10-07, UI review fix 3 and warnings): text sizes inside the contract (11.5, 12,
 * 13.5), one look for every "more" row, "Try again" without the accent, and the collapsed count at the header's end.
 */

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const classOf = (markup: string, testId: string) =>
  markup.match(new RegExp(`data-testid="${testId}"[^>]*class="([^"]*)"`))?.[1] ??
  markup.match(new RegExp(`class="([^"]*)"[^>]*data-testid="${testId}"`))?.[1] ??
  "";
const classes = (markup: string, testId: string) => classOf(markup, testId).split(/\s+/);

const settled = (over: Partial<SettledModel> = {}): SettledModel => ({
  key: "settled",
  collapsed: false,
  rows: [],
  total: 13,
  more: 3,
  expanded: false,
  ...over,
});

const ctx = { now: 0, viewerId: null, openSessionId: null, onToggle: () => {}, onExpand: () => {} };

describe("the empty line", () => {
  it('"No sessions yet." is meta text: 12 px, muted', () => {
    const out = html(<NoSessionsLine />);
    expect(out).toContain("No sessions yet.");
    expect(out).toContain("text-[12px]");
    expect(out).not.toContain("text-[13px]");
    expect(out).toContain("text-muted-foreground");
  });
});

describe("Settled's more row", () => {
  it("is the same more row as the others: h-7, 12 px, no icon, 44 px below 768", () => {
    const out = html(<SettledSection model={settled()} {...ctx} />);
    const c = classes(out, "settled-more");
    expect(c).toEqual(expect.arrayContaining(["h-7", "text-[12px]", "max-md:h-11"]));
    expect(c).not.toContain("h-8");
    expect(c).not.toContain("text-[13px]");
    expect(out).not.toContain("lucide-plus");
    expect(out).toMatch(
      /data-testid="settled-more"[^>]*aria-expanded="false"[^>]*aria-controls="wz-list-settled"/,
    );
    expect(out).toContain(">Show 3 more<");
    expect(html(<SettledSection model={settled({ expanded: true })} {...ctx} />)).toContain(">Show fewer<");
  });
});

describe('"Try again"', () => {
  it("is a foreground, underlined link button: never the accent", () => {
    const out = html(<RetryButton testId="sessions-retry" disabled={false} onClick={() => {}} />);
    const c = classes(out, "sessions-retry");
    expect(c).toEqual(
      expect.arrayContaining(["text-foreground", "underline", "text-[12px]", "max-md:min-h-11"]),
    );
    expect(c).not.toContain("text-primary");
    expect(out).toContain(">Try again<");
  });
});

describe("the collapsed count", () => {
  const header = (countAtEnd?: boolean) =>
    html(
      <SidebarSectionHeader
        id="wz-section-personal"
        title="Personal"
        expanded={false}
        hidden={2}
        onToggle={() => {}}
        {...(countAtEnd ? { countAtEnd } : {})}
      />,
    );

  it("sits at the header's end in the Work Zone (Personal like the departments)", () => {
    const c = classes(header(true), "section-count");
    expect(c).toContain("ml-auto");
    expect(c).not.toContain("ml-1");
  });

  it("is unchanged for the chat sidebar (no prop: the markup is the chat header's)", () => {
    const c = classes(header(), "section-count");
    expect(c).toContain("ml-1");
    expect(c).not.toContain("ml-auto");
  });
});
