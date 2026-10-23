import type { BotTurnActivity, Message, TurnActivityEvent } from "@ocw/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  applyMessage,
  applyTurnActivity,
  chatKeys,
  LIVE_ACTIVITY_TIMEOUT_MS,
  type LiveTurns,
  liveTurnsOf,
  nextTurns,
} from "./chat-queries";

/**
 * The running bot turns of a conversation (07.8-20, R2): the ephemeral `turn.activity` keeps one live turn per event
 * until its reply arrives, and a turn that never replies stops showing after `LIVE_ACTIVITY_TIMEOUT_MS` (WINDOWS #245:
 * `bot_turn_activity.running` stays true on the server for it).
 */

const CONV = "01a11635-d6e7-7c87-9f17-b6b1dc048900";
const EVENT = "01a11635-d6e7-7c87-9f17-b6b1dc048941";
const AGENT = "01a11635-d6e7-7c87-9f17-b6b1dc048942";
const T0 = Date.parse("2026-10-21T10:00:00.000Z");

function act(over: Partial<BotTurnActivity> = {}): BotTurnActivity {
  return { eventId: EVENT, steps: [], more: 0, running: true, current: null, ...over };
}
function ev(activity: BotTurnActivity, threadRootMessageId: string | null = null): TurnActivityEvent {
  return { type: "turn.activity", conversationId: CONV, threadRootMessageId, agentId: AGENT, activity };
}

describe("live bot turns", () => {
  it("a running turn is live in its place; the phrase survives the gap between two calls", () => {
    let map = nextTurns(undefined, ev(act({ current: "writing reports/late.csv" })), T0);
    map = nextTurns(map, ev(act({ current: null })), T0 + 1000);
    const [t] = liveTurnsOf(map, null, T0 + 2000);
    expect(t).toMatchObject({
      eventId: EVENT,
      agentId: AGENT,
      phrase: "writing reports/late.csv",
      startedAt: T0,
    });
    expect(liveTurnsOf(map, "01a11635-d6e7-7c87-9f17-b6b1dc048999", T0 + 2000)).toEqual([]);
  });

  it("a turn that never replies stops showing after the timeout (WINDOWS #245)", () => {
    const map = nextTurns(undefined, ev(act({ current: "running python fetch.py" })), T0);
    expect(liveTurnsOf(map, null, T0 + LIVE_ACTIVITY_TIMEOUT_MS - 1)).toHaveLength(1);
    expect(liveTurnsOf(map, null, T0 + LIVE_ACTIVITY_TIMEOUT_MS)).toEqual([]);
    // A new step restarts the clock.
    const again = nextTurns(
      map,
      ev(act({ current: "reading notes.txt" })),
      T0 + LIVE_ACTIVITY_TIMEOUT_MS - 10,
    );
    expect(liveTurnsOf(again, null, T0 + LIVE_ACTIVITY_TIMEOUT_MS + 1000)).toHaveLength(1);
  });

  it("a finished turn stays finished: a late running event never brings the label back", () => {
    let map: LiveTurns = nextTurns(undefined, ev(act()), T0);
    map = nextTurns(map, ev(act({ running: false })), T0 + 1);
    map = nextTurns(map, ev(act({ running: true, current: "late" })), T0 + 2);
    expect(liveTurnsOf(map, null, T0 + 3)).toEqual([]);
  });

  it("the reply carrying the turn's activity ends the live label in the cache", () => {
    const qc = new QueryClient();
    applyTurnActivity(qc, ev(act({ current: "writing reports/late.csv" })), Date.now());
    expect(liveTurnsOf(qc.getQueryData(chatKeys.turnActivity(CONV)), null, Date.now())).toHaveLength(1);
    const reply = {
      id: "01a11635-d6e7-7c87-9f17-b6b1dc048943",
      organizationId: "01a11635-d6e7-7c87-9f17-b6b1dc048944",
      conversationId: CONV,
      seq: 9,
      authorKind: "agent",
      authorId: AGENT,
      body: "Done.",
      mentions: [],
      status: "sent",
      threadId: null,
      replyCount: 0,
      lastReplyAt: null,
      clientKind: null,
      createdAt: new Date().toISOString(),
      editedAt: null,
      activity: act({ running: false }),
    } as unknown as Message;
    applyMessage(qc, reply);
    expect(liveTurnsOf(qc.getQueryData(chatKeys.turnActivity(CONV)), null, Date.now())).toEqual([]);
    applyTurnActivity(qc, ev(act({ current: "late" })), Date.now());
    expect(liveTurnsOf(qc.getQueryData(chatKeys.turnActivity(CONV)), null, Date.now())).toEqual([]);
  });
});
