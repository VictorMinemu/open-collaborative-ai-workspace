import type { BrowserActivityItem, BrowserContextRow } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ActivityRow,
  activityTime,
  activityVerb,
  BrowserTabBody,
  BrowserTabEmpty,
  OpenRow,
  privateLabel,
} from "./browser-tab";

/**
 * The bot page's Browser tab (07.8-27; D-06, BRW-02, UI-SPEC § 3.6 and States): open-now rows with the host chip, the
 * state chip and the meta line; a private row has no button; the empty states; activity rows with their times. The
 * server decides every row (resolver-filtered); the browser only lays it out. Static markup in node.
 */

const NOW = new Date(2026, 9, 22, 15, 30).getTime();
const at = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo, d, h, mi).toISOString();
const ME = "01a11635-d6e7-7c87-9f17-b6b1dc048940";
const CTX = "01a11635-d6e7-7c87-9f17-b6b1dc048941";

function openRow(over: Partial<BrowserContextRow> = {}): BrowserContextRow {
  return {
    contextId: CTX,
    host: "panel.autofy.app",
    secure: true,
    state: "live",
    conversation: { kind: "dm", name: "DM with you", route: `/chat/dm/${CTX}` },
    openedAt: at(2026, 9, 22, 10, 2),
    viewerCan: { watch: true, control: true },
    privateFor: null,
    privateReason: null,
    ...over,
  };
}

function event(over: Partial<BrowserActivityItem> = {}): BrowserActivityItem {
  return {
    kind: "opened",
    host: "panel.autofy.app",
    conversation: { kind: "dm", name: "DM with you" },
    at: at(2026, 9, 22, 10, 2),
    actor: null,
    ...over,
  };
}

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
/** As the DOM reads it (textContent): tags removed, entities decoded, no space added between elements. */
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');

describe("activityTime (UI-SPEC § 3.6 times)", () => {
  it("HH:mm today, yesterday, Oct 8, and the year outside the current one", () => {
    expect(activityTime(at(2026, 9, 22, 9, 5), NOW)).toBe("09:05");
    expect(activityTime(at(2026, 9, 21, 23, 59), NOW)).toBe("yesterday");
    expect(activityTime(at(2026, 9, 8, 12, 0), NOW)).toBe("Oct 8");
    expect(activityTime(at(2025, 11, 30, 12, 0), NOW)).toBe("Dec 30, 2025");
  });
});

describe("activityVerb and privateLabel", () => {
  it("opened, stopped, you signed in, someone else signed in", () => {
    expect(activityVerb(event(), ME)).toBe("Opened");
    expect(activityVerb(event({ kind: "stopped" }), ME)).toBe("Stopped on");
    expect(activityVerb(event({ kind: "signed_in", actor: { id: ME, displayName: "Sam Lee" } }), ME)).toBe(
      "You signed in to",
    );
    expect(activityVerb(event({ kind: "signed_in", actor: { id: CTX, displayName: "Alex Kim" } }), ME)).toBe(
      "Alex Kim signed in to",
    );
  });

  it("a takeover is a sign-in in progress; a member's saved sign-in on the page is their private browsing", () => {
    expect(privateLabel({ privateFor: "Alex Kim", privateReason: "takeover" })).toBe(
      "Private sign-in in progress",
    );
    expect(privateLabel({ privateFor: "Sam Lee", privateReason: "member_session" })).toBe(
      "Private browsing for Sam Lee",
    );
    // An API without the reason (older server): the safer of the two sentences, naming nobody.
    expect(privateLabel({ privateFor: "Sam Lee", privateReason: undefined })).toBe(
      "Private sign-in in progress",
    );
  });
});

describe("OpenRow", () => {
  it("a live row: the host chip with its lock, the Live chip, the meta line and Open live view", () => {
    const m = html(
      <ul>
        <OpenRow row={openRow()} now={NOW} onOpenLive={() => {}} />
      </ul>,
    );
    expect(m).toContain(`data-testid="browser-open-row-${CTX}"`);
    expect(m).toContain('data-testid="browser-open-host"');
    expect(m).toContain('data-secure="true"');
    expect(text(m)).toContain("panel.autofy.app");
    expect(text(m)).toContain("Live");
    expect(text(m)).toContain("DM with you · open since 10:02");
    expect(m).toContain('data-testid="browser-open-live"');
    expect(m).toContain('aria-label="Open live view of panel.autofy.app"');
  });

  it("idle and paused rows say so; an http page reads Not secure", () => {
    expect(text(html(<OpenRow row={openRow({ state: "idle" })} now={NOW} />))).toContain("Idle");
    const paused = html(<OpenRow row={openRow({ state: "paused", secure: false })} now={NOW} />);
    expect(text(paused)).toContain("Paused");
    expect(text(paused)).toContain("Not secure");
  });

  it("a private row has its sentence and no button, whatever viewerCan says", () => {
    for (const [reason, words] of [
      ["takeover", "Private sign-in in progress"],
      ["member_session", "Private browsing for Sam Lee"],
    ] as const) {
      const m = html(
        <OpenRow
          row={openRow({
            state: "private",
            privateFor: "Sam Lee",
            privateReason: reason,
            viewerCan: { watch: true, control: false },
          })}
          now={NOW}
          onOpenLive={() => {}}
        />,
      );
      expect(text(m)).toContain(words);
      expect(m).not.toContain("browser-open-live");
    }
  });

  it("a row the viewer may not watch has no button", () => {
    const m = html(<OpenRow row={openRow({ viewerCan: { watch: false, control: false } })} now={NOW} />);
    expect(m).not.toContain("browser-open-live");
  });
});

describe("ActivityRow", () => {
  it("'Opened {host} · {conversation}' with the time; 'You signed in to'; a person's sign-in", () => {
    expect(text(html(<ActivityRow item={event()} meId={ME} now={NOW} />))).toBe(
      "Opened panel.autofy.app · DM with you10:02",
    );
    expect(
      text(
        html(
          <ActivityRow
            item={event({
              kind: "signed_in",
              actor: { id: ME, displayName: "Sam Lee" },
              at: at(2026, 9, 21, 18, 0),
              conversation: { kind: "channel", name: "# ops" },
            })}
            meId={ME}
            now={NOW}
          />,
        ),
      ),
    ).toBe("You signed in to panel.autofy.app · # opsyesterday");
    expect(
      text(
        html(
          <ActivityRow
            item={event({
              kind: "signed_in",
              actor: { id: CTX, displayName: "Alex Kim" },
              at: at(2026, 9, 8, 9, 0),
            })}
            meId={ME}
            now={NOW}
          />,
        ),
      ),
    ).toBe("Alex Kim signed in to panel.autofy.app · DM with youOct 8");
  });
});

describe("BrowserTabBody and the empty states", () => {
  const body = (over: Partial<Parameters<typeof BrowserTabBody>[0]> = {}) =>
    html(
      <BrowserTabBody
        botName="Scout"
        open={[openRow()]}
        activity={[event()]}
        runtime="gvisor"
        meId={ME}
        hasMore={false}
        loadingMore={false}
        onMore={() => {}}
        now={NOW}
        {...over}
      />,
    );

  it("both sections with their copy, and the isolation line", () => {
    const m = text(body());
    expect(m).toContain("Open now");
    expect(m).toContain("Pages Scout has open that you can watch.");
    expect(m).toContain("Recent activity");
    expect(m).toContain("Hosts Scout opened in conversations you can read. Pages and addresses aren't kept.");
    expect(m).toContain("Runs in its own container, separate from the sandbox. Isolated with gVisor.");
    expect(text(body({ runtime: "hardened-runc" }))).toContain(
      "separate from the sandbox. Hardened container.",
    );
    expect(text(body({ runtime: null }))).toContain("Runs in its own container, separate from the sandbox.");
  });

  it("nothing open: the dashed box; Show more only while there is more", () => {
    const m = body({ open: [], hasMore: true });
    expect(m).toContain('data-testid="browser-open-empty"');
    expect(text(m)).toContain("Nothing open right now.");
    expect(m).toContain('data-testid="browser-activity-more"');
    expect(text(m)).toContain("Show more");
    expect(body()).not.toContain("browser-activity-more");
  });

  it("the whole-tab empty state", () => {
    const m = text(html(<BrowserTabEmpty botName="Scout" />));
    expect(m).toContain("No browser activity yet");
    expect(m).toContain("When Scout opens a page, it shows up here and you can watch it live.");
  });

  it("never a path or a query: rows draw the host and the conversation name only", () => {
    const m = body();
    expect(m).not.toContain("/chat/dm/");
    // (The markup's only URLs are the icons' SVG namespace.)
    expect(text(m)).not.toMatch(/https?:\/\//u);
    expect(m.replaceAll("http://www.w3.org/2000/svg", "")).not.toMatch(/https?:\/\//u);
  });
});
