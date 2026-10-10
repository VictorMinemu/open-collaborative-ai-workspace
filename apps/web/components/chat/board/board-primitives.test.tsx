import type { BoardCard, WaitingOn } from "@ocw/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BOARD, card } from "@/lib/board-fixtures.test-util";
import { CardTile, cardNumberLabel } from "./card-tile";
import { WaitingOnBadge } from "./waiting-on-badge";

/**
 * The board's presentational pieces (07.1-04, BOARD-02, BOARD-03) rendered to static markup in node, checked against
 * 07.1-UI-SPEC.md: card tile anatomy, waiting chip, category icons, column header, card menu and tabs.
 */

const NOW = Date.parse("2026-10-08T11:00:00.000Z");
const AUTHOR = { kind: "user" as const, name: "Víctor Ruiz", avatarUrl: null };

function tile(over: Partial<BoardCard> = {}, props: Partial<Parameters<typeof CardTile>[0]> = {}): string {
  return renderToStaticMarkup(
    <ol>
      <CardTile
        card={card(7, { title: "EXP-0007 · Acme · Broken pump", ...over })}
        board={BOARD}
        author={AUTHOR}
        canPost
        onOpen={() => {}}
        now={NOW}
        {...props}
      />
    </ol>,
  );
}

/** Attribute value of the first element matching `selector`-ish regexp on its opening tag. */
const attr = (html: string, tag: RegExp, name: string) => {
  const open = tag.exec(html)?.[0] ?? "";
  return new RegExp(`\\s${name}="([^"]*)"`).exec(open)?.[1];
};
const openButton = /<button[^>]*data-slot="card-open"[^>]*>/;
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("cardNumberLabel", () => {
  it("pads to the rule's {seq:0…} width, unpadded without one, null without a prefix or a number", () => {
    expect(cardNumberLabel({ prefix: "EXP", namingRule: "{prefix}-{seq:0000} · {summary}" }, 7)).toBe(
      "EXP-0007",
    );
    expect(cardNumberLabel({ prefix: "EXP", namingRule: "{prefix}-{seq} · {summary}" }, 7)).toBe("EXP-7");
    expect(cardNumberLabel({ prefix: "EXP", namingRule: null }, 12)).toBe("EXP-12");
    expect(cardNumberLabel({ prefix: null, namingRule: "{summary}" }, 7)).toBeNull();
    expect(cardNumberLabel({ prefix: "EXP", namingRule: null }, null)).toBeNull();
  });
});

describe("CardTile (UI-SPEC Card tile)", () => {
  it("shows the number once, in the mono badge, and the rest of the title; the open button names the full title", () => {
    const html = tile();
    expect(html).toContain('data-testid="board-card"');
    expect(html).toContain(`data-card-id="${card(7).messageId}"`);
    expect(html).toMatch(/<span[^>]*font-mono[^>]*>EXP-0007<\/span>/);
    expect(html.split("EXP-0007").length - 1).toBe(2); // the badge and the open button's aria-label
    expect(html).toMatch(/line-clamp-2[^>]*>Acme · Broken pump</);
    expect(attr(html, openButton, "aria-label")).toBe("EXP-0007 · Acme · Broken pump");
  });

  it("a title that does not start with the number keeps it whole and is named with the number", () => {
    const html = tile({ title: "Leaking seal" });
    expect(html).toMatch(/line-clamp-2[^>]*>Leaking seal</);
    expect(attr(html, openButton, "aria-label")).toBe("EXP-0007 Leaking seal");
  });

  it("without a prefix there is no badge and the title names the button", () => {
    const html = tile({ title: "Leaking seal" }, { board: { prefix: null, namingRule: null } });
    expect(html).not.toContain("font-mono");
    expect(attr(html, openButton, "aria-label")).toBe("Leaking seal");
  });

  it("renders titles as text, never HTML or Markdown", () => {
    const html = tile({ title: "<img src=x onerror=alert(1)> [x](https://evil)" });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; [x](https://evil)");
  });

  it("shows the waiting chip, and no chip when nobody is waited on", () => {
    const html = tile({ waitingOn: "customer" });
    expect(html).toMatch(/data-testid="waiting-on-badge"[^>]*data-state="customer"/);
    expect(text(html)).toContain("Waiting on customer");
    expect(tile()).not.toContain("waiting-on-badge");
  });

  it("shows the author's compact avatar, Former member for an unknown author", () => {
    expect(tile()).toContain(">V<");
    const html = tile({}, { author: null });
    expect(html).toContain(">F<");
    expect(html).toContain("Former member");
  });

  it("reply count with accessible text, hidden at 0; last activity is the latest of reply, move and creation", () => {
    const html = tile({
      replyCount: 3,
      lastReplyAt: "2026-10-08T09:00:00.000Z",
      movedAt: "2026-10-08T10:55:00.000Z",
    });
    expect(html).toContain('data-testid="card-replies"');
    expect(html).toContain("3 replies");
    expect(text(html)).toMatch(/3 · 5m/);
    expect(html).toMatch(/<time[^>]*dateTime="2026-10-08T10:55:00.000Z"[^>]*title="Last activity [^"]+"/);
    expect(tile({ replyCount: 1 })).toContain("1 reply.");
    const none = tile();
    expect(none).not.toContain('data-testid="card-replies"');
    expect(text(none)).toContain(" 2h ");
  });

  it("describes waiting state, replies and last activity for screen readers", () => {
    const html = tile({ waitingOn: "us", replyCount: 2 });
    const describedBy = attr(html, openButton, "aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(html).toMatch(
      new RegExp(`id="${describedBy}"[^>]*>Waiting on us\\. 2 replies\\. Last activity 2 hours ago\\.<`),
    );
  });

  it("selected: aria-current and the primary ring; rest: no ring", () => {
    const html = tile({}, { selected: true });
    expect(attr(html, openButton, "aria-current")).toBe("true");
    expect(html).toContain("ring-2 ring-primary/60");
    expect(tile()).not.toContain("ring-primary/60");
    expect(attr(tile(), openButton, "aria-current")).toBeUndefined();
  });

  it("grip slot, open button and menu slot in DOM order; no grip for viewers who cannot post", () => {
    const slots = (html: string) =>
      [...html.matchAll(/data-slot="(card-grip|card-open|card-menu)"/g)].map((m) => m[1]);
    const grip: ReactNode = <button type="button">grip</button>;
    const menu: ReactNode = <button type="button">menu</button>;
    expect(slots(tile({}, { grip, menu }))).toEqual(["card-grip", "card-open", "card-menu"]);
    expect(slots(tile({}, { grip, menu, canPost: false }))).toEqual(["card-open", "card-menu"]);
  });

  it("tile surface per UI-SPEC: card, border, rounded-lg, shadow-xs (none in dark), p-3, 76 px minimum", () => {
    const html = tile();
    for (const cls of [
      "bg-card",
      "border",
      "rounded-lg",
      "shadow-xs",
      "dark:shadow-none",
      "p-3",
      "min-h-19",
    ]) {
      expect(html).toContain(cls);
    }
    expect(html).not.toMatch(/reply-avatars|unread/);
  });
});

describe("WaitingOnBadge (UI-SPEC Color › Waiting state)", () => {
  const badge = (state: WaitingOn) => renderToStaticMarkup(<WaitingOnBadge state={state} />);

  it("labels every state in words, with explicit light and dark classes", () => {
    expect(badge("us")).toMatch(
      /bg-amber-100[^"]*text-amber-800[^"]*dark:bg-amber-400\/15[^"]*dark:text-amber-300/,
    );
    expect(badge("us")).toContain(">Waiting on us<");
    expect(badge("customer")).toMatch(
      /bg-sky-100[^"]*text-sky-800[^"]*dark:bg-sky-400\/15[^"]*dark:text-sky-300/,
    );
    expect(badge("customer")).toContain(">Waiting on customer<");
    expect(badge("both")).toMatch(
      /bg-fuchsia-100[^"]*text-fuchsia-800[^"]*dark:bg-fuchsia-400\/15[^"]*dark:text-fuchsia-300/,
    );
    expect(badge("both")).toContain(">Waiting on both<");
  });

  it("pill geometry: h-5 rounded-full px-2 text-xs font-semibold with a 6 px dot", () => {
    expect(badge("us")).toMatch(/inline-flex h-5[^"]*rounded-full px-2 text-xs font-semibold/);
    expect(badge("us")).toMatch(/data-slot="waiting-dot"[^>]*size-1\.5[^>]*><span[^>]*bg-amber-500/);
  });

  it("both: the dot is split into an amber half and a sky half", () => {
    const html = badge("both");
    expect(html).toMatch(/data-slot="waiting-dot"[^>]*>(<span[^>]*w-1\/2[^>]*><\/span>){2}/);
    expect(html.indexOf("bg-amber-500")).toBeLessThan(html.indexOf("bg-sky-500"));
  });

  it("none renders nothing", () => {
    expect(badge("none")).toBe("");
  });
});
