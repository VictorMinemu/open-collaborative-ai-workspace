import { expect, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { apiAs, BASE_URL, openAs } from "../support/actors";
import { createBoardChannel, createCard, openBoard } from "../support/board";
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
