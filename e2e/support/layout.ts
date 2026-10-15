import { expect, type Locator, type Page } from "@playwright/test";
import { shot } from "../tests/env";

/**
 * Layout checks shared by the 07.5 web specs (07.5-09, reused by 10-15; generalised from ai-chat-visual.spec.ts, which
 * keeps its own copy): every visible control has an accessible name, nothing scrolls sideways, every control is a
 * 44 px target below 1024, and review captures in light and dark (C-03, UI-SPEC R11).
 */

/** Visible controls without an accessible name (aria-label, labelledby, text, a `<label>` or title). */
export async function unnamedControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const nameOf = (el: Element) => {
      const label = el.getAttribute("aria-label")?.trim();
      if (label) return label;
      const by = el.getAttribute("aria-labelledby");
      if (by) {
        const text = by
          .split(/\s+/u)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
          .trim();
        if (text) return text;
      }
      const text = (el as HTMLElement).innerText?.trim() || el.textContent?.trim();
      if (text) return text;
      if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return "label";
      if (el.closest("label")?.textContent?.trim()) return "label";
      return el.getAttribute("title")?.trim() ?? "";
    };
    const selector =
      'button, [role="button"], a[href], [role="menuitem"], [role="option"], [role="switch"], [role="tab"], input:not([type="hidden"]), select, textarea';
    return [...document.querySelectorAll(selector)]
      .filter((el) => !el.closest('[aria-hidden="true"], [inert]') && visible(el) && !nameOf(el))
      .map((el) => el.outerHTML.slice(0, 200));
  });
}

/** The page never scrolls sideways (soft, so one screen never hides the others). */
export async function expectNoSidewaysScroll(page: Page, label = "page"): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect.soft(scrollWidth, `${label}: no sideways scroll`).toBeLessThanOrEqual(innerWidth);
}

/**
 * Below 1024 px every visible button, link, tab, radio and checkbox under `root` is at least 44 × 44. A native radio or
 * checkbox counts by its `<label>` (the hit area a finger uses); visually hidden (sr-only) elements are skipped.
 */
export async function expectTouchTargets(page: Page, root: string | Locator): Promise<void> {
  const width = page.viewportSize()?.width ?? 1440;
  if (width >= 1024) return;
  const locator = typeof root === "string" ? page.locator(root).first() : root;
  const small = await locator.evaluate((el) => {
    const out: string[] = [];
    const controls = el.querySelectorAll(
      'button, a[href], [role="tab"], [role="button"], input[type="radio"], input[type="checkbox"]',
    );
    for (const c of controls) {
      if (c.closest('[aria-hidden="true"], [inert]')) continue;
      const s = getComputedStyle(c);
      if (s.display === "none" || s.visibility === "hidden") continue;
      const target = c instanceof HTMLInputElement ? (c.closest("label") ?? c) : c;
      const r = target.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue; // sr-only
      if (r.width < 43.5 || r.height < 43.5) {
        out.push(`${Math.round(r.width)}×${Math.round(r.height)} ${c.outerHTML.slice(0, 140)}`);
      }
    }
    return out;
  });
  expect.soft(small, "controls under 44 × 44 below 1024").toEqual([]);
}

/**
 * Saves `<name>.png`, switches to dark, saves `<name>-dark.png`, and restores light. No-op without
 * OCW_E2E_SCREENSHOT_DIR (`shot` decides). Toasts are waited out so they never cover what is reviewed.
 */
export async function captureReview(page: Page, name: string): Promise<void> {
  if (!process.env.OCW_E2E_SCREENSHOT_DIR) return;
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
  const viewport = page.viewportSize();
  // The pointer rests on an empty edge, so no hover state is captured by accident.
  if (viewport && viewport.width >= 1024) await page.mouse.move(viewport.width - 4, viewport.height - 4);
  await page.emulateMedia({ colorScheme: "light" });
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}
