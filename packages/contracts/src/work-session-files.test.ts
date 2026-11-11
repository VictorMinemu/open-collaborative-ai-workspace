import { describe, expect, it } from "vitest";
import { ATTACHMENT_DEFAULT_MAX_BYTES } from "./attachments";
import {
  BOT_FILE_LIMIT_SOURCE_LABELS,
  BOT_FILE_LIMITS,
  BotFileLimit,
  BotFileLimitSource,
  transferDeadlineMs,
  WorkSessionFilePath,
} from "./work-session-files";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

describe("bot file limits (07.17.1.1 D-06, D-07, PD-05, PD-18)", () => {
  it("are the hub's numbers", () => {
    expect(BOT_FILE_LIMITS).toEqual({
      defaultMaxBytes: ATTACHMENT_DEFAULT_MAX_BYTES,
      minMaxBytes: MiB,
      ceilingMaxBytes: GiB,
      filesPerTurnEachWay: 5,
      pathMaxChars: 1024,
      segmentMaxChars: 255,
      partBytes: 8 * MiB,
      transferBaseMs: 30_000,
      transferBytesPerSecond: MiB,
      transferMaxMs: 600_000,
      concurrentTransfersPerProcess: 4,
    });
    expect(BOT_FILE_LIMITS.defaultMaxBytes).toBe(25 * MiB);
  });

  it("the transfer deadline grows with the size and stops at ten minutes", () => {
    expect(transferDeadlineMs(0)).toBe(30_000);
    expect(transferDeadlineMs(1)).toBe(31_000);
    expect(transferDeadlineMs(10 * MiB)).toBe(40_000);
    expect(transferDeadlineMs(GiB)).toBe(600_000);
  });
});

describe("WorkSessionFilePath (07.17.1.1 D-02, D-03, principle 7)", () => {
  const ok = (p: string) => WorkSessionFilePath.safeParse(p).success;

  it("accepts repo-relative file paths", () => {
    for (const p of [
      "docs/spec v2.pdf",
      "src/a.b/c.ts",
      ".env.example",
      "README.md",
      "a",
      "x".repeat(255),
      `${"a/".repeat(511)}bc`,
    ]) {
      expect(ok(p), p).toBe(true);
    }
  });

  it("refuses absolute, home, drive, backslash and traversal forms", () => {
    for (const p of [
      "",
      "/etc/passwd",
      "~/x",
      "~",
      "C:/x",
      "c:x",
      "a\\b",
      "C:\\x",
      "a//b",
      "./a",
      "a/..",
      "a/./b",
      "../x",
      "a/",
      "/",
    ]) {
      expect(ok(p), JSON.stringify(p)).toBe(false);
    }
  });

  it("refuses control and bidi characters", () => {
    const bidi = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f];
    for (const cp of [0, 1, 9, 10, 13, 0x1f, 0x7f, ...bidi]) {
      const p = `docs/a${String.fromCodePoint(cp)}b.txt`;
      expect(ok(p), cp.toString(16)).toBe(false);
    }
  });

  it("refuses a segment ending in a dot or a space, a segment over 255 characters and a path over 1 024", () => {
    expect(ok("notes.")).toBe(false);
    expect(ok("notes ")).toBe(false);
    expect(ok("dir./a")).toBe(false);
    expect(ok("dir /a")).toBe(false);
    expect(ok("x".repeat(256))).toBe(false);
    expect(ok(`a/${"x".repeat(256)}`)).toBe(false);
    expect(ok("a".repeat(1025))).toBe(false);
    expect(ok(`${"a/".repeat(511)}abc`)).toBe(false);
  });
});

describe("the limit that applies (07.17.1.1 D-07)", () => {
  it("names the bot, the organization or the server", () => {
    expect([...BotFileLimitSource.options]).toEqual(["bot", "organization", "server"]);
    expect(BOT_FILE_LIMIT_SOURCE_LABELS).toEqual({
      bot: "this bot's limit",
      organization: "the organization's limit",
      server: "the server's limit",
    });
    expect(BotFileLimit.parse({ bytes: 25 * MiB, source: "organization" })).toEqual({
      bytes: 25 * MiB,
      source: "organization",
    });
    expect(BotFileLimit.safeParse({ bytes: 25 * MiB, source: "user" }).success).toBe(false);
    expect(BotFileLimit.safeParse({ bytes: 0, source: "bot" }).success).toBe(false);
    expect(BotFileLimit.safeParse({ bytes: 1.5, source: "bot" }).success).toBe(false);
  });
});
