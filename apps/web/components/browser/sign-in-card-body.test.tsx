import type { AgentCard, AgentCardBrowserSignInLink } from "@ocw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentCardView } from "@/components/chat/agent-card";
import { signInAnnouncement, signInExpiresIn, signInStatusOf } from "./sign-in-card-body";

/**
 * The "Sign in needed" card (07.8-26; D-07, D-08, R1, UI-SPEC Surface 2), rendered by `AgentCardView` for kind
 * `browser`: every state of the states table, the requester's actions and everyone else's line, the host from the
 * page and the bot's reason as quoted plain text. Static markup in node, like the other web tests.
 */

const MESSAGE_ID = "0199f1c2-7a4b-7c3d-9e8f-00000000c0de";
const SAM = "0199f1c2-7a4b-7c3d-9e8f-0000000005a3";
const ALEX = "0199f1c2-7a4b-7c3d-9e8f-00000000a1e3";
const CONTEXT = "0199f1c2-7a4b-7c3d-9e8f-0000000c0e7e";
const SCOUT = { id: "0199f1c2-7a4b-7c3d-9e8f-000000000001", name: "Scout", avatarUrl: null };
const HOST = "panel.fake.test";
const REASON = "I need the orders dashboard, which needs your account.";
const MIN = 60_000;

function link(over: Partial<AgentCardBrowserSignInLink> = {}): AgentCardBrowserSignInLink {
  return {
    contextId: CONTEXT,
    host: HOST,
    secure: true,
    requesterId: SAM,
    status: "waiting",
    expiresAt: new Date(Date.now() + 15 * MIN - 500).toISOString(),
    sessionExpiresAt: null,
    stopReason: null,
    requesterName: "Sam Lee",
    decidedAt: null,
    ...over,
  };
}

function card(l: AgentCardBrowserSignInLink, viewerCan: AgentCard["viewerCan"] = ["follow"]): AgentCard {
  return {
    kind: "browser",
    title: `Sign in to ${l.host}`,
    fields: [
      { label: "Site", value: l.host },
      { label: "Why", value: REASON },
    ],
    status: "pending",
    actions: [],
    version: 1,
    decision: null,
    updatedAt: new Date().toISOString(),
    platformOwned: true,
    viewerCan,
    browserSignIn: l,
  };
}

function render(c: AgentCard, me: string): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["me"], { user: { id: me }, organization: { id: "01a11635-d6e7-7c87-9f17-b6b1dc048900" } });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AgentCardView
        messageId={MESSAGE_ID}
        card={c}
        summary={`Scout needs someone to sign in to ${HOST} to continue.`}
        authorName="Scout"
        author={SCOUT}
      />
    </QueryClientProvider>,
  );
}

/** The visible text of the markup (tags dropped, entities for quotes decoded). */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
const buttons = (html: string) =>
  [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) =>
    (m[1] ?? "").replace(/<[^>]+>/g, "").trim(),
  );
const testIds = (html: string) => [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]);

describe("SignInCardBody: waiting", () => {
  it("the requester: kind, workspace badge, pill, title, site from the page, the reason quoted, assurance, timer, actions", () => {
    const html = render(card(link(), ["follow", "sign_in"]), SAM);
    const t = text(html);
    expect(html).toContain('data-kind="browser"');
    expect(t).toContain("Sign-in");
    expect(t).toContain("Created by the workspace");
    expect(html).toMatch(/data-testid="agent-card-status" data-status="waiting"[^>]*>[\s\S]*?Sign-in needed/);
    expect(t).toContain(`Sign in to ${HOST}`);
    expect(html).toContain('data-testid="signin-host"');
    expect(html).toContain('data-secure="true"');
    expect(t).toContain(`“${REASON}”`);
    expect(t).toContain(
      "You type in the page yourself. Scout never sees what you type, and password fields are hidden from it.",
    );
    expect(t).toContain("Expires in 15 min");
    expect(buttons(html)).toEqual(expect.arrayContaining(["Not now", "Open and sign in"]));
    expect(t).not.toContain("can sign in here");
    // The generic field list is not rendered for this card (the body owns Site and Why).
    expect(testIds(html)).not.toContain("agent-card-fields");
  });

  it("anyone else: 'Only {person} can sign in here.' and no action", () => {
    const html = render(card(link(), ["follow"]), ALEX);
    expect(text(html)).toContain("Only Sam Lee can sign in here.");
    expect(buttons(html)).not.toContain("Open and sign in");
    expect(buttons(html)).not.toContain("Not now");
  });

  it("the bot's reason is text: markup in it is shown, never rendered", () => {
    const l = link();
    const c = card(l, ["sign_in"]);
    c.fields = [
      { label: "Site", value: HOST },
      { label: "Why", value: '<a href="https://evil.example">Click</a>' },
    ];
    const html = render(c, SAM);
    expect(html).not.toContain('href="https://evil.example"');
    expect(html).toContain("&lt;a href=");
  });
});

describe("SignInCardBody: every other state of the states table", () => {
  it("signing in: the requester reads 'You're signing in.' with Return to sign-in; others read '{person} is signing in.'", () => {
    const l = link({ status: "signing_in" });
    const mine = render(card(l, ["sign_in"]), SAM);
    expect(mine).toMatch(/data-status="signing_in"[^>]*>[\s\S]*?Signing in…/);
    expect(text(mine)).toContain("You're signing in.");
    expect(buttons(mine)).toContain("Return to sign-in");
    const theirs = render(card(l, []), ALEX);
    expect(text(theirs)).toContain("Sam Lee is signing in.");
    expect(buttons(theirs)).not.toContain("Return to sign-in");
  });

  it("signed in: until when, Manage in Keychain and who signed in, for the requester; one line for anyone else", () => {
    const l = link({
      status: "signed_in",
      sessionExpiresAt: "2026-10-29T10:00:00.000Z",
      decidedAt: "2026-10-22T10:05:00.000Z",
    });
    const mine = render(card(l, []), SAM);
    expect(mine).toMatch(/data-status="signed_in"[^>]*>[\s\S]*?Signed in/);
    expect(text(mine)).toContain("Signed in until Oct 29. Scout continues.");
    expect(mine).toContain('href="/settings/keychain#browser-sessions"');
    expect(text(mine)).toContain("Manage in Keychain");
    expect(text(mine)).toContain("Signed in by Sam Lee");
    const theirs = render(card(l, []), ALEX);
    expect(text(theirs)).toContain("Sam Lee signed in. Scout continues.");
    expect(theirs).not.toContain("/settings/keychain");
  });

  it("skipped, expired (also before the sweep wrote it) and stopped", () => {
    const skipped = render(card(link({ status: "skipped" }), []), SAM);
    expect(skipped).toMatch(/data-status="skipped"[^>]*>[\s\S]*?Skipped/);
    expect(text(skipped)).toContain("Sam Lee didn't sign in. Scout was told.");

    const expired = render(card(link({ status: "expired" }), []), SAM);
    expect(expired).toMatch(/data-status="expired"[^>]*>[\s\S]*?Expired/);
    expect(text(expired)).toContain("No one signed in within 15 minutes. Ask Scout again.");
    const late = render(
      card(link({ expiresAt: new Date(Date.now() - 1000).toISOString() }), ["sign_in"]),
      SAM,
    );
    expect(late).toContain('data-status="expired"');
    expect(buttons(late)).not.toContain("Open and sign in");

    const stopped = render(card(link({ status: "stopped", stopReason: "kill_switch" }), []), SAM);
    expect(stopped).toMatch(/data-status="stopped"[^>]*>[\s\S]*?Stopped/);
    expect(text(stopped)).toContain("An admin stopped all bot browsers.");
  });

  it("an ordinary card is unchanged by the sign-in branch", () => {
    const c: AgentCard = {
      ...card(link(), []),
      kind: "generic",
      platformOwned: undefined,
      browserSignIn: undefined,
    };
    const html = render(c, SAM);
    expect(testIds(html)).toContain("agent-card-fields");
    expect(testIds(html)).not.toContain("signin-card");
    expect(text(html)).not.toContain("Created by the workspace");
  });
});

describe("the countdown", () => {
  const at = Date.parse("2026-10-22T10:00:00.000Z");
  const iso = (ms: number) => new Date(at + ms).toISOString();
  it("minutes, then seconds under one minute, then expired", () => {
    expect(signInExpiresIn(iso(15 * MIN), at)).toBe("Expires in 15 min");
    expect(signInExpiresIn(iso(14 * MIN + 1), at)).toBe("Expires in 15 min");
    expect(signInExpiresIn(iso(61_000), at)).toBe("Expires in 2 min");
    expect(signInExpiresIn(iso(59_000), at)).toBe("Expires in 59 s");
    expect(signInExpiresIn(iso(0), at)).toBe("Expired");
  });
  it("announced only at 5 and 1 minutes", () => {
    expect(signInAnnouncement(iso(5 * MIN), at)).toBe("This sign-in expires in 5 minutes.");
    expect(signInAnnouncement(iso(3 * MIN + 30_000), at)).toBe(null);
    expect(signInAnnouncement(iso(MIN), at)).toBe("This sign-in expires in 1 minute.");
    expect(signInAnnouncement(iso(30_000), at)).toBe("This sign-in expires in 1 minute.");
    expect(signInAnnouncement(iso(10 * MIN), at)).toBe(null);
  });
  it("a waiting sign-in past its expiry reads expired; a decided one keeps its status", () => {
    expect(signInStatusOf(link({ expiresAt: iso(-1) }), at)).toBe("expired");
    expect(signInStatusOf(link({ status: "signing_in", expiresAt: iso(-1) }), at)).toBe("expired");
    expect(signInStatusOf(link({ status: "signed_in", expiresAt: iso(-1) }), at)).toBe("signed_in");
    expect(signInStatusOf(link({ expiresAt: iso(MIN) }), at)).toBe("waiting");
  });
});
