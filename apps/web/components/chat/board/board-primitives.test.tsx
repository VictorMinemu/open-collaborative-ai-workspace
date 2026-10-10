import type { BoardCard, BoardColumnCategory, WaitingOn } from "@ocw/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BOARD, COL, COLUMNS, card, snapshot } from "@/lib/board-fixtures.test-util";
import { CardMenu, cardMenuModel, menuColumns } from "./card-menu";
import { CardTile, cardNumberLabel } from "./card-tile";
import { CategoryIcon, ColumnHeader } from "./column-header";
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
    // The 44 px phone trigger stays centred on the 20 px first row (visual 28 on desktop).
    expect(tile({}, { menu })).toMatch(/data-slot="card-menu"[^>]*-my-1 -mr-1[^"]*max-md:-my-3 max-md:-mr-3/);
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
    expect(badge("us")).toContain("whitespace-nowrap"); // a chip never wraps
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

describe("cardMenuModel (UI-SPEC Interaction Contract › Move to…)", () => {
  const P1 = card(1, { columnId: COL.progress, rank: "a1" });
  const P2 = card(2, { columnId: COL.progress, rank: "a2", waitingOn: "us" });
  const P3 = card(3, { columnId: COL.progress, rank: "a3" });
  const D1 = card(4, { columnId: COL.done, rank: "a1" });
  const D2 = card(5, { columnId: COL.done, rank: "a2" });
  const columns = menuColumns(snapshot([P1, P2, P3, D1, D2]));

  it("lists every column with its category, the current one checked; Move to… lands at the bottom (P-07)", () => {
    const m = cardMenuModel(P2, columns, { canPost: true });
    expect(m.moveTo?.map((c) => [c.name, c.category, c.checked])).toEqual([
      ["Backlog", "backlog", false],
      ["In progress", "started", true],
      ["Done", "done", false],
      ["Cancelled", "cancelled", false],
    ]);
    const done = m.moveTo?.find((c) => c.columnId === COL.done);
    expect(done?.intent).toEqual({ move: { columnId: COL.done, afterCardId: D2.messageId }, via: "menu" });
    const empty = m.moveTo?.find((c) => c.columnId === COL.backlog);
    expect(empty?.intent).toEqual({ move: { columnId: COL.backlog, afterCardId: null }, via: "menu" });
    expect(m.moveTo?.find((c) => c.checked)?.intent).toBeNull();
  });

  it("Move to top / bottom inside the column, each disabled when already there", () => {
    const middle = cardMenuModel(P2, columns, { canPost: true });
    expect(middle.moveTop).toEqual({
      disabled: false,
      intent: { move: { columnId: COL.progress, afterCardId: null }, via: "top" },
    });
    expect(middle.moveBottom).toEqual({
      disabled: false,
      intent: { move: { columnId: COL.progress, afterCardId: P3.messageId }, via: "bottom" },
    });
    expect(cardMenuModel(P1, columns, { canPost: true }).moveTop?.disabled).toBe(true);
    expect(cardMenuModel(P3, columns, { canPost: true }).moveBottom?.disabled).toBe(true);
  });

  it("Waiting on… offers Nobody / Us / Customer / Both with the current one checked", () => {
    expect(cardMenuModel(P2, columns, { canPost: true }).waitingOn).toEqual([
      { value: "none", label: "Nobody", checked: false },
      { value: "us", label: "Us", checked: true },
      { value: "customer", label: "Customer", checked: false },
      { value: "both", label: "Both", checked: false },
    ]);
  });

  it("viewers who cannot post get Open thread only", () => {
    expect(cardMenuModel(P2, columns, { canPost: false })).toEqual({
      openThread: true,
      moveTo: null,
      moveTop: null,
      moveBottom: null,
      waitingOn: null,
    });
  });

  it("the trigger: Card actions, 28 px on desktop, a 44 × 44 hit area below 768 px", () => {
    const html = renderToStaticMarkup(
      <CardMenu
        card={P2}
        columns={columns}
        canPost
        onOpen={() => {}}
        onMove={() => {}}
        onWaitingOn={() => {}}
      />,
    );
    expect(attr(html, /<button[^>]*data-testid="card-menu"[^>]*>/, "aria-label")).toBe("Card actions");
    expect(html).toMatch(/data-testid="card-menu"[^>]*class="[^"]*size-7[^"]*max-md:size-11/);
    expect(html).toContain("lucide-ellipsis");
  });
});

describe("CategoryIcon (UI-SPEC Color › Column category)", () => {
  const icon = (category: BoardColumnCategory) => renderToStaticMarkup(<CategoryIcon category={category} />);

  it("draws the category's shape as a labelled image, colour only reinforcing it", () => {
    expect(icon("backlog")).toMatch(/lucide-circle-dashed/);
    expect(icon("started")).toMatch(/lucide-circle-dot/);
    expect(icon("done")).toMatch(/lucide-circle-check/);
    expect(icon("cancelled")).toMatch(/lucide-circle-x/);
    for (const [category, label, tone] of [
      ["backlog", "Backlog", "text-muted-foreground"],
      ["started", "Started", "text-blue-600 dark:text-blue-400"],
      ["done", "Done", "text-success"],
      ["cancelled", "Cancelled", "text-muted-foreground/70"],
    ] as const) {
      const html = icon(category);
      expect(html).toContain('role="img"');
      expect(html).toContain(`aria-label="${label}"`);
      expect(html).toContain(tone);
      expect(html).toContain("size-4");
      expect(html).not.toContain('aria-hidden="true"');
    }
  });

  it("is decorative next to a column name (menus)", () => {
    const html = renderToStaticMarkup(<CategoryIcon category="done" decorative />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="img"');
  });
});

describe("ColumnHeader (UI-SPEC Column (lane) header)", () => {
  const column = COLUMNS[1] ?? COLUMNS[0]!;
  const header = (props: Partial<Parameters<typeof ColumnHeader>[0]> = {}) =>
    renderToStaticMarkup(
      <ColumnHeader
        column={column}
        count={2}
        hasMore={false}
        canPost
        canManage
        onAdd={() => {}}
        menu={<button type="button">column menu</button>}
        {...props}
      />,
    );

  it("icon, name as the lane heading, count, + and the menu slot", () => {
    const html = header();
    expect(html).toContain('role="img" aria-label="Started"');
    expect(html).toMatch(new RegExp(`<h2 id="col-${column.id}-name"[^>]*>In progress</h2>`));
    expect(html).toMatch(/tabular-nums[^>]*>2</);
    expect(html).toContain('aria-label="Add card to In progress"');
    expect(html).toContain("column menu");
    expect(html).toContain("h-10");
  });

  it("100+ when more cards exist; no + without posting; no menu without managing", () => {
    expect(header({ hasMore: true, count: 100 })).toMatch(/tabular-nums[^>]*>100\+</);
    expect(header({ canPost: false })).not.toContain("Add card to");
    expect(header({ canManage: false })).not.toContain("column menu");
  });
});

describe("Tabs (ui/tabs.tsx)", () => {
  const tabs = (variant: "segmented" | "underline") =>
    renderToStaticMarkup(
      <Tabs variant={variant} defaultValue="board">
        <TabsList aria-label="Channel view">
          <TabsTrigger value="board">Board</TabsTrigger>
          <TabsTrigger value="messages">Messages</TabsTrigger>
        </TabsList>
        <TabsContent value="board">board</TabsContent>
      </Tabs>,
    );
  const listClass = (html: string) => attr(html, /<div[^>]*role="tablist"[^>]*>/, "class") ?? "";
  const tabClass = (html: string) => attr(html, /<button[^>]*role="tab"[^>]*>/, "class") ?? "";

  it("segmented: a neutral pill, 32 px (44 px below 768), triggers 24 px (36 px)", () => {
    const html = tabs("segmented");
    for (const cls of ["bg-muted", "p-1", "rounded-lg", "h-8", "max-md:h-11"])
      expect(listClass(html)).toContain(cls);
    for (const cls of ["h-6", "px-3", "max-md:h-9", "data-active:bg-background", "data-active:shadow-xs"]) {
      expect(tabClass(html)).toContain(cls);
    }
    expect(html).not.toContain("tabs-indicator");
    expect(html).not.toContain("bg-primary");
  });

  it("underline: scrollable 44 px tabs with a 2 px primary indicator that does not slide under reduced motion", () => {
    const html = tabs("underline");
    expect(listClass(html)).toContain("overflow-x-auto");
    expect(listClass(html)).not.toContain("bg-muted");
    expect(tabClass(html)).toContain("min-h-11");
    expect(html).toMatch(
      /data-slot="tabs-indicator"[^>]*class="[^"]*h-0\.5[^"]*bg-primary[^"]*motion-reduce:transition-none/,
    );
  });

  it("roles come from Base UI: tablist, tab with aria-selected, tabpanel", () => {
    const html = tabs("segmented");
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Channel view"');
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"/);
    expect(html).toContain('role="tabpanel"');
  });
});
