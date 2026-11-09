import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  request,
} from "@playwright/test";
import { API_URL } from "../tests/env";

/**
 * Shared helpers for two-person realtime specs (Phase 3). Frozen after 03-01: later plans import these and keep
 * any extra helpers local to their spec.
 */

export const BASE_URL = process.env.OCW_E2E_BASE_URL ?? "http://localhost:3000";

export interface Actor {
  name: string;
  email: string;
  password: string;
}

/** A developer-role colleague, created on first use (invite + accept through the API). */
export const SAM: Actor = { name: "Sam Lee", email: "sam@ocw.test", password: "sam-e2e-password-123" };

/** API request context signed in as `user` (cookie session, web Origin). */
export async function apiAs(user: { email: string; password: string }): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL: API_URL, extraHTTPHeaders: { origin: BASE_URL } });
  const res = await ctx.post("/api/auth/sign-in/email", {
    data: { email: user.email, password: user.password },
  });
  expect(res.ok(), `sign in ${user.email}`).toBe(true);
  return ctx;
}

/**
 * Makes sure `user` is a member (invited with `role` and accepted when the email is not in /members yet) and
 * returns their user id. Idempotent across projects and runs.
 */
export async function ensureMember(admin: APIRequestContext, user: Actor, role: string): Promise<string> {
  const find = async () => {
    const res = await admin.get("/api/v1/members");
    expect(res.ok(), "list members").toBe(true);
    const members = (await res.json()).members as Array<{ userId: string; email: string | null }>;
    return members.find((m) => m.email === user.email)?.userId;
  };
  const existing = await find();
  if (existing) return existing;
  const invRes = await admin.post("/api/v1/invitations", { data: { email: user.email, role } });
  expect(invRes.ok(), `invite ${user.email}`).toBe(true);
  const inv = (await invRes.json()) as { id: string };
  const anon = await request.newContext({ baseURL: API_URL, extraHTTPHeaders: { origin: BASE_URL } });
  const res = await anon.post(`/api/v1/invitations/${inv.id}/accept`, {
    data: { name: user.name, password: user.password },
  });
  expect(res.ok(), `accept invitation for ${user.email}`).toBe(true);
  await anon.dispose();
  const id = await find();
  expect(id, `${user.email} is a member`).toBeTruthy();
  return id as string;
}

/** The signed-in user's id. */
export async function userIdOf(api: APIRequestContext): Promise<string> {
  const res = await api.get("/api/v1/me");
  expect(res.ok(), "GET /me").toBe(true);
  return ((await res.json()) as { user: { id: string } }).user.id;
}

/** Creates a channel and returns its id. */
export async function createChannel(
  api: APIRequestContext,
  name: string,
  visibility: "public" | "private" = "public",
): Promise<string> {
  const res = await api.post("/api/v1/channels", { data: { name, visibility } });
  expect(res.ok(), `create channel ${name}`).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

export async function joinChannel(api: APIRequestContext, id: string): Promise<void> {
  const res = await api.post(`/api/v1/channels/${id}/join`);
  expect(res.ok(), `join channel ${id}`).toBe(true);
}

/**
 * How long a sign-in (or a visit to `/chat`) may take to land on a channel. The landing is three serial hops, each
 * needing the one before: the sign-in POST and `/me`, the `/chat` route (RSC + chunks) that waits for
 * `GET /api/v1/channels`, then the `/chat/<id>` route (RSC + chunks) whose commit is when the URL changes. CI traces of
 * the failures at the 5 s default (pipeline 204: watched-records mobile, signin-card desktop) show every hop
 * completing and the channel page mounting 4.9-5.2 s after the click, with `/channels` alone taking 0.6-0.9 s and the
 * renderer starved (1 s expect polls arriving 1.6 s apart). It is the app's real latency under a shared, loaded
 * agent, not a redirect that never happens: three times the worst measured landing keeps a regression to "never"
 * failing well inside the test timeout.
 */
export const CHANNEL_LANDING_TIMEOUT_MS = 15_000;

/**
 * Waits for `/chat`'s redirect to the default (or first joined) channel. A member in no channel never gets one (the
 * empty state stays on `/chat`), so this still fails for that case, with the URL in the message.
 */
export async function expectChannelLanding(page: Page): Promise<void> {
  await expect(page, "lands on a channel (/chat redirects to #general)").toHaveURL(/\/chat\/[0-9a-f-]{36}/, {
    timeout: CHANNEL_LANDING_TIMEOUT_MS,
  });
}

/**
 * A fresh browser context signed in as `user` through the login form, sized like the Playwright project
 * (desktop 1440×900, mobile 390×844 with touch).
 */
export async function openAs(
  browser: Browser,
  user: { email: string; password: string },
  project: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const mobile = project === "mobile";
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/login`);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page
    .getByTestId("login-form")
    .getByRole("button", { name: /sign in|log in/i })
    .click();
  await expectChannelLanding(page);
  return { context, page };
}
