import { expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { freshChannel, messageRow, openMessageActions, postAs } from "../support/chat";
import { ADMIN, shot } from "./env";

/**
 * CHAT-06 (04-01): an author edits a message from the hover toolbar (desktop) or the long-press sheet (390) and a
 * second member sees the new text and "(edited)" live, without reloading. Deletes (own, and an admin's
 * moderation) vanish live for the other member; a deleted thread root keeps its thread as a tombstone.
 */

/** Opens the actions of a message and picks "Delete message"; returns the confirm dialog. */
async function chooseDelete(page: Page, messageId: string, project: string) {
  const actions = await openMessageActions(page, messageId, project);
  if (project === "mobile") {
    await actions.getByTestId("delete-message").click();
  } else {
    await actions.getByTestId("message-more").click();
    await page.getByTestId("message-menu").getByTestId("delete-message").click();
  }
  const dialog = page.getByTestId("confirm-delete");
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe.configure({ mode: "serial" });

test("edit: the author's edit reaches another member live with an (edited) marker", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const size = project === "mobile" ? "390" : "1440";
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  const sam = await apiAs(SAM);
  const channel = await freshChannel(admin, [sam], "edit");
  const original = await postAs(admin, channel.id, "Launch checklist: staging deploy at 9:00");

  const a = await openAs(browser, ADMIN, project);
  const s = await openAs(browser, SAM, project);
  await a.page.goto(`${BASE_URL}/chat/${channel.id}`);
  await s.page.goto(`${BASE_URL}/chat/${channel.id}`);
  await expect(messageRow(s.page, original.id)).toContainText("staging deploy at 9:00");

  // ---- the author opens the actions and edits inline
  const actions = await openMessageActions(a.page, original.id, project);
  await shot(a.page, `chat-edit-toolbar-${size}`);
  await a.page.emulateMedia({ colorScheme: "dark" });
  await shot(a.page, `chat-edit-toolbar-${size}-dark`);
  await a.page.emulateMedia({ colorScheme: "light" });
  await actions.getByTestId("edit-message").click();
  const input = messageRow(a.page, original.id).getByTestId("edit-input");
  await expect(input).toBeVisible();
  // The editor focuses itself (caret at the end) on its first frame; fill only after that, or the two race.
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Launch checklist: staging deploy at 9:00");
  await input.fill("Launch checklist: staging deploy at 10:30");
  await messageRow(a.page, original.id).getByTestId("edit-save").click();
  await expect(messageRow(a.page, original.id).getByTestId("edit-input")).toHaveCount(0);
  await expect(messageRow(a.page, original.id)).toContainText("staging deploy at 10:30");

  // ---- the other member sees it live (no reload), with the marker
  const onSam = messageRow(s.page, original.id);
  await expect(onSam).toContainText("staging deploy at 10:30", { timeout: 5_000 });
  await expect(onSam.getByTestId("edited-marker")).toBeVisible({ timeout: 5_000 });
  await expect(onSam).not.toContainText("9:00");
  await shot(s.page, `chat-edited-${size}`);
  await s.page.emulateMedia({ colorScheme: "dark" });
  await shot(s.page, `chat-edited-${size}-dark`);

  await a.context.close();
  await s.context.close();
  await admin.dispose();
  await sam.dispose();
});

test("delete: own and moderated deletes vanish live; a deleted thread root stays as a tombstone", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const size = project === "mobile" ? "390" : "1440";
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  const sam = await apiAs(SAM);
  const channel = await freshChannel(admin, [sam], "delete");
  const own = await postAs(sam, channel.id, "Oops, wrong channel for this one");
  const spam = await postAs(sam, channel.id, "Buy cheap followers here");

  const a = await openAs(browser, ADMIN, project);
  const s = await openAs(browser, SAM, project);
  await a.page.goto(`${BASE_URL}/chat/${channel.id}`);
  await s.page.goto(`${BASE_URL}/chat/${channel.id}`);
  await expect(messageRow(a.page, own.id)).toBeVisible();

  // ---- Sam deletes his own message; it disappears from the admin's page live
  const dialog = await chooseDelete(s.page, own.id, project);
  await expect(dialog).toContainText("wrong channel for this one");
  await shot(s.page, `chat-delete-confirm-${size}`);
  await s.page.emulateMedia({ colorScheme: "dark" });
  await shot(s.page, `chat-delete-confirm-${size}-dark`);
  await s.page.emulateMedia({ colorScheme: "light" });
  await dialog.getByTestId("confirm-delete-submit").click();
  await expect(dialog).toBeHidden();
  await expect(messageRow(s.page, own.id)).toHaveCount(0);
  await expect(messageRow(a.page, own.id)).toHaveCount(0, { timeout: 5_000 });

  // ---- the admin moderates Sam's next message (offered by viewerCan message.delete_any)
  const moderation = await chooseDelete(a.page, spam.id, project);
  await expect(moderation).toContainText("audit log");
  await moderation.getByTestId("confirm-delete-submit").click();
  await expect(messageRow(a.page, spam.id)).toHaveCount(0);
  await expect(messageRow(s.page, spam.id)).toHaveCount(0, { timeout: 5_000 });

  // ---- a deleted thread root with replies stays as a tombstone with its reply count
  const root = await postAs(admin, channel.id, "Retro notes for the launch");
  await postAs(sam, channel.id, "Adding my notes in the thread", { threadRootId: root.id });
  await expect(messageRow(s.page, root.id).getByTestId("thread-summary")).toContainText("1 reply");
  const removed = await admin.delete(`/api/v1/messages/${root.id}`);
  expect(removed.ok()).toBe(true);
  const tomb = messageRow(s.page, root.id);
  await expect(tomb.getByTestId("message-tombstone")).toHaveText("This message was deleted.", {
    timeout: 5_000,
  });
  await expect(tomb.getByTestId("thread-summary")).toContainText("1 reply");
  await expect(tomb).not.toContainText("Retro notes");
  await shot(s.page, `chat-tombstone-${size}`);
  await s.page.emulateMedia({ colorScheme: "dark" });
  await shot(s.page, `chat-tombstone-${size}-dark`);

  await a.context.close();
  await s.context.close();
  await admin.dispose();
  await sam.dispose();
});
