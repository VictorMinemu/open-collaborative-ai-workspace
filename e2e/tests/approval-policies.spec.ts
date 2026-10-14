import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, openAs } from "../support/actors";
import {
  ACME_CRM,
  clearApprovalPolicies,
  LUIS,
  seedApprovalMcp,
  seedApprovalPeople,
} from "../support/approvals";
import { ADMIN } from "./env";

/**
 * Settings › Approval policies (07.5-09; APPROVE-01, D-01, UI-SPEC Surface 4, R2-R5, R11). An admin decides which bot
 * actions need a person: the fake MCP server is registered as "Acme CRM" (`echo` read-only, `write_note` destructive)
 * and every Acme CRM tool is set to "Always ask" with Admins approving, from the page, in a few clicks. Leads add
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

test("admin: Always ask for every Acme CRM tool, from Settings, shown on every row", async ({
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
  await expect(crm).toContainText(ACME_CRM);
  await expect(crm).toContainText("MCP server · 2 tools");
  await expect(crm.getByRole("button", { name: new RegExp(`^${ACME_CRM}`) })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(page.getByTestId("policy-group-plugin")).toContainText("Plugins");
  await expect(page.getByTestId("policy-group-http")).toContainText("Web requests");
  await expect(root).toContainText(
    "Web search, web pages, memory, cards and Work Zone proposals can't use these rules",
  );

  // ---- Acme CRM expanded: the server row, then each tool with its effect, all Never ask
  await expandGroup(page, ACME_CRM);
  await expect(rowOf(page, serverPattern())).toContainText(`All ${ACME_CRM} tools`);
  await expect(rowOf(page, serverPattern())).toContainText("Never ask");
  await expect(rowOf(page, tool("echo"))).toContainText("Read-only");
  await expect(rowOf(page, tool("echo"))).toContainText("Never ask");
  await expect(rowOf(page, tool("write_note"))).toContainText("Changes data");
  await expect(rowOf(page, tool("write_note"))).toContainText("Never ask");

  // ---- Edit the server row: focus on the first radio, Save disabled until a change
  await editOf(page, serverPattern()).click();
  const dialog = page.getByTestId("policy-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`Approval for all ${ACME_CRM} tools`);
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
