import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, type FakeDevice } from "../../testing-device";
import { connectWithProject, invite, pairDevice, shareDevice, startSession } from "../../testing-workzone";
import { pendingApprovers } from "./browser-grant";
import type { WorkSessionService } from "./service";

/**
 * Phase 07.13 Plan 07 Task 3 (D-11, D-21, D-26, PD-10) on a real PostgreSQL + Redis and the full API: a browser
 * approval is stored with its kind, origin and tool, shown on the timeline and in the approvals list, and audited with
 * its origin. The device's `browser.kind` is only a hint: who may answer the member approvals comes from the API's own
 * state (`work_browsers.signin_user_id`, the in-flight prompt's author), so another member gets 403 even with
 * `work_session.approve`.
 */

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

let stack: TestStack;
let su: pg.Client;
let victor: TestClient; // admin (has work_session.approve on every session)
let mia: TestClient; // developer, owner of the device
let miaId: string;
let carl: TestClient; // developer, the device is shared with him
let device: FakeDevice;
let deviceId: string;
let projectId: string;
let orgId: string;

async function ok(res: Promise<{ status: number; body: Json | null }>, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

const detail = (as: TestClient, sid: string) => ok(as.request("GET", `/api/v1/work-sessions/${sid}`));

const resolve = (as: TestClient, sid: string, approvalId: string) =>
  as.request("POST", `/api/v1/work-sessions/${sid}/approvals/${approvalId}`, { decision: "once" });

const codeOf = (r: { body: Json | null }) => (r.body?.error as Json | undefined)?.code;

/** The device asks for a browser approval; resolves once the API stored it. */
async function askBrowser(sid: string, browser: Json, tool = "mcp__ocw_browser__open") {
  const approvalId = randomUUID();
  device.event(sid, {
    type: "approval.requested",
    approvalId,
    tool,
    summary: `Open ${String(browser.origin)}`,
    paths: [],
    browser,
  });
  await eventually(async () => {
    const r = await su.query("select 1 from app.work_approvals where id = $1", [approvalId]);
    return (r.rowCount ?? 0) > 0;
  });
  return approvalId;
}

const storedRequest = async (approvalId: string) =>
  (await su.query("select request from app.work_approvals where id = $1", [approvalId])).rows[0]
    ?.request as Json;

const setSignedIn = (sid: string, userId: string | null) =>
  su.query(
    `insert into app.work_browsers (work_session_id, organization_id, state, signin_user_id) values ($1, $2, 'open', $3)
     on conflict (work_session_id) do update set signin_user_id = excluded.signin_user_id`,
    [sid, orgId, userId],
  );

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  victor = new TestClient(stack.baseUrl);
  const setup = await ok(
    victor.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  orgId = (setup.organization as Json).id as string;
  ({ client: mia, userId: miaId } = await invite(stack, victor, "mia@example.test", "Mia", "developer"));
  let carlId: string;
  ({ client: carl, userId: carlId } = await invite(stack, victor, "carl@example.test", "Carl", "developer"));
  const paired = await pairDevice(stack, mia, "Mia's Mac");
  deviceId = paired.deviceId;
  ({ device, projectId } = await connectWithProject(stack, mia, paired.token, {
    localId: "lp_web",
    name: "web",
  }));
  await shareDevice(mia, deviceId, carlId);
}, 180_000);

afterAll(async () => {
  await device?.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

describe("browser approvals (D-11, D-21, D-26, PD-10)", () => {
  it("a host approval is stored, shown on the timeline and the list, audited with its origin, and answered as today", async () => {
    const sid = await startSession(mia, device, projectId);
    const browser = { kind: "host", origin: "https://github.com:443", tool: "ocw_browser_open" };
    const approvalId = await askBrowser(sid, browser);
    expect((await storedRequest(approvalId)).browser).toEqual(browser);
    const d = await detail(mia, sid);
    expect((d.approvals as Json[]).find((a) => a.id === approvalId)?.request.browser).toEqual(browser);
    const ev = (d.events as Json[]).find(
      (e) => e.event?.type === "approval.requested" && e.event.approvalId === approvalId,
    );
    expect(ev?.event.browser).toEqual(browser);
    const audit = await su.query(
      "select metadata from app.audit_events where action = 'work_approval.requested' and resource_id = $1",
      [approvalId],
    );
    expect(audit.rows[0].metadata).toEqual({
      tool: "mcp__ocw_browser__open",
      paths: [],
      origin: browser.origin,
    });
    // Any approver of the session decides a host approval (the admin here).
    const r = await resolve(victor, sid, approvalId);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as Json).request.browser).toEqual(browser);
    const cmd = await device.command("approval.resolve", sid);
    expect(cmd.payload).toMatchObject({ approvalId, decision: "once" });
    device.ack(cmd.id);
  });

  it("signed_in_host: only the member whose sign-in is loaded answers; the admin gets 403 approval_not_yours", async () => {
    const sid = await startSession(mia, device, projectId);
    await setSignedIn(sid, miaId);
    const approvalId = await askBrowser(sid, {
      kind: "signed_in_host",
      origin: "https://evil.example:443",
      tool: "ocw_browser_open",
    });
    const denied = await resolve(victor, sid, approvalId);
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(codeOf(denied)).toBe("approval_not_yours");
    const pending = ((await detail(mia, sid)).approvals as Json[]).find((a) => a.id === approvalId);
    expect(pending?.status).toBe("pending");
    expect(device.pending("approval.resolve")).toHaveLength(0);
    const r = await resolve(mia, sid, approvalId);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    device.ack((await device.command("approval.resolve", sid)).id);
  });

  it("a host approval while a member's sign-in is loaded is that member's too (the device's kind is a hint)", async () => {
    const sid = await startSession(mia, device, projectId);
    await setSignedIn(sid, miaId);
    const approvalId = await askBrowser(sid, {
      kind: "host",
      origin: "https://other.example:443",
      tool: "ocw_browser_open",
    });
    expect(codeOf(await resolve(victor, sid, approvalId))).toBe("approval_not_yours");
    expect((await resolve(mia, sid, approvalId)).status).toBe(200);
    device.ack((await device.command("approval.resolve", sid)).id);
  });

  it("signed_in_host with no loaded sign-in: nobody may answer (the device's timeout decides)", async () => {
    const sid = await startSession(mia, device, projectId);
    const approvalId = await askBrowser(sid, {
      kind: "signed_in_host",
      origin: "https://evil.example:443",
      tool: "ocw_browser_open",
    });
    expect(codeOf(await resolve(mia, sid, approvalId))).toBe("approval_not_yours");
    expect(codeOf(await resolve(victor, sid, approvalId))).toBe("approval_not_yours");
  });

  it("signin: only the in-flight prompt's author answers; the session's creator gets 403", async () => {
    // Carl creates the session on Mia's device; Mia (the device owner) asks the turn that wants a sign-in.
    const sid = await startSession(carl, device, projectId);
    await ok(mia.request("POST", `/api/v1/work-sessions/${sid}/prompts`, { body: "Sign in to GitHub" }));
    const frame = await device.command("prompt", sid);
    device.ack(frame.id);
    device.event(sid, { type: "prompt.started", promptId: frame.payload.promptId });
    const approvalId = await askBrowser(
      sid,
      {
        kind: "signin",
        origin: "https://github.com:443",
        tool: "ocw_browser_signin",
        reason: "Read your PRs",
      },
      "mcp__ocw_browser__signin",
    );
    const denied = await resolve(carl, sid, approvalId);
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(codeOf(denied)).toBe("approval_not_yours");
    expect(codeOf(await resolve(victor, sid, approvalId))).toBe("approval_not_yours");
    const r = await resolve(mia, sid, approvalId);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    device.ack((await device.command("approval.resolve", sid)).id);
  });

  it("HI-04: once a sign-in loaded in the member's turn, every browser approval of that turn is theirs, even after the page unloaded it", async () => {
    const sid = await startSession(mia, device, projectId);
    await ok(mia.request("POST", `/api/v1/work-sessions/${sid}/prompts`, { body: "Check my account" }));
    const frame = await device.command("prompt", sid);
    device.ack(frame.id);
    const promptId = frame.payload.promptId as string;
    device.event(sid, { type: "prompt.started", promptId });
    await eventually(async () => {
      const r = await su.query("select status from app.work_prompts where id = $1", [promptId]);
      return ["dispatched", "running"].includes(r.rows[0]?.status as string) || undefined;
    });
    const host = { kind: "host", origin: "https://one.example:443", tool: "ocw_browser_open" };
    // Before any sign-in in this turn: the session's approvers decide (the admin here).
    const before = await askBrowser(sid, host);
    expect((await resolve(victor, sid, before)).status).toBe(200);
    device.ack((await device.command("approval.resolve", sid)).id);

    // Mia's sign-in loaded in this turn (the API's own record of the load), then the page left the site: the row no
    // longer names her, but what the agent read stays in the turn (the bots' sticky member-data rule).
    await su.query(
      `insert into app.audit_events (organization_id, actor_kind, actor_id, user_id, device_id, session_id, resource_type,
         resource_id, action, result, metadata)
       values ($1, 'device', $2, $3, $2, $4, 'work_browser_signin', $5, 'work_browser.signin_loaded', 'success',
         '{"origin": "https://bank.example:443"}'::jsonb)`,
      [orgId, deviceId, miaId, sid, randomUUID()],
    );
    await setSignedIn(sid, null);
    for (const browser of [
      { ...host, origin: "https://two.example:443" },
      { kind: "signed_in_host", origin: "https://evil.example:443", tool: "ocw_browser_open" },
      { kind: "admin_rule", origin: "https://three.example:443", tool: "ocw_browser_open" },
    ]) {
      const approvalId = await askBrowser(sid, browser);
      // "Needs you" reads the same rule: only Mia is asked.
      const rules = await stack.built.core.db.withTenant({ organizationId: orgId, userId: null }, (tx) =>
        pendingApprovers(tx, [sid]),
      );
      expect(rules.get(sid), browser.kind).toEqual({ open: false, only: new Set([miaId]) });
      expect(codeOf(await resolve(victor, sid, approvalId)), browser.kind).toBe("approval_not_yours");
      const r = await resolve(mia, sid, approvalId);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      device.ack((await device.command("approval.resolve", sid)).id);
    }

    // The turn ends: the next turn is no member-data turn until a sign-in loads in it.
    device.emitTurn(sid, { promptId, text: "Done" });
    await eventually(async () => {
      const r = await su.query("select status from app.work_prompts where id = $1", [promptId]);
      return !["dispatched", "running"].includes(r.rows[0]?.status as string) || undefined;
    });
    const after = await askBrowser(sid, { ...host, origin: "https://four.example:443" });
    expect((await resolve(victor, sid, after)).status).toBe(200);
    device.ack((await device.command("approval.resolve", sid)).id);
  });

  it("a non-browser approval in a signed-in session keeps the existing rule", async () => {
    const sid = await startSession(mia, device, projectId);
    await setSignedIn(sid, miaId);
    const approvalId = randomUUID();
    device.emitApproval(sid, { approvalId, tool: "Edit", paths: ["src/a.ts"] });
    await eventually(
      async () =>
        ((await su.query("select 1 from app.work_approvals where id = $1", [approvalId])).rowCount ?? 0) > 0,
    );
    expect((await storedRequest(approvalId)).browser).toBeUndefined();
    expect((await resolve(victor, sid, approvalId)).status).toBe(200);
    device.ack((await device.command("approval.resolve", sid)).id);
  });

  it("a browser part whose origin is not a BrowserOrigin is dropped, never stored as text", async () => {
    const sid = await startSession(mia, device, projectId);
    // The link refuses the whole frame (the contract), so nothing is stored at all.
    const refused = randomUUID();
    device.event(sid, {
      type: "approval.requested",
      approvalId: refused,
      tool: "mcp__ocw_browser__open",
      summary: "Open",
      paths: [],
      browser: { kind: "host", origin: "javascript:alert(1)", tool: "ocw_browser_open" },
    });
    await device.next((f) => f.type === "error" && f.code === "invalid_frame");
    expect((await su.query("select 1 from app.work_approvals where id = $1", [refused])).rowCount).toBe(0);
    // Defence in depth behind the link: the session handler drops a browser part that does not parse.
    const svc = stack.built.deviceHub.sessionHandler as unknown as WorkSessionService;
    const approvalId = randomUUID();
    await svc.onEvent({ deviceId, organizationId: orgId, ownerUserId: miaId }, {
      type: "event",
      sessionId: sid,
      event: {
        type: "approval.requested",
        approvalId,
        tool: "mcp__ocw_browser__open",
        summary: "Open",
        paths: [],
        browser: { kind: "host", origin: "javascript:alert(1)", tool: "ocw_browser_open" },
      },
    } as unknown as Parameters<WorkSessionService["onEvent"]>[1]);
    const stored = await storedRequest(approvalId);
    expect(stored).toBeDefined();
    expect(stored).not.toHaveProperty("browser");
    expect(JSON.stringify(stored)).not.toContain("javascript");
    const ev = (await detail(mia, sid)).events as Json[];
    expect(JSON.stringify(ev)).not.toContain("javascript");
  });
});
