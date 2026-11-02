import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionMemorySummary } from "@ocw/contracts";
import type { TopicFrame } from "@ocw/realtime-client";
import { QueryClient } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api";
import {
  applyApprovalUpdatedToMemory,
  applyWorkMemoryFrame,
  applyWorkSessionMemoryUpdated,
  workMemoryKeys,
} from "@/lib/work-memory-queries";
import { PROPOSE_COPY, payerOf } from "./propose-summary-dialog";
import {
  isFinished,
  LINK_REPOS_HREF,
  proposeErrorText,
  SessionMemoryStripView,
  STRIP_COPY,
  stripModel,
} from "./session-memory-strip";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) => (
    <a href={href} {...(rest as object)}>
      {children as never}
    </a>
  ),
}));

/**
 * The Work Zone → memory strip (07.6-22, AUTO-06; D-06 as amended by D-10, D-07, D-11; UI-SPEC Surface 9): every
 * `SessionMemoryStatus` as the owner and as another reader of the session, as static markup, plus the user-stream
 * handlers. The API decides the state and who may propose or link; the strip only renders what it returns.
 */

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
/** Visible words only (tags stripped, entities of the copy decoded). */
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

const SESSION = "01a11635-d6e7-7c87-9f17-0000000000a1";
const OTHER_SESSION = "01a11635-d6e7-7c87-9f17-0000000000a2";
const UNIT = "01a11635-d6e7-7c87-9f17-0000000000b1";
const PROPOSAL = "01a11635-d6e7-7c87-9f17-0000000000c1";
const MARTA = "01a11635-d6e7-7c87-9f17-0000000000d1";

const summary = (over: Partial<SessionMemorySummary> = {}): SessionMemorySummary => ({
  status: "none",
  unit: { id: UNIT, name: "Billing" },
  proposalId: null,
  auto: false,
  nothingNew: false,
  decidedBy: null,
  decisionNote: null,
  canPropose: true,
  canMap: false,
  model: { label: "Claude Haiku 4.5", metered: true, plan: false },
  ...over,
});

const reader = (over: Partial<SessionMemorySummary> = {}) =>
  summary({ canPropose: false, model: null, ...over });

function render(s: SessionMemorySummary, fileHref: string | null = null): string | null {
  const model = stripModel(s, { fileHref });
  if (!model) return null;
  return html(
    <SessionMemoryStripView model={model} autoOn={false} onPropose={() => {}} onAutoChange={() => {}} />,
  );
}

const must = (markup: string | null): string => {
  expect(markup).not.toBeNull();
  return markup as string;
};

describe("SessionMemoryStripView: the owner (canPropose)", () => {
  it("Ready: the line names the team project and offers Propose to memory and the ⋯ menu", () => {
    const m = must(render(summary()));
    expect(m).toContain('data-testid="session-memory-strip"');
    expect(m).toContain('aria-label="Project memory"');
    expect(m).toContain('role="status"');
    expect(text(m)).toContain("Save what this session learned to Billing memory.");
    expect(m).toContain('data-testid="session-memory-propose"');
    expect(text(m)).toContain("Propose to memory");
    expect(m).toContain(`aria-label="${STRIP_COPY.menu}"`);
  });

  it("Nothing new: the Propose button is aria-disabled and described by the line", () => {
    const m = must(render(summary({ nothingNew: true })));
    expect(text(m)).toContain("Already proposed. Nothing new since then.");
    const button = /<button[^>]*data-testid="session-memory-propose"[^>]*>/u.exec(m)?.[0] ?? "";
    expect(button).toContain('aria-disabled="true"');
    const describedBy = /aria-describedby="([^"]+)"/u.exec(button)?.[1];
    expect(describedBy).toBeTruthy();
    expect(m).toContain(`id="${describedBy}"`);
  });

  it("Writing: the line with a spinner and no action", () => {
    const m = must(render(summary({ status: "writing" })));
    expect(text(m)).toContain("Writing a summary…");
    expect(m).toContain("animate-spin");
    expect(m).not.toContain('data-testid="session-memory-propose"');
  });

  it("Pending: Proposed to {Unit} memory, the Pending review pill and Review → to the proposal", () => {
    const m = must(render(summary({ status: "pending", proposalId: PROPOSAL, nothingNew: true })));
    expect(text(m)).toContain("Proposed to Billing memory · Pending review");
    expect(m).toContain(`href="/memory/proposals/${PROPOSAL}"`);
    expect(text(m)).toContain("Review");
  });

  it("Pending, automatic: Proposed automatically to {Unit} memory", () => {
    const m = must(render(summary({ status: "pending", proposalId: PROPOSAL, auto: true })));
    expect(text(m)).toContain("Proposed automatically to Billing memory · Pending review");
  });

  it("Applied: Saved to {Unit} memory, the Applied pill, the decider and Open → (the file once known)", () => {
    const s = summary({
      status: "applied",
      proposalId: PROPOSAL,
      decidedBy: { id: MARTA, displayName: "Marta Gil" },
    });
    const m = must(render(s, "/memory/scope-1/work-zone/2026-11-02-fix.md"));
    expect(text(m)).toContain("Saved to Billing memory · Applied by Marta Gil");
    expect(m).toContain('href="/memory/scope-1/work-zone/2026-11-02-fix.md"');
    expect(text(m)).toContain("Open");
    // Before the file is known, Open → goes to the proposal (whose review links the file).
    expect(must(render(s))).toContain(`href="/memory/proposals/${PROPOSAL}"`);
  });

  it("Denied: the decider and their note in curly quotes, no action", () => {
    const m = must(
      render(
        summary({
          status: "denied",
          proposalId: PROPOSAL,
          decidedBy: { id: MARTA, displayName: "Marta Gil" },
          decisionNote: "Too vague",
        }),
      ),
    );
    expect(text(m)).toContain("Not saved: Marta Gil declined it.");
    expect(text(m)).toContain("“Too vague”");
    expect(m).not.toContain('data-testid="session-memory-review"');
  });

  it("Failed: the red line and Try again (which opens the confirmation, never a request)", () => {
    const m = must(render(summary({ status: "failed" })));
    expect(text(m)).toContain("Couldn't write the summary. Nothing was saved.");
    expect(m).toContain("text-red-700");
    expect(m).toContain('data-testid="session-memory-retry"');
  });

  it("Not mapped with canMap: Link it → to 07.9's Projects index (D-10)", () => {
    const m = must(render(summary({ status: "unmapped", unit: null, canMap: true })));
    expect(text(m)).toContain("This repository isn't linked to a project's memory.");
    expect(LINK_REPOS_HREF).toBe("/work-zone/projects");
    expect(m).toContain('href="/work-zone/projects"');
    expect(text(m)).toContain("Link it");
    expect(text(m)).not.toContain("Ask a lead");
  });

  it("Not mapped without canMap: Ask a lead to link it., no link", () => {
    const m = must(render(summary({ status: "unmapped", unit: null, canMap: false })));
    expect(text(m)).toContain("Ask a lead to link it.");
    expect(m).not.toContain('href="/work-zone/projects"');
  });
});

describe("SessionMemoryStripView: another reader of the session (canPropose false)", () => {
  it("no strip while nothing was proposed (only the owner proposes and pays), nor for the owner's failure", () => {
    expect(render(reader())).toBeNull();
    expect(render(reader({ nothingNew: true }))).toBeNull();
    expect(render(reader({ status: "failed" }))).toBeNull();
  });

  it("status lines only: Pending, Applied and Denied without buttons or the ⋯ menu", () => {
    const pending = must(render(reader({ status: "pending", proposalId: PROPOSAL })));
    expect(text(pending)).toContain("Proposed to Billing memory · Pending review");
    const applied = must(
      render(
        reader({
          status: "applied",
          proposalId: PROPOSAL,
          decidedBy: { id: MARTA, displayName: "Marta Gil" },
        }),
      ),
    );
    expect(text(applied)).toContain("Saved to Billing memory · Applied by Marta Gil");
    const denied = must(
      render(
        reader({
          status: "denied",
          proposalId: PROPOSAL,
          decidedBy: { id: MARTA, displayName: "Marta Gil" },
        }),
      ),
    );
    expect(text(denied)).toContain("Not saved: Marta Gil declined it.");
    for (const m of [pending, applied, denied]) {
      expect(m).not.toContain("<button");
      expect(m).not.toContain("<a ");
      expect(m).not.toContain(STRIP_COPY.menu);
    }
  });

  it("Not mapped: Link it → when the API says they may link (a lead with the device), else Ask a lead", () => {
    const lead = must(render(reader({ status: "unmapped", unit: null, canMap: true })));
    expect(lead).toContain('href="/work-zone/projects"');
    expect(lead).not.toContain(STRIP_COPY.menu);
    const member = must(render(reader({ status: "unmapped", unit: null, canMap: false })));
    expect(text(member)).toContain("Ask a lead to link it.");
  });
});

describe("strip helpers", () => {
  it("only Ended and Archived sessions have a strip", () => {
    expect(isFinished("completed")).toBe(true);
    expect(isFinished("archived")).toBe(true);
    for (const s of [
      "idle",
      "running",
      "waiting_approval",
      "failed",
      "provisioning",
      "host_offline",
    ] as const)
      expect(isFinished(s)).toBe(false);
  });

  it("the confirmation names the payer: the organization on its keys, the person on their plan", () => {
    expect(payerOf({ label: "Claude Haiku 4.5", metered: true, plan: false })).toBe("the organization");
    expect(payerOf({ label: "GPT", metered: false, plan: true })).toBe("you");
    expect(PROPOSE_COPY.onceTitle("Billing")).toBe("Propose a summary to Billing memory?");
    expect(PROPOSE_COPY.autoBody("you")).toMatch(/one AI request billed to you\.$/u);
    expect(PROPOSE_COPY.meteredNotice).toContain("Only repo-relative paths are sent.");
  });

  it("API codes never reach the screen: a refused propose reads as the strip's own words", () => {
    expect(proposeErrorText(new ApiRequestError(409, "nothing_new", "nothing_new"))).toBe(
      STRIP_COPY.nothingNew,
    );
    expect(proposeErrorText(new ApiRequestError(409, "session_unmapped", "x"))).toBe(STRIP_COPY.notMapped);
  });
});

describe("user-stream handlers (D-11)", () => {
  const seeded = () => {
    const qc = new QueryClient();
    qc.setQueryData(workMemoryKeys.session(SESSION), summary({ status: "pending", proposalId: PROPOSAL }));
    qc.setQueryData(workMemoryKeys.session(OTHER_SESSION), summary());
    return qc;
  };
  const stale = (qc: QueryClient, id: string) => qc.getQueryState(workMemoryKeys.session(id))?.isInvalidated;

  it("work_session_memory.updated refetches that session only", () => {
    const qc = seeded();
    expect(applyWorkSessionMemoryUpdated(qc, { workSessionId: SESSION })).toBe(true);
    expect(stale(qc, SESSION)).toBe(true);
    expect(stale(qc, OTHER_SESSION)).toBe(false);
    // Anything but the ids-only payload is ignored.
    expect(applyWorkSessionMemoryUpdated(qc, { workSessionId: SESSION, status: "pending" })).toBe(false);
  });

  it("the memory frame arrives ephemeral (`eph`) and still refetches; other frames are ignored", () => {
    const qc = seeded();
    const frame = (op: "ev" | "eph", type: string, data: unknown) =>
      ({ op, topic: `user:${MARTA}`, seq: 1, type, data }) as unknown as TopicFrame;
    expect(
      applyWorkMemoryFrame(qc, frame("eph", "work_session_memory.updated", { workSessionId: SESSION })),
    ).toBe(true);
    expect(stale(qc, SESSION)).toBe(true);
    expect(applyWorkMemoryFrame(seeded(), frame("ev", "message.created", { workSessionId: SESSION }))).toBe(
      false,
    );
    expect(
      applyWorkMemoryFrame(
        seeded(),
        frame("ev", "approval_request.updated", { id: PROPOSAL, status: "denied" }),
      ),
    ).toBe(true);
  });

  it("approval_request.updated refetches only the strip showing that proposal", () => {
    const qc = seeded();
    expect(applyApprovalUpdatedToMemory(qc, { id: PROPOSAL, status: "applied" })).toBe(true);
    expect(stale(qc, SESSION)).toBe(true);
    expect(stale(qc, OTHER_SESSION)).toBe(false);
    expect(applyApprovalUpdatedToMemory(seeded(), { id: MARTA, status: "denied" })).toBe(false);
  });

  it("the strip never reads the ws: stream or the session DTO for its state", () => {
    const root = join(import.meta.dirname, "..", "..");
    const queries = readFileSync(join(root, "lib", "work-memory-queries.ts"), "utf8");
    const strip = readFileSync(join(root, "components", "work-zone", "session-memory-strip.tsx"), "utf8");
    expect(queries).toContain('topic("user"');
    for (const src of [queries, strip]) {
      expect(src).not.toMatch(/topic\("ws"|`ws:\$\{|"ws:"/u);
      expect(src).not.toMatch(/session\.memory/u);
    }
  });

  it("session-view mounts the strip once, between the event stream and the composer area (R7)", () => {
    const root = join(import.meta.dirname, "..", "..");
    const view = readFileSync(join(root, "components", "work-zone", "session-view.tsx"), "utf8");
    expect(view.match(/<SessionMemoryStrip /gu)?.length).toBe(1);
    const at = view.indexOf("<SessionMemoryStrip ");
    expect(view.lastIndexOf("<EventStream", at)).toBeGreaterThan(-1);
    expect(view.indexOf("<Composer", at)).toBeGreaterThan(at);
  });
});
