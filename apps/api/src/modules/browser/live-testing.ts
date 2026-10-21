import { randomUUID } from "node:crypto";
import { WS_AUTH_PROTOCOL_PREFIX, WS_PROTOCOL } from "@ocw/contracts";
import { expect } from "vitest";
import WebSocket from "ws";
import { TestClient, WEB_ORIGIN } from "../../testing";
import { type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";

/**
 * Shared fixture of the live-view integration tests (07.8-16): the sandbox stack (real PostgreSQL and Redis, the
 * in-memory sandboxd) with the Browser switch on for Scout and organization A, plus:
 * - `#ops`, a private channel Sam created, with Alex and Scout in it (Sam and Alex read it);
 * - Víctor (admin) owns Scout and does NOT read `#ops`; Nia (standard) neither reads it nor owns the bot;
 * - Eve is organization B's admin.
 * Everything the fixture starts is stopped by `stop()` (the stack's own try/finally, P-17).
 */

export interface LiveStack {
  s: SandboxStack;
  nia: TestClient;
  niaId: string;
  ops: string;
  /** `who` mentions Scout in `conversationId` (default `#ops`); returns the delivered turn. */
  turnIn(who: TestClient, conversationId?: string): Promise<Json>;
  /** Scout opens `url` in the turn's page; returns the context id. */
  open(ev: Json, url?: string): Promise<string>;
  /** A bot route of the turn (`/agent-channel/v1/browser/<name>`). */
  browser(name: string, ev: Json, body?: Json): Promise<Res>;
  stop(): Promise<void>;
}

export async function startLiveStack(): Promise<LiveStack> {
  const s = await startSandboxStack();
  try {
    await s.setPolicy({ enabled: true });
    await s.su.query("update app.sandbox_policies set max_browsers = 50 where organization_id = $1", [
      s.orgA,
    ]);
    await s.su.query(
      "update app.agents set owner_user_id = $2, capabilities = capabilities || jsonb_build_object('browser', true) where id = $1",
      [s.scoutId, s.victorId],
    );
    const inv = await ok(
      s.victor.request("POST", "/api/v1/invitations", {
        email: "nia@example.test",
        role: "standard",
      }) as Promise<Res>,
    );
    const nia = new TestClient(s.stack.baseUrl);
    const accepted = await ok(
      nia.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
        name: "Nia Park",
        password: "nia-long-password-123",
      }) as Promise<Res>,
    );
    const niaId = accepted.user.id as string;
    const ops = (
      await ok(
        s.sam.request("POST", "/api/v1/channels", { name: "ops", visibility: "private" }) as Promise<Res>,
      )
    ).id as string;
    await ok(
      s.sam.request("POST", `/api/v1/channels/${ops}/members`, {
        kind: "user",
        id: s.alexId,
      }) as Promise<Res>,
    );
    await ok(
      s.sam.request("POST", `/api/v1/channels/${ops}/members`, {
        kind: "agent",
        id: s.scoutId,
      }) as Promise<Res>,
    );

    const turnIn = async (who: TestClient, conversationId = ops): Promise<Json> => {
      const msg = await ok(
        who.request("POST", `/api/v1/conversations/${conversationId}/messages`, {
          body: `@scout please look ${randomUUID().slice(0, 6)}`,
        }) as Promise<Res>,
      );
      const rows = (
        await s.su.query(
          "select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1' and payload->'message'->>'id' = $2 and payload->'agent'->>'id' = $3",
          [`cell:${s.orgA}`, msg.id, s.scoutId],
        )
      ).rows;
      expect(rows).toHaveLength(1);
      return rows[0].payload as Json;
    };
    const browser = (name: string, ev: Json, body: Json = {}) =>
      s.cell(`/browser/${name}`, { eventId: ev.eventId, agentId: s.scoutId, ...body });
    const open = async (ev: Json, url = "https://panel.fake.test/login") =>
      (await ok(browser("open", ev, { url }))).contextId as string;

    return { s, nia, niaId, ops, turnIn, open, browser, stop: () => s.stop() };
  } catch (err) {
    await s.stop();
    throw err;
  }
}

export interface LiveSocket {
  socket: WebSocket;
  /** JSON control frames in arrival order. */
  json: Json[];
  /** Binary frames: arrival time and the first bytes only (never kept whole). */
  binary: Array<{ at: number; size: number; head: number[] }>;
  closed: Promise<{ code: number }>;
  send(frame: unknown): void;
  close(): void;
}

const liveUrl = (baseUrl: string, contextId: string) =>
  `${baseUrl.replace("http", "ws")}/api/v1/live/browser/${contextId}`;

/** An authenticated live-view socket that records every frame. */
export async function liveSocket(baseUrl: string, token: string, contextId: string): Promise<LiveSocket> {
  const socket = new WebSocket(
    liveUrl(baseUrl, contextId),
    [WS_PROTOCOL, `${WS_AUTH_PROTOCOL_PREFIX}${token}`],
    {
      headers: { origin: WEB_ORIGIN },
    },
  );
  const json: Json[] = [];
  const binary: LiveSocket["binary"] = [];
  socket.on("message", (data, isBinary) => {
    const buf = data as Buffer;
    if (isBinary) binary.push({ at: Date.now(), size: buf.length, head: [...buf.subarray(0, 3)] });
    else json.push(JSON.parse(buf.toString("utf8")) as Json);
  });
  const closed = new Promise<{ code: number }>((resolve) => socket.on("close", (code) => resolve({ code })));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return {
    socket,
    json,
    binary,
    closed,
    send: (frame) => socket.send(JSON.stringify(frame)),
    close: () => socket.close(),
  };
}

/** The HTTP status of an upgrade attempt (101 when it opened). */
export async function upgradeStatus(
  url: string,
  opts: { origin?: string | null; token?: string | null },
): Promise<number> {
  const protocols = [WS_PROTOCOL, ...(opts.token ? [`${WS_AUTH_PROTOCOL_PREFIX}${opts.token}`] : [])];
  const socket = new WebSocket(url, protocols, {
    headers: opts.origin === null ? {} : { origin: opts.origin ?? WEB_ORIGIN },
  });
  return new Promise((resolve) => {
    socket.once("open", () => {
      socket.close();
      resolve(101);
    });
    socket.once("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      socket.terminate();
    });
    socket.once("error", () => resolve(0));
  });
}

export { liveUrl };

export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 4000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The latest `state` frame of a socket. */
export const lastState = (l: LiveSocket) => [...l.json].reverse().find((f) => f.type === "state");

/** Waits until the socket's latest state is `state` (and matches `extra`). */
export const waitState = (l: LiveSocket, state: string, timeoutMs = 4000) =>
  waitFor(() => {
    const st = lastState(l);
    return st?.state === state ? st : undefined;
  }, timeoutMs);
