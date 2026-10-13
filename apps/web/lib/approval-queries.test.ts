import { describe, expect, it } from "vitest";
import { highlightRanges, lineRanges } from "@/components/memory/proposal-view";
import { ApiRequestError } from "./api";
import {
  countLabel,
  decisionErrorText,
  expiresText,
  failedReason,
  nextVersion,
  pendingLabel,
  proposalAge,
  readerSentence,
  scopeText,
} from "./approval-queries";

/** The proposals inbox copy and the review's highlight ranges (07.2-13, UI-SPEC Copywriting, R5). */

const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const at = (ms: number) => new Date(NOW - ms).toISOString();

describe("inbox copy", () => {
  it("names the nav entry with the count, singular and plural", () => {
    expect(pendingLabel("Memory", 0)).toBe("Memory");
    expect(pendingLabel("Memory", 1)).toBe("Memory, 1 proposal to review");
    expect(pendingLabel("Memory", 3)).toBe("Memory, 3 proposals to review");
    expect(countLabel(120)).toBe("99+");
  });

  it("ages and expiries read short", () => {
    expect(proposalAge(at(10_000), NOW)).toBe("just now");
    expect(proposalAge(at(5 * 60_000), NOW)).toBe("5m ago");
    expect(proposalAge(at(2 * 3_600_000), NOW)).toBe("2h ago");
    expect(proposalAge(at(3 * 86_400_000), NOW)).toBe("3d ago");
    expect(expiresText(new Date(NOW + 13.9 * 86_400_000).toISOString(), NOW)).toBe("Expires in 13 days");
    expect(expiresText(new Date(NOW + 1.2 * 86_400_000).toISOString(), NOW)).toBe("Expires in 1 day");
    expect(expiresText(new Date(NOW + 3_600_000).toISOString(), NOW)).toBe("Expires today");
  });

  it("explains every failed apply in words, never a code", () => {
    expect(failedReason("stale_base", "Scout")).toBe(
      "The file changed since this proposal. Ask Scout to propose again.",
    );
    expect(failedReason("scope_full", "Scout")).toBe("This memory is full (2,000 files).");
    expect(failedReason("apply_failed", "Scout")).toBe("Couldn't apply this change.");
    expect(failedReason("bot_deleted", "Scout")).toBe("Scout was deleted. Nothing was changed.");
    expect(failedReason("bot_disabled", "Scout")).toBe("Scout is turned off. Nothing was changed.");
  });

  it("names the memory, its readers and the version an approval becomes", () => {
    const agent = { id: "a", displayName: "Scout" };
    const forUser = { id: "u", displayName: "Sam Lee" };
    const team = {
      scope: { id: "s", kind: "unit" as const, label: "Ventas" },
      requestedBy: { agent, forUser },
    };
    expect(scopeText(team)).toBe("Ventas memory");
    expect(scopeText({ ...team, scope: { ...team.scope, kind: "personal" } })).toBe(
      "your private memory with Scout",
    );
    expect(readerSentence({ ...team, readerCount: 12 })).toBe("12 people will see this");
    expect(readerSentence({ ...team, readerCount: 1 })).toBe("1 person will see this");
    expect(readerSentence({ scope: { ...team.scope, kind: "personal" }, readerCount: 1 })).toBe(
      "Only you will see this",
    );
    expect(nextVersion({ currentVersion: null })).toBe(1);
    expect(nextVersion({ currentVersion: 4 })).toBe(5);
  });
});

describe("highlight ranges", () => {
  const proposed = "# Acme\n- Contact: ana@acme.com\n- Met Ana García\n";

  it("maps 1-based lines to offsets", () => {
    expect(lineRanges(proposed, [2])).toEqual([{ start: 7, end: 30 }]);
    expect(proposed.slice(7, 30)).toBe("- Contact: ana@acme.com");
    expect(lineRanges(proposed, [99])).toEqual([]);
  });

  it("uses the view's spans, and whole lines for a finding kind without spans (line-level fallback)", () => {
    const start = proposed.indexOf("ana@acme.com");
    const ranges = highlightRanges({
      proposed,
      spans: [{ kind: "email", start, end: start + 12 }],
      findings: [
        {
          kind: "email",
          severity: "warn",
          source: "builtin",
          count: 1,
          samples: ["a•••@acme.com"],
          lines: [2],
        },
        {
          kind: "person",
          severity: "warn",
          source: "presidio",
          count: 1,
          samples: ["A••• G•••"],
          lines: [3],
        },
        {
          kind: "extended_scan_partial",
          severity: "info",
          source: "presidio",
          count: 0,
          samples: [],
          lines: [],
        },
      ],
    });
    expect(ranges.map((r) => proposed.slice(r.start, r.end))).toEqual(["ana@acme.com", "- Met Ana García"]);
  });
});

describe("decision errors (owner decision 2026-10-13)", () => {
  it("a refused decider reads one sentence, never “your own proposal”", () => {
    // Whoever holds the decision right may approve their own proposal: the requester is refused like anyone else.
    expect(decisionErrorText(new ApiRequestError(403, "not_approver", "x"))).toBe(
      "You can't decide this proposal.",
    );
    expect(decisionErrorText(new ApiRequestError(409, "approval_already_decided", "x"))).toBe(
      "Someone already decided this proposal.",
    );
  });
});
