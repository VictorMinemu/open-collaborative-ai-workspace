import { readFileSync } from "node:fs";
import { expect, type Locator, type Page, type WebSocket as PwWebSocket } from "@playwright/test";
import { fakeSandboxd } from "./sandbox";

/**
 * Live-view helpers for the e2e specs (07.8-22, later 26/28): open the live view from a browser step's Watch, watch the
 * live-view socket's traffic (counts and the frames the page sent; never a frame's bytes), read the fake sandboxd's
 * per-page stats, and a scripted live-view server (`page.routeWebSocket`) for the visual states a real stack cannot hold
 * still (connecting, error, every ended reason).
 */

/** The live view's socket path; every other socket is the realtime gateway's. */
export const LIVE_SOCKET = /\/api\/v1\/live\/browser\//;

/** The fake's JPEG fixture of a page with a sign-in form (infra/fake-model/fixtures/sandbox/frames). */
export const LOGIN_FORM_JPEG = readFileSync(
  new URL("../../infra/fake-model/fixtures/sandbox/frames/login-form.jpg", import.meta.url),
);

export interface SocketTap {
  /** Binary frames received on the live-view socket(s). */
  binary(): number;
  /** Text frames the page sent on the live-view socket(s), parsed. */
  sent(): Array<Record<string, unknown>>;
  /** Every text payload of every socket of the page, with its direction and whether it was the live view's. */
  all(): Array<{ live: boolean; dir: "sent" | "received"; payload: string }>;
}

/** Records the page's WebSocket traffic from now on. */
export function tapSockets(page: Page): SocketTap {
  let binary = 0;
  const sent: Array<Record<string, unknown>> = [];
  const all: Array<{ live: boolean; dir: "sent" | "received"; payload: string }> = [];
  page.on("websocket", (ws: PwWebSocket) => {
    const live = LIVE_SOCKET.test(ws.url());
    ws.on("framereceived", (f) => {
      if (typeof f.payload === "string") all.push({ live, dir: "received", payload: f.payload });
      else if (live) binary++;
    });
    ws.on("framesent", (f) => {
      if (typeof f.payload !== "string") return;
      all.push({ live, dir: "sent", payload: f.payload });
      if (live) {
        try {
          sent.push(JSON.parse(f.payload) as Record<string, unknown>);
        } catch {
          // Not JSON: never expected on the live view.
        }
      }
    });
  });
  return { binary: () => binary, sent: () => sent, all: () => all };
}

/** The bot's reply row whose text contains `text`, in `scope`. */
export function replyRow(scope: Page | Locator, text: string): Locator {
  return scope.locator('[data-testid="message"][data-author-kind="agent"]').filter({ hasText: text }).last();
}

/** Expands the reply's activity and clicks Watch on its open browser step; returns the live view. */
export async function watchFrom(row: Locator): Promise<Locator> {
  await expect(row).toBeVisible({ timeout: 20_000 });
  const toggle = row.getByTestId("bot-activity-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  const watch = row.getByTestId("activity-watch").first();
  await expect(watch).toBeVisible();
  await watch.click();
  const live = row.page().getByTestId("live-view");
  await expect(live).toBeVisible();
  return live;
}

/** The fake sandboxd's view of one page: viewers (upstream frame streams), viewport, takeover and input counts. */
export async function fakePage(contextId: string): Promise<
  | {
      viewers: number;
      viewport: { width: number; height: number };
      viewportMode: string | null;
      takeover: boolean;
      inputs: Record<string, number>;
    }
  | undefined
> {
  const stats = (await fakeSandboxd().stats()) as {
    browser: {
      contexts: Array<{
        contextId: string;
        viewers: number;
        viewport: { width: number; height: number };
        viewportMode: string | null;
        takeover: boolean;
        inputs: Record<string, number>;
      }>;
    };
  };
  return stats.browser.contexts.find((c) => c.contextId === contextId);
}

/** The live view's context id (`data-context`). */
export async function contextOf(live: Locator): Promise<string> {
  const id = await live.getAttribute("data-context");
  expect(id, "the live view's context").toBeTruthy();
  return id as string;
}

export interface ScriptedState {
  state: string;
  endReason?: string;
  pausedFor?: "approval" | "signin" | null;
  activity?: string | null;
  host?: string | null;
  secure?: boolean | null;
  controller?: "self" | "other_device" | "other" | null;
  privateReason?: "takeover" | "member_session";
  memberName?: string;
  requesterName?: string;
  approvalRoute?: string;
}

/**
 * Replaces the live-view server for this page with a script (no API involved), read when each socket connects:
 * `connecting` never answers, `error` refuses the socket, anything else sends `viewerCan`, the state and (for states
 * with the page) the fake's JPEG frames at 8 fps; a final state closes like the API (1000 ended, 4403 no permission).
 * Returns the setter of the next connection's script.
 */
export async function scriptLiveView(
  page: Page,
): Promise<(next: { state: ScriptedState | "connecting" | "error"; control?: boolean }) => void> {
  let script: { state: ScriptedState | "connecting" | "error"; control?: boolean } = { state: "connecting" };
  await page.routeWebSocket(LIVE_SOCKET, (ws) => {
    const { state: s, control } = script;
    if (s === "connecting") return;
    if (s === "error") {
      ws.close({ code: 1011, reason: "unavailable" });
      return;
    }
    const watch = s.state !== "no_permission";
    ws.send(JSON.stringify({ type: "viewerCan", watch, control: watch && !!control }));
    ws.send(
      JSON.stringify({
        type: "state",
        pausedFor: null,
        activity: null,
        host: null,
        secure: null,
        controller: null,
        ...s,
      }),
    );
    if (s.state === "ended") {
      ws.close({ code: 1000, reason: "ended" });
      return;
    }
    if (s.state === "no_permission") {
      ws.close({ code: 4403, reason: "no_permission" });
      return;
    }
    if (s.state === "private") return;
    const timer = setInterval(() => ws.send(LOGIN_FORM_JPEG), 125);
    ws.onClose(() => clearInterval(timer));
    ws.send(LOGIN_FORM_JPEG);
  });
  return (next) => {
    script = next;
  };
}
