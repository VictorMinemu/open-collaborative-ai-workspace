import { expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { freshTeamBot } from "../support/bot-tools";
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

test("typing in the palette stays there when a channel mounts behind it (the composer never takes focus from a dialog)", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "⌘K is the desktop shortcut");
  test.setTimeout(90_000);
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  await admin.dispose();
  const word = uniqueWord();
  const s = await openAs(browser, SAM, "desktop");
  // Phase 4 race, found by the 07.1 gate under a full run's load: the palette opened while #general was still
  // mounting, and the composer's autoFocus took the keyboard from the open dialog, so the end of the query went into
  // the composer behind it. Here the channel mounts behind the open palette on purpose: All (no composer), open the
  // palette, half the query, then Back to the channel.
  await s.page.getByRole("link", { name: "All", exact: true }).click();
  await expect(s.page).toHaveURL(/\/chat\/all$/);
  await expect(s.page.getByTestId("composer")).toHaveCount(0);
  const palette = await openPalette(s.page, "desktop");
  const input = palette.getByTestId("search-input");
  await input.pressSequentially("migra", { delay: 30 });
  await s.page.goBack();
  await expect(s.page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
  await expect(s.page.getByTestId("composer")).toBeAttached();
  await input.pressSequentially(`cion ${word}`, { delay: 30 });
  await expect(input).toHaveValue(`migracion ${word}`);
  await expect(input).toBeFocused();
  await expect(s.page.getByTestId("composer")).toHaveValue("");
  await s.context.close();
});

test("results page: In and From narrow the hits, Load more appends the next page", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const size = project === "mobile" ? "390" : "1440";
  const admin = await apiAs(ADMIN);
  const samId = await ensureMember(admin, SAM, "developer");
  const sam = await apiAs(SAM);
  const ops = await freshChannel(admin, [sam], "ops");
  const web = await freshChannel(admin, [sam], "web");
  const word = uniqueWord();
  for (let n = 1; n <= 18; n++) await postAs(admin, ops.id, `deploy ${word} step ${n}`);
  for (let n = 1; n <= 4; n++) await postAs(sam, ops.id, `Sam deployed ${word} hotfix ${n}`);
  for (let n = 1; n <= 3; n++) await postAs(admin, web.id, `deploy ${word} web ${n}`);

  const s = await openAs(browser, SAM, project);
  await s.page.goto(`${BASE_URL}/search?q=${encodeURIComponent(`deploy ${word}`)}`);
  const count = s.page.getByTestId("search-count");
  const hits = s.page.getByTestId("search-page-hit");
  await expect(count).toHaveText("20+ messages");
  await expect(hits).toHaveCount(20);
  await expect(hits.first().locator("mark").first()).toBeVisible();

  // Load more appends the last 5.
  await s.page.getByTestId("search-load-more").click();
  await expect(hits).toHaveCount(25);
  await expect(count).toHaveText("25 messages");
  await expect(s.page.getByTestId("search-load-more")).toHaveCount(0);

  // In: only #ops (22 hits → still more than a page).
  await s.page.getByTestId("filter-in").click();
  const inPicker = s.page.getByTestId("picker-in");
  await inPicker.getByRole("textbox").fill(ops.name);
  await inPicker.locator(`[data-option-id="${ops.id}"]`).click();
  await expect(s.page).toHaveURL(new RegExp(`[?&]in=${ops.id}`));
  await expect(count).toHaveText("20+ messages");

  // From: only Sam's (4).
  await s.page.getByTestId("filter-from").click();
  const fromPicker = s.page.getByTestId("picker-from");
  await fromPicker.getByRole("textbox").fill("Sam Lee");
  await fromPicker.locator(`[data-option-id="${samId}"]`).click();
  await expect(s.page).toHaveURL(new RegExp(`[?&]from=${samId}`));
  await expect(count).toHaveText("4 messages");
  await expect(hits).toHaveCount(4);
  for (const text of await hits.allInnerTexts()) expect(text).toContain("Sam Lee");
  await expect(s.page.getByTestId("filter-in")).toContainText(`#${ops.name}`);
  await bothThemes(s.page, `search-results-${size}`);

  // Clearing In widens to Sam's messages everywhere (still 4: Sam only posted in #ops).
  await s.page.getByTestId("filter-in-clear").click();
  await expect(s.page).not.toHaveURL(/[?&]in=/);
  await expect(count).toHaveText("4 messages");

  // A hit opens the message through its permalink.
  const first = hits.first();
  const messageId = await first.getAttribute("data-message-id");
  await first.click();
  await expect(s.page).toHaveURL(new RegExp(`/chat/${ops.id}\\?m=${messageId}`));
  await expect(messageRow(s.page, messageId ?? "")).toHaveAttribute("data-highlighted", "true");

  await s.context.close();
  await admin.dispose();
  await sam.dispose();
});

test("palette People shows Sam and a bot (the bot opens its DM); Channels opens a channel", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const admin = await apiAs(ADMIN);
  const samId = await ensureMember(admin, SAM, "developer");
  const botId = await freshTeamBot(admin, "Sammy Scout");
  const channel = await freshChannel(admin, [], "srch");

  const a = await openAs(browser, ADMIN, project);
  let palette = await openPalette(a.page, project);
  await palette.getByTestId("search-input").pressSequentially("sam", { delay: 30 });
  const person = palette.locator(`[data-kind="person"][data-person-id="${samId}"]`);
  const bot = palette.locator(`[data-kind="person"][data-person-id="${botId}"]`);
  await expect(person).toBeVisible();

  // A person shows their card; back returns to the results.
  await person.click();
  await expect(palette.getByTestId("search-profile")).toContainText("Sam Lee");
  await palette.getByRole("button", { name: "Back to results" }).click();
  await expect(person).toBeVisible();
  // Back returns the keyboard to the search field. Without it the dialog's focus restore re-focuses the popup
  // a frame later and can swallow the next keystrokes (seen on a loaded full run, 06.1-05).
  await expect(palette.getByTestId("search-input")).toBeFocused();

  // The bot is a person result too. "sam" alone matches more people than the overview shows on a shared stack
  // (other specs create their own Sams), so narrow to the bot's name.
  await palette.getByTestId("search-input").fill("");
  await palette.getByTestId("search-input").pressSequentially("sammy", { delay: 30 });
  await expect(bot).toBeVisible();
  await expect(bot).toContainText("BOT");

  // The bot opens its DM.
  await bot.click();
  await expect(palette).toBeHidden();
  await expect(a.page).toHaveURL(/\/chat\/dm\/[0-9a-f-]{36}/);

  // Channels: the fresh channel opens.
  palette = await openPalette(a.page, project);
  await palette.getByTestId("search-input").pressSequentially(channel.name, { delay: 10 });
  const hit = palette.locator(`[data-kind="channel"][data-channel-id="${channel.id}"]`);
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(a.page).toHaveURL(new RegExp(`/chat/${channel.id}$`));

  // "See all results" leads to the results page with the query.
  palette = await openPalette(a.page, project);
  await palette.getByTestId("search-input").fill("deploy");
  await palette.getByTestId("search-see-all").click();
  await expect(a.page).toHaveURL(/\/search\?q=deploy/);
  await expect(a.page.getByTestId("search-page-input")).toHaveValue("deploy");

  await a.context.close();
  await admin.dispose();
});
