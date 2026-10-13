import type { AgentCard, AgentCardApprovalLink } from "@ocw/contracts";
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

function render(
  card: AgentCard,
  summary = "Deploying api v2.3 to production",
  viewer: { me?: string; authorName?: string } = {},
): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The signed-in person, as the app shell caches it (`useMe`).
  if (viewer.me) qc.setQueryData(["me"], { user: { id: viewer.me } });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AgentCardView
        messageId={MESSAGE_ID}
        card={card}
        summary={summary}
        {...(viewer.authorName ? { authorName: viewer.authorName } : {})}
      />
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

// ---------------------------------------------------------------- 07.2-17: cards that mirror an approval

const ME = "01a11635-d6e7-7c87-9f17-b6b1dc048950";
const APPROVAL_ID = "01a11635-d6e7-7c87-9f17-b6b1dc048951";
const TAINT = "Scout read web or tool content in this turn.";

/** A platform-owned memory proposal card as the server composes it (07.2-09), linked to its approval (07.2-06). */
function memoryCard(over: Partial<AgentCard> = {}, link: Partial<AgentCardApprovalLink> = {}): AgentCard {
  return {
    kind: "approval",
    title: "Append to MEMORY.md",
    fields: [
      { label: "Memory", value: "You & Scout · Private" },
      { label: "Readers", value: "Only you" },
      { label: "Found", value: "Nothing found" },
    ],
    status: "pending",
    actions: [
      { kind: "approve", label: "Approve", denyLabel: "Deny" },
      { kind: "open", label: "Review changes", target: `/memory/proposals/${APPROVAL_ID}` },
    ],
    version: 1,
    decision: null,
    updatedAt: "2026-10-07T09:00:00.000Z",
    following: false,
    viewerCan: ["decide"],
    platformOwned: true,
    approval: {
      id: APPROVAL_ID,
      actionHash: "b".repeat(64),
      status: "pending",
      requestedForUserId: ME,
      warnings: [TAINT],
      resultCode: null,
      ...link,
    },
    ...over,
  };
}

const PREVIEW = "+ \n+ - Pumps: 3 plants";
const SAM_DECIDED = {
  by: { kind: "user" as const, id: ME, displayName: "Sam Lee" },
  at: "2026-10-07T09:05:00.000Z",
};
/** The visible text of the element with `data-testid`, tags stripped. */
const textOf = (html: string, testId: string) =>
  (new RegExp(`data-testid="${testId}"[^>]*>([\\s\\S]*?)</(p|span|div)>`).exec(html)?.[1] ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();

describe("AgentCardView: a platform-owned card that mirrors an approval (07.2-17)", () => {
  it("shows the workspace badge with its description, the visible preview and the taint line as an amber warning", () => {
    const html = render(memoryCard(), PREVIEW, { me: ME });
    expect(html).toContain('data-testid="agent-card-workspace"');
    expect(html).toContain("Created by the workspace");
    const describedBy =
      /data-testid="agent-card-workspace"[^>]*aria-describedby="([^"]+)"|aria-describedby="([^"]+)"[^>]*data-testid="agent-card-workspace"/.exec(
        html,
      );
    const id = describedBy?.[1] ?? describedBy?.[2];
    expect(id).toBeTruthy();
    expect(html).toMatch(new RegExp(`id="${id}"[^>]*>This card was made by the workspace, not by the bot.<`));
    expect(html).toContain('data-testid="agent-card-preview"');
    expect(html).toContain("- Pumps: 3 plants");
    expect(html).toMatch(/data-testid="agent-card-warning"[^>]*class="[^"]*bg-amber-50/);
    expect(textOf(html, "agent-card-warning")).toBe(TAINT);
    expect(html).toContain('data-approval-status="pending"');
  });

  it("caps the preview at 6 lines with “+{n} more lines”, hidden from screen readers (the summary describes the card)", () => {
    const long = Array.from({ length: 8 }, (_, i) => `+ line ${i + 1}`).join("\n");
    const html = render(memoryCard(), long, { me: ME });
    expect(html).toContain("line 6");
    expect(html).not.toContain("line 7</div>");
    expect(html).toContain("+2 more lines");
    expect(html).toMatch(/data-testid="agent-card-preview" aria-hidden="true"/);
  });

  it.each([
    ["pending", "Pending"],
    ["applied", "Applied"],
    ["denied", "Denied"],
    ["failed", "Failed"],
    ["expired", "Expired"],
  ] as const)("the pill reads the approval's status: %s → %s", (status, label) => {
    // The card's own status says something else on purpose: the approval decides the label.
    const html = render(memoryCard({ status: "running" }, { status }), PREVIEW, { me: ME });
    expect(html).toContain(`aria-label="Status: ${label}"`);
    expect(html).toContain(`data-status="${status}"`);
  });

  it("the decider gets Review changes, Approve and Deny", () => {
    const html = render(memoryCard(), PREVIEW, { me: ME });
    expect(buttons(html)).toEqual(["Approve", "Deny"]);
    expect(hrefs(html)).toEqual([`/memory/proposals/${APPROVAL_ID}`]);
  });

  it("a requester in a shared scope reads that they can't approve their own proposal, and gets no Approve", () => {
    const shared = memoryCard({
      viewerCan: [],
      fields: [
        { label: "Memory", value: "Ventas · Team" },
        { label: "Readers", value: "4 people" },
        { label: "Found", value: "Nothing found" },
      ],
    });
    const html = render(shared, PREVIEW, { me: ME });
    expect(buttons(html)).toEqual([]);
    expect(textOf(html, "agent-card-waiting")).toBe(
      "Waiting for a reviewer. You can't approve your own proposal.",
    );
    expect(hrefs(html)).toEqual([`/memory/proposals/${APPROVAL_ID}`]);
  });

  it("another reader waits for a reviewer and is not offered the review", () => {
    const html = render(memoryCard({ viewerCan: [] }), PREVIEW, {
      me: "01a11635-d6e7-7c87-9f17-b6b1dc048959",
    });
    expect(buttons(html)).toEqual([]);
    expect(textOf(html, "agent-card-waiting")).toBe("Waiting for a reviewer");
    expect(hrefs(html)).toEqual([]);
  });

  it("an expired proposal offers no Approve, even to a decider", () => {
    const html = render(memoryCard({}, { status: "expired" }), PREVIEW, { me: ME });
    expect(html).toContain('aria-label="Status: Expired"');
    expect(buttons(html)).toEqual([]);
    expect(html).not.toContain("agent-card-waiting");
  });

  it("a stale failure says why in words, naming the bot; the decision line stays", () => {
    const html = render(
      memoryCard(
        { status: "failed", decision: { outcome: "approved", ...SAM_DECIDED }, viewerCan: [] },
        { status: "failed", resultCode: "stale_base" },
      ),
      PREVIEW,
      { me: ME, authorName: "Scout" },
    );
    expect(html).toContain('aria-label="Status: Failed"');
    expect(textOf(html, "agent-card-failed-reason")).toBe(
      "The file changed since this proposal. Ask Scout to propose again.",
    );
    expect(html).toMatch(/Approved by Sam Lee/);
  });

  it.each([
    ["path_exists", "A file with this name was created since this proposal."],
    ["scope_gone", "This memory no longer exists."],
    ["secret_detected", "Not applied: the text contains a secret."],
    ["scope_full", "This memory is full (2,000 files)."],
    ["too_large", "The file would be over 256 KB."],
    ["apply_failed", "Couldn't apply this change."],
    [null, "Couldn't apply this change."],
  ])("failed reason %s", (resultCode, copy) => {
    const html = render(memoryCard({ status: "failed" }, { status: "failed", resultCode }), PREVIEW, {
      me: ME,
    });
    expect(textOf(html, "agent-card-failed-reason")).toBe(copy);
  });

  it("a decided card shows the decision line and the quoted note; Denied in muted tones", () => {
    const html = render(
      memoryCard(
        {
          status: "cancelled",
          decision: { outcome: "denied", ...SAM_DECIDED, note: "Duplicate of the CRM entry." },
          viewerCan: [],
        },
        { status: "denied" },
      ),
      PREVIEW,
      { me: ME },
    );
    expect(html).toContain('aria-label="Status: Denied"');
    expect(html).toMatch(/data-testid="agent-card-status"[^>]*class="[^"]*bg-muted text-muted-foreground/);
    expect(html).toMatch(/Denied by Sam Lee/);
    expect(textOf(html, "agent-card-note")).toBe("“Duplicate of the CRM entry.”");
    expect(buttons(html)).toEqual([]);
  });

  it("an approval link without the server's platformOwned flag gets no badge and no approval UI (T-07.2-17-01)", () => {
    const forged = memoryCard({ platformOwned: undefined });
    const html = render(forged, PREVIEW, { me: ME });
    expect(html).not.toContain("agent-card-workspace");
    expect(html).not.toContain("agent-card-preview");
    expect(html).not.toContain("agent-card-warning");
    expect(html).not.toContain("data-approval-status");
    // The ordinary card: the card's own status and the agent's labels.
    expect(html).toContain('aria-label="Status: Pending"');
    expect(buttons(html)).toEqual(["Approve", "Deny"]);
  });
});
