import type { WorkBrowserSignInItem } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { workSignInPath } from "@/lib/work-browser-queries";
import {
  revokeWorkSignInWords,
  WORK_SIGNINS_EMPTY,
  WorkSignInRow,
  WorkSignInsList,
  workSignInLines,
} from "./work-signins-section";

/**
 * Settings › Keychain › Work Zone sign-ins (07.13-21; D-23): the member's own sign-ins saved in Work Zone sessions,
 * from the owner-only list. Each row says the site, "Work Zone", when it was saved, last used and expires, and its
 * status; Revoke asks first and then DELETEs. The DTO carries no cookie, value or account name, so none can be drawn.
 * Static markup in node, like the other web component tests.
 */

const NOW = Date.parse("2026-11-25T12:00:00Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

function item(over: Partial<WorkBrowserSignInItem> = {}): WorkBrowserSignInItem {
  return {
    id: "01a11635-d6e7-7c87-9f17-b6b1dc048951",
    site: "github.com",
    scope: "work_zone",
    createdAt: iso(NOW - 3 * DAY),
    lastUsedAt: iso(NOW - DAY),
    expiresAt: iso(NOW + 20 * DAY),
    status: "active",
    ...over,
  };
}

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const row = (i: WorkBrowserSignInItem) =>
  renderToStaticMarkup(
    <ul>
      <WorkSignInRow item={i} now={NOW} onRevoke={() => {}} />
    </ul>,
  );

describe("workSignInLines (D-23)", () => {
  it("saved, last used and expires, as dates", () => {
    expect(workSignInLines(item(), NOW)).toEqual({
      saved: "Saved Nov 22",
      used: "Last used Nov 24",
      expires: "Expires Dec 15",
    });
  });

  it("never used", () => {
    expect(workSignInLines(item({ lastUsedAt: null }), NOW).used).toBe("Last used never");
  });
});

describe("WorkSignInRow", () => {
  it("shows the site, Work Zone, the dates, the status and Revoke", () => {
    const html = row(item());
    const t = text(html);
    expect(t).toContain("github.com");
    expect(t).toContain("Work Zone");
    expect(t).toContain("Saved Nov 22");
    expect(t).toContain("Last used Nov 24");
    expect(t).toContain("Expires Dec 15");
    expect(html).toContain('data-testid="work-signin-row-status"');
    expect(t).toContain("Active");
    expect(html).toContain('data-testid="work-signin-revoke"');
    expect(html).toContain('aria-label="Revoke your github.com sign-in"');
  });

  it("an expired row says so", () => {
    const html = row(item({ status: "expired", expiresAt: iso(NOW - DAY) }));
    expect(text(html)).toContain("Expired");
    expect(html).toContain('data-status="expired"');
  });

  it("stacks at 390 and Revoke is a 44 px full-width target on phones", () => {
    const html = row(item());
    expect(html).toMatch(/<li[^>]*flex-wrap[^>]*sm:flex-nowrap/);
    const [button] = html.match(/<button[^>]*data-testid="work-signin-revoke"[^>]*>/) ?? [""];
    expect(button).toContain("max-md:h-11");
    expect(button).toContain("w-full");
  });

  it("never draws anything but the site and dates (no value can be in the DTO)", () => {
    const html = row(item());
    expect(html).not.toMatch(/cookie|token|password/i);
  });
});

describe("WorkSignInsList", () => {
  it("two items: two rows", () => {
    const html = renderToStaticMarkup(
      <WorkSignInsList
        items={[item(), item({ id: "01a11635-d6e7-7c87-9f17-b6b1dc048952", site: "gitlab.com" })]}
        now={NOW}
        onRevoke={() => {}}
      />,
    );
    expect(html.match(/data-testid="work-signin-row-[0-9a-f]/g)?.length).toBe(2);
    expect(text(html)).toContain("gitlab.com");
  });

  it("empty: says when sign-ins appear here", () => {
    const html = renderToStaticMarkup(<WorkSignInsList items={[]} now={NOW} onRevoke={() => {}} />);
    expect(WORK_SIGNINS_EMPTY).toBe(
      "No Work Zone sign-ins yet. When an agent asks you to sign in to a site in a Work Zone session, you can save it here.",
    );
    expect(text(html)).toContain(WORK_SIGNINS_EMPTY);
    expect(html).toContain('data-testid="work-signins-empty"');
  });
});

describe("Revoke", () => {
  it("asks first, in plain words", () => {
    expect(revokeWorkSignInWords("github.com")).toEqual({
      title: "Revoke your sign-in to github.com?",
      body: "A page using it closes. This doesn't sign you out at github.com: to end the session there, sign out on the site or change your password.",
    });
  });

  it("DELETEs the contract's revoke route with the id", () => {
    expect(workSignInPath("01a11635-d6e7-7c87-9f17-b6b1dc048951")).toBe(
      "/api/v1/work-browser/signins/01a11635-d6e7-7c87-9f17-b6b1dc048951",
    );
  });
});
