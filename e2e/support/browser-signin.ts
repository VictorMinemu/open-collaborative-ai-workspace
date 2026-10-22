import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { API_URL } from "../tests/env";
import { postAs } from "./chat";
import type { FakeCellPlugin, MentionPayload } from "./fake-cell-plugin";
import { fakeSandboxd } from "./sandbox";

/**
 * A member's saved sign-in through 07.8-21's real path, for the Keychain and Browser tab specs (07.8-27): the member
 * asks the bot in their DM; the bot (the fake cell, by hand) opens the site and asks them to sign in; the member takes
 * control of that page on the live-view socket from their own signed-in page, the fake site becomes signed in (what
 * typing a password does on the real site), and the member hands back. The API exports the page's state, locks the page
 * to the site and seals it for that member, that bot and that site. Nothing here writes a session row directly.
 *
 * The socket is opened inside the member's page (its Origin is the web app, its token the member's own), exactly as the
 * live view does; the frames it receives are ignored.
 */

export interface SessionJson {
  id: string;
  site: string;
  agentId: string;
  agentName: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  status: "active" | "expired";
}

export async function sessionsOf(api: APIRequestContext): Promise<SessionJson[]> {
  const res = await api.get("/api/v1/browser-sessions");
  expect(res.ok(), `GET /browser-sessions: ${res.status()}`).toBe(true);
  return ((await res.json()) as { items: SessionJson[] }).items;
}

/** Revokes every saved sign-in of `api`'s member, so a test starts from its own state. */
export async function clearSessions(api: APIRequestContext): Promise<void> {
  for (const s of await sessionsOf(api)) {
    const res = await api.delete(`/api/v1/browser-sessions/${s.id}`);
    expect([204, 404], `revoke ${s.site}`).toContain(res.status());
  }
}

/** The open page of `botId` on `host` in `conversationRoute` that `api`'s member sees on the bot's Browser tab. */
export async function openContextOf(
  api: APIRequestContext,
  botId: string,
  host: string,
  conversationRoute: string,
): Promise<string> {
  let found: string | undefined;
  await expect
    .poll(
      async () => {
        const res = await api.get(`/api/v1/agents/${botId}/browser`);
        if (!res.ok()) return undefined;
        const view = (await res.json()) as {
          open: Array<{ contextId: string; host: string; conversation: { route: string } }>;
        };
        found = view.open.find(
          (r) => r.host === host && r.conversation.route === conversationRoute,
        )?.contextId;
        return found;
      },
      { message: `${host} open in ${conversationRoute}`, timeout: 15_000 },
    )
    .toBeTruthy();
  return found as string;
}

/** Takes control of `contextId` from `page` (the member's signed-in page) on the live-view socket. */
export async function take(page: Page, contextId: string): Promise<void> {
  await page.evaluate(
    async ({ api, contextId }) => {
      const res = await fetch(`${api}/api/auth/token`, { credentials: "include" });
      const { token } = (await res.json()) as { token: string };
      const ws = new WebSocket(`${api.replace(/^http/u, "ws")}/api/v1/live/browser/${contextId}`, [
        "ocw.v1",
        `ocw.auth.${token}`,
      ]);
      (window as unknown as { __ocwSeal?: WebSocket }).__ocwSeal = ws;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("take: no control within 15 s")), 15_000);
        let asked = false;
        ws.onmessage = (ev) => {
          if (typeof ev.data !== "string") return;
          const f = JSON.parse(ev.data) as { type: string; control?: boolean; state?: string };
          if (f.type === "viewerCan" && f.control && !asked) {
            asked = true;
            ws.send(JSON.stringify({ type: "take" }));
          }
          if (f.type === "state" && f.state === "controlling") {
            clearTimeout(timer);
            resolve();
          }
        };
        ws.onclose = (e) => {
          clearTimeout(timer);
          reject(new Error(`take: the live view closed (${e.code})`));
        };
      });
    },
    { api: API_URL, contextId },
  );
}

/** Hands back (`release`) and closes the socket once the page is no longer controlled. */
export async function handBack(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const ws = (window as unknown as { __ocwSeal?: WebSocket }).__ocwSeal;
    if (!ws) throw new Error("hand back: no live-view socket");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("hand back: still in control after 15 s")), 15_000);
      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        const f = JSON.parse(ev.data) as { type: string; state?: string };
        if (f.type === "state" && f.state !== "controlling") {
          clearTimeout(timer);
          resolve();
        }
      };
      ws.send(JSON.stringify({ type: "release" }));
    });
    ws.onclose = null;
    ws.close();
  });
}

export interface SignInTurn {
  cell: FakeCellPlugin;
  /** The mention the API delivers for `messageId`. */
  mentionOf(messageId: string): Promise<MentionPayload>;
  member: APIRequestContext;
  /** The member's signed-in page (any width: the socket does not care). */
  page: Page;
  botId: string;
  dmId: string;
}

/**
 * The member asks the bot to open `host` in their DM, the bot asks them to sign in, they take control, the fake site is
 * signed in (its session cookie expiring at `expiresAt`, unix seconds, if given) and they hand back. Returns the sealed
 * session as the member's own list shows it.
 */
export async function signInThroughBot(
  t: SignInTurn,
  host: string,
  opts: { expiresAt?: number; tag?: string } = {},
): Promise<SessionJson> {
  const asked = await postAs(t.member, t.dmId, `Open ${host} for me ${opts.tag ?? ""}`.trim());
  const m = await t.mentionOf(asked.id);
  // A fresh page for this turn: an earlier page in this DM would be locked to its own site.
  await t.cell.browser(m, "ocw_browser_close", {});
  expect(await t.cell.browser(m, "ocw_browser_open", { url: `https://${host}/` })).toBe(`opened ${host}`);
  expect(await t.cell.browser(m, "ocw_browser_signin", { reason: "It needs your account." })).toBe(
    `sign-in requested for ${host}`,
  );
  await t.cell.reply(m, `Please sign in to ${host}.`);
  const contextId = await openContextOf(t.member, t.botId, host, `/chat/dm/${t.dmId}`);
  await take(t.page, contextId);
  await fakeSandboxd().signedIn(contextId, opts.expiresAt);
  await handBack(t.page);
  let sealed: SessionJson | undefined;
  await expect
    .poll(
      async () => {
        sealed = (await sessionsOf(t.member)).find((s) => s.site === host && s.agentId === t.botId);
        return sealed?.id;
      },
      { message: `${host} sealed after the hand back`, timeout: 15_000 },
    )
    .toBeTruthy();
  return sealed as SessionJson;
}
