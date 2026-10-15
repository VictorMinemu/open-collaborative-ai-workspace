import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { apiAs, BASE_URL, openAs } from "../support/actors";
import {
  clearApprovalPolicies,
  LUIS,
  MARTA,
  NORTHWIND_CRM,
  seedApprovalMcp,
  seedApprovalPeople,
  setApprovalPolicy,
} from "../support/approvals";
import {
  captureReview,
  expectNoSidewaysScroll,
  expectTouchTargets,
  unnamedControls,
} from "../support/layout";
import { ADMIN } from "./env";

/**
 * Settings › Approval policies (07.5-09; APPROVE-01, D-01, UI-SPEC Surface 4, R2-R5, R11). An admin decides which bot
 * actions need a person: the fake MCP server is registered as "Northwind CRM" (`echo` read-only, `write_note` destructive)
 * and every Northwind CRM tool is set to "Always ask" with Admins approving, from the page, in a few clicks. Leads add
 * approvals for the units they lead and can never relax the organization's; everyone else does not see the section.
 * API calls seed the stack (scripts/e2e-isolated.sh); no provider is called.
 */

test.describe.configure({ mode: "serial" });

let admin: APIRequestContext;
let safeName = "";
const serverPattern = () => `${safeName}__*`;
const tool = (name: string) => `${safeName}__${name}`;

/** The row's Edit: the ghost button at ≥ 768, the whole row below it (one of the two is visible). */
const editOf = (page: Page, pattern: string) =>
  page.getByTestId(`policy-edit-${pattern}`).filter({ visible: true });
const rowOf = (page: Page, pattern: string) => page.getByTestId(`policy-row-${pattern}`);
const toast = (page: Page, text: string) => page.locator("[data-sonner-toast]").filter({ hasText: text });

async function openPolicies(page: Page, mobile: boolean) {
  if (mobile) {
    await page.goto(`${BASE_URL}/settings/approval-policies`);
  } else {
    await page.goto(`${BASE_URL}/settings`);
    await page.getByTestId("settings-nav-approval-policies").click();
  }
  await expect(page).toHaveURL(/\/settings\/approval-policies/);
  const root = page.getByTestId("approval-policies");
  await expect(root).toBeVisible();
  return root;
}

async function expandGroup(page: Page, name: string) {
  const header = page.getByRole("button", { name: new RegExp(`^${name}`) });
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
}

test.beforeAll(async () => {
  admin = await apiAs(ADMIN);
  ({ safeName } = await seedApprovalMcp(admin));
  await seedApprovalPeople(admin);
});

test.beforeEach(async () => {
  await clearApprovalPolicies(admin);
});

test.afterAll(async () => {
  await clearApprovalPolicies(admin);
  await admin.dispose();
});

test("admin: Always ask for every Northwind CRM tool, from Settings, shown on every row", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const mobile = info.project.name === "mobile";
  const { page } = await openAs(browser, ADMIN, info.project.name);
  const root = await openPolicies(page, mobile);

  // ---- the catalog: explanation, scope, the groups and what can't use rules
  await expect(root).toContainText("When a bot wants to use a tool with a rule, it stops and asks a person.");
  await expect(page.getByTestId("policy-scope")).toContainText("Organization");
  const crm = page.getByTestId(`policy-group-${safeName}`);
  await expect(crm).toContainText(NORTHWIND_CRM);
  await expect(crm).toContainText("MCP server · 2 tools");
  await expect(crm.getByRole("button", { name: new RegExp(`^${NORTHWIND_CRM}`) })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(page.getByTestId("policy-group-plugin")).toContainText("Plugins");
  await expect(page.getByTestId("policy-group-http")).toContainText("Web requests");
  await expect(root).toContainText(
    "Web search, web pages, memory, cards and Work Zone proposals can't use these rules",
  );

  // ---- Northwind CRM expanded: the server row, then each tool with its effect, all Never ask
  await expandGroup(page, NORTHWIND_CRM);
  await expect(rowOf(page, serverPattern())).toContainText(`All ${NORTHWIND_CRM} tools`);
  await expect(rowOf(page, serverPattern())).toContainText("Never ask");
  await expect(rowOf(page, tool("echo"))).toContainText("Read-only");
  await expect(rowOf(page, tool("echo"))).toContainText("Never ask");
  await expect(rowOf(page, tool("write_note"))).toContainText("Changes data");
  await expect(rowOf(page, tool("write_note"))).toContainText("Never ask");

  // ---- Edit the server row: focus on the first radio, Save disabled until a change
  await editOf(page, serverPattern()).click();
  const dialog = page.getByTestId("policy-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`Approval for all ${NORTHWIND_CRM} tools`);
  await expect(dialog.getByTestId("policy-mode-never").locator("input")).toBeFocused();
  await expect(dialog.getByTestId("policy-save")).toBeDisabled();
  await dialog.getByTestId("policy-mode-always").click();
  await dialog.getByTestId("policy-approvers-admins").click();
  await expect(dialog.getByTestId("policy-save")).toBeEnabled();
  await dialog.getByTestId("policy-save").click();
  await expect(toast(page, "Rule saved")).toBeVisible();
  await expect(dialog).toBeHidden();

  // ---- the rows updated in place; focus back on the row's Edit
  await expect(rowOf(page, serverPattern()).getByTestId("policy-mode-chip")).toHaveText("Always ask");
  await expect(rowOf(page, serverPattern())).toContainText("Admins");
  for (const name of ["echo", "write_note"]) {
    await expect(rowOf(page, tool(name)).getByTestId("policy-mode-chip")).toHaveText("Always ask");
    await expect(rowOf(page, tool(name))).toContainText("from all tools");
  }
  await expect(editOf(page, serverPattern())).toBeFocused();
});

test("member: no Approval policies entry; the direct URL says they can't manage them", async ({
  browser,
}, info) => {
  const mobile = info.project.name === "mobile";
  const { page } = await openAs(browser, LUIS, info.project.name);
  await page.goto(`${BASE_URL}/settings/profile`);
  if (!mobile) {
    await expect(page.getByTestId("settings-nav-profile")).toBeVisible();
    await expect(page.getByTestId("settings-nav-approval-policies")).toHaveCount(0);
  }
  await page.goto(`${BASE_URL}/settings/approval-policies`);
  await expect(page.getByText("You can't manage approval policies")).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to settings" })).toBeVisible();
  await expect(page.getByTestId("approval-policies")).toHaveCount(0);
});

/** Opens the rule dialog of a row and returns it. */
async function openRule(page: Page, pattern: string) {
  await editOf(page, pattern).click();
  const dialog = page.getByTestId("policy-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test("lead: only the units they lead; the organization's Always is read-only; weaker options are disabled; they add an approval", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const mobile = info.project.name === "mobile";
  await setApprovalPolicy(admin, {
    scopeUnitId: null,
    toolPattern: tool("write_note"),
    mode: "always",
    approverKind: "admins",
  });
  await setApprovalPolicy(admin, {
    scopeUnitId: null,
    toolPattern: "ocw_http_request",
    mode: "when_tainted",
    approverKind: "requester",
  });
  const { page } = await openAs(browser, MARTA, info.project.name);
  await openPolicies(page, mobile);

  // ---- Scope: Sales and its team only, never the organization
  const scope = page.getByTestId("policy-scope");
  await expect(scope).toContainText("Sales (Department)");
  await scope.click();
  const options = page.getByRole("option");
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toContainText("Sales");
  await expect(options.nth(1)).toContainText("Sales East");
  await page.keyboard.press("Escape");

  // ---- the organization's Always on write_note: read-only, with its source and the reason
  const write = rowOf(page, tool("write_note"));
  await expect(write.getByTestId("policy-mode-chip")).toHaveText("Always ask");
  await expect(write.getByTestId("policy-source")).toHaveText("from Organization");
  await expect(write.getByTestId("policy-locked-reason")).toHaveText(
    "The organization already asks every time. A unit can only add approvals.",
  );
  if (mobile) {
    await expect(editOf(page, tool("write_note"))).toHaveCount(0);
  } else {
    await expect(editOf(page, tool("write_note"))).toHaveAttribute("aria-disabled", "true");
    // aria-disabled stays focusable (the reason is read with it); a click opens nothing.
    await editOf(page, tool("write_note")).click({ force: true });
    await expect(page.getByTestId("policy-dialog")).toHaveCount(0);
  }

  // ---- Web requests asks after outside content upstairs: Never ask is disabled with the reason
  let dialog = await openRule(page, "ocw_http_request");
  await expect(dialog.getByTestId("policy-mode-when_tainted").locator("input")).toBeChecked();
  await expect(dialog.getByTestId("policy-mode-never").locator("input")).toBeDisabled();
  await expect(dialog.getByTestId("policy-mode-never")).toContainText(
    "The organization already asks after outside content. A unit can only add approvals.",
  );
  await expect(dialog.getByTestId("policy-mode-always").locator("input")).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  // ---- the lead adds "Ask after outside content" with Leads of Sales on echo
  dialog = await openRule(page, tool("echo"));
  await expect(dialog).toContainText("Applies in Sales and its teams");
  await dialog.getByTestId("policy-mode-when_tainted").click();
  await dialog.getByTestId("policy-approvers-unit_leads").click();
  await expect(dialog).toContainText("The person who asked can't approve their own request.");
  await dialog.getByTestId("policy-save").click();
  await expect(toast(page, "Rule saved")).toBeVisible();
  await expect(rowOf(page, tool("echo")).getByTestId("policy-mode-chip")).toHaveText(
    "Ask after outside content",
  );
  await expect(rowOf(page, tool("echo"))).toContainText("Leads of Sales");
});

test("admin: specific people approve; reopening shows them checked", async ({ browser }, info) => {
  test.setTimeout(120_000);
  const mobile = info.project.name === "mobile";
  const { page } = await openAs(browser, ADMIN, info.project.name);
  await openPolicies(page, mobile);
  await expandGroup(page, NORTHWIND_CRM);

  let dialog = await openRule(page, tool("write_note"));
  await expect(dialog).toContainText("Applies to everyone");
  await expect(dialog.getByTestId("policy-approvers-unit_leads")).toHaveCount(0);
  await dialog.getByTestId("policy-mode-always").click();
  await dialog.getByTestId("policy-approvers-users").click();
  await expect(dialog.getByTestId("policy-save")).toBeDisabled();
  await expect(dialog.getByTestId("policy-people-count")).toHaveText("0 of 20");
  const search = dialog.getByTestId("policy-people-search");
  for (const name of ["Marta Gil", "Luis Mora"]) {
    await search.fill(name.split(" ")[0] ?? name);
    await dialog.locator(`[data-testid="policy-person"][data-name="${name}"]`).click();
  }
  await expect(dialog.getByTestId("policy-person-chip")).toHaveCount(2);
  await expect(dialog.getByTestId("policy-people-count")).toHaveText("2 of 20");
  await search.fill("nobody-here");
  await expect(dialog).toContainText("No people match “nobody-here”.");
  await search.fill("");
  await dialog.getByTestId("policy-save").click();
  await expect(toast(page, "Rule saved")).toBeVisible();
  await expect(rowOf(page, tool("write_note"))).toContainText(/Marta Gil or 1 other|Luis Mora or 1 other/);

  dialog = await openRule(page, tool("write_note"));
  await expect(dialog.getByTestId("policy-approvers-users").locator("input")).toBeChecked();
  for (const name of ["Marta Gil", "Luis Mora"]) {
    await expect(dialog.locator(`[data-testid="policy-person"][data-name="${name}"] input`)).toBeChecked();
  }
  await expect(dialog.getByTestId("policy-person-chip")).toHaveCount(2);
});

test("admin: a concurrent change shows the conflict with Reload; Remove asks first; Change history lists both", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const mobile = info.project.name === "mobile";
  await setApprovalPolicy(admin, {
    scopeUnitId: null,
    toolPattern: serverPattern(),
    mode: "always",
    approverKind: "admins",
  });
  const { context, page } = await openAs(browser, ADMIN, info.project.name);
  await openPolicies(page, mobile);
  const other = await context.newPage();
  await other.goto(`${BASE_URL}/settings/approval-policies`);

  // ---- two tabs edit the same rule: the second save is refused, Reload shows the first change
  const first = await openRule(page, serverPattern());
  const second = await openRule(other, serverPattern());
  await first.getByTestId("policy-approvers-requester").click();
  await first.getByTestId("policy-save").click();
  await expect(toast(page, "Rule saved")).toBeVisible();
  await second.getByTestId("policy-mode-when_tainted").click();
  await second.getByTestId("policy-save").click();
  await expect(second.getByTestId("policy-error")).toHaveText(
    /Someone changed this rule while you were editing\. Reload to see it\./,
  );
  await second.getByTestId("policy-reload").click();
  await expect(second.getByTestId("policy-error")).toHaveCount(0);
  await expect(second.getByTestId("policy-mode-always").locator("input")).toBeChecked();
  await expect(second.getByTestId("policy-approvers-requester").locator("input")).toBeChecked();
  await other.close();

  // ---- Remove rule asks first (Cancel focused), then the row falls back to Never ask
  const dialog = await openRule(page, serverPattern());
  await dialog.getByTestId("policy-remove").click();
  const confirm = page.getByTestId("policy-remove-dialog");
  await expect(confirm).toContainText("Remove this rule?");
  await expect(confirm).toContainText(`All ${NORTHWIND_CRM} tools go back to Never ask.`);
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByTestId("policy-remove-confirm").click();
  await expect(toast(page, "Rule removed")).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(rowOf(page, serverPattern()).getByTestId("policy-mode-chip")).toHaveText("Never ask");
  await expect(rowOf(page, tool("echo")).getByTestId("policy-mode-chip")).toHaveText("Never ask");

  // ---- Change history, from the header and from the footnote: newest first
  for (const opener of ["policy-history", "policy-history-link"]) {
    await page.getByTestId(opener).click();
    const sheet = page.getByTestId("policy-history-sheet");
    await expect(sheet).toBeVisible();
    await expect(page).toHaveURL(/history=1/);
    const items = sheet.getByTestId("policy-history-item");
    await expect(items.nth(0)).toContainText(`${ADMIN.name} removed the rule for All ${NORTHWIND_CRM} tools`);
    await expect(items.nth(1)).toContainText(`${ADMIN.name} set All ${NORTHWIND_CRM} tools to Always ask`);
    await expect(items.nth(1)).toContainText("Approvers: The person who asked");
    await expect(items.nth(2)).toContainText(`${ADMIN.name} set All ${NORTHWIND_CRM} tools to Always ask`);
    await expect(items.nth(2)).toContainText("Approvers: Admins");
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet).toBeHidden();
    await expect(page).not.toHaveURL(/history=1/);
  }
});

test("admin: Settings › MCP servers shows Needs approval and Asks after outside content next to the tools", async ({
  browser,
}, info) => {
  await setApprovalPolicy(admin, {
    scopeUnitId: null,
    toolPattern: tool("write_note"),
    mode: "always",
    approverKind: "admins",
  });
  await setApprovalPolicy(admin, {
    scopeUnitId: null,
    toolPattern: tool("echo"),
    mode: "when_tainted",
    approverKind: "requester",
  });
  const { page } = await openAs(browser, ADMIN, info.project.name);
  await page.goto(`${BASE_URL}/settings/mcp-servers`);
  const card = page.locator(`[data-testid="mcp-server"][data-name="${NORTHWIND_CRM}"]`);
  const toolRow = (name: string) => card.locator(`[data-testid="mcp-tool"][data-tool="${name}"]`);
  await expect(toolRow("write_note").getByTestId("tool-effect")).toHaveText("Changes data");
  await expect(toolRow("write_note").getByTestId("tool-needs-approval")).toHaveText("Needs approval");
  await expect(toolRow("echo").getByTestId("tool-effect")).toHaveText("Read-only");
  await expect(toolRow("echo").getByTestId("tool-needs-approval")).toHaveText("Asks after outside content");
});

/** axe (serious / critical), names, no sideways scroll and 44 px targets for one surface, in light and dark. */
async function reviewSurface(page: Page, selector: string, label: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expectNoSeriousA11y(page, selector);
    await expectNoSidewaysScroll(page, `${label} (${theme})`);
    expect.soft(await unnamedControls(page), `${label} (${theme}): unnamed controls`).toEqual([]);
    await expectTouchTargets(page, selector);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("review: the page, the rule dialog and the history at the project's width, light and dark, with screenshots", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const mobile = info.project.name === "mobile";
  const w = mobile ? "390" : "1440";
  await setApprovalPolicy(admin, {
    scopeUnitId: null,
    toolPattern: serverPattern(),
    mode: "when_tainted",
    approverKind: "requester",
  });
  await setApprovalPolicy(admin, {
    scopeUnitId: null,
    toolPattern: tool("write_note"),
    mode: "always",
    approverKind: "admins",
  });
  const { page } = await openAs(browser, ADMIN, info.project.name);
  await openPolicies(page, mobile);
  await expect(rowOf(page, tool("write_note")).getByTestId("policy-mode-chip")).toHaveText("Always ask");
  await expect(rowOf(page, tool("echo")).getByTestId("policy-mode-chip")).toHaveText(
    "Ask after outside content",
  );

  // ---- the page
  if (mobile) {
    // Each row is one button (min-h 56); the scope select and the search are 44 tall.
    const rowButton = await editOf(page, tool("echo")).boundingBox();
    expect(rowButton?.height ?? 0).toBeGreaterThanOrEqual(55.5);
    expect(rowButton?.width ?? 0).toBeGreaterThan(300);
    for (const id of ["policy-scope", "policy-search"]) {
      expect((await page.getByTestId(id).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(43.5);
    }
  }
  await expectNoSeriousA11y(page, '[data-testid="approval-policies"]');
  await reviewSurface(page, '[data-testid="approval-policies"]', `page @${w}`);
  await captureReview(page, `approval-policies-${w}`);

  // ---- the rule dialog with Always ask and specific people (not saved)
  const dialog = await openRule(page, tool("write_note"));
  await dialog.getByTestId("policy-approvers-users").click();
  for (const name of ["Marta Gil", "Luis Mora"]) {
    await dialog.locator(`[data-testid="policy-person"][data-name="${name}"]`).click();
  }
  await expect(dialog.getByTestId("policy-person-chip")).toHaveCount(2);
  if (mobile) {
    const box = await dialog.boundingBox();
    expect(Math.round(box?.width ?? 0)).toBe(390);
    expect(Math.round(box?.height ?? 0)).toBe(844);
  }
  await expectNoSeriousA11y(page, '[data-testid="policy-dialog"]');
  await reviewSurface(page, '[data-testid="policy-dialog"]', `dialog @${w}`);
  await captureReview(page, `approval-policy-dialog-${w}`);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  // ---- the change history
  await page.getByTestId("policy-history").click();
  const sheet = page.getByTestId("policy-history-sheet");
  await expect(sheet.getByTestId("policy-history-item").first()).toBeVisible();
  if (mobile) expect(Math.round((await sheet.boundingBox())?.width ?? 0)).toBe(390);
  await expectNoSeriousA11y(page, '[data-testid="policy-history-sheet"]');
  await reviewSurface(page, '[data-testid="policy-history-sheet"]', `history @${w}`);
  if (!mobile) await captureReview(page, "approval-policies-history-1440");
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toBeHidden();

  // ---- Settings › MCP servers with the chip
  if (!mobile) {
    await page.goto(`${BASE_URL}/settings/mcp-servers`);
    const card = page.locator(`[data-testid="mcp-server"][data-name="${NORTHWIND_CRM}"]`);
    await expect(card.getByTestId("tool-needs-approval").first()).toBeVisible();
    await card.getByTestId("mcp-tools").scrollIntoViewIfNeeded();
    await captureReview(page, "mcp-tools-needs-approval-1440");
  }
});

test("review: a lead on Sales, the organization's rule locked with its reason", async ({ browser }, info) => {
  test.setTimeout(120_000);
  const mobile = info.project.name === "mobile";
  const { salesId } = await seedApprovalPeople(admin);
  await setApprovalPolicy(admin, {
    scopeUnitId: null,
    toolPattern: tool("write_note"),
    mode: "always",
    approverKind: "admins",
  });
  await setApprovalPolicy(admin, {
    scopeUnitId: salesId,
    toolPattern: tool("echo"),
    mode: "when_tainted",
    approverKind: "unit_leads",
  });
  const { page } = await openAs(browser, MARTA, info.project.name);
  await openPolicies(page, mobile);
  await expect(rowOf(page, tool("write_note")).getByTestId("policy-locked-reason")).toBeVisible();
  await expect(rowOf(page, tool("echo"))).toContainText("Leads of Sales");
  await reviewSurface(page, '[data-testid="approval-policies"]', `lead page @${mobile ? 390 : 1440}`);
  if (!mobile) await captureReview(page, "approval-policies-unit-lead-1440");
});
