import type { MessageConsult } from "@ocw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@/lib/api";
import { chatKeys } from "@/lib/chat-queries";
import { stopErrorMessage, stopSuccessMessage } from "@/lib/consult-queries";
import { queryKeys } from "@/lib/queries";
import { ConsultChip, consultChipModel, consultNames } from "./consult-chip";

/**
 * 07.7-10 (A2A-01, A2A-03, D-04, P-14): the chip on a consult hop's question and answer. Copy per the plan's table,
 * every status with its own label and icon, handoff and second-level wording, names from the viewer's directory with
 * neutral fallbacks, and Stop only on a waiting question for the chain's human or a channel moderator (a hint: the API
 * decides). Static markup in node.
 */

const VICTOR = "00000000-0000-4000-8000-0000000000f1";
const ALEX = "00000000-0000-4000-8000-0000000000f2";
const ARCHIE = "00000000-0000-4000-8000-0000000000a1";
const BEA = "00000000-0000-4000-8000-0000000000b1";

function hop(over: Partial<MessageConsult> = {}): MessageConsult {
  return {
    chainId: "00000000-0000-4000-8000-0000000000c1",
    hopId: "00000000-0000-4000-8000-0000000000c2",
    role: "question",
    sourceAgentId: ARCHIE,
    targetAgentId: BEA,
    onBehalfOfUserId: VICTOR,
    depth: 1,
    mode: "consult",
    status: "pending",
    ...over,
  };
}

const NAMES = { target: "@bea", source: "@archie", human: "Víctor Ruiz" };

/** The directory the app shell caches: Víctor and Alex, and the team bots Archie and Bea. */
function client(known = true): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (!known) {
    qc.setQueryData(queryKeys.members, { members: [] });
    qc.setQueryData(chatKeys.agents, { agents: [] });
    return qc;
  }
  const member = (userId: string, displayName: string, email: string) => ({
    userId,
    displayName,
    email,
    avatarUrl: null,
    role: "admin",
    username: null,
  });
  qc.setQueryData(queryKeys.members, {
    members: [member(VICTOR, "Víctor Ruiz", "admin@ocw.test"), member(ALEX, "Alex Kim", "alex@ocw.test")],
  });
  const bot = (id: string, name: string, username: string) => ({
    id,
    name,
    username,
    avatarUrl: null,
    description: null,
    status: "ready",
    scope: "team",
  });
  qc.setQueryData(chatKeys.agents, { agents: [bot(ARCHIE, "Archie", "archie"), bot(BEA, "Bea", "bea")] });
  return qc;
}

function render(
  consult: MessageConsult,
  viewer: { meId?: string; canModerate?: boolean } = {},
  known = true,
): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client(known)}>
      <ConsultChip consult={consult} meId={viewer.meId ?? ALEX} canModerate={viewer.canModerate ?? false} />
    </QueryClientProvider>,
  );
}

/** The chip's visible text, tags stripped. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .trim();

describe("consultChipModel (copy table)", () => {
  const cases: Array<[MessageConsult["status"], string]> = [
    ["pending", "Waiting…"],
    ["answered", "Answered"],
    ["failed", "Couldn't answer"],
    ["timed_out", "No answer in time"],
    ["cancelled", "Stopped"],
    ["refused", "Daily limit reached"],
  ];
  it.each(cases)("a %s question reads “Asked @bea for Víctor Ruiz” and “%s”", (status, label) => {
    const m = consultChipModel(hop({ status }), NAMES, { isHuman: false, canModerate: false });
    expect(m.text).toBe("Asked @bea for Víctor Ruiz");
    expect(m.status?.label).toBe(label);
    expect(m.canStop).toBe(false);
  });

  it("every status has its own icon; only Answered is emerald, only the failures amber; only Waiting spins", () => {
    const models = cases.map(([status]) =>
      consultChipModel(hop({ status }), NAMES, { isHuman: false, canModerate: false }),
    );
    expect(new Set(models.map((m) => m.status?.icon)).size).toBe(cases.length);
    expect(models.map((m) => m.status?.tone)).toEqual(["muted", "ok", "warn", "warn", "muted", "warn"]);
    expect(models.map((m) => m.status?.spin)).toEqual([true, false, false, false, false, false]);
  });

  it("a handoff reads “Handed over to @bea for Víctor Ruiz” with Working… / Handed over; depth 2 says Step 2", () => {
    const v = { isHuman: false, canModerate: false };
    const pending = consultChipModel(hop({ mode: "handoff" }), NAMES, v);
    expect(pending.text).toBe("Handed over to @bea for Víctor Ruiz");
    expect(pending.status?.label).toBe("Working…");
    expect(consultChipModel(hop({ mode: "handoff", status: "answered" }), NAMES, v).status?.label).toBe(
      "Handed over",
    );
    expect(consultChipModel(hop({ mode: "handoff", status: "timed_out" }), NAMES, v).status?.label).toBe(
      "No answer in time",
    );
    expect(consultChipModel(hop({ depth: 2 }), NAMES, v).text).toBe("Step 2 · Asked @bea for Víctor Ruiz");
    expect(consultChipModel(hop({ depth: 2, mode: "handoff" }), NAMES, v).text).toBe(
      "Step 2 · Handed over to @bea for Víctor Ruiz",
    );
  });

  it("an answer reads “Answer to @archie” with no status and never Stop", () => {
    const m = consultChipModel(hop({ role: "answer" }), NAMES, { isHuman: true, canModerate: true });
    expect(m.text).toBe("Answer to @archie");
    expect(m.status).toBeUndefined();
    expect(m.canStop).toBe(false);
  });

  it("Stop: only on a waiting question, for the chain's human or a moderator", () => {
    const stop = (over: Partial<MessageConsult>, viewer: { isHuman: boolean; canModerate: boolean }) =>
      consultChipModel(hop(over), NAMES, viewer).canStop;
    expect(stop({}, { isHuman: true, canModerate: false })).toBe(true);
    expect(stop({}, { isHuman: false, canModerate: true })).toBe(true);
    expect(stop({}, { isHuman: false, canModerate: false })).toBe(false);
    for (const status of ["answered", "failed", "timed_out", "cancelled", "refused"] as const) {
      expect(stop({ status }, { isHuman: true, canModerate: true })).toBe(false);
    }
    expect(stop({ mode: "handoff" }, { isHuman: true, canModerate: false })).toBe(true);
  });
});

describe("consultNames", () => {
  it("bots by id → @handle, the person by id → display name; unknown → a bot / a teammate", () => {
    const byKey = new Map([
      [
        `agent:${BEA}`,
        {
          kind: "agent" as const,
          id: BEA,
          displayName: "Bea",
          handle: "bea",
          avatarUrl: null,
          subtitle: null,
        },
      ],
      [
        `user:${VICTOR}`,
        {
          kind: "user" as const,
          id: VICTOR,
          displayName: "Víctor Ruiz",
          handle: "victor",
          avatarUrl: null,
          subtitle: null,
        },
      ],
    ]);
    expect(consultNames(hop(), { byKey })).toEqual({ target: "@bea", source: "a bot", human: "Víctor Ruiz" });
    expect(consultNames(hop(), { byKey: new Map() })).toEqual({
      target: "a bot",
      source: "a bot",
      human: "a teammate",
    });
  });
});

describe("ConsultChip", () => {
  it("a waiting question for Víctor: the chip with its role, status, icons hidden from readers, and Stop with its name", () => {
    const html = render(hop(), { meId: VICTOR });
    expect(html).toContain('data-testid="consult-chip"');
    expect(html).toContain('data-role="question"');
    expect(html).toContain('data-status="pending"');
    expect(html).toMatch(/^<p\b/);
    expect(text(html)).toBe("Asked @bea for Víctor Ruiz·Waiting…Stop");
    expect(html).toContain('data-testid="consult-stop"');
    expect(html).toContain('aria-label="Stop asking @bea"');
    expect(html).toMatch(/<button\b[^>]*type="button"/);
    expect(html).toContain("max-md:h-11");
    expect(html).toContain("animate-spin motion-reduce:animate-none");
    // Every icon is decorative: the words carry the meaning.
    const svgs = html.match(/<svg\b[^>]*>/g) ?? [];
    expect(svgs.length).toBeGreaterThanOrEqual(3);
    for (const svg of svgs) expect(svg).toContain('aria-hidden="true"');
  });

  it("Alex (neither the human nor a moderator) sees the same chip without Stop; a moderator gets Stop", () => {
    const alex = render(hop(), { meId: ALEX });
    expect(text(alex)).toBe("Asked @bea for Víctor Ruiz·Waiting…");
    expect(alex).not.toContain("consult-stop");
    expect(render(hop(), { meId: ALEX, canModerate: true })).toContain('data-testid="consult-stop"');
  });

  it("each finished status renders its label, its tone and no Stop", () => {
    const answered = render(hop({ status: "answered" }), { meId: VICTOR });
    expect(text(answered)).toBe("Asked @bea for Víctor Ruiz·Answered");
    expect(answered).toContain("text-emerald-700 dark:text-emerald-400");
    expect(answered).not.toContain("consult-stop");
    const timedOut = render(hop({ status: "timed_out" }), { meId: VICTOR });
    expect(text(timedOut)).toBe("Asked @bea for Víctor Ruiz·No answer in time");
    expect(timedOut).toContain("text-amber-700 dark:text-amber-400");
    expect(text(render(hop({ status: "failed" }), { meId: VICTOR }))).toContain("Couldn't answer");
    expect(text(render(hop({ status: "refused" }), { meId: VICTOR }))).toContain("Daily limit reached");
    const stopped = render(hop({ status: "cancelled" }), { meId: VICTOR });
    expect(text(stopped)).toBe("Asked @bea for Víctor Ruiz·Stopped");
    expect(stopped).not.toContain("text-emerald");
    expect(stopped).not.toContain("text-amber");
  });

  it("an answer renders “Answer to @archie” and nothing else", () => {
    const html = render(hop({ role: "answer", status: "answered" }), { meId: VICTOR });
    expect(html).toContain('data-role="answer"');
    expect(text(html)).toBe("Answer to @archie");
    expect(html).not.toContain("consult-status");
    expect(html).not.toContain("consult-stop");
  });

  it("names it does not know fall back to “a bot” / “a teammate”", () => {
    expect(text(render(hop({ status: "answered" }), {}, false))).toBe("Asked a bot for a teammate·Answered");
    expect(text(render(hop({ role: "answer" }), {}, false))).toBe("Answer to a bot");
  });
});

describe("Stop messages", () => {
  it("success names the asking bot; 403 and 404 read the copy table; anything else the API's message", () => {
    expect(stopSuccessMessage("@archie")).toBe("Stopped. @archie won't get more answers for this request.");
    expect(stopSuccessMessage("a bot")).toBe("Stopped. A bot won't get more answers for this request.");
    expect(stopErrorMessage(new ApiRequestError(403, "not_chain_owner", "x"))).toBe(
      "Only the person who asked can stop this.",
    );
    expect(stopErrorMessage(new ApiRequestError(404, "chain_not_found", "x"))).toBe(
      "This request is no longer available.",
    );
    expect(stopErrorMessage(new ApiRequestError(500, "internal", "Something broke"))).toBe("Something broke");
  });
});
