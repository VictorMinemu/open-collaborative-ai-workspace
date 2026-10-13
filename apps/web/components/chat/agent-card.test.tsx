import type { AgentCard } from "@ocw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentCardView } from "./agent-card";

/**
 * The one Agent Card renderer (06-15, AGENT-04, D-07, D-08, P-11): kind, title, status, fields and the actions the
 * server allows (`viewerCan`, `decision`). Card text is untrusted agent output: plain text only, and Open is a link
 * only to an internal route (`AgentCardRoute`, re-checked here). Static markup in node.
 */

const MESSAGE_ID = "01a11635-d6e7-7c87-9f17-b6b1dc048941";

function deployment(over: Partial<AgentCard> = {}): AgentCard {
  return {
    kind: "deployment",
    title: "Deploy api v2.3",
    fields: [
      { label: "Environment", value: "production" },
      { label: "Commit", value: "abc123" },
    ],
    status: "running",
    actions: [
      { kind: "open", label: "Open", target: "/work-zone" },
      { kind: "follow", label: "Follow" },
      { kind: "approve", label: "Approve" },
    ],
    version: 1,
    decision: null,
    updatedAt: "2026-10-07T09:00:00.000Z",
    following: false,
    viewerCan: ["follow", "decide"],
    ...over,
  };
}

function render(card: AgentCard, summary = "Deploying api v2.3 to production"): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AgentCardView messageId={MESSAGE_ID} card={card} summary={summary} />
    </QueryClientProvider>,
  );
}

/** Every href value in the markup. */
const hrefs = (html: string) => [...html.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1] ?? "");
/** The visible text of every <button>. */
const buttons = (html: string) =>
  [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) =>
    (m[1] ?? "").replace(/<[^>]+>/g, "").trim(),
  );

describe("AgentCardView", () => {
  it("renders kind, title, an accessible status pill, each field and Open / Follow / Approve / Deny", () => {
    const html = render(deployment());
    expect(html).toContain('data-testid="agent-card"');
    expect(html).toContain('data-kind="deployment"');
    expect(html).toContain(">Deployment<");
    expect(html).toContain(">Deploy api v2.3<");
    expect(html).toContain('aria-label="Status: Running"');
    expect(html).toContain('data-status="running"');
    expect(html).toMatch(/<dt[^>]*>Environment<\/dt><dd[^>]*>production<\/dd>/);
    expect(html).toMatch(/<dt[^>]*>Commit<\/dt><dd[^>]*>abc123<\/dd>/);
    expect(hrefs(html)).toEqual(["/work-zone"]);
    expect(html).toMatch(/<a[^>]*data-testid="agent-card-open"[^>]*>[\s\S]*Open[\s\S]*<\/a>/);
    expect(buttons(html)).toEqual(["Follow", "Approve", "Deny"]);
  });

  it("keeps the summary for screen readers as the card's description, once", () => {
    const html = render(deployment());
    const id = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`id="${id}"`);
    expect(html.split("Deploying api v2.3 to production")).toHaveLength(2);
  });

  it("an Open target that fails AgentCardRoute renders no link (and no Open control)", () => {
    for (const target of [
      "https://evil.example/login",
      "//evil.example",
      "/work-zone/../../x",
      "javascript:alert(1)",
    ]) {
      const html = render(deployment({ actions: [{ kind: "open", label: "Open", target }] }));
      expect(hrefs(html), target).toEqual([]);
      expect(html).not.toContain("agent-card-open");
    }
  });

  it("renders title, field and summary text literally: no HTML, no Markdown links", () => {
    const html = render(
      deployment({
        title: "<b>Deploy</b> [x](https://evil)",
        fields: [{ label: "Notes", value: "<b>bold</b> [x](https://evil) **strong**" }],
      }),
      "[click](https://evil) <img src=x>",
    );
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<strong");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt; [x](https://evil) **strong**");
    expect(html).toContain("&lt;b&gt;Deploy&lt;/b&gt; [x](https://evil)");
    expect(hrefs(html).filter((h) => h.includes("evil"))).toEqual([]);
  });

  it("a decided card says who decided and offers no Approve or Deny", () => {
    const html = render(
      deployment({
        kind: "approval",
        status: "pending",
        decision: {
          outcome: "approved",
          by: { kind: "user", id: "01a11635-d6e7-7c87-9f17-b6b1dc048942", displayName: "Sam Lee" },
          at: "2026-10-07T09:05:00.000Z",
        },
        viewerCan: ["follow"],
      }),
    );
    expect(html).toContain('data-testid="agent-card-decision"');
    expect(html).toMatch(/Approved by Sam Lee/);
    expect(buttons(html)).toEqual(["Follow"]);
  });

  it("offers Approve only when the server says the viewer may decide; Following when followed", () => {
    const html = render(deployment({ viewerCan: ["follow"], following: true }));
    expect(buttons(html)).toEqual(["Following"]);
    expect(html).toContain('aria-pressed="true"');
  });

  it("uses the agent's labels for its actions and a calm neutral pill for info", () => {
    const html = render(
      deployment({
        kind: "approval",
        status: "info",
        actions: [{ kind: "approve", label: "Ship it", denyLabel: "Hold" }],
      }),
    );
    expect(buttons(html)).toEqual(["Ship it", "Hold"]);
    expect(html).toContain('aria-label="Status: Info"');
  });
});

/**
 * Characterisation (07.2-17): cards that mirror no approval render exactly as before the platform-owned card mirror.
 * The snapshot was recorded on the renderer before 07.2-17 changed it; any difference fails.
 */
describe("AgentCardView: cards without an approval link are unchanged", () => {
  const decided = deployment({
    kind: "approval",
    status: "succeeded",
    decision: {
      outcome: "denied",
      by: { kind: "user", id: "01a11635-d6e7-7c87-9f17-b6b1dc048942", displayName: "Sam Lee" },
      at: "2026-10-07T09:05:00.000Z",
      note: "Not on a Friday",
    },
    viewerCan: ["follow"],
  });
  it.each([
    ["running deployment, decider", deployment()],
    ["decided approval with a note", decided],
    ["info card, no actions", deployment({ status: "info", actions: [], viewerCan: [] })],
    [
      "pending approval, viewer copy not read yet",
      deployment({ kind: "approval", status: "pending", viewerCan: undefined }),
    ],
  ])("%s", (_name, card) => {
    // The decision time is local: the snapshot keeps the markup, not the machine's time zone.
    expect(render(card).replace(/(<time [^>]*>)[^<]*(<\/time>)/g, "$1·TIME$2")).toMatchSnapshot();
  });
});
