import { type APIRequestContext, expect, type Locator, type Page } from "@playwright/test";
import type { Actor } from "./actors";

/**
 * Helpers shared by the Phase 4 chat specs (04-01 onwards). Later plans import these and keep anything else
 * local to their spec.
 */

/** A developer-role colleague (the same account chat.spec.ts creates). */
export const ALEX: Actor = { name: "Alex Kim", email: "alex@ocw.test", password: "alex-e2e-password-123" };

/** Posts a message through the API as the signed-in user of `api` and returns the created message. */
export async function postAs(
  api: APIRequestContext,
  conversationId: string,
  body: string,
  extra: Record<string, unknown> = {},
): Promise<{ id: string; seq: number; body: string; threadId: string | null }> {
  const res = await api.post(`/api/v1/conversations/${conversationId}/messages`, {
    data: { body, ...extra },
  });
  expect(res.ok(), `post in ${conversationId}: ${res.status()}`).toBe(true);
  return res.json();
}

/** A new public channel with a unique name, created by `adminApi` and joined by every `members` context. */
export async function freshChannel(
  adminApi: APIRequestContext,
  members: APIRequestContext[] = [],
  prefix = "c",
): Promise<{ id: string; name: string }> {
  const name = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const res = await adminApi.post("/api/v1/channels", { data: { name, visibility: "public" } });
  expect(res.ok(), `create channel ${name}`).toBe(true);
  const { id } = (await res.json()) as { id: string };
  for (const m of members) {
    const joined = await m.post(`/api/v1/channels/${id}/join`);
    expect(joined.ok(), `join ${name}`).toBe(true);
  }
  return { id, name };
}

/** The message row with this id (works in the channel list and in the thread panel). */
export function messageRow(scope: Page | Locator, messageId: string): Locator {
  return scope.locator(`[data-testid="message"][data-message-id="${messageId}"]`).first();
}

/**
 * Opens a message's actions: hover toolbar on desktop, long-press bottom sheet on mobile. Returns the surface
 * that holds the action buttons (`edit-message`, `reply-in-thread`, …).
 */
export async function openMessageActions(page: Page, messageId: string, project: string): Promise<Locator> {
  const row = messageRow(page, messageId);
  await expect(row).toBeVisible();
  if (project !== "mobile") {
    await row.hover();
    const toolbar = row.getByTestId("message-toolbar");
    await expect(toolbar).toBeVisible();
    return toolbar;
  }
  // Playwright has no long-press gesture: hold a touch pointer for longer than the 450 ms threshold.
  const box = await row.boundingBox();
  const point = { clientX: (box?.x ?? 0) + 40, clientY: (box?.y ?? 0) + 12 };
  const init = { pointerType: "touch", isPrimary: true, pointerId: 7, ...point };
  await row.dispatchEvent("pointerdown", init);
  await page.waitForTimeout(650);
  await row.dispatchEvent("pointerup", init);
  const sheet = page.getByTestId("message-sheet");
  await expect(sheet).toBeVisible();
  return sheet;
}
