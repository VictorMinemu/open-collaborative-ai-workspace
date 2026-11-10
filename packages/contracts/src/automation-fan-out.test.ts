import { describe, expect, it } from "vitest";
import {
  AgentChannelConversationOpen,
  AgentChannelConversationOpenResponse,
  CONVERSATION_OPEN_SENTENCES,
  ConversationOpenRefusal,
  EscalationTargetView,
  FAN_OUT_LIMITS,
  fanOutLabel,
} from "./automation-fan-out";

const EVENT = "0199b1c2-d3e4-7f5a-8b9c-0d1e2f3a4b51";
const AGENT = "0199b1c2-d3e4-7f5a-8b9c-0d1e2f3a4b52";
const CONV = "0199b1c2-d3e4-7f5a-8b9c-0d1e2f3a4b53";
const ROOT = "0199b1c2-d3e4-7f5a-8b9c-0d1e2f3a4b54";

const item = (n: number) => ({
  externalKey: `order-${n}`,
  title: `Order ${n}`,
  body: `Order ${n} from the ERP.`,
});

describe("the open tool's request (07.17 D-02, D-03, P6)", () => {
  it("parses the empty list (nothing new) and 25 items; the body defaults to empty", () => {
    expect(AgentChannelConversationOpen.parse({ eventId: EVENT, agentId: AGENT, items: [] }).items).toEqual(
      [],
    );
    const full = Array.from({ length: FAN_OUT_LIMITS.perRunMax }, (_, i) => item(i));
    expect(
      AgentChannelConversationOpen.parse({ eventId: EVENT, agentId: AGENT, items: full }).items,
    ).toHaveLength(25);
    const parsed = AgentChannelConversationOpen.parse({
      eventId: EVENT,
      agentId: AGENT,
      items: [{ externalKey: "  A-1  ", title: "  Order A-1 " }],
    });
    expect(parsed.items[0]).toEqual({ externalKey: "A-1", title: "Order A-1", body: "" });
  });

  it("refuses 26 items, empty keys and titles after trim, a 201-character key and a 4 001-character body", () => {
    const base = { eventId: EVENT, agentId: AGENT };
    const refused = [
      { ...base, items: Array.from({ length: 26 }, (_, i) => item(i)) },
      { ...base, items: [{ ...item(1), externalKey: "   " }] },
      { ...base, items: [{ ...item(1), title: "  " }] },
      { ...base, items: [{ ...item(1), externalKey: "k".repeat(201) }] },
      { ...base, items: [{ ...item(1), title: "t".repeat(201) }] },
      { ...base, items: [{ ...item(1), body: "b".repeat(4001) }] },
    ];
    for (const body of refused) expect(AgentChannelConversationOpen.safeParse(body).success).toBe(false);
    expect(
      AgentChannelConversationOpen.safeParse({ ...base, items: [{ ...item(1), body: "b".repeat(4000) }] })
        .success,
    ).toBe(true);
  });

  it("never names a target, a run, an automation or a person (each key alone is a parse error)", () => {
    for (const key of ["automationId", "runId", "conversationId", "columnId", "userId"]) {
      const body = { eventId: EVENT, agentId: AGENT, items: [item(1)], [key]: CONV };
      expect(AgentChannelConversationOpen.safeParse(body).success, key).toBe(false);
      const inItem = { eventId: EVENT, agentId: AGENT, items: [{ ...item(1), [key]: CONV }] };
      expect(AgentChannelConversationOpen.safeParse(inItem).success, `item.${key}`).toBe(false);
    }
  });
});

describe("the open tool's answer (07.17 D-03, PD-07, PD-08)", () => {
  it("an ok answer lists opened, existing and refused items with the remaining caps", () => {
    const answer = {
      ok: true,
      results: [
        {
          externalKey: "order-1",
          opened: true,
          conversationId: CONV,
          threadRootMessageId: ROOT,
          refused: null,
        },
        {
          externalKey: "order-2",
          opened: false,
          conversationId: CONV,
          threadRootMessageId: ROOT,
          refused: null,
        },
        {
          externalKey: "order-3",
          opened: false,
          conversationId: null,
          threadRootMessageId: null,
          refused: "run_cap",
        },
      ],
      remainingRun: 0,
      remainingDay: 96,
    };
    expect(AgentChannelConversationOpenResponse.parse(answer)).toEqual(answer);
    expect(AgentChannelConversationOpenResponse.safeParse({ ...answer, remainingRun: -1 }).success).toBe(
      false,
    );
  });

  it("a refusal carries one of the six codes and its sentence; a seventh code is refused", () => {
    expect([...ConversationOpenRefusal.options]).toEqual([
      "not_in_turn",
      "not_a_run",
      "automation_inactive",
      "fan_out_off",
      "target_not_postable",
      "cap_reached",
    ]);
    for (const code of ConversationOpenRefusal.options) {
      const answer = { ok: false, code, sentence: CONVERSATION_OPEN_SENTENCES[code] };
      expect(AgentChannelConversationOpenResponse.parse(answer)).toEqual(answer);
    }
    expect(
      AgentChannelConversationOpenResponse.safeParse({ ok: false, code: "too_many", sentence: "No." })
        .success,
    ).toBe(false);
  });

  it("exactly six fixed sentences, short and with no template, link or path", () => {
    expect(Object.keys(CONVERSATION_OPEN_SENTENCES).sort()).toEqual(
      [...ConversationOpenRefusal.options].sort(),
    );
    for (const sentence of Object.values(CONVERSATION_OPEN_SENTENCES)) {
      expect(sentence.length).toBeLessThanOrEqual(300);
      expect(sentence).not.toMatch(/[{/]|http/);
    }
    expect(CONVERSATION_OPEN_SENTENCES.not_a_run).toBe(
      "Only an automation run can open conversations. Reply in this thread instead.",
    );
  });

  it("the run card's label counts what this run opened", () => {
    expect(fanOutLabel(0)).toBe("Nothing new");
    expect(fanOutLabel(1)).toBe("Opened 1 conversation");
    expect(fanOutLabel(3)).toBe("Opened 3 conversations");
  });
});

describe("escalation targets as the bot sees them (07.17 D-08, PD-15)", () => {
  it("ids, handles and display names only, bounded", () => {
    const view = { kind: "unit", id: CONV, handle: "logistics", displayName: "Logistics" };
    expect(EscalationTargetView.parse(view)).toEqual(view);
    expect(EscalationTargetView.safeParse({ ...view, kind: "agent" }).success).toBe(false);
    expect(EscalationTargetView.safeParse({ ...view, handle: "h".repeat(65) }).success).toBe(false);
  });
});
