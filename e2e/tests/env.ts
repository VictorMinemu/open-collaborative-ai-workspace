import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

function fromDotEnv(name: string): string | undefined {
  const file = join(import.meta.dirname, "..", "..", ".env");
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${name}=`));
  return line?.slice(name.length + 1).trim();
}

export const API_URL = process.env.OCW_E2E_API_URL ?? "http://localhost:4000";
export const SETUP_TOKEN = process.env.OCW_SETUP_TOKEN ?? fromDotEnv("OCW_SETUP_TOKEN") ?? "";
export const ADMIN = {
  name: process.env.OCW_E2E_ADMIN_NAME ?? "Víctor Ruiz",
  email: process.env.OCW_E2E_ADMIN_EMAIL ?? "admin@ocw.test",
  password: process.env.OCW_E2E_ADMIN_PASSWORD ?? "e2e-admin-password-123",
  orgName: process.env.OCW_E2E_ORG ?? "Autofy Labs",
};

/** Save a review screenshot when OCW_E2E_SCREENSHOT_DIR is set (no-op otherwise). */
export async function shot(page: Page, name: string) {
  const dir = process.env.OCW_E2E_SCREENSHOT_DIR;
  if (!dir) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: false, animations: "disabled" });
}
