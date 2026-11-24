import { type APIRequestContext, expect, type Page } from "@playwright/test";
import {
  type AccountPoolView,
  AccountPoolView as AccountPoolViewSchema,
  ClaudeSetupToken,
  type PoolAccount,
  type PoolProvider,
} from "../../packages/contracts/src/account-pool.ts";

/**
 * Account pool helpers for the 07.18 browser journey (e2e/tests/account-pool.spec.ts): fake Claude setup-tokens, adding
 * one through Settings › Account pool, and reading or clearing the organization's pool through the admin API. Fake
 * tokens only: no real account is ever used (T-07.18-16-01), and every value is assembled at runtime from parts, so no
 * credential-shaped literal sits whole in the repository.
 */

/**
 * A fake `claude setup-token` value, distinct per `n`, valid for the contract's `ClaudeSetupToken` (never a real
 * credential: the fake runtime never reads it, and no request with it ever leaves the stack).
 */
export function fakeSetupToken(n: number): string {
  const fill = `e2e${n}`.padEnd(48, String.fromCharCode(97 + (n % 26)));
  const token = ["sk", "ant", "oat01", fill].join("-");
  return ClaudeSetupToken.parse(token);
}

/** The organization's pool as the admin API returns it (parsed with the contract). */
export async function poolAs(api: APIRequestContext): Promise<AccountPoolView> {
  const res = await api.get("/api/v1/account-pool");
  expect(res.ok(), `GET /account-pool: ${res.status()}`).toBe(true);
  return AccountPoolViewSchema.parse(await res.json());
}

/** The live account of `provider` labelled exactly `label` (fails the test when it is missing). */
export async function poolAccount(
  api: APIRequestContext,
  provider: PoolProvider,
  label: string,
): Promise<PoolAccount> {
  const account = (await poolAs(api))[provider].accounts.find((a) => a.label === label);
  expect(account, `${provider} pool account "${label}"`).toBeTruthy();
  return account as PoolAccount;
}

/**
 * Removes every account of both pools (the spec's setup and `finally`), so the next spec on the same stack starts from an
 * empty pool and every later Work Zone session runs on its device's own login again. Best effort: a row removed
 * meanwhile (404) is fine.
 */
export async function resetPool(api: APIRequestContext): Promise<void> {
  const view = await poolAs(api);
  for (const a of [...view.claude.accounts, ...view.chatgpt.accounts]) {
    const res = await api.delete(`/api/v1/account-pool/accounts/${a.id}`);
    expect([200, 204, 404], `remove pool account ${a.label}`).toContain(res.status());
  }
}

/**
 * Settings › Account pool › Add Claude account, as an admin does it: opens the dialog (its token field starts empty),
 * types the label and pastes the token, saves, and waits for the dialog to close and the account's row to show. The page
 * must already be on `/settings/account-pool`. `beforeSave` runs on the filled dialog (the spec's layout checks and
 * review captures).
 */
export async function addClaudeAccountInUi(
  page: Page,
  label: string,
  token: string,
  beforeSave?: () => Promise<void>,
): Promise<void> {
  await page.getByTestId("pool-add-claude").click();
  const dialog = page.getByTestId("add-claude-account-dialog");
  await expect(dialog).toBeVisible();
  // 07.18-19 R3: the dialog opens on "Connect a Claude account" (Anthropic's own sign-in); pasting a setup-token is the
  // secondary path, which this fake-runtime journey uses because it cannot reach Anthropic.
  await expect(dialog.getByTestId("claude-connect-start")).toBeVisible();
  await dialog.getByTestId("claude-use-token").click();
  // Write-only (D-13): a new dialog never shows a token, not even the one pasted last time.
  await expect(dialog.getByTestId("claude-account-token")).toHaveValue("");
  await dialog.getByTestId("claude-account-label").fill(label);
  await dialog.getByTestId("claude-account-token").fill(token);
  await expect(dialog.getByTestId("claude-account-token")).toHaveAttribute("type", "password");
  await expect(dialog.getByTestId("claude-account-save")).toBeEnabled();
  await beforeSave?.();
  await dialog.getByTestId("claude-account-save").click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(poolRow(page, "claude", label)).toBeVisible();
}

/** The row of the account labelled exactly `label` in a provider's section of Settings › Account pool. */
export function poolRow(page: Page, provider: PoolProvider, label: string) {
  return page
    .getByTestId(`pool-section-${provider}`)
    .getByTestId("pool-account")
    .filter({ has: page.getByText(label, { exact: true }) });
}
