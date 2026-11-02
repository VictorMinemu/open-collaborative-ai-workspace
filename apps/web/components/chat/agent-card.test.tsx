import type { AgentCard, AgentCardApprovalLink } from "@ocw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentCardView, cardExpiresIn } from "./agent-card";

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
  if (viewer.me) {
    qc.setQueryData(["me"], {
      user: { id: viewer.me },
      organization: { id: "01a11635-d6e7-7c87-9f17-b6b1dc048900" },
    });
  }
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

  it("a requester who may decide a shared scope (an admin's organization proposal) gets Review changes, Approve and Deny", () => {
    // Owner decision 2026-10-13: the decision right, not who asked, decides who approves.
    const org = memoryCard({
      viewerCan: ["follow", "decide"],
      fields: [
        { label: "Memory", value: "Organization · Everyone" },
        { label: "Readers", value: "12 people" },
        { label: "Found", value: "Nothing found" },
      ],
    });
    const html = render(org, PREVIEW, { me: ME });
    expect(buttons(html)).toEqual(["Approve", "Deny"]);
    expect(hrefs(html)).toEqual([`/memory/proposals/${APPROVAL_ID}`]);
    expect(html).not.toContain("agent-card-waiting");
  });

  it("a requester without the decision right in a shared scope waits for a reviewer, with no Approve", () => {
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
    expect(textOf(html, "agent-card-waiting")).toBe("Waiting for a reviewer");
    expect(html).not.toContain("your own proposal");
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
    ["bot_deleted", "The bot was deleted. Nothing was changed."],
    ["bot_disabled", "The bot is turned off. Nothing was changed."],
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

  // Characterisation (07.5-14, D-04): the 07.5 card kinds must leave a 07.2 memory card's markup byte-identical.
  it.each([
    ["pending, decider", memoryCard()],
    ["pending, requester without the right", memoryCard({ viewerCan: [] })],
    [
      "denied with a note",
      memoryCard(
        {
          status: "cancelled",
          decision: { outcome: "denied", ...SAM_DECIDED, note: "Duplicate of the CRM entry." },
          viewerCan: [],
        },
        { status: "denied" },
      ),
    ],
    [
      "failed, stale",
      memoryCard(
        { status: "failed", decision: { outcome: "approved", ...SAM_DECIDED }, viewerCan: [] },
        { status: "failed", resultCode: "stale_base" },
      ),
    ],
  ])("a 07.2 memory card renders exactly as before: %s", (_name, card) => {
    const html = render(card, PREVIEW, { me: ME, authorName: "Scout" })
      .replace(/(<time [^>]*>)[^<]*(<\/time>)/g, "$1·TIME$2")
      .replace(/_R_[A-Za-z0-9_]+_/g, "_ID_");
    expect(html).toMatchSnapshot();
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

// ---------------------------------------------------------------- 07.5-14: linked tool.call and work_zone.start cards

const OTHER = "01a11635-d6e7-7c87-9f17-b6b1dc048959";
const DEVICE_ID = "01a11635-d6e7-7c87-9f17-b6b1dc048960";
const SESSION_ID = "01a11635-d6e7-7c87-9f17-b6b1dc048961";
const HOUR_MS = 3_600_000;
/** A request posted a moment ago: 24 h minus a minute left, the timer reads "Expires in 24 h". */
const in24h = () => new Date(Date.now() + 24 * HOUR_MS - 60_000).toISOString();
const NOTE_TEXT = "Invoice for September, 3 plants. Payment within 30 days.";

/** The `tool.call` card the server composes in Sam's DM (07.5-07 `composeToolCallCard`, display exact). */
function toolCard(over: Partial<AgentCard> = {}, link: Partial<AgentCardApprovalLink> = {}): AgentCard {
  return {
    kind: "approval",
    title: "Run write_note on Acme CRM",
    fields: [
      { label: "Tool", value: "write_note" },
      { label: "Source", value: "Acme CRM · MCP server" },
      { label: "To", value: "billing@globex.example" },
      { label: "Amount", value: "1250" },
      { label: "Text", value: NOTE_TEXT },
    ],
    status: "pending",
    actions: [
      { kind: "approve", label: "Approve", denyLabel: "Deny" },
      { kind: "open", label: "Review", target: `/approvals/${APPROVAL_ID}` },
    ],
    version: 1,
    decision: null,
    updatedAt: "2026-10-07T09:00:00.000Z",
    viewerCan: ["decide"],
    platformOwned: true,
    approval: {
      id: APPROVAL_ID,
      actionHash: "c".repeat(64),
      status: "pending",
      requestedForUserId: ME,
      warnings: [],
      resultCode: null,
      kind: "tool.call",
      display: "exact",
      expiresAt: in24h(),
      useBy: null,
      usedAt: null,
      waitingFor: "Waiting for Sam Lee to approve",
      actionFields: 2,
      ...link,
    },
    ...over,
  };
}

/** The summary card the server composes everywhere but the requester's own DM (no values, no approve action). */
function summaryCard(over: Partial<AgentCard> = {}, link: Partial<AgentCardApprovalLink> = {}): AgentCard {
  return toolCard(
    {
      title: "Ledger wants to run write_note for Sam Lee",
      fields: [
        { label: "Tool", value: "write_note" },
        { label: "Source", value: "Acme CRM" },
      ],
      actions: [{ kind: "open", label: "Review", target: `/approvals/${APPROVAL_ID}` }],
      viewerCan: [],
      ...over,
    },
    { display: "summary", waitingFor: "Waiting for a lead of Sales", ...link },
  );
}

const TOOL_SUMMARY = "Run write_note on Acme CRM";
const renderTool = (card: AgentCard, me = ME) =>
  render(card, card.title === TOOL_SUMMARY ? TOOL_SUMMARY : `${card.title}. Waiting.`, {
    me,
    authorName: "Ledger",
  });

describe("AgentCardView: a linked tool.call card, exact view (07.5-14, D-02, UI-SPEC Surface 1)", () => {
  it("shows ACTION and WHAT LEDGER WILL SEND, the timer, Review, Approve and Deny for the requester who decides", () => {
    const html = renderTool(toolCard());
    expect(html).toContain('data-testid="agent-card-workspace"');
    expect(html).toContain('aria-label="Status: Pending"');
    expect(html).toMatch(/role="heading" aria-level="4"[^>]*>Action</);
    expect(html).toMatch(/role="heading" aria-level="4"[^>]*>What Ledger will send</);
    expect(textOf(html, "agent-card-action-field-tool")).toBe("write_note");
    expect(textOf(html, "agent-card-action-field-source")).toContain("Acme CRM · MCP server");
    expect(html).toContain("billing@globex.example");
    expect(html).toContain(NOTE_TEXT);
    expect(textOf(html, "agent-card-timer")).toBe("Runs once, with exactly these values · Expires in 24 h");
    expect(buttons(html)).toEqual(["Approve", "Deny"]);
    expect(hrefs(html)).toEqual([`/approvals/${APPROVAL_ID}`]);
    // The 07.2 change preview never renders for an action (the body is the title, never a value).
    expect(html).not.toContain("agent-card-preview");
    // Values are text: never a link, even an email.
    expect(hrefs(html).some((h) => h.startsWith("mailto:"))).toBe(false);
  });

  it("a value with a newline or over 160 characters is a block value that clamps with Show more", () => {
    const long = Array.from({ length: 8 }, (_, i) => `Line ${i + 1}`).join("\n");
    const html = renderTool(
      toolCard({
        fields: [
          { label: "Tool", value: "write_note" },
          { label: "Source", value: "Acme CRM · MCP server" },
          { label: "Text", value: long },
        ],
      }),
    );
    expect(html).toContain('data-testid="agent-card-block-value"');
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>Show more<\/button>/);
  });

  it("a revealed hidden character renders as a named chip with the hidden-characters line", () => {
    const html = renderTool(
      toolCard({
        fields: [
          { label: "Tool", value: "write_note" },
          { label: "Source", value: "Acme CRM · MCP server" },
          { label: "To", value: "billing⟨U+202E⟩@globex.example" },
        ],
      }),
    );
    expect(html).toContain('aria-label="hidden character U+202E"');
    expect(html).toContain("Contains hidden characters, shown as ⟨U+…⟩.");
  });

  it("the taint warning is an amber line", () => {
    const html = renderTool(
      toolCard({}, { warnings: ["Ledger read outside content earlier in this turn. Check the values."] }),
    );
    expect(html).toMatch(/data-testid="agent-card-warning"[^>]*class="[^"]*bg-amber-50/);
    expect(textOf(html, "agent-card-warning")).toBe(
      "Ledger read outside content earlier in this turn. Check the values.",
    );
  });

  it("the requester without the decision right waits (copy from viewerCan) and gets Review only", () => {
    const html = renderTool(toolCard({ viewerCan: [] }, { waitingFor: "Waiting for a lead of Sales" }));
    expect(textOf(html, "agent-card-waiting")).toBe(
      "Waiting for a lead of Sales. You can't approve your own request.",
    );
    expect(buttons(html)).toEqual([]);
    expect(hrefs(html)).toEqual([`/approvals/${APPROVAL_ID}`]);
  });

  it("a requester who holds the right reads no 'own request' sentence (self-approval follows the right)", () => {
    const html = renderTool(toolCard());
    expect(html).not.toContain("your own request");
    expect(html).not.toContain("agent-card-waiting");
  });

  it("review_only: the truncation notice, Review as the primary action and Deny; never Approve", () => {
    const html = renderTool(
      toolCard(
        {},
        {
          display: "review_only",
          warnings: ["Some values are too long for the card. Review them in full before approving."],
        },
      ),
    );
    expect(textOf(html, "agent-card-truncated")).toBe(
      "Some values are too long for the card. Review them in full before approving.",
    );
    expect(buttons(html)).toEqual(["Deny"]);
    // The card cannot show every value, so it never claims "exactly these values".
    expect(textOf(html, "agent-card-timer")).toBe("Runs once · Expires in 24 h");
    expect(html).toMatch(/<a[^>]*data-testid="agent-card-open"[^>]*class="[^"]*bg-primary/);
    expect(html).not.toContain("agent-card-approve");
  });
});

describe("AgentCardView: a linked tool.call card, summary view (07.5-14, D-04, Pitfall 7)", () => {
  it("shows the server's title, Tool and Source, the waiting and privacy lines; Review for the requester", () => {
    const html = renderTool(summaryCard());
    expect(textOf(html, "agent-card-title")).toBe("Ledger wants to run write_note for Sam Lee");
    expect(textOf(html, "agent-card-action-field-tool")).toBe("write_note");
    expect(textOf(html, "agent-card-action-field-source")).toContain("Acme CRM");
    expect(textOf(html, "agent-card-waiting")).toBe("Waiting for a lead of Sales · Expires in 24 h");
    expect(textOf(html, "agent-card-privacy")).toBe("Only Sam Lee and the approvers can see the details.");
    expect(html).not.toMatch(/What Ledger will send/);
    expect(buttons(html)).toEqual([]);
    expect(hrefs(html)).toEqual([`/approvals/${APPROVAL_ID}`]);
  });

  it("a decider reads the card and gets Review only, never an in-card Approve (the server refuses it)", () => {
    const html = renderTool(
      summaryCard({
        viewerCan: ["decide"],
        // Even if an approve action were present, a summary card never offers it.
        actions: [
          { kind: "approve", label: "Approve", denyLabel: "Deny" },
          { kind: "open", label: "Review", target: `/approvals/${APPROVAL_ID}` },
        ],
      }),
      OTHER,
    );
    expect(buttons(html)).toEqual([]);
    expect(hrefs(html)).toEqual([`/approvals/${APPROVAL_ID}`]);
  });

  it("any other reader gets no Review and no buttons, only the privacy line explains why", () => {
    const html = renderTool(summaryCard(), OTHER);
    expect(buttons(html)).toEqual([]);
    expect(hrefs(html)).toEqual([]);
    expect(textOf(html, "agent-card-privacy")).toBe("Only Sam Lee and the approvers can see the details.");
  });
});

describe("AgentCardView: tool.call pills and state lines (07.5-14, UI-SPEC States, R6)", () => {
  const decided = (outcome: "approved" | "denied", note?: string) => ({
    outcome,
    ...SAM_DECIDED,
    ...(note ? { note } : {}),
  });

  it("approved, within the use window: Approved (no ping) and the run-once line", () => {
    const useBy = new Date(Date.now() + 10 * 60_000).toISOString();
    const html = renderTool(
      toolCard({ status: "running", decision: decided("approved") }, { status: "approved", useBy }),
    );
    expect(html).toContain('aria-label="Status: Approved"');
    expect(html).not.toContain("animate-ping");
    expect(textOf(html, "agent-card-state-line")).toMatch(
      /^Ledger runs it once, before \d{1,2}:\d{2}\s?[AP]M\.$/,
    );
    expect(html).toMatch(/Approved by Sam Lee/);
    expect(buttons(html)).toEqual([]);
  });

  it("approved, past the use window: Not used", () => {
    const useBy = new Date(Date.now() - 60_000).toISOString();
    const html = renderTool(
      toolCard({ status: "running", decision: decided("approved") }, { status: "approved", useBy }),
    );
    expect(html).toContain('aria-label="Status: Not used"');
    expect(textOf(html, "agent-card-state-line")).toMatch(
      /^Approved, but Ledger didn't run it before \d{1,2}:\d{2}\s?[AP]M\. Ask again if you still need it\.$/,
    );
  });

  it("applied: Used and the ran-once line", () => {
    const html = renderTool(
      toolCard(
        { status: "succeeded", decision: decided("approved") },
        { status: "applied", usedAt: "2026-10-07T09:07:00.000Z" },
      ),
    );
    expect(html).toContain('aria-label="Status: Used"');
    expect(textOf(html, "agent-card-state-line")).toMatch(/^Ran once at \d{1,2}:\d{2}\s?[AP]M\.$/);
    expect(html).toMatch(/Approved by Sam Lee/);
  });

  it("denied: Denied with the quoted note", () => {
    const html = renderTool(
      toolCard({ status: "cancelled", decision: decided("denied", "Wrong customer") }, { status: "denied" }),
    );
    expect(html).toContain('aria-label="Status: Denied"');
    expect(html).toMatch(/Denied by Sam Lee/);
    expect(textOf(html, "agent-card-note")).toBe("“Wrong customer”");
    expect(buttons(html)).toEqual([]);
  });

  it("a summary or review-only card never shows a decision note, even one a server sent (W-1)", () => {
    const summary = renderTool(
      summaryCard(
        { status: "cancelled", decision: decided("denied", "NOTE-SENTINEL-web-summary") },
        { status: "denied" },
      ),
    );
    expect(summary).toMatch(/Denied by Sam Lee/);
    expect(summary).not.toContain("agent-card-note");
    expect(summary).not.toContain("NOTE-SENTINEL-web-summary");
    const reviewOnly = renderTool(
      toolCard(
        { status: "cancelled", decision: decided("denied", "NOTE-SENTINEL-web-review") },
        { status: "denied", display: "review_only" },
      ),
    );
    expect(reviewOnly).toMatch(/Denied by Sam Lee/);
    expect(reviewOnly).not.toContain("NOTE-SENTINEL-web-review");
  });

  it("expired: Expired and nothing was run", () => {
    const html = renderTool(toolCard({ status: "cancelled" }, { status: "expired" }));
    expect(html).toContain('aria-label="Status: Expired"');
    expect(textOf(html, "agent-card-state-line")).toBe("No one decided within 24 hours. Nothing was run.");
    expect(buttons(html)).toEqual([]);
  });
});

/** The `work_zone` card the server composes for a proposal (07.5-08), as its requester (ME) reads it. */
function wzCard(over: Partial<AgentCard> = {}, link: Partial<AgentCardApprovalLink> = {}): AgentCard {
  return {
    kind: "work_zone",
    title: "Start a session in billing-api",
    fields: [
      { label: "Project", value: "billing-api" },
      { label: "Device", value: "MacBook Pro · Online" },
      { label: "Runtime", value: "Claude Code" },
      { label: "Mode", value: "Supervised" },
      { label: "For", value: "Ana Pérez · proposed by Scout" },
      { label: "Prompt", value: "Fix the rounding error in invoice totals." },
    ],
    status: "pending",
    actions: [
      { kind: "approve", label: "Start session", denyLabel: "Dismiss" },
      { kind: "open", label: "Review", target: `/approvals/${APPROVAL_ID}` },
    ],
    version: 1,
    decision: null,
    updatedAt: "2026-10-07T09:00:00.000Z",
    viewerCan: ["decide"],
    platformOwned: true,
    approval: {
      id: APPROVAL_ID,
      actionHash: "d".repeat(64),
      status: "pending",
      requestedForUserId: ME,
      warnings: [],
      resultCode: null,
      kind: "work_zone.start",
      display: "exact",
      expiresAt: in24h(),
      deviceId: DEVICE_ID,
      resultRoute: null,
      blocked: null,
      ...link,
    },
    ...over,
  };
}

const renderWz = (card: AgentCard, me = ME) =>
  render(card, "Fix the rounding error in invoice totals.", { me, authorName: "Scout" });

describe("AgentCardView: a linked Work Zone proposal card (07.5-14, D-03, UI-SPEC Surface 3, R8, R9)", () => {
  it("the requester reads the fields, the prompt and the mode line, with Review, Start session and Dismiss", () => {
    const html = renderWz(wzCard());
    expect(html).toContain('aria-label="Status: Proposed"');
    expect(textOf(html, "agent-card-wz-project")).toBe("billing-api");
    expect(html).toContain("MacBook Pro");
    expect(textOf(html, "agent-card-wz-runtime")).toBe("Claude Code");
    expect(textOf(html, "agent-card-wz-mode")).toBe("Supervised");
    expect(textOf(html, "agent-card-wz-for")).toBe("Ana Pérez · proposed by Scout");
    expect(html).toContain("Fix the rounding error in invoice totals.");
    expect(textOf(html, "agent-card-wz-mode-line")).toBe(
      "Asks before edits and commands. Bots never choose Full access.",
    );
    expect(html).not.toContain("Full access</");
    expect(buttons(html)).toEqual(["Start session", "Dismiss"]);
    expect(hrefs(html)).toEqual([`/approvals/${APPROVAL_ID}`]);
    expect(html).not.toContain("agent-card-preview");
  });

  it("everyone else reads that only the requester can start it, with no buttons and no Review", () => {
    const html = renderWz(wzCard({ viewerCan: [] }, { blocked: null }), OTHER);
    expect(textOf(html, "agent-card-wz-readonly")).toBe("Only Ana Pérez can start this session.");
    expect(buttons(html)).toEqual([]);
    expect(hrefs(html)).toEqual([]);
  });

  it("an offline device disables Start (aria-disabled, described by the visible reason); Dismiss stays", () => {
    const html = renderWz(
      wzCard(
        {
          fields: wzCard().fields.map((f) =>
            f.label === "Device" ? { ...f, value: "MacBook Pro · Offline" } : f,
          ),
        },
        { blocked: "device_offline" },
      ),
    );
    const reason = "MacBook Pro is offline. You can start it when the device is back.";
    expect(textOf(html, "agent-card-wz-blocked")).toBe(reason);
    const start = /<button[^>]*data-testid="agent-card-start"[^>]*>/.exec(html)?.[0] ?? "";
    expect(start).toContain('aria-disabled="true"');
    const describedBy = /aria-describedby="([^"]+)"/.exec(start)?.[1];
    expect(describedBy).toBeTruthy();
    // The reason line the button points at carries the visible reason (never only a tooltip).
    expect(html).toMatch(new RegExp(`id="${describedBy}"[^>]*data-testid="agent-card-wz-blocked"`));
    expect(buttons(html)).toEqual(["Start session", "Dismiss"]);
  });

  it("approved and applying: Starting…, no buttons", () => {
    const html = renderWz(wzCard({ status: "running" }, { status: "approved" }));
    expect(html).toContain('aria-label="Status: Starting…"');
    expect(buttons(html)).toEqual([]);
  });

  it("applied: Started, the started line and Open session to the result route", () => {
    const html = renderWz(
      wzCard(
        {
          status: "succeeded",
          decision: {
            outcome: "approved",
            ...SAM_DECIDED,
            by: { ...SAM_DECIDED.by, displayName: "Ana Pérez" },
          },
          viewerCan: [],
        },
        { status: "applied", resultRoute: `/work-zone/${SESSION_ID}` },
      ),
      OTHER,
    );
    expect(html).toContain('aria-label="Status: Started"');
    expect(html).toMatch(/Started by Ana Pérez/);
    expect(hrefs(html)).toEqual([`/work-zone/${SESSION_ID}`]);
    expect(html).toMatch(/data-testid="agent-card-open-session"[^>]*>[\s\S]*Open session/);
  });

  it("failed: the reason in words and the follow-up line", () => {
    const html = renderWz(
      wzCard(
        { status: "failed", decision: { outcome: "approved", ...SAM_DECIDED }, viewerCan: [] },
        { status: "failed", resultCode: "project_not_found" },
      ),
    );
    expect(html).toContain('aria-label="Status: Failed"');
    expect(textOf(html, "agent-card-failed-reason")).toBe("This project was removed.");
    expect(textOf(html, "agent-card-wz-followup")).toBe("Ask Scout again when it's fixed.");
  });

  it("denied: Dismissed with the line and the note", () => {
    const html = renderWz(
      wzCard(
        {
          status: "cancelled",
          decision: { outcome: "denied", ...SAM_DECIDED, note: "Not today" },
          viewerCan: [],
        },
        { status: "denied" },
      ),
    );
    expect(html).toContain('aria-label="Status: Dismissed"');
    expect(html).toMatch(/Dismissed by Sam Lee/);
    expect(textOf(html, "agent-card-note")).toBe("“Not today”");
  });

  it("expired: Expired and nobody started it", () => {
    const html = renderWz(wzCard({ status: "cancelled" }, { status: "expired" }));
    expect(html).toContain('aria-label="Status: Expired"');
    expect(textOf(html, "agent-card-state-line")).toBe("No one started it within 24 hours.");
    expect(buttons(html)).toEqual([]);
  });
});

describe("cardExpiresIn (UI-SPEC Timer)", () => {
  const now = Date.parse("2026-10-15T10:00:00.000Z");
  const at = (ms: number) => new Date(now + ms).toISOString();
  it.each([
    [24 * HOUR_MS - 5_000, "Expires in 24 h"],
    [23 * HOUR_MS + 20 * 60_000, "Expires in 23 h"],
    [HOUR_MS + 60_000, "Expires in 1 h"],
    [59 * 60_000 + 30_000, "Expires in 1 h"],
    [59 * 60_000, "Expires in 59 min"],
    [12 * 60_000, "Expires in 12 min"],
    [-1, "Expired"],
  ])("%d ms left → %s", (left, text) => {
    expect(cardExpiresIn(at(left), now)).toBe(text);
  });
});

// ---------------------------------------------------------------- 07.8-20: signed-in browser actions (Surface 6, R8)

const in15min = () => new Date(Date.now() + 15 * 60_000 - 20_000).toISOString();

/** The browser card the server composes in Sam's DM (07.8-14 `composeToolCallCard`, R8 fields, display exact). */
function browserCard(over: Partial<AgentCard> = {}, link: Partial<AgentCardApprovalLink> = {}): AgentCard {
  return toolCard(
    {
      title: "Type into “Email” on shop.fake.test",
      fields: [
        { label: "Action", value: "Type" },
        { label: "Element", value: "textbox “Email”" },
        { label: "Page", value: "shop.fake.test" },
        { label: "Session", value: "Signed in as you" },
        { label: "Value", value: "sam.lee@shop.example" },
      ],
      ...over,
    },
    {
      actionFields: 0,
      expiresAt: in15min(),
      waitingFor: "Waiting for Sam Lee to approve",
      browser: { action: "type", host: "shop.fake.test", secure: true, signedIn: true },
      ...link,
    },
  );
}
const renderBrowser = (card: AgentCard, me = ME) =>
  render(card, `${card.title}. Waiting.`, { me, authorName: "Scout" });

describe("AgentCardView: a signed-in browser action (07.8-20, UI-SPEC Surface 6, R8)", () => {
  it("exact view: Action, Element, Page as the host chip, Session, What Scout will type, the explanation and the timer", () => {
    const html = renderBrowser(browserCard());
    expect(html).toContain(">Type into “Email” on shop.fake.test<");
    expect(html).toMatch(/role="heading" aria-level="4"[^>]*>Action</);
    expect(html).toMatch(/role="heading" aria-level="4"[^>]*>What Scout will type</);
    expect(html).not.toContain("What Scout will send");
    expect(textOf(html, "agent-card-action-field-action")).toBe("Type");
    expect(textOf(html, "agent-card-action-field-element")).toBe("textbox “Email”");
    const page = /data-testid="agent-card-action-field-page"[\s\S]*?<\/dd>/.exec(html)?.[0] ?? "";
    expect(page).toContain('data-testid="host-chip"');
    expect(page).toContain('data-secure="true"');
    expect(page).toContain("lucide-lock-keyhole");
    expect(textOf(html, "agent-card-action-field-session")).toBe("Signed in as you");
    expect(textOf(html, "agent-card-value-field-value")).toBe("sam.lee@shop.example");
    expect(textOf(html, "agent-card-browser-why")).toBe(
      "Scout is signed in to shop.fake.test with your account, so it asks before acting.",
    );
    expect(textOf(html, "agent-card-timer")).toBe("Runs once, while the page is open · Expires in 15 min");
    expect(buttons(html)).toEqual(["Approve", "Deny"]);
  });

  it("an http page reads “Not secure” as a word in the Page field", () => {
    const html = renderBrowser(
      browserCard(
        {},
        { browser: { action: "click", host: "intranet.fake.test", secure: false, signedIn: true } },
      ),
    );
    const page = /data-testid="agent-card-action-field-page"[\s\S]*?<\/dd>/.exec(html)?.[0] ?? "";
    expect(page).toContain('data-secure="false"');
    expect(page).toContain("Not secure");
    expect(page).toContain("intranet.fake.test");
  });

  it("a click has no type section; expired says what was not clicked or typed", () => {
    const click = browserCard(
      {
        title: "Click “Place order” on shop.fake.test",
        fields: [
          { label: "Action", value: "Click" },
          { label: "Element", value: "button “Place order”" },
          { label: "Page", value: "shop.fake.test" },
          { label: "Session", value: "Signed in as you" },
        ],
      },
      { browser: { action: "click", host: "shop.fake.test", secure: true, signedIn: true } },
    );
    expect(renderBrowser(click)).not.toContain("will type");
    const expired = (card: AgentCard) =>
      renderBrowser({
        ...card,
        approval: { ...(card.approval as AgentCardApprovalLink), status: "expired" },
      });
    expect(textOf(expired(click), "agent-card-state-line")).toBe(
      "No one decided within 15 minutes. Nothing was clicked.",
    );
    expect(textOf(expired(browserCard()), "agent-card-state-line")).toBe(
      "No one decided within 15 minutes. Nothing was typed.",
    );
  });

  it("approved but the page closed or changed: Not used with the browser line", () => {
    const html = renderBrowser(
      browserCard(
        {
          decision: {
            outcome: "approved",
            by: { kind: "user", id: ME, displayName: "Sam Lee" },
            at: new Date(Date.now() - 20 * 60_000).toISOString(),
          },
        },
        { status: "approved", useBy: new Date(Date.now() - 5 * 60_000).toISOString() },
      ),
    );
    expect(html).toContain('aria-label="Status: Not used"');
    expect(textOf(html, "agent-card-state-line")).toBe(
      "The page closed or changed before Scout could do it. Ask again if you still need it.",
    );
  });

  it("summary view for any other reader: who wants to click where for whom; no element, value, chip or explanation", () => {
    const html = renderBrowser(
      browserCard(
        {
          title: "Scout wants to click on shop.fake.test for Sam Lee",
          fields: [
            { label: "Tool", value: "ocw_browser_act" },
            { label: "Source", value: "Browser" },
          ],
          actions: [{ kind: "open", label: "Review", target: `/approvals/${APPROVAL_ID}` }],
          viewerCan: [],
        },
        {
          display: "summary",
          requestedForUserId: OTHER,
          browser: { action: "click", host: "shop.fake.test", secure: true, signedIn: true },
        },
      ),
    );
    expect(html).toContain(">Scout wants to click on shop.fake.test for Sam Lee<");
    expect(textOf(html, "agent-card-privacy")).toBe("Only Sam Lee and the approvers can see the details.");
    expect(html).not.toContain("agent-card-browser-why");
    expect(html).not.toContain('data-testid="host-chip"');
    expect(html).not.toContain("Element");
    expect(buttons(html)).toEqual([]);
  });
});

// ---------------------------------------------------------------- 07.6-15: server-composed cards (R1, AUTO-03)

const AUTOMATION_ID = "01a11635-d6e7-7c87-9f17-b6b1dc048970";
const RUN_ID = "01a11635-d6e7-7c87-9f17-b6b1dc048971";

/** A platform-owned automation run card (07.6-09, UI-SPEC Surface 8a) as the server composes it. */
function runCard(over: Partial<AgentCard> = {}): AgentCard {
  return {
    kind: "automation",
    title: "Weekly sales report",
    fields: [
      { label: "For", value: "Víctor Ruiz" },
      { label: "Trigger", value: "Scheduled" },
      { label: "Schedule", value: "Fridays at 5:00 PM · Europe/Madrid" },
    ],
    status: "running",
    actions: [
      {
        kind: "open",
        label: "Open automation",
        target: `/bots/automations?edit=${AUTOMATION_ID}&run=${RUN_ID}`,
      },
      { kind: "follow", label: "Follow" },
    ],
    version: 1,
    decision: null,
    updatedAt: "2026-10-23T15:00:01.000Z",
    following: false,
    viewerCan: ["follow"],
    platformOwned: true,
    statusLabel: "Running",
    ...over,
  };
}

const notesOf = (html: string) =>
  [...html.matchAll(/<p[^>]*data-testid="agent-card-notice"[^>]*>[\s\S]*?<\/p>/g)].map((m) => m[0]);

describe("AgentCardView: platform-owned cards carry the server's statusLabel and notices (07.6-15, R1)", () => {
  it("the pill says the server's word with the status's tone, and the workspace badge shows", () => {
    const html = render(
      runCard({ status: "failed", statusLabel: "No reply" }),
      "Scheduled task “Weekly sales report” for Víctor Ruiz.",
    );
    expect(html).toContain('aria-label="Status: No reply"');
    expect(html).toContain('data-status="failed"');
    expect(html).toMatch(/bg-red-100[^"]*"[^>]*>[\s\S]*?No reply<\/span>/);
    expect(html).toContain('data-testid="agent-card-workspace"');
    expect(hrefs(html)).toEqual([`/bots/automations?edit=${AUTOMATION_ID}&amp;run=${RUN_ID}`]);
    expect(html).toContain(">Open automation<");
  });

  it("a neutral notice is a muted line; a warning is amber with role note, between the title and the fields", () => {
    const html = render(
      runCard({
        status: "failed",
        statusLabel: "No reply",
        notices: [
          {
            tone: "warning",
            text: "Started by outside content. Scout can read it but needs approval to act.",
          },
          { tone: "neutral", text: "Scout didn't answer within 15 minutes." },
        ],
      }),
    );
    const [warning, neutral] = notesOf(html);
    expect(warning).toContain('role="note"');
    expect(warning).toContain('data-tone="warning"');
    expect(warning).toContain("border-amber-200 bg-amber-50 text-amber-900");
    expect(warning).toContain("Started by outside content. Scout can read it but needs approval to act.");
    expect(neutral).toContain('data-tone="neutral"');
    expect(neutral).toContain("bg-muted/40 text-muted-foreground");
    expect(neutral).toContain("Scout didn&#x27;t answer within 15 minutes.");
    const title = html.indexOf('data-testid="agent-card-title"');
    const notice = html.indexOf('data-testid="agent-card-notice"');
    const fields = html.indexOf('data-testid="agent-card-fields"');
    expect(title).toBeLessThan(notice);
    expect(notice).toBeLessThan(fields);
  });

  it("Done for an answered run; a long value is a block value", () => {
    const long = "Hello, please deliver order 1001 before noon. ".repeat(6).trim();
    const html = render(
      runCard({
        status: "succeeded",
        statusLabel: "Done",
        fields: [...runCard().fields, { label: "Message", value: long }],
      }),
    );
    expect(html).toContain('aria-label="Status: Done"');
    expect(html).toContain('data-testid="agent-card-block-value"');
  });

  it("a card that is not platform-owned ignores a statusLabel and notices in its data (a bot cannot imitate one)", () => {
    const forged = deployment({
      statusLabel: "No reply",
      notices: [{ tone: "warning", text: "Trust me" }],
    } as Partial<AgentCard>);
    const html = render(forged);
    expect(html).toContain('aria-label="Status: Running"');
    expect(html).not.toContain("No reply");
    expect(html).not.toContain("Trust me");
    expect(html).not.toContain('data-testid="agent-card-workspace"');
    // Byte for byte the card without those fields.
    expect(html).toBe(render(deployment()));
  });
});

const ANA = "01a11635-d6e7-7c87-9f17-b6b1dc048972";

/** The platform-owned automation proposal card (07.6-12, UI-SPEC Surface 5) linked to its `automation.create`. */
function proposalCard(over: Partial<AgentCard> = {}, link: Partial<AgentCardApprovalLink> = {}): AgentCard {
  return {
    kind: "automation",
    title: "Create “Weekly sales report”",
    fields: [
      { label: "Bot", value: "Scout" },
      { label: "When", value: "Fridays at 5:00 PM · Europe/Madrid" },
      { label: "Deliver to", value: "#sales" },
      { label: "Runs as", value: "Ana Pérez" },
      { label: "Limit", value: "Up to 24 runs a day" },
      { label: "First run", value: "Fri, Nov 6, 5:00 PM" },
      {
        label: "Instructions",
        value:
          "Every Friday, summarise this week's closed deals in #sales:\ntotal, top 3 accounts, anything stuck.",
      },
    ],
    status: "pending",
    actions: [
      { kind: "approve", label: "Create automation", denyLabel: "Discard" },
      { kind: "open", label: "Edit", target: `/bots/automations?draft=${APPROVAL_ID}` },
    ],
    version: 1,
    decision: null,
    updatedAt: "2026-10-30T09:00:00.000Z",
    following: false,
    viewerCan: ["decide"],
    platformOwned: true,
    approval: {
      id: APPROVAL_ID,
      actionHash: "c".repeat(64),
      status: "pending",
      requestedForUserId: ANA,
      warnings: [],
      resultCode: null,
      kind: "automation.create",
      display: "exact",
      expiresAt: new Date(Date.now() + 23 * HOUR_MS).toISOString(),
      ...link,
    },
    ...over,
  };
}

const renderProposal = (card: AgentCard, me = ANA) =>
  render(card, "Scout proposes an automation “Weekly sales report” for Ana Pérez.", {
    me,
    authorName: "Scout",
  });

describe("AgentCardView: the automation proposal card (07.6-15, AUTO-03, UI-SPEC Surface 5)", () => {
  it("pending, for the person it runs as: Proposed, the fields, the line, Edit · Create automation · Discard", () => {
    const html = renderProposal(proposalCard());
    expect(html).toContain('aria-label="Status: Proposed"');
    expect(html).toContain('data-testid="agent-card-workspace"');
    expect(html).toContain("Fridays at 5:00 PM · Europe/Madrid");
    expect(html).toContain('data-testid="agent-card-block-value"');
    expect(textOf(html, "agent-card-automation-line")).toBe(
      "Scout proposed this. Nothing runs until Ana Pérez confirms.",
    );
    expect(buttons(html)).toEqual(["Create automation", "Discard"]);
    expect(hrefs(html)).toEqual([`/bots/automations?draft=${APPROVAL_ID}`]);
    expect(html).toMatch(/data-testid="agent-card-open"[^>]*>[\s\S]*?Edit/);
  });

  it("pending, for everyone else: only the person it runs as can confirm; no buttons, no Edit", () => {
    const html = renderProposal(proposalCard({ viewerCan: [] }), OTHER);
    expect(textOf(html, "agent-card-automation-readonly")).toBe(
      "Only Ana Pérez can confirm this automation.",
    );
    expect(buttons(html)).toEqual([]);
    expect(hrefs(html)).toEqual([]);
  });

  it.each([
    ["applied", {}, "Created"],
    ["applied", { edited: true }, "Created with changes"],
    ["denied", {}, "Discarded"],
    ["expired", {}, "Expired"],
    ["failed", { resultCode: "automation_cap" }, "Failed"],
  ] as const)("%s %o reads %s", (status, extra, label) => {
    const html = renderProposal(proposalCard({ viewerCan: [] }, { status, ...extra }));
    expect(html).toContain(`aria-label="Status: ${label}"`);
    expect(buttons(html)).toEqual([]);
  });

  it("created: Created by {person} · {date} and Open automation to the result route", () => {
    const html = renderProposal(
      proposalCard(
        {
          viewerCan: [],
          decision: {
            outcome: "approved",
            by: { kind: "user", id: ANA, displayName: "Ana Pérez" },
            at: "2026-10-30T09:05:00.000Z",
          },
        },
        { status: "applied", resultRoute: `/bots/automations?edit=${AUTOMATION_ID}` },
      ),
    );
    expect(html).toMatch(/Created by Ana Pérez/);
    expect(hrefs(html)).toEqual([`/bots/automations?edit=${AUTOMATION_ID}`]);
    expect(html).toContain(">Open automation<");
    expect(html).not.toContain("agent-card-automation-line");
  });

  it("discarded: Discarded by {person}", () => {
    const html = renderProposal(
      proposalCard(
        {
          viewerCan: [],
          decision: {
            outcome: "denied",
            by: { kind: "user", id: ANA, displayName: "Ana Pérez" },
            at: "2026-10-30T09:05:00.000Z",
          },
        },
        { status: "denied" },
      ),
    );
    expect(html).toMatch(/Discarded by Ana Pérez/);
  });

  it("expired: nobody confirmed it within 24 hours", () => {
    const html = renderProposal(proposalCard({ viewerCan: [] }, { status: "expired" }));
    expect(textOf(html, "agent-card-state-line")).toBe("No one confirmed it within 24 hours.");
  });

  it("failed: the reason in words and the follow-up line", () => {
    const html = renderProposal(
      proposalCard({ viewerCan: [] }, { status: "failed", resultCode: "target_not_postable" }),
    );
    expect(textOf(html, "agent-card-failed-reason")).toBe("Scout can no longer post in #sales.");
    expect(textOf(html, "agent-card-automation-followup")).toBe("Ask Scout again when it's fixed.");
    for (const [code, sentence] of [
      ["schedule_too_frequent", "That schedule is too frequent for this workspace."],
      ["agent_unavailable", "Scout isn't available any more."],
    ] as const) {
      const h = renderProposal(proposalCard({ viewerCan: [] }, { status: "failed", resultCode: code }));
      expect(textOf(h, "agent-card-failed-reason"), code).toBe(sentence);
    }
  });
});
