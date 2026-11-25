import { randomUUID } from "node:crypto";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type pg from "pg";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Type-only (erased): the app's modules load only after OpenTelemetry started, below.
import type { TestClient, TestStack } from "../../testing";
import type { FakeDevice } from "../../testing-device";

/**
 * Phase 07.13-22 Task 1 (D-31, WZB-11; T-07.13-22-01): the API-level sentinel sweep of the Work Zone browser. One
 * stack run where Mia takes control of her session's page through the live view and types `OCW-WZ-SENTINEL-TYPED-6611`,
 * hands it back with "save my sign-in", her device uploads a state whose cookie is `OCW-WZ-SENTINEL-COOKIE-2209`, and
 * on her next turn the device asks `browser.signin.load` and receives that state back (then re-seals and unloads it).
 * The device also reports the run's events and a sign-in approval Mia answers.
 *
 * Afterwards neither sentinel is in any text or jsonb column of any table (the sealed secret's ciphertext aside, the one
 * place the state lives, encrypted), `device_commands`, the session's timeline (`work_session_events`: the `ws:<id>`
 * rows of `app.stream_events`), the audit rows, the API log, the in-memory spans, the Redis commands of the run, or any
 * HTTP or WebSocket answer a person received. On the Device Link the typed text reaches the device only inside the
 * `browser.input` frames of the lease (that is how a member types into the page) and the cookie only inside the one
 * `browser.signin.state` frame answering the device's own load.
 *
 * The sentinels are built from parts at runtime. OpenTelemetry runs in-process with the API's own instrumentations,
 * started BEFORE the app is imported.
 */

const TYPED = ["OCW", "WZ", "SENTINEL", "TYPED", "6611"].join("-");
const COOKIE = ["OCW", "WZ", "SENTINEL", "COOKIE", "2209"].join("-");
const ORIGIN = "http://127.0.0.1:4317";
const SITE = "127.0.0.1:4317";

const spans = new InMemorySpanExporter();
// biome-ignore lint/suspicious/noExplicitAny: the SDK is created before the app modules are imported
let sdk: any;
// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Testing = typeof import("../../testing");
type Device = typeof import("../../testing-device");
type WorkZone = typeof import("../../testing-workzone");
type Live = typeof import("./live-testing");
let T: Testing;
let D: Device;
let W: WorkZone;
let L: Live;

let stack: TestStack;
let su: pg.Client;
let ada: TestClient;
let mia: TestClient;
let miaId: string;
let d: FakeDevice;
let deviceId: string;
let projectId: string;
/** API log lines (pino at debug). */
const logs: string[] = [];
/** Every command Redis saw while the run went on (MONITOR). */
const redisSeen: string[] = [];
let monitor: ReturnType<typeof createClient> | null = null;
/** Every HTTP answer body a person or the device received, and every live-socket frame. */
const answers: string[] = [];
/** Every JSON Device Link frame the device received, raw, in order. */
const deviceFrames: Json[] = [];

beforeAll(async () => {
  const [{ NodeSDK }, { HttpInstrumentation }, { PgInstrumentation }, { FastifyOtelInstrumentation }] =
    await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/instrumentation-http"),
      import("@opentelemetry/instrumentation-pg"),
      import("@fastify/otel"),
    ]);
  sdk = new NodeSDK({
    resourceDetectors: [],
    spanProcessors: [new SimpleSpanProcessor(spans)],
    instrumentations: [
      new HttpInstrumentation(),
      new PgInstrumentation(),
      new FastifyOtelInstrumentation({ registerOnInitialization: true }),
    ],
  });
  sdk.start();
  T = await import("../../testing");
  D = await import("../../testing-device");
  W = await import("../../testing-workzone");
  L = await import("./live-testing");
  const { default: pgModule } = await import("pg");

  stack = await T.startTestStack({
    env: { LOG_LEVEL: "debug" },
    logStream: { write: (line: string) => void logs.push(line) },
  });
  su = new pgModule.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  ada = new T.TestClient(stack.baseUrl);
  const setup = await ada.request("POST", "/api/v1/setup", {
    token: T.TEST_SETUP_TOKEN,
    name: "Ada Admin",
    email: "ada@example.test",
    password: "correct-horse-battery",
    orgName: "Autofy Labs",
  });
  expect(setup.status, JSON.stringify(setup.body)).toBe(200);
  ({ client: mia, userId: miaId } = await W.invite(stack, ada, "mia@example.test", "Mia Lopez", "developer"));
  expect((await ada.request("PUT", "/api/v1/work-zone-policy", { allowBrowser: true })).status).toBe(200);

  const paired = await W.pairDevice(stack, mia, "Mia's Mac");
  deviceId = paired.deviceId;
  d = await D.FakeDevice.connect(stack.baseUrl, paired.token, undefined, {
    browser: { version: 1, optIn: true },
  });
  d.ws.on("message", (data, isBinary) => {
    if (!isBinary) deviceFrames.push(JSON.parse((data as Buffer).toString("utf8")) as Json);
  });
  d.send({
    type: "projects.sync",
    projects: [{ localId: "web", name: "web", gitRemote: null, defaultBranch: "main" }],
  });
  await d.next((f) => f.type === "projects.ack");
  const projects = (await mia.request("GET", "/api/v1/projects")).body!.projects as Array<{
    id: string;
    name: string;
  }>;
  projectId = projects.find((p) => p.name === "web")!.id;

  monitor = createClient({ url: stack.redis.getConnectionUrl() });
  await monitor.connect();
  await monitor.monitor((reply) => {
    redisSeen.push(String(reply));
  });
}, 240_000);

afterAll(async () => {
  try {
    monitor?.destroy();
    await d?.close().catch(() => {});
    await su?.end().catch(() => {});
  } finally {
    try {
      await stack?.stop();
    } finally {
      await sdk?.shutdown().catch(() => {});
    }
  }
});

/** A person's request whose answer is recorded. */
async function people(method: string, path: string, body?: unknown, who = mia) {
  const r = await who.request(method, path, body);
  answers.push(JSON.stringify(r.body));
  return r;
}

/** A device-JWT PUT whose answer is recorded. */
async function devicePut(path: string, body: unknown) {
  const res = await fetch(`${stack.baseUrl}${path}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${d.jwt}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  answers.push(text);
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Json | null };
}

/** Mia asks a turn of `sid`; the device receives it and runs it (in flight). */
async function ask(sid: string, text: string): Promise<string> {
  const res = await people("POST", `/api/v1/work-sessions/${sid}/prompts`, { body: text });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const promptId = res.body!.id as string;
  const cmd = await d.command("prompt", sid);
  d.ack(cmd.id);
  d.event(sid, { type: "prompt.started", promptId });
  await D.eventually(async () => {
    const r = await su.query("select status from app.work_prompts where id = $1", [promptId]);
    return ["dispatched", "running"].includes((r.rows[0] as Json | undefined)?.status as string) || undefined;
  });
  return promptId;
}

/** The turn ends as a runtime reports it. */
function finish(sid: string, promptId: string, text: string) {
  d.event(sid, { type: "assistant.message", messageId: randomUUID(), text });
  d.event(sid, { type: "prompt.completed", promptId, usage: { inputTokens: 10, outputTokens: 5 } });
}

/** One browser tool call on the timeline, as the device's mappers report it (summary lines only, never page text). */
function toolCall(sid: string, name: string, started: string, completed: string) {
  const toolUseId = `tu-${randomUUID()}`;
  d.event(sid, { type: "tool.started", toolUseId, name, summary: started });
  d.event(sid, { type: "tool.completed", toolUseId, ok: true, summary: completed });
}

const browserRow = async (sid: string) =>
  (await su.query("select * from app.work_browsers where work_session_id = $1", [sid])).rows[0] as
    | Json
    | undefined;

/** One expiry for every copy of the cookie (the load answers exactly what was sealed). */
const EXPIRES = Math.floor(Date.now() / 1000) + 7 * 86_400;
const cookie = (value: string) => ({
  name: "session",
  value,
  domain: "127.0.0.1",
  path: "/",
  expires: EXPIRES,
  httpOnly: true,
  secure: false,
  sameSite: "Lax" as const,
});

/**
 * Every text-like column of every table (schemas app, auth and pgboss) holding `needle`, as `schema.table.column`; the
 * sealed secret's ciphertext is never read.
 */
async function columnsHolding(needle: string): Promise<string[]> {
  const cols = (
    await su.query(
      `select table_schema, table_name, column_name, data_type from information_schema.columns
        where table_schema in ('app', 'auth', 'pgboss')
          and (data_type in ('text', 'jsonb', 'json', 'character varying', 'bytea')
               or udt_name in ('_text', '_varchar'))`,
    )
  ).rows as Array<{ table_schema: string; table_name: string; column_name: string; data_type: string }>;
  expect(cols.length).toBeGreaterThan(50);
  const found: string[] = [];
  for (const c of cols) {
    if (c.table_schema === "app" && c.table_name === "secrets" && c.column_name === "ciphertext") continue;
    // A bytea column is searched for the needle's bytes; every other one as text.
    const where =
      c.data_type === "bytea"
        ? `position(convert_to($1, 'UTF8') in "${c.column_name}") > 0`
        : `"${c.column_name}"::text like '%' || $1 || '%'`;
    const n = (
      await su.query(`select count(*)::int as n from "${c.table_schema}"."${c.table_name}" where ${where}`, [
        needle,
      ])
    ).rows[0].n as number;
    if (n > 0) found.push(`${c.table_schema}.${c.table_name}.${c.column_name}`);
  }
  return found;
}

const spansHolding = (needle: string) =>
  spans
    .getFinishedSpans()
    .filter((s) => JSON.stringify({ n: s.name, a: s.attributes, e: s.events }).includes(needle))
    .map((s) => s.name);

describe("07.13-22: no typed text and no sign-in cookie survives anywhere on the server but the sealed secret (D-31, WZB-11)", () => {
  it("Mia types through the live view, saves her sign-in, the device loads it on her next turn: both sentinels stay out of every store, log, span, Redis command and answer", async () => {
    const sid = await W.startSession(mia, d, projectId);

    // Turn 1: the agent opens the site, asks Mia to sign in; she says yes and takes control.
    const first = await ask(sid, "open the app and sign in");
    d.browserEvent(sid, { kind: "opened", origin: ORIGIN, promptId: first });
    toolCall(sid, "mcp__ocw_browser__open", `Opening ${ORIGIN}`, `Opened ${SITE}`);
    await D.eventually(async () => (await browserRow(sid))?.state === "open" || undefined);
    const approvalId = randomUUID();
    d.event(sid, {
      type: "approval.requested",
      approvalId,
      tool: "mcp__ocw_browser__signin",
      summary: `Sign in to ${SITE}`,
      paths: [],
      browser: { kind: "signin", origin: ORIGIN, tool: "ocw_browser_signin", reason: "to read your account" },
    });
    await D.eventually(
      async () =>
        ((await su.query("select 1 from app.work_approvals where id = $1", [approvalId])).rowCount ?? 0) > 0,
    );
    const yes = await people("POST", `/api/v1/work-sessions/${sid}/approvals/${approvalId}`, {
      decision: "once",
    });
    expect(yes.status, JSON.stringify(yes.body)).toBe(200);
    d.ack((await d.command("approval.resolve", sid)).id);

    const live = await L.workLiveSocket(stack.baseUrl, await mia.token(), sid);
    let uploadId: string;
    try {
      await L.waitState(live, "live");
      live.socket.send(JSON.stringify({ type: "take" }));
      await d.next((f) => f.type === "browser.lease" && f.sessionId === sid && f.state === "held");
      await L.waitState(live, "controlling", 4000);
      live.socket.send(JSON.stringify({ type: "mouse", event: "down", x: 100, y: 120, button: "left" }));
      live.socket.send(JSON.stringify({ type: "mouse", event: "up", x: 100, y: 120, button: "left" }));
      live.socket.send(JSON.stringify({ type: "text", text: TYPED }));
      live.socket.send(
        JSON.stringify({ type: "key", event: "down", key: "Enter", code: "Enter", modifiers: 0 }),
      );
      live.socket.send(
        JSON.stringify({ type: "key", event: "up", key: "Enter", code: "Enter", modifiers: 0 }),
      );
      await D.eventually(
        async () =>
          deviceFrames.some((f) => f.type === "browser.input" && JSON.stringify(f).includes(TYPED)) ||
          undefined,
      );
      // "Done, save my sign-in": the API mints the one-use upload and tells the device only through the hand back.
      live.socket.send(JSON.stringify({ type: "release", save: true }));
      const handback = (await d.next((f) => f.type === "browser.handback" && f.sessionId === sid)) as Json;
      expect(handback.save).toBe(true);
      uploadId = handback.uploadId as string;
      const put = await devicePut(`/api/v1/runtime/browser-signins/uploads/${uploadId}`, {
        sessionId: sid,
        origin: ORIGIN,
        state: { cookies: [cookie(COOKIE)], origins: [] },
        changed: true,
      });
      expect(put.status, JSON.stringify(put.body)).toBe(201);
      // A save closes the page (the next member open loads the sealed copy).
      d.browserEvent(sid, { kind: "closed", origin: ORIGIN, promptId: first });
      await D.eventually(async () => (await browserRow(sid))?.state === "closed" || undefined);
      await L.waitState(live, "ended", 4000);
    } finally {
      answers.push(JSON.stringify(live.json));
      live.close();
    }
    toolCall(sid, "mcp__ocw_browser__signin", `Asking you to sign in to ${SITE}`, "Signed in: yes");
    finish(sid, first, "You are signed in.");
    await D.eventually(async () => {
      const r = await su.query("select status from app.work_prompts where id = $1", [first]);
      return (r.rows[0] as Json).status === "completed" || undefined;
    });
    const signinId = (
      (
        await su.query("select id from app.work_browser_signins where user_id = $1 and site_key = $2", [
          miaId,
          SITE,
        ])
      ).rows[0] as Json
    ).id as string;

    // Turn 2: the device loads the sealed sign-in for Mia's own turn, on its own socket.
    const second = await ask(sid, "read my account page");
    const requestId = randomUUID();
    d.send({ type: "browser.signin.load", requestId, sessionId: sid, promptId: second, origin: ORIGIN });
    const loaded = (await d.next(
      (f) => f.type === "browser.signin.state" && f.requestId === requestId,
    )) as Json;
    expect(loaded.result).toMatchObject({ ok: true, signinId, state: { cookies: [cookie(COOKIE)] } });
    await D.eventually(async () => (await browserRow(sid))?.signin_user_id === miaId || undefined);
    d.browserEvent(sid, { kind: "opened", origin: ORIGIN, promptId: second });
    toolCall(sid, "mcp__ocw_browser__open", `Opening ${ORIGIN}`, `Opened ${SITE}\nSigned in: yes`);
    toolCall(sid, "mcp__ocw_browser__snapshot", "Reading the page", "Read the page");
    // Mia's live view while the sign-in is loaded: private for everyone but her (her answer is recorded too).
    const again = await L.workLiveSocket(stack.baseUrl, await mia.token(), sid);
    try {
      await L.waitFor(() => L.lastState(again), 4000);
    } finally {
      answers.push(JSON.stringify(again.json));
      again.close();
    }
    // Re-seal before the unload (the site rolled nothing: the same cookie), then unload and finish.
    const resealed = await devicePut(`/api/v1/runtime/browser-signins/${signinId}/state`, {
      sessionId: sid,
      origin: ORIGIN,
      state: { cookies: [cookie(COOKIE)], origins: [] },
      changed: true,
    });
    expect(resealed.status, JSON.stringify(resealed.body)).toBe(200);
    d.browserEvent(sid, { kind: "closed", origin: ORIGIN, promptId: second });
    d.browserEvent(sid, { kind: "signin_unloaded", origin: ORIGIN, promptId: second });
    await D.eventually(async () => (await browserRow(sid))?.signin_user_id === null || undefined);
    finish(sid, second, "Your account page says you are signed in.");

    // What a person reads afterwards: the session, the session list, the Keychain.
    expect((await people("GET", `/api/v1/work-sessions/${sid}`)).status).toBe(200);
    expect((await people("GET", "/api/v1/work-sessions")).status).toBe(200);
    const list = await people("GET", "/api/v1/work-browser/signins");
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain(SITE);
    await W.settled(stack);
    await D.sleep(300);

    // The Redis tap works: a probe published now is seen, so every command before it was seen too.
    const probe = `probe-${randomUUID()}`;
    await stack.built.core.bus.publish("ocw:test:probe", probe);
    await D.eventually(async () => redisSeen.some((line) => line.includes(probe)) || undefined);

    for (const needle of [TYPED, COOKIE]) {
      expect(await columnsHolding(needle), needle).toEqual([]);
      // Named explicitly as well: device_commands, work_session_events (the session's `ws:` stream rows), audit.
      for (const [table, column, where] of [
        ["device_commands", "payload", "true"],
        ["stream_events", "payload", `stream_id = 'ws:${sid}'`],
        ["audit_events", "metadata", "true"],
        ["work_approvals", "request", "true"],
      ] as const) {
        const r = await su.query(
          `select count(*)::int as n from app.${table} where ${where} and ${column}::text like $1`,
          [`%${needle}%`],
        );
        expect((r.rows[0] as Json).n, `${table} ${needle}`).toBe(0);
      }
      expect(
        logs.filter((line) => line.includes(needle)),
        needle,
      ).toEqual([]);
      expect(spansHolding(needle), needle).toEqual([]);
      expect(
        redisSeen.filter((line) => line.includes(needle)),
        needle,
      ).toEqual([]);
      expect(
        answers.filter((a) => a.includes(needle)),
        needle,
      ).toEqual([]);
    }
    // The run did write to every one of those sinks (a sweep over empty sinks proves nothing).
    expect(logs.length).toBeGreaterThan(0);
    expect(spans.getFinishedSpans().length).toBeGreaterThan(0);
    expect(answers.length).toBeGreaterThan(5);
    const timeline = (
      await su.query("select count(*)::int as n from app.stream_events where stream_id = $1", [`ws:${sid}`])
    ).rows[0] as Json;
    expect(timeline.n).toBeGreaterThan(5);
    const commands = (
      await su.query("select count(*)::int as n from app.device_commands where device_id = $1", [deviceId])
    ).rows[0] as Json;
    expect(commands.n).toBeGreaterThan(2);

    // The Device Link: the typed text only in the lease's `browser.input` frames, the cookie only in the one load reply.
    const withTyped = deviceFrames.filter((f) => JSON.stringify(f).includes(TYPED));
    expect(withTyped.length).toBeGreaterThan(0);
    expect([...new Set(withTyped.map((f) => f.type))]).toEqual(["browser.input"]);
    const withCookie = deviceFrames.filter((f) => JSON.stringify(f).includes(COOKIE));
    expect(withCookie.map((f) => [f.type, f.requestId])).toEqual([["browser.signin.state", requestId]]);

    // The one place the state lives: the sealed secret of Mia's sign-in, encrypted.
    const secret = (
      await su.query(
        "select s.ciphertext from app.secrets s join app.work_browser_signins w on w.secret_id = s.id where w.id = $1",
        [signinId],
      )
    ).rows[0] as Json;
    expect(Buffer.from(String(secret.ciphertext)).includes(COOKIE)).toBe(false);
  });
});
