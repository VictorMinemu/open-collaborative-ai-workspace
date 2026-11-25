import type { LiveStateFrame } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LiveView } from "@/components/browser/live-store";
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

const render = (v: LiveView) =>
  renderToStaticMarkup(<WorkLiveBody view={v} frames={null} deviceName="build-01" />);

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
