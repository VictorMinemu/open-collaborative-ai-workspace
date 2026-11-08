import { describe, expect, it } from "vitest";
import {
  normalizeSessionTitle,
  SESSION_TITLE_MAX_CHARS,
  SESSION_TITLE_MAX_WORDS,
  SESSION_TITLE_MIN_WORDS,
  SessionTitle,
  TITLE_MODEL,
  TITLE_PROMPT_MAX_CHARS,
  TITLE_TIMEOUT_MS,
  TitleFailureCode,
  TitleSource,
  titleProblems,
  titleWords,
} from "./index";
import { measureScaling } from "./testing/scaling";

describe("normalizeSessionTitle (D-20, P-16)", () => {
  it("drops wrapping quotes and trailing punctuation", () => {
    expect(normalizeSessionTitle('"Fix login redirect bug."')).toBe("Fix login redirect bug");
  });

  it("drops a Title: label and markdown marks", () => {
    expect(normalizeSessionTitle("Title: **Add dark mode toggle**")).toBe("Add dark mode toggle");
    expect(normalizeSessionTitle("**Título:** Arregla el login roto")).toBe("Arregla el login roto");
  });

  it("turns a Title Case heading into sentence case", () => {
    expect(normalizeSessionTitle("# Fix Login Redirect Bug")).toBe("Fix login redirect bug");
  });

  it("keeps all-caps and mixed-case words and caps the title at five words", () => {
    expect(normalizeSessionTitle("Fix API Rate Limit GitHub Client")).toBe("Fix API rate limit GitHub");
  });

  it("takes the first non-empty line of a multi-line answer", () => {
    expect(normalizeSessionTitle("\n  Add dark mode toggle\nThis title describes the request.")).toBe(
      "Add dark mode toggle",
    );
  });

  it("cuts a long title at a word boundary within 32 characters, without trailing punctuation", () => {
    const out = normalizeSessionTitle("Investigate flaky replication, sync failures");
    expect(out).toBe("Investigate flaky replication");
    expect(out!.length).toBeLessThanOrEqual(SESSION_TITLE_MAX_CHARS);
  });

  it("normalizes the recorded fixture answers to five words within 32 characters", () => {
    // Claude Code 2.1.289 (haiku) and codex 0.160.0 (gpt-6-luna) recordings, made under the 3-6 word / 48 rule.
    expect(normalizeSessionTitle("Redirección de login al expirar sesión")).toBe(
      "Redirección de login al expirar",
    );
    expect(normalizeSessionTitle("Fix settings page login redirect bug")).toBe(
      "Fix settings page login redirect",
    );
  });

  it("a cut title never ends on a dangling connector word", () => {
    expect(normalizeSessionTitle("Add a toggle for the dark mode")).toBe("Add a toggle");
    expect(normalizeSessionTitle("Revisar la caché de las sesiones activas")).toBe("Revisar la caché");
    expect(normalizeSessionTitle("Explain how the auth works")).toBe("Explain how the auth works");
  });

  it("cuts on a word boundary when five words are still longer than 32 characters", () => {
    expect(normalizeSessionTitle("Arregla error inicio sesión página")).toBe("Arregla error inicio sesión");
  });

  it("keeps the prompt's language", () => {
    expect(normalizeSessionTitle("Arregla la redirección del login")).toBe(
      "Arregla la redirección del login",
    );
  });

  it("counts words in scripts without spaces", () => {
    const out = normalizeSessionTitle("修复登录重定向错误");
    expect(out).toBe("修复登录重定向错误");
    expect(out!.length).toBeLessThanOrEqual(SESSION_TITLE_MAX_CHARS);
  });

  it("uppercases the first letter", () => {
    expect(normalizeSessionTitle("add dark mode toggle")).toBe("Add dark mode toggle");
  });

  it("accepts two words", () => {
    expect(normalizeSessionTitle("Fix login.")).toBe("Fix login");
  });

  it("returns null for an unusable answer", () => {
    expect(normalizeSessionTitle("Fix")).toBeNull();
    expect(normalizeSessionTitle("Internationalization localization")).toBeNull(); // 33 characters, no cut fits 2 words
    expect(normalizeSessionTitle("")).toBeNull();
    expect(normalizeSessionTitle("   \n  ")).toBeNull();
    expect(normalizeSessionTitle("x".repeat(60))).toBeNull();
  });

  it("removes control characters and collapses whitespace", () => {
    expect(normalizeSessionTitle("Fix\u0007   login\t redirect\u200b bug")).toBe("Fix login redirect bug");
  });

  it("whatever it returns passes SessionTitle", () => {
    for (const raw of [
      '"Fix login redirect bug."',
      "Title: **Add dark mode toggle**",
      "# Fix Login Redirect Bug",
      "Fix API Rate Limit GitHub Client",
      "Investigate flaky replication, sync failures",
      "Redirección de login al expirar sesión",
      "Fix settings page login redirect bug",
      "修复登录重定向错误",
      "<b>Fix the broken login form</b>",
      "`Add retry to webhook handler`!",
    ]) {
      const out = normalizeSessionTitle(raw);
      expect(out, raw).not.toBeNull();
      expect(titleProblems(out!), raw).toEqual([]);
    }
  });
});

describe("SessionTitle (D-20, P-16)", () => {
  const ok = (t: string) => SessionTitle.safeParse(t).success;

  it("accepts a short sentence-case title", () => {
    expect(ok("Fix login redirect bug settings")).toBe(true);
    expect(ok("Arregla error inicio sesión")).toBe(true);
    expect(ok("Fix login")).toBe(true);
  });

  it("refuses titles out of shape", () => {
    expect(ok(`Fix ${"a".repeat(25)} now`)).toBe(false); // 33 characters
    expect(ok("Fix login redirect bug settings page")).toBe(false); // 36 characters, 6 words
    expect(ok("Fix the login bug on it")).toBe(false); // 6 words, 23 characters
    expect(ok("Fix")).toBe(false);
    expect(ok("")).toBe(false);
    expect(ok("Fix login\nredirect bug")).toBe(false);
    expect(ok("Fix login\u0007 redirect bug")).toBe(false);
    expect(ok("Fix `login` redirect bug")).toBe(false);
    expect(ok("Fix <b>login</b> redirect")).toBe(false);
    expect(ok("Fix **login** redirect bug")).toBe(false);
    expect(ok("Fix login redirect bug.")).toBe(false);
    expect(ok(" Fix login redirect bug")).toBe(false);
    expect(ok('"Fix login redirect bug"')).toBe(false);
  });

  it("refuses absolute host paths", () => {
    expect(ok("Fix /Users/victor/app login")).toBe(false);
    expect(ok("Clean /home/sam/build cache")).toBe(false);
    expect(ok("Clean ~/projects build cache")).toBe(false);
    expect(ok("Clean C:\\work build cache")).toBe(false);
  });

  it("names its problems", () => {
    expect(titleProblems("Fix")).toContain("too_few_words");
    expect(titleProblems("Fix the login bug on it")).toContain("too_many_words");
    expect(titleProblems(`Fix ${"a".repeat(25)} now`)).toContain("too_long");
    expect(titleProblems("Fix login redirect bug.")).toContain("trailing_punctuation");
  });
});

describe("title constants", () => {
  it("pins the shape: 2 to 5 words, at most 32 characters (fits a 1440 sidebar row)", () => {
    expect([SESSION_TITLE_MIN_WORDS, SESSION_TITLE_MAX_WORDS, SESSION_TITLE_MAX_CHARS]).toEqual([2, 5, 32]);
  });

  it("pins the small model per runtime, the timeout and the prompt cap", () => {
    expect(TITLE_MODEL).toEqual({ "claude-code": "haiku", codex: "gpt-6-luna" });
    expect(TITLE_TIMEOUT_MS).toBe(20_000);
    expect(TITLE_PROMPT_MAX_CHARS).toBe(4_000);
    expect(TitleSource.options).toEqual(["user", "heuristic", "auto"]);
    expect(TitleFailureCode.safeParse("title_timeout").success).toBe(true);
    expect(TitleFailureCode.safeParse("title_sanitized").success).toBe(true);
  });

  it("titleWords keeps word-like segments only", () => {
    expect(titleWords("Fix API rate-limit, now!")).toEqual(["Fix", "API", "rate", "limit", "now"]);
  });
});

describe("normalizeSessionTitle: linear on hostile runs (the API titles a chat from its first message)", () => {
  // `/[…]+$/u` trims and `/<[^>]*>/g` rescanned a run from every start position: ~0.9 s at 20 000 `…` (the chat body
  // cap), ~2.4 s at 32 000.
  const SHAPES = [".", "…", " .", "- ", '"', "« ", "<", "< "];
  const sized = (shape: string, size: number) =>
    `a${shape.repeat(Math.ceil(size / shape.length)).slice(0, size)}x`;
  for (const shape of SHAPES) {
    it(`a run of ${JSON.stringify(shape)} then one character scales linearly (64 000 → 256 KiB)`, () => {
      const CEILING = 2000;
      const small = sized(shape, 64_000);
      const large = sized(shape, 256 * 1024);
      // The smallest ratio of five small-then-large rounds after a warm-up, so one noisy round (pipeline 202: 11.95
      // from the best times of different rounds) cannot fail it; a run over the ceiling ends the measurement at once,
      // so a quadratic rule (tens of seconds at 256 KiB) fails in seconds.
      const { ratio, ratios, largeMs } = measureScaling(
        () => normalizeSessionTitle(small),
        () => normalizeSessionTitle(large),
        { ceilingMs: CEILING },
      );
      // ~4x the input: about 4x the time when linear, ~17x when quadratic. The 2 ms floor keeps a tiny baseline from
      // inflating the ratio; the ceiling is the backstop for a rule that is slow at every size.
      expect(largeMs).toBeLessThan(CEILING);
      expect(ratio, `per-round ratios ${ratios.map((r) => r.toFixed(1)).join(", ")}`).toBeLessThan(10);
    }, 60_000);
  }

  it("keeps stripping trailing punctuation, trailing quotes and tags as before", () => {
    expect(normalizeSessionTitle("Fix the login bug …!?. ")).toBe("Fix the login bug");
    expect(normalizeSessionTitle("«Fix the login bug» ")).toBe("Fix the login bug");
    expect(normalizeSessionTitle("Fix <b>login</b> redirect")).toBe("Fix login redirect");
    expect(normalizeSessionTitle("Fix <a<b> login redirect")).toBe("Fix login redirect");
    expect(normalizeSessionTitle("Fix <b login redirect")).toBe("Fix b login redirect");
    expect(normalizeSessionTitle("Fix a > b redirect")).toBe("Fix a b redirect");
  });
});
