import type { BrowserSessionItem } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { monthDay, SessionRow, sessionLines } from "./browser-sessions-section";

/**
 * Settings › Keychain › Browser sessions (07.8-27; D-08, R7, U-3, U-13, UI-SPEC § 4.5): the row says the site, the bot
 * and the dates; an expiry under 3 days is amber with the glyph; an expired row offers Remove; nothing sealed exists in
 * the DTO, so nothing sealed can be drawn. Static markup in node, like the other web component tests.
 */

const NOW = Date.parse("2026-10-22T12:00:00Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

function item(over: Partial<BrowserSessionItem> = {}): BrowserSessionItem {
  return {
    id: "01a11635-d6e7-7c87-9f17-b6b1dc048941",
    site: "panel.fake.test",
    agentId: "01a11635-d6e7-7c87-9f17-b6b1dc048942",
    agentName: "Scout",
    createdAt: iso(NOW - 8 * DAY),
    lastUsedAt: iso(NOW - 5 * 60_000),
    expiresAt: iso(NOW + 22 * DAY),
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

const row = (i: BrowserSessionItem) =>
  renderToStaticMarkup(
    <ul>
      <SessionRow item={i} now={NOW} onRevoke={() => {}} onRemove={() => {}} />
    </ul>,
  );

describe("sessionLines (UI-SPEC § 4.5 Row, Expiring, Expired)", () => {
  it("signed in, last used and the expiry date", () => {
    expect(sessionLines(item(), NOW)).toEqual({
      used: "Signed in Oct 14 · last used 5 minutes ago",
      expires: { text: "expires Nov 13", soon: false },
      expired: null,
    });
  });

  it("never used; signed in today", () => {
    expect(sessionLines(item({ lastUsedAt: null, createdAt: iso(NOW - 60_000) }), NOW).used).toBe(
      "Signed in today · never used",
    );
  });

  it("under 3 days the expiry is relative and soon; under a day it counts hours", () => {
    expect(sessionLines(item({ expiresAt: iso(NOW + 2 * DAY) }), NOW).expires).toEqual({
      text: "expires in 2 days",
      soon: true,
    });
    expect(sessionLines(item({ expiresAt: iso(NOW + DAY + 60_000) }), NOW).expires?.text).toBe(
      "expires in 1 day",
    );
    expect(sessionLines(item({ expiresAt: iso(NOW + 5 * 3_600_000) }), NOW).expires?.text).toBe(
      "expires in 5 hours",
    );
    expect(sessionLines(item({ expiresAt: iso(NOW + 3 * DAY) }), NOW).expires?.soon).toBe(false);
  });

  it("an expired row (by status, or by time since the list was read) asks to sign in again", () => {
    for (const i of [
      item({ status: "expired", expiresAt: iso(NOW - DAY) }),
      item({ expiresAt: iso(NOW - 1) }),
    ]) {
      expect(sessionLines(i, NOW)).toEqual({
        used: null,
        expires: null,
        expired: "Sign in again when a bot asks.",
      });
    }
  });

  it("monthDay adds the year outside the current one", () => {
    expect(monthDay("2027-01-04T12:00:00Z", NOW)).toBe("Jan 4, 2027");
    expect(monthDay("2026-11-13T12:00:00Z", NOW)).toBe("Nov 13");
  });
});

describe("SessionRow", () => {
  it("an active row: site, 'with {bot}', the meta line and Revoke named for its site", () => {
    const html = row(item());
    expect(text(html)).toContain("panel.fake.test with Scout");
    // As the DOM reads it (textContent, no space added between elements): the separators are real text.
    expect(html.replace(/<[^>]+>/g, "")).toContain(
      "Signed in Oct 14 · last used 5 minutes ago · expires Nov 13",
    );
    expect(html).toContain('data-testid="browser-session-revoke"');
    expect(html).toContain('aria-label="Revoke your panel.fake.test sign-in"');
    expect(html).not.toContain("Expired");
    expect(html).not.toContain("text-amber-700");
  });

  it("an expiring row: amber text with the warning glyph", () => {
    const html = row(item({ expiresAt: iso(NOW + 2 * DAY) }));
    expect(html).toContain('data-soon="true"');
    expect(html).toContain("text-amber-700 dark:text-amber-300");
    expect(html).toContain("lucide-triangle-alert");
    expect(text(html)).toContain("expires in 2 days");
  });

  it("an expired row: the Expired badge, the sentence and Remove instead of Revoke", () => {
    const html = row(item({ status: "expired", expiresAt: iso(NOW - DAY) }));
    expect(text(html)).toContain("Expired");
    expect(text(html)).toContain("Sign in again when a bot asks.");
    expect(html).toContain('data-testid="browser-session-remove"');
    expect(html).not.toContain('data-testid="browser-session-revoke"');
  });
});
