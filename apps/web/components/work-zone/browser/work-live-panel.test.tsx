import type { LiveStateFrame } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LiveView } from "@/components/browser/live-store";
import { LEASE_MS } from "@/components/browser/live-store";
import type { WorkLiveView } from "@/lib/use-work-live";
import { WorkLiveBody, workActivityOf, workPlaceholderOf } from "./work-live-panel";

/**
 * The session view's Browser panel (07.13-16; D-15, D-20, D-27; 07.8 UI-SPEC § States, § Copywriting › Live view) as
 * static markup: every state's words in the Work Zone's agent-neutral copy, the host only when the server sent one, and
 * no frame image while the page is private, ended or not the viewer's to see.
 */

const SID = "0199f1c2-7a4b-7c3d-9e8f-123456789abc";

function state(over: Partial<LiveStateFrame> = {}): LiveStateFrame {
  return {
    type: "state",
    state: "live",
    pausedFor: null,
    activity: null,
    host: "localhost:3000",
    secure: false,
    controller: null,
    ...over,
  } as LiveStateFrame;
}

function view(over: Partial<LiveView> = {}): LiveView {
  return {
    contextId: SID,
    bot: { id: SID, name: "Claude Code" },
    expanded: false,
    wantControl: false,
    pending: null,
    closeAfterRelease: false,
    conn: "open",
    server: state(),
    viewerCan: { watch: true, control: false },
    leaseDeadline: null,
    sensitive: false,
    hasFrame: true,
    attempt: 0,
    signIn: null,
    closeOnRefuse: false,
    phoneArea: null,
    ...over,
  };
}

const render = (v: LiveView & Partial<Pick<WorkLiveView, "refused">>, coarse = false) =>
  renderToStaticMarkup(<WorkLiveBody view={v} frames={null} deviceName="build-01" coarse={coarse} />);

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

const CONTROLLING = state({ state: "controlling", controller: "self", host: "github.com:443", secure: true });
const controlling = (over: Partial<LiveView> = {}) =>
  view({
    server: CONTROLLING,
    viewerCan: { watch: true, control: true },
    leaseDeadline: Date.now() + LEASE_MS,
    ...over,
  });

const PRIVATE_TAKEOVER = state({
  state: "private",
  privateReason: "takeover",
  host: null,
  memberName: "Sam",
});
const PRIVATE_MEMBER = state({
  state: "private",
  privateReason: "member_session",
  memberName: "Ana",
  host: null,
});
const ENDED_IDLE = state({ state: "ended", endReason: "idle", host: null });
const NO_PERMISSION = state({ state: "no_permission", host: null });

describe("WorkLivePanel states (D-20, D-27)", () => {
  it("connecting", () => {
    const html = render(view({ conn: "connecting", server: null, hasFrame: false }));
    expect(html).toContain("Connecting…");
    expect(html).not.toContain("Claude Code&#x27;s browser…");
  });

  it("idle: the agent has not opened a page yet", () => {
    const html = render(view({ server: state({ state: "connecting", host: null }), hasFrame: false }));
    expect(html).toContain('data-state="idle"');
    expect(html).toContain("Nothing to show yet: the agent has not opened a page");
    expect(html).toContain(">Idle<");
  });

  it("live: the frame, the host and the state chip", () => {
    const html = render(view());
    expect(html).toContain(">Live<");
    expect(html).toContain("localhost:3000");
    expect(html).toContain("<img");
    expect(html).toContain("Not secure");
    expect(html).toContain("Claude Code&#x27;s browser on build-01");
  });

  it("live with the server's masked activity", () => {
    expect(
      workActivityOf(view({ server: state({ activity: "clicking “Orders”" }) }), "live", "build-01"),
    ).toBe("Claude Code is clicking “Orders”");
  });

  it("private + takeover: a private sign-in is in progress", () => {
    const html = render(view({ server: PRIVATE_TAKEOVER, hasFrame: false }));
    expect(html).toContain("Private sign-in in progress");
    expect(html).toContain(">Private<");
  });

  it("private + member_session: the member's own browsing", () => {
    const html = render(view({ server: PRIVATE_MEMBER, hasFrame: false }));
    expect(html).toContain("Private browsing for Ana");
    expect(html).toContain("Only Ana can watch while the agent uses their sign-in.");
  });

  it("ended + idle: closed after the idle limit, in the Work Zone's words", () => {
    const html = render(view({ server: ENDED_IDLE, hasFrame: false }));
    expect(html).toContain("The browser closed after 10 minutes without use");
    expect(html).toContain(">Ended<");
  });

  it("ended for every other reason never names a bot", () => {
    for (const endReason of [
      "crashed",
      "takeover_abandoned",
      "closed_by_bot",
      "kill_switch",
      "module_off",
    ] as const) {
      const p = workPlaceholderOf(
        view({ server: state({ state: "ended", endReason, host: null }) }),
        "ended",
      );
      expect(p?.title).toBeTruthy();
      expect(p?.title).not.toMatch(/bot/i);
      expect(p?.title).not.toContain("Claude Code");
    }
  });

  it("no_permission, also after access was lost", () => {
    for (const server of [NO_PERMISSION, state({ state: "ended", endReason: "access_lost", host: null })]) {
      const html = render(view({ server, hasFrame: false }));
      expect(html).toContain("You can&#x27;t watch this browser");
      expect(html).toContain("Only people who can see this session can watch its browser.");
    }
  });

  it("reconnecting keeps the last frame, dimmed, and says so", () => {
    const html = render(view({ conn: "reconnecting" }));
    expect(html).toContain("Reconnecting…");
    expect(html).toContain("opacity-60");
    expect(html).toContain("<img");
  });

  it("a connection error offers Try again", () => {
    const html = render(view({ conn: "error", server: null, hasFrame: false }));
    expect(html).toContain("Couldn&#x27;t connect to the live view.");
    expect(html).toContain("Try again");
  });
});

describe("WorkLivePanel privacy (T-07.13-16-03)", () => {
  it("shows the host only when the state carries it", () => {
    expect(render(view())).toContain('data-testid="work-live-host-host"');
    for (const server of [PRIVATE_TAKEOVER, PRIVATE_MEMBER, NO_PERMISSION, ENDED_IDLE]) {
      const html = render(view({ server, hasFrame: false }));
      expect(html).not.toContain("localhost:3000");
      expect(html).not.toContain('data-testid="work-live-host-host"');
    }
  });

  it("renders no frame image for private, ended and no_permission", () => {
    for (const server of [PRIVATE_TAKEOVER, PRIVATE_MEMBER, ENDED_IDLE, NO_PERMISSION]) {
      // Even with a stale hasFrame, no image element exists.
      expect(render(view({ server, hasFrame: true }))).not.toContain("<img");
    }
  });
});

describe("WorkLivePanel accessibility", () => {
  it("names the frame, and the state chip is a polite live region", () => {
    const html = render(view());
    expect(html).toContain('aria-label="Live view of the session&#x27;s browser"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Session browser"');
  });
});

/** UX bar (Task 3): phones get 44 px targets, the frame keeps 960×600 and only design tokens colour the panel. */
describe("WorkLivePanel on phones and in both themes", () => {
  const all = [
    view(),
    view({ conn: "connecting", server: null, hasFrame: false }),
    view({ server: state({ state: "connecting", host: null }), hasFrame: false }),
    view({ conn: "reconnecting" }),
    view({ conn: "error", server: null, hasFrame: false }),
    view({ server: PRIVATE_TAKEOVER, hasFrame: false }),
    view({ server: PRIVATE_MEMBER, hasFrame: false }),
    view({ server: ENDED_IDLE, hasFrame: false }),
    view({ server: NO_PERMISSION, hasFrame: false }),
    view({
      server: state({ state: "paused", pausedFor: "signin" }),
      viewerCan: { watch: true, control: true },
    }),
    controlling(),
    controlling({ leaseDeadline: Date.now() + 30_000 }),
  ];

  it("every button is a 44 px target below 768 (Try again, Take control, Done, Keep control, Show keyboard)", () => {
    let buttons = 0;
    for (const v of all) {
      for (const [tag] of [
        ...render(v).matchAll(/<button[^>]*>/g),
        ...render(v, true).matchAll(/<button[^>]*>/g),
      ]) {
        buttons++;
        expect(tag).toMatch(/max-md:h-11|max-md:min-h-11/);
      }
    }
    expect(buttons).toBeGreaterThan(0);
  });

  it("the header row is 44 px tall on phones, so the host's tooltip trigger and the chip are easy to reach", () => {
    expect(render(view())).toMatch(/data-testid="work-live-bar"[^>]*max-md:min-h-11/);
  });

  it("keeps the 960×600 aspect ratio and scales to the panel's width", () => {
    const html = render(view());
    expect(html).toContain("aspect-[8/5]");
    expect(html).toContain("w-full");
  });

  it("uses only theme tokens (no hex colours, no fixed white or black text)", () => {
    for (const v of all) {
      const html = render(v);
      expect(html).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(html).not.toMatch(/\b(bg-white|text-black|text-white)\b/);
    }
  });
});

/** 07.13-21 (D-20, D-22, D-29, D-32): take control, the takeover bar, the two hand backs and the honest device copy. */
describe("WorkLivePanel takeover", () => {
  it("the person the server lets take control sees Take control on the page; nobody else does", () => {
    const paused = state({ state: "paused", pausedFor: "signin" });
    expect(render(view({ server: paused, viewerCan: { watch: true, control: true } }))).toContain(
      'data-testid="work-live-take"',
    );
    expect(render(view({ viewerCan: { watch: true, control: true } }))).toContain("Take control");
    expect(render(view({ server: paused }))).not.toContain('data-testid="work-live-take"');
    // Nothing to take before the agent opens a page.
    expect(
      render(
        view({
          server: state({ state: "connecting", host: null }),
          viewerCan: { watch: true, control: true },
        }),
      ),
    ).not.toContain('data-testid="work-live-take"');
  });

  it("a pending take reads Taking control…", () => {
    const html = render(view({ viewerCan: { watch: true, control: true }, pending: "take" }));
    expect(text(html)).toContain("Taking control…");
  });

  it("in control: the takeover bar, Done, save my sign-in and Done", () => {
    const html = render(controlling());
    expect(html).toContain('data-testid="takeover-bar"');
    expect(text(html)).toContain("You're in control. Claude Code is paused.");
    expect(html).toContain('data-testid="work-live-save"');
    expect(text(html)).toContain("Done, save my sign-in");
    expect(html).toContain('data-testid="work-live-done"');
    expect(html).not.toContain('data-testid="work-live-take"');
  });

  it("in the lease's last minute the bar asks Still there? with Keep control (warning at 9 minutes)", () => {
    const html = render(controlling({ leaseDeadline: Date.now() + 30_000 }));
    expect(html).toContain('data-warning="true"');
    expect(text(html)).toMatch(/Still there\? Control goes back to Claude Code in \d+ s\./);
    expect(html).toContain('data-testid="live-keep-control"');
  });

  it("says honestly where the sign-in is used and who controls that computer (D-29, D-32)", () => {
    const t = text(render(controlling()));
    expect(t).toContain(
      "Your sign-in will be used by the agent on build-01 in your own turns only. The owner of build-01 controls that computer.",
    );
    expect(t).toContain("Sign-ins work only in sessions only you (and the owner of build-01) can see.");
  });

  it("the page takes input while controlled: focusable, named, described by the hint", () => {
    const html = render(controlling());
    expect(html).toMatch(/data-testid="work-live-frame"[^>]*role="application"/);
    expect(html).toContain('aria-label="github.com:443, controlled by you"');
    expect(html).toMatch(/data-testid="work-live-frame"[^>]*tabindex="0"/i);
    expect(html).toContain('data-controlling="true"');
  });

  it("on a phone the page takes taps and a Show keyboard button focuses a hidden input", () => {
    const html = render(controlling(), true);
    expect(html).toContain('data-testid="work-live-show-keyboard"');
    expect(html).toContain('data-testid="work-live-soft-input"');
    expect(html).toContain('autoComplete="off"');
    const masked = render(controlling({ sensitive: true }), true);
    expect(masked).toMatch(/<input[^>]*type="password"[^>]*>/);
  });

  it("watching only: no input capture on the frame", () => {
    const html = render(view());
    expect(html).not.toContain('role="application"');
    expect(html).not.toContain('data-testid="work-live-soft-input"');
  });

  it("a refused take shows its fixed sentence", () => {
    const html = render({ ...view({ viewerCan: { watch: true, control: true } }), refused: "not_allowed" });
    expect(html).toContain('data-testid="work-live-refused"');
    expect(text(html)).toContain("Only the person who asked can take control here.");
  });

  it("everyone else, while someone signs in, sees only Private sign-in in progress", () => {
    const t = text(render(view({ server: PRIVATE_TAKEOVER, hasFrame: false })));
    expect(t).toContain("Private sign-in in progress");
    expect(t).not.toContain("Done, save my sign-in");
    expect(t).not.toContain("Take control");
  });
});
