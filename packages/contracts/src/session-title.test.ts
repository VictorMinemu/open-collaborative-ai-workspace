import { describe, expect, it } from "vitest";
import {
  normalizeSessionTitle,
  SESSION_TITLE_MAX_CHARS,
  SessionTitle,
  TITLE_MODEL,
  TITLE_PROMPT_MAX_CHARS,
  TITLE_TIMEOUT_MS,
  TitleFailureCode,
  TitleSource,
  titleProblems,
  titleWords,
} from "./index";

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

  it("keeps all-caps and mixed-case words and caps the title at six words", () => {
    expect(normalizeSessionTitle("Fix API Rate Limit In GitHub Client")).toBe("Fix API rate limit in GitHub");
  });

  it("takes the first non-empty line of a multi-line answer", () => {
    expect(normalizeSessionTitle("\n  Add dark mode toggle\nThis title describes the request.")).toBe(
      "Add dark mode toggle",
    );
  });

  it("cuts a long title at a word boundary within 48 characters, without trailing punctuation", () => {
    const out = normalizeSessionTitle("Investigate intermittent synchronization, failures in replication");
    expect(out).toBe("Investigate intermittent synchronization");
    expect(out!.length).toBeLessThanOrEqual(SESSION_TITLE_MAX_CHARS);
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

  it("returns null for an unusable answer", () => {
    expect(normalizeSessionTitle("Fix login")).toBeNull();
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
      "Fix API Rate Limit In GitHub Client",
      "Investigate intermittent synchronization, failures in replication",
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
    expect(ok("Fix login redirect bug settings page")).toBe(true);
    expect(ok("Arregla error inicio sesión página ajustes")).toBe(true);
  });

  it("refuses titles out of shape", () => {
    expect(ok(`Fix ${"a".repeat(45)} now`)).toBe(false); // 49 characters
    expect(ok("Fix the login redirect bug on settings")).toBe(false); // 7 words
    expect(ok("Fix login")).toBe(false);
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
    expect(titleProblems("Fix login")).toContain("too_few_words");
    expect(titleProblems("Fix login redirect bug.")).toContain("trailing_punctuation");
  });
});

describe("title constants", () => {
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
