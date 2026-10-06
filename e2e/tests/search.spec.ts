import { expect, type Page, test } from "@playwright/test";
import { apiAs, ensureMember, openAs, SAM } from "../support/actors";
import { freshChannel, messageRow, postAs } from "../support/chat";
import { ADMIN, shot } from "./env";

/**
 * CHAT-11 / D-04 (04-06): ⌘K search over PostgreSQL full-text. Accent-less Spanish finds accented text, the hit
 * shows a highlighted snippet, and choosing it lands on the message highlighted through its permalink.
 */

async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** A lowercase token unique to this run, so earlier runs and the other project never add hits. */
const uniqueWord = () =>
  `zq${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.replace(/[0-9]/g, (d) =>
    String.fromCharCode(97 + Number(d)),
  );

async function openPalette(page: Page, project: string) {
  if (project === "mobile") await page.getByTestId("open-search").click();
  else await page.keyboard.press("ControlOrMeta+K");
  const palette = page.getByTestId("search-palette");
  await expect(palette).toBeVisible();
  await expect(palette.getByTestId("search-input")).toBeFocused();
  return palette;
}

test.describe.configure({ mode: "serial" });

test("⌘K → accent-less Spanish word → highlighted hit → lands on the message highlighted", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const size = project === "mobile" ? "390" : "1440";
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  const sam = await apiAs(SAM);
  const channel = await freshChannel(admin, [sam], "busqueda");
  const word = uniqueWord();
  await postAs(admin, channel.id, `Arrancamos el despliegue del clúster ${word}`);
  const target = await postAs(
    admin,
    channel.id,
    `La migración de autenticación del clúster ${word} terminó sin errores`,
  );
  for (let n = 1; n <= 30; n++) await postAs(sam, channel.id, `Mensaje de relleno ${n}`);

  const s = await openAs(browser, SAM, project);
  const palette = await openPalette(s.page, project);
  await palette.getByTestId("search-input").pressSequentially(`migracion ${word}`, { delay: 30 });

  const hit = palette.locator(`[data-kind="message"][data-message-id="${target.id}"]`);
  await expect(hit).toBeVisible();
  await expect(palette.locator('[data-kind="message"]')).toHaveCount(1);
  await expect(hit.locator("mark").first()).toHaveText("migración");
  await expect(hit).toContainText(`#${channel.name}`);
  await expect(hit).toContainText(ADMIN.name);
  // Snippets are text: no element other than <mark> inside the snippet.
  expect(await hit.locator("script, img, a").count()).toBe(0);
  await bothThemes(s.page, `search-palette-${size}`);

  if (project === "mobile") await hit.click();
  else {
    await expect(hit).toHaveAttribute("aria-selected", "true");
    await s.page.keyboard.press("Enter");
  }
  await expect(palette).toBeHidden();
  await expect(s.page).toHaveURL(new RegExp(`/chat/${channel.id}\\?m=${target.id}`));
  const row = messageRow(s.page, target.id);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-highlighted", "true");
  await expect(row).toBeInViewport();

  await s.context.close();
  await admin.dispose();
  await sam.dispose();
});
