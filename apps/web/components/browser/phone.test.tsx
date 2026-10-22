import type { LiveInputFrame, LiveStateFrame } from "@ocw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { LiveDock, MiniRow } from "./live-dock";
import {
  beforeInputFrames,
  forwardSoftInput,
  phoneViewport,
  SMALL_PAGE,
  softInputType,
  softKeyFrames,
  swipeFrame,
  tapFrames,
} from "./live-input";
import { type LiveView, refusalSentence, useLiveStore } from "./live-store";

/**
 * The phone live view (07.8-26; D-06, D-07, UI-SPEC §1.5, Interaction "Input (phone)", R10, U-4, U-7): taps as the page's
 * touches at the phone viewport's coordinates, swipes as scrolls, the keyboard input's text and keys (emptied after every
 * forward, `password` on a sensitive field), the dock's peek and mini rows, and the sign-in wording of a refused take.
 */

const ID = "0199f1c2-7a4b-7c3d-9e8f-123456789abc";
const BOT = { id: "0199f1c2-7a4b-7c3d-9e8f-000000000001", name: "Scout", avatarUrl: null };

function state(over: Partial<LiveStateFrame> = {}): LiveStateFrame {
  return {
    type: "state",
    state: "live",
    pausedFor: null,
    activity: "clicking “Orders”",
    host: "panel.fake.test",
    secure: true,
    controller: null,
    requesterName: "Sam Lee",
    ...over,
  } as LiveStateFrame;
}

function view(over: Partial<LiveView> = {}): LiveView {
  return {
    contextId: ID,
    bot: BOT,
    expanded: false,
    wantControl: false,
    pending: null,
    closeAfterRelease: false,
    conn: "open",
    server: state(),
    viewerCan: { watch: true, control: true },
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

const key = (k: string, code = k, over: Record<string, unknown> = {}) => ({
  key: k,
  code,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...over,
});

describe("taps and swipes (UI-SPEC Input (phone); R10)", () => {
  const page = phoneViewport(390, 660);
  it("a tap is touchStart then touchEnd at the page's coordinates, scaled from the drawn frame", () => {
    // The frame fills the sheet's area at the page's own size.
    expect(
      tapFrames({ clientX: 195, clientY: 400 }, { left: 0, top: 70, width: 390, height: 660 }, page),
    ).toEqual([
      { type: "touch", event: "start", x: 195, y: 330 },
      { type: "touch", event: "end", x: 195, y: 330 },
    ]);
    // The same page drawn at half size (pinch zoomed out, or a frame not resized yet): coordinates double.
    expect(
      tapFrames({ clientX: 100, clientY: 100 }, { left: 0, top: 0, width: 195, height: 330 }, page),
    ).toEqual([
      { type: "touch", event: "start", x: 200, y: 200 },
      { type: "touch", event: "end", x: 200, y: 200 },
    ]);
    // A letterbox bar is not the page.
    expect(
      tapFrames({ clientX: 5, clientY: 5 }, { left: 0, top: 0, width: 390, height: 900 }, SMALL_PAGE),
    ).toBe(null);
  });

  it("a swipe scrolls the way the finger moved; a short move is a tap", () => {
    const box = { left: 0, top: 0, width: 390, height: 660 };
    expect(swipeFrame({ clientX: 200, clientY: 500 }, { clientX: 200, clientY: 300 }, box, page)).toEqual({
      type: "wheel",
      x: 200,
      y: 500,
      dx: 0,
      dy: 200,
    });
    expect(swipeFrame({ clientX: 200, clientY: 500 }, { clientX: 204, clientY: 506 }, box, page)).toBe(null);
  });

  it("the phone viewport is the frame area in whole pixels, within the contract's bounds", () => {
    expect(phoneViewport(390.4, 659.6)).toEqual({ width: 390, height: 660 });
    expect(phoneViewport(120, 3000)).toEqual({ width: 200, height: 2000 });
  });
});

describe("the keyboard input (UI-SPEC Input (phone); T-07.8-26-01)", () => {
  it("beforeinput: text as one text frame; deletions and line breaks as key presses; composition left to its end", () => {
    expect(beforeInputFrames({ inputType: "insertText", data: "a" })).toEqual([{ type: "text", text: "a" }]);
    expect(beforeInputFrames({ inputType: "insertReplacementText", data: "word" })).toEqual([
      { type: "text", text: "word" },
    ]);
    expect(beforeInputFrames({ inputType: "deleteContentBackward", data: null })).toEqual([
      { type: "key", event: "down", key: "Backspace", code: "Backspace", modifiers: 0 },
      { type: "key", event: "up", key: "Backspace", code: "Backspace", modifiers: 0 },
    ]);
    expect(beforeInputFrames({ inputType: "insertLineBreak", data: null })?.map((f) => f.type)).toEqual([
      "key",
      "key",
    ]);
    expect(beforeInputFrames({ inputType: "insertParagraph", data: null })?.[0]).toMatchObject({
      key: "Enter",
    });
    expect(beforeInputFrames({ inputType: "insertCompositionText", data: "ka" })).toBe(null);
    expect(beforeInputFrames({ inputType: "insertText", data: "" })).toBe(null);
  });

  it("keydown: Backspace, Enter and arrows are key presses; characters and IME keys are not", () => {
    expect(softKeyFrames(key("Backspace"))).toEqual([
      { type: "key", event: "down", key: "Backspace", code: "Backspace", modifiers: 0 },
      { type: "key", event: "up", key: "Backspace", code: "Backspace", modifiers: 0 },
    ]);
    expect(softKeyFrames(key("Enter"))?.[0]).toMatchObject({ key: "Enter", event: "down" });
    expect(softKeyFrames(key("ArrowLeft"))?.[1]).toMatchObject({ key: "ArrowLeft", event: "up" });
    expect(softKeyFrames(key("Tab", "Tab", { shiftKey: true }))?.[0]).toMatchObject({ modifiers: 8 });
    expect(softKeyFrames(key("a", "KeyA"))).toBe(null);
    expect(softKeyFrames(key("Unidentified", "", { keyCode: 229 }))).toBe(null);
    expect(softKeyFrames(key("Backspace", "Backspace", { isComposing: true }))).toBe(null);
  });

  it("every forward empties the input: nothing typed stays in our DOM", () => {
    const sent: LiveInputFrame[] = [];
    const input = { value: "s" };
    forwardSoftInput(input, [{ type: "text", text: "s" }], (f) => sent.push(f));
    expect(input.value).toBe("");
    expect(sent).toEqual([{ type: "text", text: "s" }]);
    // A keyboard that inserted something we do not forward: still emptied.
    input.value = "x";
    forwardSoftInput(input, null, (f) => sent.push(f));
    expect(input.value).toBe("");
    expect(sent).toHaveLength(1);
  });

  it("a sensitive focused field turns the input into a password field", () => {
    expect(softInputType(true)).toBe("password");
    expect(softInputType(false)).toBe("text");
  });
});

describe("the dock (UI-SPEC §1.5)", () => {
  afterEach(() => useLiveStore.setState({ dock: "peek" }));
  const render = (v: LiveView) => {
    const qc = new QueryClient();
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <LiveDock view={v} />
      </QueryClientProvider>,
    );
  };

  it("peek: a region (not a dialog) with the handle, header (host, state, Expand, Close), the frame and the activity", () => {
    useLiveStore.setState({ dock: "peek" });
    const html = render(view());
    expect(html).toContain('data-testid="live-dock"');
    expect(html).toContain('data-dock="peek"');
    expect(html).toMatch(/<section[^>]*aria-label="Live view of Scout&#x27;s browser"/);
    expect(html).not.toContain('role="dialog"');
    expect(html).toContain('aria-label="Resize live view"');
    expect(html).toContain('aria-label="Expand"');
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('data-testid="live-frame"');
    expect(html).toContain("aspect-[16/10]");
    expect(html).toContain("Scout is clicking “Orders”");
    // UI-SPEC sizes: handle area 20, header 48, activity 40, the dock fixed at the bottom above the top bar (z-45).
    expect(html).toContain("h-5");
    expect(html).toContain("h-12");
    expect(html).toContain("h-10");
    expect(html).toMatch(/class="fixed inset-x-0 bottom-0 z-45 rounded-t-2xl/);
  });

  it("mini: one row of 56 with the host, the activity, the state and Show live view; no frame", () => {
    // Static markup renders the store's initial state (peek), so the mini row is rendered on its own.
    const html = renderToStaticMarkup(<MiniRow view={view()} onShow={() => {}} />);
    expect(html).toContain("h-14");
    expect(html).toContain("panel.fake.test");
    expect(html).toContain("Scout is clicking “Orders”");
    expect(html).toContain('aria-label="Show live view"');
    expect(html).not.toContain('data-testid="live-frame"');
  });

  it("private: the dock's frame shows the placeholder, never an image", () => {
    useLiveStore.setState({ dock: "peek" });
    const html = render(
      view({
        server: state({ state: "private", privateReason: "takeover", memberName: "Sam Lee", host: null }),
      }),
    );
    expect(html).toContain("Private sign-in in progress");
    expect(html).not.toContain("<img");
  });
});

describe("a sign-in card's open", () => {
  it("words a refused take as a sign-in", () => {
    const v = view({ signIn: { messageId: ID, host: "panel.fake.test" } });
    expect(refusalSentence("not_allowed", v)).toBe("Only Sam Lee can sign in here.");
    expect(refusalSentence("someone_else", v)).toBe("Someone else is in control right now.");
    expect(refusalSentence("expired", v)).toBe("This sign-in expired. Ask Scout again.");
    expect(refusalSentence("not_allowed", view())).toBe("Only Sam Lee can take control here.");
  });

  it("closes again when its take is refused only if it opened the view", () => {
    useLiveStore.getState().close();
    useLiveStore.getState().open({
      contextId: ID,
      bot: BOT,
      takeControl: true,
      signIn: { messageId: ID, host: "panel.fake.test" },
    });
    expect(useLiveStore.getState().view).toMatchObject({
      closeOnRefuse: true,
      wantControl: true,
      expanded: true,
    });
    useLiveStore.getState().close();
    useLiveStore.getState().open({ contextId: ID, bot: BOT });
    useLiveStore.getState().open({
      contextId: ID,
      bot: BOT,
      takeControl: true,
      signIn: { messageId: ID, host: "panel.fake.test" },
    });
    expect(useLiveStore.getState().view).toMatchObject({ closeOnRefuse: false, wantControl: true });
    useLiveStore.getState().close();
  });
});
