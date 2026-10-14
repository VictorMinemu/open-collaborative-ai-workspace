import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * Accessibility gate for the specs (Phase 07.1, created by 07.1-08; reused by later phases). Runs axe-core through
 * `@axe-core/playwright` on the elements matching `selector` and fails on any violation whose impact is **serious**
 * or **critical**, listing rule ids and targets. Moderate and minor findings are printed, not failed, unless their rule
 * is in `failOn` (a screen that fixed one, e.g. `heading-order` on the memory viewer, keeps it fixed).
 *
 * Fallback: if `@axe-core/playwright` is not installed, the helper says so in the test output and asserts roles and
 * accessible names instead (the region is named, every button, tab, menu item and form control has a name).
 */
export async function expectNoSeriousA11y(
  page: Page,
  selector: string,
  opts: { failOn?: readonly string[] } = {},
): Promise<void> {
  await expect(page.locator(selector).first()).toBeVisible();
  // Opening dialogs, menus and sheets fade in: colours measured mid-transition are blends, not the real contrast.
  // Infinite animations (a pulse, a spinner, a skeleton shimmer) never finish: waiting on them would hang until the
  // test times out, so only finite ones are awaited.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  let AxeBuilder: typeof import("@axe-core/playwright")["default"] | null = null;
  try {
    AxeBuilder = (await import("@axe-core/playwright")).default;
  } catch {
    AxeBuilder = null;
  }
  if (!AxeBuilder) {
    test
      .info()
      .annotations.push({ type: "a11y", description: `axe unavailable: role/name fallback on ${selector}` });
    console.log(`[a11y] @axe-core/playwright not installed: checking roles and names on ${selector}`);
    await rolesAndNames(page, selector);
    return;
  }
  const results = await new AxeBuilder({ page }).include(selector).analyze();
  const failOn = opts.failOn ?? [];
  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical" || failOn.includes(v.id),
  );
  const minor = results.violations.filter((v) => !blocking.includes(v));
  if (minor.length > 0) {
    console.log(`[a11y] ${selector}: non-blocking ${minor.map((v) => `${v.id} (${v.impact})`).join(", ")}`);
  }
  const report = blocking
    .map(
      (v) =>
        `${v.id} [${v.impact}] ${v.help}\n${v.nodes
          .slice(0, 5)
          .map((n) => `    ${n.target.join(" ")}: ${n.failureSummary?.split("\n").join(" ") ?? ""}`)
          .join("\n")}`,
    )
    .join("\n");
  const what = failOn.length > 0 ? `serious, critical or ${failOn.join("/")}` : "serious or critical";
  expect(blocking, `${what} axe violations in ${selector}:\n${report}`).toEqual([]);
}

/** Without axe: every interactive element under `selector` has a role-appropriate accessible name. */
async function rolesAndNames(page: Page, selector: string): Promise<void> {
  const unnamed = await page.locator(selector).evaluateAll((roots) => {
    const out: string[] = [];
    for (const root of roots) {
      const els = root.querySelectorAll(
        'button, [role="tab"], [role="menuitem"], [role="menuitemradio"], input, select, textarea, [role="region"]',
      );
      for (const el of els) {
        const label =
          el.getAttribute("aria-label") ??
          (el.getAttribute("aria-labelledby") ? "labelledby" : null) ??
          (el.id ? root.ownerDocument.querySelector(`label[for="${el.id}"]`)?.textContent : null) ??
          el.closest("label")?.textContent ??
          el.textContent;
        if (!label?.trim()) out.push(el.outerHTML.slice(0, 120));
      }
    }
    return out;
  });
  expect(unnamed, `elements without an accessible name in ${selector}`).toEqual([]);
}

/**
 * The WCAG contrast ratio of an element's own colour (`color`: its text, or an SVG icon's `currentColor`) against what
 * it is painted on: every translucent background from the element up to the first opaque one, composited (07.4-14,
 * WINDOWS #197). axe checks text only; icon-only tiles need 3:1 (WCAG 1.4.11) and are checked with this.
 */
export async function contrastOf(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d context");
    const rgba = (css: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, (d[3] ?? 0) / 255];
    };
    const layers: Array<[number, number, number, number]> = [];
    for (let n: Element | null = el; n; n = n.parentElement) {
      const c = rgba(getComputedStyle(n).backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break;
    }
    let bg: [number, number, number] = [255, 255, 255];
    for (const [r, g, b, a] of layers.reverse()) {
      bg = [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)];
    }
    const [fr, fg, fb, fa] = rgba(getComputedStyle(el).color);
    const fgc = [fr * fa + bg[0] * (1 - fa), fg * fa + bg[1] * (1 - fa), fb * fa + bg[2] * (1 - fa)];
    const lum = (c: number[]) => {
      const [r, g, b] = c.map((v) => {
        const x = v / 255;
        return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
    };
    const [hi, lo] = [lum(fgc), lum(bg)].sort((x, y) => y - x);
    return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
  });
}
