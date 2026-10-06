import { expect, type Locator, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { freshChannel, messageRow, openMessageActions, postAs } from "../support/chat";
import { ADMIN, shot } from "./env";

/**
 * CHAT-07 / CHAT-13 (04-05): reactions from the toolbar, the long-press sheet and the full picker reach another
 * member live, per-viewer highlights included; pins and personal saves live on the same message actions.
 */

async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** The chip of `emoji` under a message. */
const chip = (row: Locator, emoji: string) =>
  row.locator(`[data-testid="reaction-chip"][data-emoji="${emoji}"]`);

/** Adds a quick reaction from the hover toolbar (desktop) or the long-press sheet (mobile). */
async function quickReact(page: Page, messageId: string, emoji: string, project: string) {
  const actions = await openMessageActions(page, messageId, project);
  await actions.locator(`[data-testid="quick-reaction"][data-emoji="${emoji}"]`).click();
  if (project === "mobile") await expect(page.getByTestId("message-sheet")).toBeHidden();
}

/** Opens the full picker from the message actions; returns the picker. */
async function openPicker(page: Page, messageId: string, project: string): Promise<Locator> {
  const actions = await openMessageActions(page, messageId, project);
  await actions.getByTestId("add-reaction").click();
  const picker = page.getByTestId("emoji-picker");
  await expect(picker).toBeVisible();
  // The emoji data is served by the app itself (no CDN): the grid fills once it loaded.
  await expect(picker.locator('[data-testid="emoji-option"]:visible').first()).toBeVisible({
    timeout: 10_000,
  });
  return picker;
}

test.describe.configure({ mode: "serial" });

test("reactions: toolbar/sheet and picker reactions reach another member live, highlights per viewer", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const size = project === "mobile" ? "390" : "1440";
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  const sam = await apiAs(SAM);
  const channel = await freshChannel(admin, [sam], "react");
  const msg = await postAs(admin, channel.id, "Release 2.4 is out on staging");

  const a = await openAs(browser, ADMIN, project);
  const s = await openAs(browser, SAM, project);
  await a.page.goto(`${BASE_URL}/chat/${channel.id}`);
  await s.page.goto(`${BASE_URL}/chat/${channel.id}`);
  const onAdmin = messageRow(a.page, msg.id);
  const onSam = messageRow(s.page, msg.id);
  await expect(onSam).toContainText("Release 2.4");

  // ---- the admin adds 👍 from the quick reactions; Sam sees the chip live
  await quickReact(a.page, msg.id, "👍", project);
  await expect(chip(onAdmin, "👍")).toHaveAttribute("data-mine", "true");
  await expect(chip(onSam, "👍")).toContainText("1", { timeout: 5_000 });
  await expect(chip(onSam, "👍")).toHaveAttribute("data-mine", "false");

  // ---- Sam clicks the chip: both see 2
  await chip(onSam, "👍").click();
  await expect(chip(onSam, "👍")).toContainText("2");
  await expect(chip(onSam, "👍")).toHaveAttribute("data-mine", "true");
  await expect(chip(onAdmin, "👍")).toContainText("2", { timeout: 5_000 });

  // ---- the admin removes theirs: the highlight stays on Sam's page only
  await chip(onAdmin, "👍").click();
  await expect(chip(onAdmin, "👍")).toContainText("1");
  await expect(chip(onAdmin, "👍")).toHaveAttribute("data-mine", "false");
  await expect(chip(onSam, "👍")).toContainText("1", { timeout: 5_000 });
  await expect(chip(onSam, "👍")).toHaveAttribute("data-mine", "true");
  await bothThemes(s.page, `reactions-bar-${size}`);

  // ---- the admin picks 🎉 through the full picker (search "tada")
  const picker = await openPicker(a.page, msg.id, project);
  await bothThemes(a.page, `reactions-picker-${size}`);
  await picker.getByTestId("emoji-search").fill("tada");
  const tada = picker.locator('[data-testid="emoji-option"][data-emoji="🎉"]:visible').first();
  await expect(tada).toBeVisible();
  await tada.click();
  await expect(picker).toBeHidden();
  await expect(chip(onAdmin, "🎉")).toHaveAttribute("data-mine", "true");
  await expect(chip(onSam, "🎉")).toContainText("1", { timeout: 5_000 });
  // First-reaction order: 👍 then 🎉.
  await expect(onSam.getByTestId("reaction-chip")).toHaveCount(2);
  await expect(onSam.getByTestId("reaction-chip").first()).toHaveAttribute("data-emoji", "👍");

  // ---- a thread reply gets a reaction in the thread panel, live for Sam
  const root = await postAs(admin, channel.id, "Who reviews the migration?");
  const reply = await postAs(sam, channel.id, "I can take it this afternoon", { threadRootId: root.id });
  await s.page.goto(`${BASE_URL}/chat/${channel.id}?thread=${root.id}`);
  await a.page.goto(`${BASE_URL}/chat/${channel.id}?thread=${root.id}`);
  const replyOnSam = s.page.getByTestId("thread-panel").locator(`[data-message-id="${reply.id}"]`);
  await expect(replyOnSam).toContainText("this afternoon");
  await expect(a.page.getByTestId("thread-panel").locator(`[data-message-id="${reply.id}"]`)).toBeVisible();
  await quickReact(a.page, reply.id, "✅", project);
  await expect(chip(replyOnSam, "✅")).toContainText("1", { timeout: 5_000 });
  await expect(chip(replyOnSam, "✅")).toHaveAttribute("data-mine", "false");

  await a.context.close();
  await s.context.close();
  await admin.dispose();
  await sam.dispose();
});
