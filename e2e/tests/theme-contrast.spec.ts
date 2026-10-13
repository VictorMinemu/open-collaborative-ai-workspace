import { expect, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { apiAs, BASE_URL, openAs } from "../support/actors";
import { cardTile, createBoardChannel, createCard, openBoard } from "../support/board";
import { ADMIN, shot } from "./env";

/**
 * Dark-mode primary buttons meet WCAG AA (07.1-14, WINDOWS #106). The text on `--primary` measured 3.44:1 in dark mode
 * (4.5:1 is required), so axe reported every enabled primary button. axe runs on screens whose primary buttons are
 * enabled: the board toolbar's New card, the New card dialog with a description, and the create-channel dialog with
 * a name. Screenshots: `dark-primary-*`, at 1440 and 390.
 */

test("dark mode: enabled primary buttons pass axe color-contrast (board toolbar, New card, Create channel)", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const width = project === "mobile" ? 390 : 1440;
  const admin = await apiAs(ADMIN);
  const { id: convId } = await createBoardChannel(admin, { prefix: "contrast" });
  await createCard(admin, convId, { description: "Broken pump\nPump 3 leaks", waitingOn: "customer" });
  const { context, page } = await openAs(browser, ADMIN, project);
  await page.emulateMedia({ colorScheme: "dark" });
  await openBoard(page, convId);

  // ---- the board toolbar: New card is an enabled primary button
  const newCardButton = page.getByTestId("new-card-button").filter({ visible: true }).first();
  await expect(newCardButton).toBeEnabled();
  await shot(page, `dark-primary-board-${width}`);
  await expectNoSeriousA11y(page, '[data-testid="board-toolbar"]');

  // ---- New card with a description: Create card is enabled
  await newCardButton.click();
  const newCard = page.getByTestId("new-card");
  await expect(newCard).toBeVisible();
  await newCard.getByLabel("Description").fill("Seal kit for pump 3");
  await expect(newCard.getByTestId("new-card-submit")).toBeEnabled();
  await shot(page, `dark-primary-new-card-${width}`);
  await expectNoSeriousA11y(page, '[data-testid="new-card"]');
  await page.keyboard.press("Escape");
  await expect(newCard).toBeHidden();

  // ---- the create-channel dialog with a name: Create channel is enabled (at 390 from the navigation sheet)
  await page.goto(`${BASE_URL}/chat`);
  if (project === "mobile") await page.getByTestId("mobile-nav-trigger").click();
  await page.getByTestId("create-channel").filter({ visible: true }).first().click();
  const dialog = page.getByTestId("create-channel-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Name").fill("contrast-check");
  await expect(dialog.getByTestId("create-channel-submit")).toBeEnabled();
  await shot(page, `dark-primary-create-channel-${width}`);
  await expectNoSeriousA11y(page, '[data-testid="create-channel-dialog"]');

  await context.close();
  await admin.dispose();
});

/**
 * Dark-mode destructive buttons and destructive text meet WCAG AA (07.1 fix, after 07.1-14's open item 1). White text
 * on the dark `--destructive` measured about 3.3:1. axe runs on enabled destructive buttons (Delete card and Delete
 * column, the latter with its move target chosen), on the card menu with Delete card… highlighted, and on an inline
 * column-name error. Screenshots: `dark-destructive-*`, at 1440 and 390.
 */
test("dark mode: destructive buttons and destructive text pass axe color-contrast (Delete card, Delete column, errors)", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const width = project === "mobile" ? 390 : 1440;
  const admin = await apiAs(ADMIN);
  const { id: convId } = await createBoardChannel(admin, { prefix: "contrast-destructive" });
  const card = await createCard(admin, convId, { description: "Broken pump\nPump 3 leaks" });
  const { context, page } = await openAs(browser, ADMIN, project);
  await page.emulateMedia({ colorScheme: "dark" });
  const board = await openBoard(page, convId);

  // ---- the card menu: Delete card… is destructive text on the popover, highlighted on a destructive tint
  await cardTile(board, card.messageId).filter({ visible: true }).getByTestId("card-menu").click();
  const deleteItem = page.getByRole("menuitem", { name: "Delete card…" });
  await deleteItem.hover();
  await expect(deleteItem).toHaveAttribute("data-highlighted", "");
  await shot(page, `dark-destructive-card-menu-${width}`);
  await expectNoSeriousA11y(page, '[data-testid="card-menu-content"]');

  // ---- Delete card: an enabled destructive button
  await deleteItem.click();
  const deleteCard = page.getByTestId("delete-card");
  await expect(deleteCard.getByTestId("delete-card-submit")).toBeEnabled();
  await shot(page, `dark-destructive-delete-card-${width}`);
  await expectNoSeriousA11y(page, '[data-testid="delete-card"]');
  await deleteCard.getByRole("button", { name: "Cancel" }).click();
  await expect(deleteCard).toBeHidden();

  // ---- Delete column with its cards' target chosen: an enabled destructive button
  const backlogActions = page
    .getByRole("button", { name: "Backlog column actions" })
    .filter({ visible: true });
  await backlogActions.click();
  await page.getByRole("menuitem", { name: "Delete column…" }).click();
  const deleteColumn = page.getByTestId("delete-column");
  await deleteColumn.getByTestId("column-move-to").click();
  await page.getByRole("option", { name: "Done" }).click();
  await expect(deleteColumn.getByTestId("delete-column-submit")).toBeEnabled();
  await shot(page, `dark-destructive-delete-column-${width}`);
  await expectNoSeriousA11y(page, '[data-testid="delete-column"]');
  await deleteColumn.getByRole("button", { name: "Cancel" }).click();
  await expect(deleteColumn).toBeHidden();

  // ---- an inline error: renaming Backlog to an existing column's name
  await backlogActions.click();
  await page.getByRole("menuitem", { name: "Edit column…" }).click();
  const settings = page.getByTestId("column-settings");
  await settings.getByLabel("Name").fill("done");
  await settings.getByTestId("column-settings-submit").click();
  await expect(settings.getByRole("alert")).toHaveText("A column named “done” already exists");
  await shot(page, `dark-destructive-column-error-${width}`);
  await expectNoSeriousA11y(page, '[data-testid="column-settings"]');

  await context.close();
  await admin.dispose();
});
