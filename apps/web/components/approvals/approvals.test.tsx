import type { ApprovalSummary, WorkZoneProposalView as WorkZoneProposal } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApprovalPill, pillOf, waitingLine } from "./approval-review";
import { ApprovalRow, rowName, sortBox } from "./approvals-inbox";
import {
  DeviceState,
  deviceStateOf,
  failedStartText,
  liveStartBlock,
  startBlockedText,
  WorkZoneProposalView,
} from "./work-zone-proposal-view";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) => (
    <a href={href} {...(rest as object)}>
      {children as never}
    </a>
  ),
}));

/**
 * The `/approvals` inbox rows and the Work Zone proposal review (07.5-12, UI-SPEC Surface 2, R1, R8, R9): what a row
 * says to assistive tech, the device state words, the bot's prompt as plain text, why Start is unavailable, and the
 * waiting line that follows the decision right. Static markup in node; the API decides every decision.
 */

const ME = "01a11635-d6e7-7c87-9f17-000000000001";
const BOT = "01a11635-d6e7-7c87-9f17-000000000002";
const DEVICE = "01a11635-d6e7-7c87-9f17-000000000003";
const PROJECT = "01a11635-d6e7-7c87-9f17-000000000004";
const HASH = "a".repeat(64);
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

function row(over: Partial<ApprovalSummary> = {}): ApprovalSummary {
  return {
    id: "01a11635-d6e7-7c87-9f17-0000000000aa",
    kind: "work_zone.start",
    mode: "server_apply",
    status: "pending",
    actionHash: HASH,
    requestedBy: { agentId: BOT, userId: ME, displayName: "Scout" },
    createdAt: iso(-5 * 60_000 - 2_000),
    expiresAt: iso(23 * 3_600_000),
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    resultCode: null,
    viewerCan: ["decide"],
    headline: {
      title: "Start a session in billing-api",
      context: "MacBook Pro · Claude Code",
      requester: "Scout for Sam Lee",
      tags: [],
      agent: { id: BOT, displayName: "Scout" },
      origin: { kind: "dm", name: null },
      chips: [{ kind: "device", label: "MacBook Pro", state: "online" }],
    },
    ...over,
  };
}

function view(over: Partial<WorkZoneProposal> = {}): WorkZoneProposal {
  return {
    type: "work_zone_proposal",
    title: "Start a session in billing-api",
    project: { id: PROJECT, name: "billing-api", removed: false },
    device: { id: DEVICE, name: "MacBook Pro", online: true, usable: true },
    runtime: { id: "claude-code", label: "Claude Code", available: true },
    mode: "default",
    prompt: "Fix the rounding error.\n\n  see https://x.example <b>now</b>",
    agent: { id: BOT, displayName: "Scout" },
    requestedFor: { id: ME, displayName: "Sam Lee" },
    origin: { kind: "dm", name: null },
    workSessionId: null,
    startBlocked: null,
    ...over,
  };
}

describe("inbox rows", () => {
  it("names a row the way the UI-SPEC says, with 'for you' for the viewer's own request", () => {
    expect(rowName(row(), "review", ME)).toBe(
      "Start a session in billing-api, Scout for you, in DM, 5 minutes ago, MacBook Pro, Online",
    );
    // Someone else's request keeps the server's "{bot} for {person}"; a channel origin names the channel.
    expect(
      rowName(
        row({ headline: { ...row().headline!, origin: { kind: "channel", name: "ops" } } }),
        "review",
        null,
      ),
    ).toBe("Start a session in billing-api, Scout for Sam Lee, in ops, 5 minutes ago, MacBook Pro, Online");
    // Requested and Decided rows add their status.
    expect(rowName(row({ status: "applied" }), "decided", ME)).toMatch(/, Started$/);
  });

  it("renders the row as one named link with the device chip, and no expiry for a fresh request", () => {
    const html = renderToStaticMarkup(
      <ul>
        <ApprovalRow item={row()} box="review" kind="all" meId={ME} selected={false} stacked={false} />
      </ul>,
    );
    expect(html).toContain(
      'aria-label="Start a session in billing-api, Scout for you, in DM, 5 minutes ago, MacBook Pro, Online"',
    );
    expect(html).toContain("MacBook Pro · Online");
    expect(html).toContain("5m ago");
    expect(html).not.toContain("Expires in");
  });

  it("shows 'Expires in {n} min' in amber when under one hour is left", () => {
    const html = renderToStaticMarkup(
      <ul>
        <ApprovalRow
          item={row({ expiresAt: iso(12 * 60_000 - 1_000) })}
          box="review"
          kind="all"
          meId={ME}
          selected={false}
          stacked={false}
        />
      </ul>,
    );
    expect(html).toContain("Expires in 12 min");
    expect(html).toContain("text-amber-800");
  });

  it("sorts To review by expiry and the other tabs newest first, Decided without pending ones", () => {
    const a = row({
      id: "01a11635-d6e7-7c87-9f17-0000000000a1",
      expiresAt: iso(5_000),
      createdAt: iso(-10_000),
    });
    const b = row({
      id: "01a11635-d6e7-7c87-9f17-0000000000a2",
      expiresAt: iso(1_000),
      createdAt: iso(-1_000),
    });
    expect(sortBox("review", [a, b]).map((i) => i.id)).toEqual([b.id, a.id]);
    expect(sortBox("requested", [a, b]).map((i) => i.id)).toEqual([b.id, a.id]);
    expect(sortBox("decided", [a, row({ id: b.id, status: "denied" })]).map((i) => i.id)).toEqual([b.id]);
  });
});

describe("status pills", () => {
  it("labels Work Zone proposals and actions per the UI-SPEC", () => {
    const wz = (s: ApprovalSummary["status"]) => pillOf("work_zone.start", s).label;
    expect(
      ["pending", "approved", "applied", "denied", "failed", "expired"].map((s) => wz(s as never)),
    ).toEqual(["Proposed", "Starting…", "Started", "Dismissed", "Failed", "Expired"]);
    expect(pillOf("tool.call", "applied").label).toBe("Used");
    expect(pillOf("tool.call", "approved", iso(60_000)).label).toBe("Approved");
    expect(pillOf("tool.call", "approved", iso(-60_000)).label).toBe("Not used");
  });

  it("draws the state's glyph (a lucide icon is an object, not a function), and a dot only while pending", () => {
    const failed = renderToStaticMarkup(<ApprovalPill kind="work_zone.start" status="failed" />);
    expect(failed).toContain("lucide-circle-x");
    expect(failed).not.toContain("rounded-full bg-primary");
    expect(renderToStaticMarkup(<ApprovalPill kind="work_zone.start" status="applied" />)).toContain(
      "lucide-circle-check",
    );
    expect(renderToStaticMarkup(<ApprovalPill kind="work_zone.start" status="denied" />)).toContain(
      "lucide-circle-slash",
    );
    expect(renderToStaticMarkup(<ApprovalPill kind="work_zone.start" status="pending" />)).toContain(
      "bg-amber-500",
    );
    // The review header's pill is a status for assistive tech.
    expect(renderToStaticMarkup(<ApprovalPill kind="work_zone.start" status="applied" announce />)).toContain(
      'aria-label="Status: Started"',
    );
  });
});

describe("Work Zone proposal review", () => {
  it("renders the bot's prompt as one plain text node: no link, no markup, whitespace kept", () => {
    const html = renderToStaticMarkup(<WorkZoneProposalView view={view()} device="online" />);
    expect(html).toContain("see https://x.example &lt;b&gt;now&lt;/b&gt;");
    expect(html).not.toMatch(/<a[\s>]/);
    expect(html).not.toContain("<b>");
    expect(html).toContain("whitespace-pre-wrap");
    expect(html).toContain("Written by Scout. Read it before starting: it runs on your device, as you.");
    expect(html).toContain(
      "Bots never choose Full access. You can change the mode after the session starts.",
    );
  });

  it("shows the mode as Supervised, never Default or Full access", () => {
    const html = renderToStaticMarkup(<WorkZoneProposalView view={view()} device="online" />);
    expect(html).toContain("Supervised");
    expect(html).toContain("asks before edits and commands");
    expect(html).not.toMatch(/Full access<\/dd>|>Default</);
  });

  it("words every device state, with the dot hidden from assistive tech", () => {
    const words = (state: Parameters<typeof DeviceState>[0]["state"]) =>
      renderToStaticMarkup(<DeviceState state={state} runtime="Claude Code" />);
    expect(words("online")).toContain("Online");
    expect(words("online")).toMatch(/<span aria-hidden="true" class="[^"]*bg-emerald-500/);
    expect(words("offline")).toContain("Offline");
    expect(words("offline")).toMatch(/<span aria-hidden="true"/);
    expect(words("signed_out")).toContain("Claude Code isn&#x27;t signed in");
    expect(words("not_shared")).toContain("Not shared with you any more");
  });

  it("derives the device state live, falling back to the view", () => {
    const v = view();
    const online = {
      status: "online" as const,
      runtimes: [{ id: "claude-code" as const, installed: true, version: null, loggedIn: true }],
    };
    expect(deviceStateOf(v, online, true)).toBe("online");
    expect(deviceStateOf(v, { ...online, status: "offline" }, true)).toBe("offline");
    expect(
      deviceStateOf(
        v,
        { ...online, runtimes: [{ id: "claude-code", installed: true, version: null, loggedIn: false }] },
        true,
      ),
    ).toBe("signed_out");
    expect(deviceStateOf(v, null, true)).toBe("not_shared");
    expect(deviceStateOf(view({ device: { ...v.device, online: false } }), null, false)).toBe("offline");
  });

  it("says why Start is unavailable, in the server's order, and why a Start failed", () => {
    const v = view();
    expect(liveStartBlock(v, "online", true)).toBeNull();
    expect(liveStartBlock(v, "offline", true)).toBe("device_offline");
    expect(liveStartBlock(view({ startBlocked: "device_offline" }), "online", true)).toBeNull();
    expect(liveStartBlock(view({ project: { ...v.project, removed: true } }), "offline", true)).toBe(
      "project_not_found",
    );
    expect(liveStartBlock(v, "online", false)).toBe("not_allowed");
    expect(startBlockedText("device_offline", v)).toBe(
      "MacBook Pro is offline. You can start it when the device is back.",
    );
    expect(startBlockedText("runtime_unavailable", v)).toBe("Claude Code isn't signed in on MacBook Pro.");
    expect(failedStartText("project_not_found", v)).toBe("This project was removed.");
    expect(failedStartText("something_new", v)).toBe("Couldn't start the session.");
  });

  it("says before Start that the repository belongs to a project the person is not in (07.9 polish)", () => {
    const v = view({ startBlocked: "not_in_project" });
    // The server's order: after the device share, before the device's live state.
    expect(liveStartBlock(v, "online", true)).toBe("not_in_project");
    expect(liveStartBlock(v, "offline", true)).toBe("not_in_project");
    expect(liveStartBlock(v, "not_shared", true)).toBe("device_not_shared");
    expect(liveStartBlock(v, "online", false)).toBe("not_allowed");
    expect(startBlockedText("not_in_project", v)).toBe(
      "billing-api belongs to a project you're not in. Ask one of its leads to add you.",
    );
    expect(failedStartText("not_in_project", v)).toBe("billing-api belongs to a project you're not in.");
  });
});

describe("waiting line", () => {
  it("says 'You can't approve your own request' only when the requester has no decision right", () => {
    const own = row({ viewerCan: [] });
    expect(waitingLine(own, ME, "a lead of Sales")).toBe(
      "Waiting for a lead of Sales. You can't approve your own request.",
    );
    // Self-approval follows the decision right: a requester who holds it is never told they can't.
    expect(waitingLine(row({ viewerCan: ["decide"] }), ME, "a lead of Sales")).toBe(
      "Waiting for a lead of Sales.",
    );
    expect(waitingLine(own, "someone-else", "a lead of Sales")).toBe("Waiting for a lead of Sales.");
  });
});
