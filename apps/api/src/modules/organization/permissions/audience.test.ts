import { describe, expect, it } from "vitest";
import { AUDIENCE_COVER_MAX, audienceCovers } from "./policy";

/**
 * 07.8-25 (D-11 F-8): a conversation's audience covers a bot's workspace audience only when every person who reads the
 * workspace also reads the conversation; anything unknown refuses (pure, the only copy of the rule).
 */
describe("audienceCovers (F-8: data moves only from a broader audience to a narrower one)", () => {
  it("covers when every person the bot serves reads the conversation (more readers are fine)", () => {
    expect(audienceCovers({ workspace: ["sam"], readers: new Set(["sam"]) })).toBe(true);
    expect(
      audienceCovers({ workspace: ["alex", "sam", "victor"], readers: new Set(["alex", "sam", "victor"]) }),
    ).toBe(true);
  });

  it("does not cover when the bot serves anyone who cannot read the conversation", () => {
    expect(audienceCovers({ workspace: ["alex", "sam", "victor"], readers: new Set(["sam"]) })).toBe(false);
    expect(audienceCovers({ workspace: ["alex", "sam"], readers: new Set(["sam", "victor"]) })).toBe(false);
    expect(audienceCovers({ workspace: ["sam"], readers: new Set() })).toBe(false);
  });

  it("refuses when unsure: unknown workspace, unknown readers or nobody at all", () => {
    expect(audienceCovers({ workspace: null, readers: null })).toBe(false);
    expect(audienceCovers({ workspace: null, readers: new Set(["sam"]) })).toBe(false);
    expect(audienceCovers({ workspace: ["sam"], readers: null })).toBe(false);
    expect(audienceCovers({ workspace: [], readers: new Set(["sam"]) })).toBe(false);
  });

  it("bounds how many people it checks", () => {
    expect(AUDIENCE_COVER_MAX).toBe(1_000);
  });
});
