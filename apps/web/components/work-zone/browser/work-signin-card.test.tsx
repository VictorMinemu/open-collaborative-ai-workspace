import type { WorkApproval } from "@ocw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApprovalBanner, browserApprovalWords } from "../approval-banner";
import { signInSiteOf, WorkSignInCard } from "./work-signin-card";

/**
 * The agent's sign-in request and the browser approvals in the session (07.13-21; D-11, D-21, D-26; 07.8 UI-SPEC
 * Surface 2 and Surface 6): the asker reads "{Runtime} needs you to sign in to {site}" with Open and sign in and Not
 * now, everyone else "Waiting for {person} to sign in"; browser host approvals name the origin; member-only ones say
 * who can answer and offer nobody else an action. Who may answer stays the API's decision: the web only hides what the
 * API would refuse. Static markup in node, like the other web component tests.
 */

const SID = "0199f1c2-7a4b-7c3d-9e8f-123456789abc";
const ANA = "0199f1c2-7a4b-7c3d-9e8f-00000000a0a0";
const SAM = "0199f1c2-7a4b-7c3d-9e8f-00000000b0b0";
const NOW = Date.parse("2026-11-25T10:00:00Z");

function approval(
  over: Partial<WorkApproval> & { browser?: WorkApproval["request"]["browser"] | null } = {},
): WorkApproval {
  const { browser, ...rest } = over;
  return {
    id: "0199f1c2-7a4b-7c3d-9e8f-0000000000a1",
    workSessionId: SID,
    request: {
      tool: "mcp__ocw_browser__signin",
      summary: "Sign in to github.com:443: to read your pull requests",
      paths: [],
      ...(browser === undefined
        ? {
            browser: {
              kind: "signin",
              origin: "https://github.com:443",
              tool: "ocw_browser_signin",
              reason: "to read your pull requests",
            },
          }
        : browser
          ? { browser }
          : {}),
    },
    status: "pending",
    decidedBy: null,
    decidedByName: null,
    decision: null,
    comment: null,
    createdAt: new Date(NOW - 60_000).toISOString(),
    decidedAt: null,
    ...rest,
  };
}

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

const card = (a: WorkApproval, viewerIsAsker: boolean) =>
  renderToStaticMarkup(
    <WorkSignInCard
      approval={a}
      agentLabel="Claude Code"
      askerName="Ana"
      viewerIsAsker={viewerIsAsker}
      canDecline={viewerIsAsker}
      deviceName="build-01"
      now={NOW}
      onOpen={() => {}}
      onNotNow={() => {}}
    />,
  );

const banner = (a: WorkApproval, viewerId: string | null, canDecide = true) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ApprovalBanner
        sessionId={SID}
        approval={a}
        pendingCount={1}
        canDecide={canDecide}
        agentLabel="Claude Code"
        deciderHint="Waiting for Ana to decide."
        viewerId={viewerId}
        asker={{ id: ANA, name: "Ana" }}
        deviceName="build-01"
        onOpenSignIn={() => {}}
      />
    </QueryClientProvider>,
  );

describe("signInSiteOf", () => {
  it("drops the scheme and the default port, keeps any other port", () => {
    expect(signInSiteOf("https://github.com:443")).toBe("github.com");
    expect(signInSiteOf("http://example.test:80")).toBe("example.test");
    expect(signInSiteOf("http://127.0.0.1:5173")).toBe("127.0.0.1:5173");
  });
});

describe("WorkSignInCard (D-21)", () => {
  it("the asker: {Runtime} needs you to sign in, the reason, Open and sign in and Not now", () => {
    const html = card(approval(), true);
    const t = text(html);
    expect(t).toContain("Claude Code needs you to sign in to github.com");
    expect(t).toContain("“to read your pull requests”");
    expect(html).toContain('data-testid="work-signin-open"');
    expect(t).toContain("Open and sign in");
    expect(html).toContain('data-testid="work-signin-skip"');
    expect(t).toContain("Not now");
    expect(t).toContain("Expires in 14 min");
  });

  it("tells the asker honestly where the sign-in goes (D-29, D-32)", () => {
    const t = text(card(approval(), true));
    expect(t).toContain("You type in the page yourself, on build-01.");
    expect(t).toContain("If you save it, the agent on build-01 uses it in your own turns only");
    expect(t).toContain("in sessions only you (and the owner of build-01) can see");
  });

  it("anyone else: Waiting for {person} to sign in, no actions", () => {
    const html = card(approval(), false);
    expect(text(html)).toContain("Waiting for Ana to sign in");
    expect(html).not.toContain("<button");
  });

  it("resolved: Signed in or Skipped (or Expired), no actions", () => {
    const signed = card(approval({ status: "approved", decision: "once", decidedByName: "Ana" }), true);
    expect(text(signed)).toContain("Signed in");
    expect(signed).not.toContain("<button");
    const skipped = card(approval({ status: "denied", decision: "deny", decidedByName: "Ana" }), true);
    expect(text(skipped)).toContain("Skipped");
    expect(skipped).not.toContain("<button");
    expect(text(card(approval({ status: "expired" }), true))).toContain("Expired");
  });

  it("the reason is plain text (never markup) and every button is a 44 px target on phones", () => {
    const html = card(
      approval({
        browser: {
          kind: "signin",
          origin: "https://github.com:443",
          tool: "ocw_browser_signin",
          reason: "<img src=x onerror=alert(1)>",
        },
      }),
      true,
    );
    expect(html).not.toContain("<img");
    for (const [tag] of html.matchAll(/<button[^>]*>/g)) expect(tag).toMatch(/max-md:h-11|max-lg:h-11/);
  });

  it("uses only theme tokens (no hex colours, no fixed white or black text)", () => {
    for (const html of [card(approval(), true), card(approval(), false)]) {
      expect(html).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(html).not.toMatch(/\b(bg-white|text-black|text-white)\b/);
    }
  });
});

describe("ApprovalBanner browser approvals (D-11, D-21, D-26, D-34)", () => {
  it("a sign-in request renders the sign-in card for the asker, the waiting line for everyone else", () => {
    const mine = banner(approval(), ANA);
    expect(mine).toContain('data-testid="work-signin-card"');
    expect(mine).toContain('data-testid="work-signin-open"');
    const theirs = banner(approval(), SAM);
    expect(theirs).toContain('data-testid="work-signin-card"');
    expect(text(theirs)).toContain("Waiting for Ana to sign in");
    expect(theirs).not.toContain('data-testid="work-signin-open"');
    expect(theirs).not.toContain('data-testid="approve-once"');
  });

  it("host: Open https://github.com:443 with Approve once, For this session and Deny", () => {
    const html = banner(
      approval({
        request: {
          tool: "mcp__ocw_browser__open",
          summary: "Open https://github.com:443",
          paths: [],
          browser: { kind: "host", origin: "https://github.com:443", tool: "ocw_browser_open" },
        },
      }),
      SAM,
    );
    const t = text(html);
    expect(t).toContain("Open https://github.com:443");
    expect(html).toContain('data-testid="approve-once"');
    expect(html).toContain('data-testid="allow-session"');
    expect(t).toContain("For this session");
    expect(html).toContain('data-testid="deny"');
  });

  it("signed_in_host: the member answers; anyone else reads Only {member} can answer this, with no actions", () => {
    const a = approval({
      request: {
        tool: "mcp__ocw_browser__open",
        summary: "Open https://gist.github.com:443",
        paths: [],
        browser: { kind: "signed_in_host", origin: "https://gist.github.com:443", tool: "ocw_browser_open" },
      },
    });
    const other = banner(a, SAM);
    expect(text(other)).toContain("Open https://gist.github.com:443");
    expect(text(other)).toContain("Only Ana can answer this");
    expect(other).not.toContain('data-testid="approve-once"');
    expect(other).not.toContain('data-testid="deny"');
    const member = banner(a, ANA);
    expect(member).toContain('data-testid="approve-once"');
  });

  it("admin_rule: Your organization asks before {tool} is used", () => {
    const html = banner(
      approval({
        request: {
          tool: "mcp__ocw_browser__screenshot",
          summary: "Take a screenshot",
          paths: [],
          browser: { kind: "admin_rule", origin: "https://github.com:443", tool: "ocw_browser_screenshot" },
        },
      }),
      SAM,
    );
    expect(text(html)).toContain("Your organization asks before ocw_browser_screenshot is used");
    expect(html).toContain('data-testid="approve-once"');
  });

  it("non-browser approvals render as before", () => {
    const html = banner(
      approval({ browser: null, request: { tool: "Bash", summary: "rm -rf build", paths: ["build"] } }),
      SAM,
    );
    const t = text(html);
    expect(t).toContain("Claude Code wants to use Bash");
    expect(t).toContain("Approve once");
    expect(t).toContain("Allow Bash for session");
    expect(html).not.toContain("work-signin-card");
  });

  it("browserApprovalWords decides the words and who the web lets act, never the API's rule", () => {
    const signin = approval();
    expect(browserApprovalWords(signin, { viewerId: SAM, asker: { id: ANA, name: "Ana" } })).toMatchObject({
      kind: "signin",
      answerable: false,
    });
    expect(browserApprovalWords(signin, { viewerId: ANA, asker: { id: ANA, name: "Ana" } })).toMatchObject({
      kind: "signin",
      answerable: true,
    });
    // No human turn in flight: nobody can answer a member-only request.
    expect(browserApprovalWords(signin, { viewerId: ANA, asker: null })).toMatchObject({ answerable: false });
    expect(
      browserApprovalWords(approval({ browser: null, request: { tool: "Bash", summary: "", paths: [] } }), {
        viewerId: SAM,
        asker: null,
      }),
    ).toBeNull();
  });
});
