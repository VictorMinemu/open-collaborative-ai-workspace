import { describe, expect, it } from "vitest";
import { withDefaultBot } from "./automation-editor-sheet";

/**
 * A new automation starts on the first usable bot, but never over a bot already chosen: a bot's proposal
 * (`?draft=`) keeps its bot even when the proposal and the bot list arrive in the same render (the default's update
 * then runs after the draft's values were set). Seen in e2e as the proposal's "Scout" turning into another org bot.
 */

const SCOUT = { id: "scout", ready: true, personal: false };
const ARCHIE = { id: "archie", ready: true, personal: false };
const PERSONAL = { id: "mine", ready: true, personal: true };
const base = { agentId: "", target: { kind: "channel" as const, label: "#sales" } };

describe("withDefaultBot", () => {
  it("fills an empty form with the first ready bot", () => {
    expect(withDefaultBot(base, [ARCHIE, SCOUT]).agentId).toBe("archie");
  });

  it("never replaces a bot already in the form (a proposal's bot set in the same render)", () => {
    const fromDraft = { ...base, agentId: "scout" };
    expect(withDefaultBot(fromDraft, [ARCHIE, SCOUT])).toBe(fromDraft);
  });

  it("skips bots that are not ready and switches the target to a DM for a personal bot", () => {
    const next = withDefaultBot(base, [{ ...ARCHIE, ready: false }, PERSONAL]);
    expect(next.agentId).toBe("mine");
    expect(next.target.kind).toBe("dm");
  });

  it("leaves the form alone without bots", () => {
    expect(withDefaultBot(base, [])).toBe(base);
  });
});
