/**
 * `ocw_automation_propose` (07.6 AUTO-03, D-02, D-03, C-01): the bot proposes a scheduled automation for the person it
 * talks to; the API posts a card that person confirms. Driven through the tool's registration with a recording client
 * (the HTTP shape is api-client.test.ts's; the gate's taint block is tool-guard.test.ts's).
 */
import { describe, expect, it } from "vitest";
import type {
  AgentChannelAutomationPropose,
  AgentChannelAutomationProposeResponse,
  TurnContext,
} from "./agent-channel-protocol.js";
import { type AgentChannelClient, AgentChannelHttpError } from "./api-client.js";
import {
  AUTOMATION_PROPOSE_SENTENCES,
  AUTOMATION_PROPOSE_TOOL,
  type AutomationToolContext,
  registerAutomationTool,
} from "./automation-tool.js";
import { openClawAgentIdFor } from "./mention-mapper.js";
import { createToolGuard } from "./tool-guard.js";

const BOT = "0199a6f0-0000-7000-8000-00000000a001";
const CONV = "0199a6f0-0000-7000-8000-00000000c002";
const SESSION = `agent:${openClawAgentIdFor(BOT)}:ocw:channel:${CONV}`;
const FLAGS = { untrustedOutput: false, sideEffecting: true };
const PROPOSED =
  "I posted a card proposing “Weekly sales report”. Ana Pérez has to confirm it. Tell them in one short sentence, without repeating the details.";
const INSTRUCTIONS = "Summarise this week's closed deals and post the total.";
const CALL = {
  name: "Weekly sales report",
  instructions: INSTRUCTIONS,
  cron: "0 17 * * 5",
  timeZone: "Europe/Madrid",
  deliverTo: "here",
};

function turn(over: Partial<TurnContext> = {}): TurnContext {
  return {
    tools: ["web_search", AUTOMATION_PROPOSE_TOOL],
    toolFlags: {
      web_search: { untrustedOutput: true, sideEffecting: false },
      [AUTOMATION_PROPOSE_TOOL]: FLAGS,
    },
    memory: [],
    now: null,
    maxToolCalls: 8,
    maxWebCalls: 5,
    ...over,
  };
}

type ToolResult = { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };
type Tool = {
  name: string;
  description: string;
  parameters: {
    type: string;
    additionalProperties: boolean;
    required?: string[];
    properties: Record<string, { type?: string; enum?: string[]; maxLength?: number; maximum?: number }>;
  };
  execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<ToolResult>;
};
type Factory = (ctx: AutomationToolContext) => Tool;
const text = (r: ToolResult) => r.content.map((c) => c.text).join("");

function setup(
  respond: (
    body: AgentChannelAutomationPropose,
  ) => Promise<AgentChannelAutomationProposeResponse> = async () => ({
    ok: true,
    approvalId: "0199a6f0-0000-7000-8000-0000000000a9",
    sentence: PROPOSED,
  }),
) {
  const calls: AgentChannelAutomationPropose[] = [];
  const client = {
    proposeAutomation: async (body: AgentChannelAutomationPropose) => {
      calls.push(structuredClone(body));
      return respond(body);
    },
  } as unknown as AgentChannelClient;
  const guard = createToolGuard({ client: () => client });
  const registered: Array<{ factory: Factory; opts: { name: string } }> = [];
  const logs: string[] = [];
  registerAutomationTool(
    {
      registerTool: (factory: Factory, opts: { name: string }) => registered.push({ factory, opts }),
    } as never,
    { guard, client: () => client, logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) } },
  );
  const tool = (ctx: AutomationToolContext = { sessionKey: SESSION, agentId: openClawAgentIdFor(BOT) }) => {
    const r = registered.find((x) => x.opts.name === AUTOMATION_PROPOSE_TOOL);
    if (!r) throw new Error("not registered");
    return r.factory(ctx);
  };
  const begin = (t: TurnContext = turn(), requesterName: string | null = "Ana Pérez") =>
    guard.beginTurn(SESSION, {
      eventId: "evt-1",
      agentId: BOT,
      turn: t,
      conversationId: CONV,
      ...(requesterName ? { requesterName } : {}),
    });
  return { calls, guard, registered, tool, begin, logs };
}

describe("ocw_automation_propose (07.6 AUTO-03, D-03, C-01): a thin caller of POST /automations/propose", () => {
  it("registers one tool under its fixed name, with a closed schema", () => {
    const { registered, tool } = setup();
    expect(registered.map((r) => r.opts.name)).toEqual(["ocw_automation_propose"]);
    const t = tool();
    expect(t.name).toBe("ocw_automation_propose");
    expect(t.parameters.additionalProperties).toBe(false);
    expect(Object.keys(t.parameters.properties).sort()).toEqual(
      ["cron", "deliverTo", "instructions", "maxRunsPerDay", "name", "timeZone"].sort(),
    );
    expect(t.parameters.required?.sort()).toEqual(
      ["cron", "deliverTo", "instructions", "name", "timeZone"].sort(),
    );
    expect(t.parameters.properties.deliverTo?.enum).toEqual(["here", "dm"]);
  });

  it("posts exactly {eventId, agentId, name, instructions, schedule, target: here} and returns the server's sentence", async () => {
    const { calls, begin, tool } = setup();
    begin();
    const r = await tool().execute("tc-1", { ...CALL, name: "  Weekly sales report " });
    expect(calls).toEqual([
      {
        eventId: "evt-1",
        agentId: BOT,
        name: "Weekly sales report",
        instructions: INSTRUCTIONS,
        schedule: { cron: "0 17 * * 5", timeZone: "Europe/Madrid" },
        target: { kind: "here" },
      },
    ]);
    expect(text(r)).toBe(PROPOSED);
    expect(r.details).toEqual({ ok: true });
  });

  it("deliverTo dm maps to {kind: dm}; maxRunsPerDay passes through when given", async () => {
    const { calls, begin, tool } = setup();
    begin();
    await tool().execute("tc-1", { ...CALL, deliverTo: "dm", maxRunsPerDay: 4 });
    expect(calls[0]?.target).toEqual({ kind: "dm" });
    expect(calls[0]?.maxRunsPerDay).toBe(4);
  });

  it("a refusal answer returns its sentence (no throw), with its code", async () => {
    const sentence =
      "That schedule isn't valid or runs more often than every 15 minutes. Ask Ana Pérez for a simpler schedule.";
    const { begin, tool } = setup(async () => ({ ok: false, code: "schedule_too_frequent", sentence }));
    begin();
    const r = await tool().execute("tc-1", { ...CALL, cron: "*/5 * * * *" });
    expect(text(r)).toBe(sentence);
    expect(r.details).toEqual({ ok: false, code: "schedule_too_frequent" });
  });

  it("a tainted turn never reaches the API and gets the UI-SPEC sentence", async () => {
    const { calls, begin, guard, tool, logs } = setup();
    begin();
    const t = guard.activeTurn(SESSION);
    if (!t) throw new Error("no turn");
    t.tainted = true;
    const r = await tool().execute("tc-1", CALL);
    expect(calls).toEqual([]);
    expect(text(r)).toBe(
      "I can't propose an automation after reading outside content in this turn. Tell Ana Pérez to ask again in a new message.",
    );
    expect(r.details).toEqual({ ok: false, code: "tainted" });
    expect(logs.join("\n")).not.toContain(INSTRUCTIONS);
  });

  it("without an active turn → the fixed not-available answer; a turn that does not offer the tool → refused locally", async () => {
    const none = setup();
    const r = await none.tool().execute("tc-1", CALL);
    expect(text(r)).toBe(AUTOMATION_PROPOSE_SENTENCES.no_turn());
    expect(none.calls).toEqual([]);
    const off = setup();
    off.begin(turn({ tools: ["web_search"] }));
    const r2 = await off.tool().execute("tc-1", CALL);
    expect(text(r2)).toBe(AUTOMATION_PROPOSE_SENTENCES.not_in_turn());
    expect(off.calls).toEqual([]);
  });

  it("invalid params are refused locally: extra keys (a person, a conversation), empty fields, a bad target or limit", async () => {
    const { calls, begin, tool } = setup();
    begin();
    for (const bad of [
      { ...CALL, runAs: "u-someone" },
      { ...CALL, conversationId: CONV },
      { ...CALL, name: "  " },
      { ...CALL, instructions: "" },
      { ...CALL, instructions: "x".repeat(4001) },
      { ...CALL, name: "x".repeat(121) },
      { ...CALL, cron: "" },
      { ...CALL, timeZone: 3 },
      { ...CALL, deliverTo: "channel" },
      { ...CALL, maxRunsPerDay: 0 },
      { ...CALL, maxRunsPerDay: 289 },
      { ...CALL, maxRunsPerDay: 1.5 },
    ]) {
      const r = await tool().execute("tc-x", bad);
      expect(r.details.ok).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("an HTTP refusal carrying {ok:false, code, sentence} is that sentence; an ended turn and an outage are fixed sentences", async () => {
    const tainted = setup(async () => {
      throw new AgentChannelHttpError(403, "/automations/propose", "x", undefined, undefined, undefined, {
        ok: false,
        code: "tainted",
        sentence: "I can't propose an automation after reading outside content in this turn.",
      });
    });
    tainted.begin();
    const r = await tainted.tool().execute("tc-1", CALL);
    expect(text(r)).toBe("I can't propose an automation after reading outside content in this turn.");
    expect(r.details).toEqual({ ok: false, code: "tainted" });

    const ended = setup(async () => {
      throw new AgentChannelHttpError(404, "/automations/propose", "x", "unknown_turn");
    });
    ended.begin();
    expect(text(await ended.tool().execute("tc-1", CALL))).toBe(AUTOMATION_PROPOSE_SENTENCES.unknown_turn());

    const down = setup(async () => {
      throw new Error("ECONNREFUSED");
    });
    down.begin();
    const r3 = await down.tool().execute("tc-1", CALL);
    expect(text(r3)).toBe(AUTOMATION_PROPOSE_SENTENCES.unreachable());
    expect(r3.details).toEqual({ ok: false, code: "unreachable" });
  });

  it("the server's sentence is shown as one bounded line without control or structural characters", async () => {
    const { begin, tool } = setup(async () => ({
      ok: true,
      approvalId: "0199a6f0-0000-7000-8000-0000000000a9",
      sentence: "I posted a card\nproposing <“x”>.‮",
    }));
    begin();
    expect(text(await tool().execute("tc-1", CALL))).toBe("I posted a card proposing “x”.");
  });
});
