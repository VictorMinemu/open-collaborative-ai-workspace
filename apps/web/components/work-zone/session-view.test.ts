import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  accessLostCopy,
  leftProjectLine,
  PanelTabs,
  panelTabsOf,
  SessionAccountChip,
  SessionBackLink,
  sessionAccountLabel,
  sessionAccountTooltip,
  sessionBackLink,
} from "./session-view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));

/** The session view's words for a lost session and for a creator who left the project (07.9-10, R7, D-12). */
describe("session view words", () => {
  it("says why the session went away, with today's words for every cause but visibility (R7)", () => {
    expect(accessLostCopy("visibility", "Ana Ruiz")).toEqual({
      title: "You can no longer see this session",
      description: "Who can see it changed. Ask Ana Ruiz if you need it back.",
    });
    expect(accessLostCopy("visibility", null).description).toBe(
      "Who can see it changed. Ask the owner if you need it back.",
    );
    for (const cause of ["role", "device", "module", null]) {
      expect(accessLostCopy(cause, "Ana Ruiz")).toEqual({
        title: "You no longer have access to this session",
        description: "Your role or permissions changed. Ask an admin if you need it back.",
      });
    }
  });

  it("replaces the composer for a creator who left the project (D-12)", () => {
    expect(leftProjectLine("Customer portal")).toBe(
      "You left Customer portal. You can still read and archive this session.",
    );
  });

  it("never uses the words ACL, grant, audience, scope or visibility rule (N4)", () => {
    const words = [
      ...Object.values(accessLostCopy("visibility", "Ana")),
      ...Object.values(accessLostCopy("role", "Ana")),
      leftProjectLine("Customer portal"),
    ].join(" ");
    expect(words).not.toMatch(/\b(acl|grant|grants|audience|scope|visibility rule)\b/i);
  });
});

/** 07.16-18 (D-13, PD-19): "Back to <conversation>" from the server's per-viewer origin, never a client return URL. */
describe("session back link", () => {
  const conv = "11111111-1111-4111-8111-111111111111";
  const root = "22222222-2222-4222-8222-222222222222";
  const card = "33333333-3333-4333-8333-333333333333";

  it("a channel thread: '#name' and the permalink of the card in its thread", () => {
    expect(
      sessionBackLink({
        conversationId: conv,
        kind: "channel",
        name: "eng",
        threadRootId: root,
        messageId: card,
      }),
    ).toEqual({ label: "Back to #eng", href: `/chat/${conv}?thread=${root}&m=${card}` });
  });

  it("a channel message without a thread: the channel permalink", () => {
    expect(
      sessionBackLink({
        conversationId: conv,
        kind: "channel",
        name: "eng",
        threadRootId: null,
        messageId: card,
      }).href,
    ).toBe(`/chat/${conv}?m=${card}`);
  });

  it("a DM or a group: the name as the DM list shows it, the DM permalink", () => {
    for (const kind of ["dm", "group"] as const) {
      expect(
        sessionBackLink({ conversationId: conv, kind, name: "Atlas", threadRootId: root, messageId: card }),
      ).toEqual({ label: "Back to Atlas", href: `/chat/dm/${conv}?m=${card}` });
    }
  });

  it("an AI chat: its title and the AI chat route", () => {
    expect(
      sessionBackLink({
        conversationId: conv,
        kind: "ai_chat",
        name: "Invoice bug",
        threadRootId: null,
        messageId: card,
      }),
    ).toEqual({ label: "Back to Invoice bug", href: `/chat/ai/${conv}` });
  });

  it("SessionBackLink: a link to the built target, 44 px on mobile, truncating its label", () => {
    const html = renderToStaticMarkup(
      createElement(SessionBackLink, {
        origin: { conversationId: conv, kind: "channel", name: "eng", threadRootId: null, messageId: card },
      }),
    );
    expect(html).toContain('data-testid="session-back"');
    expect(html).toContain(`href="/chat/${conv}?m=${card}"`);
    expect(html).toContain("max-md:h-11");
    expect(html).toContain('<span class="truncate">Back to #eng</span>');
  });
});

/** 07.18-12 (D-11): the pool account a session runs on, label only, in the header. */
describe("session account", () => {
  const account = (label: string) => ({
    id: "44444444-4444-4444-8444-444444444444",
    label,
    provider: "claude" as const,
  });
  const base = { deviceName: "build-01", runtime: "claude-code" as const };

  it("names the pool account, the device's own login, or nothing for an older API", () => {
    expect(sessionAccountLabel({ poolAccount: account("ana@acme.dev") })).toBe("Account: ana@acme.dev");
    expect(sessionAccountLabel({ poolAccount: null })).toBe("This device's login");
    expect(sessionAccountLabel({})).toBeNull();
  });

  it("cuts a long label to 32 characters with an ellipsis; the tooltip keeps it whole", () => {
    const long = "a-very-long-pool-account-label-for-the-team@acme.dev";
    const label = sessionAccountLabel({ poolAccount: account(long) });
    expect(label).toBe(`Account: ${long.slice(0, 31)}…`);
    expect(label?.length).toBe("Account: ".length + 32);
    expect(sessionAccountTooltip({ ...base, poolAccount: account(long) })).toBe(
      `Pool account ${long} · on build-01`,
    );
    expect(sessionAccountTooltip({ ...base, poolAccount: null })).toBe(
      "Claude Code uses its own sign-in on build-01",
    );
  });

  it("renders a quiet chip with the label, and nothing without the field", () => {
    const html = renderToStaticMarkup(
      createElement(SessionAccountChip, { session: { ...base, poolAccount: account("A") } }),
    );
    expect(html).toContain('data-testid="session-account"');
    expect(html).toContain("Account: A");
    expect(html).toContain("Pool account A · on build-01");
    expect(renderToStaticMarkup(createElement(SessionAccountChip, { session: base }))).toBe("");
  });

  it("renders a label as text, never as markup (T-07.18-12-02)", () => {
    const html = renderToStaticMarkup(
      createElement(SessionAccountChip, { session: { ...base, poolAccount: account("<b>x</b>") } }),
    );
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

/** 07.13-16 (D-15): the Browser tab beside Queue and Changes, only while the session's browser is available. */
describe("session panel tabs", () => {
  const tabs = (browser: Parameters<typeof panelTabsOf>[0]) =>
    renderToStaticMarkup(
      createElement(PanelTabs, { tab: "queue", onTab: () => undefined, queued: 0, changesCount: 0, browser }),
    );

  it("lists Browser when the browser is available, live or not", () => {
    expect(panelTabsOf({ status: "available", live: false })).toEqual(["queue", "changes", "browser"]);
    const html = tabs({ status: "available", live: true });
    expect(html).toContain('data-testid="tab-browser"');
    expect(html).toContain("Browser");
    expect(html).toContain('role="tab"');
  });

  it("leaves Browser out when it is off, needs an update, or an older API sends nothing", () => {
    for (const status of ["off_policy", "off_device", "update_device"] as const) {
      expect(panelTabsOf({ status, live: false })).toEqual(["queue", "changes"]);
      expect(tabs({ status, live: false })).not.toContain("tab-browser");
    }
    expect(panelTabsOf(undefined)).toEqual(["queue", "changes"]);
    expect(tabs(undefined)).not.toContain("Browser");
  });

  it("every tab is a keyboard-reachable button at least 44 px tall (the phone sheet's touch rule)", () => {
    const html = tabs({ status: "available", live: false });
    expect(html.match(/<button type="button" role="tab"/g)).toHaveLength(3);
    expect(html.match(/ h-12 /g)?.length).toBe(3);
    expect(html).not.toContain('tabindex="-1"');
  });
});
