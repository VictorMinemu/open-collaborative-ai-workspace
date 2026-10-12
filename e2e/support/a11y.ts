import { expect, type Page, test } from "@playwright/test";

/**
 * Accessibility gate for the specs (Phase 07.1, created by 07.1-08; reused by later phases). Runs axe-core through
 * `@axe-core/playwright` on the elements matching `selector` and fails on any violation whose impact is **serious**
 * or **critical**, listing rule ids and targets. Moderate and minor findings are printed, not failed.
 *
 * Fallback: if `@axe-core/playwright` is not installed, the helper says so in the test output and asserts roles and
 * accessible names instead (the region is named, every button, tab, menu item and form control has a name).
 */
export async function expectNoSeriousA11y(page: Page, selector: string): Promise<void> {
  await expect(page.locator(selector).first()).toBeVisible();
  // Opening dialogs, menus and sheets fade in: colours measured mid-transition are blends, not the real contrast.
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
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
  const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
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
  expect(blocking, `serious or critical axe violations in ${selector}:\n${report}`).toEqual([]);
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
