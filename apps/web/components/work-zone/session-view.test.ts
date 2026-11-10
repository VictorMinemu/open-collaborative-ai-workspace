import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { accessLostCopy, leftProjectLine, SessionBackLink, sessionBackLink } from "./session-view";

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
