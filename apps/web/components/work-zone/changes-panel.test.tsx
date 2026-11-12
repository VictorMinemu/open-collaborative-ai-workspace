import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NoGitState, projectHasNoGit } from "./changes-panel";

const at = "2026-11-06T00:00:00.000Z";

describe("changes panel: a project without git", () => {
  it("is decided by the device's diff (or the last live changes), never guessed from a null branch", () => {
    expect(projectHasNoGit(undefined, null)).toBe(false);
    expect(
      projectHasNoGit(
        { files: [], patch: "", truncated: false, branch: null, headSha: null, generatedAt: at },
        null,
      ),
    ).toBe(false);
    expect(
      projectHasNoGit(
        { files: [], patch: "", truncated: false, branch: null, headSha: null, generatedAt: at, git: false },
        null,
      ),
    ).toBe(true);
    expect(
      projectHasNoGit(undefined, {
        files: [],
        branch: null,
        headSha: null,
        truncated: false,
        at,
        git: false,
      }),
    ).toBe(true);
  });

  it("renders a clear No git state instead of an error or an empty diff", () => {
    const html = renderToStaticMarkup(<NoGitState />);
    expect(html).toContain('data-testid="changes-no-git"');
    expect(html).toContain("No git");
    expect(html).toContain("not tracked");
  });
});

/** WCAG relative luminance of an `oklch(L C H)` colour (OKLab → linear sRGB, clamped). */
function oklchLuminance(css: string): number {
  const m = css.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/);
  if (!m) throw new Error(`not an oklch colour: ${css}`);
  const [L, C, H] = [Number(m[1]), Number(m[2]), (Number(m[3]) * Math.PI) / 180];
  const a = C * Math.cos(H);
  const b = C * Math.sin(H);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const R = clamp(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s);
  const G = clamp(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s);
  const B = clamp(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

describe("changes panel: the green counts and letters are readable small text (07.17.1.1 review WR-07)", () => {
  const css = readFileSync(join(__dirname, "../../app/globals.css"), "utf8");
  const source = readFileSync(join(__dirname, "changes-panel.tsx"), "utf8");

  it("--success-text is at least 4.5:1 on white in light mode; dark mode keeps --success", () => {
    const root = css.slice(css.indexOf(":root {"), css.indexOf("\n.dark {"));
    const light = root.match(/--success-text:\s*([^;]+);/)?.[1] ?? "";
    expect(1.05 / (oklchLuminance(light) + 0.05)).toBeGreaterThanOrEqual(4.5);
    const dark = css.slice(css.indexOf("\n.dark {"));
    expect(dark).toMatch(/--success-text:\s*var\(--success\);/);
    expect(css).toMatch(/--color-success-text:\s*var\(--success-text\);/);
    // The fill colour the badges use is not darkened.
    expect(root).toMatch(/--success:\s*oklch\(0\.65 0\.17 155\);/);
  });

  it("the Changes panel's counts and A/U letters use the text token, never the fill", () => {
    expect(source).not.toMatch(/text-success(?!-text)/);
    expect(source.match(/text-success-text/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });
});
