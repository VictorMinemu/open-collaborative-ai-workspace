import { randomUUID } from "node:crypto";
import { WorkBrowserSignInList } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";
import { eventually, FakeDevice } from "../../testing-device";
import { invite, pairDevice, startSession } from "../../testing-workzone";
import { browserSessionAad } from "../browser";
import { sealWorkSignIn, workSignInAad } from "./signins";

/**
 * Phase 07.13-17 (D-22, D-23, D-28, D-30, PD-03, PD-15, P7) on a real PostgreSQL + Redis and the full API: a member's
 * hand-back upload from the session's own device is re-filtered to the site, sealed with the Work Zone AAD (never the
 * bots'), one row per member × site, owner-only. The upload id is used once; another device, a user token or the raw
 * device token never reaches it. The member's Keychain lists only their own sign-ins; another member, an admin and
 * another organization see nothing and revoke nothing.
 */

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

const PORT = 4100;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SITE = `127.0.0.1:${PORT}`;
const CANARY = `canary-${randomUUID()}`;

let stack: TestStack;
let su: pg.Client;
let orgA: string;
let ada: TestClient; // admin
let owen: TestClient; // developer, owns the device
let owenId: string;
let pia: TestClient; // developer
let eve: TestClient; // admin of organization B
let eveId: string;
let orgB: string;
let d: FakeDevice; // Owen's device (browser)
let spare: FakeDevice; // Owen's second device
let rawDeviceToken: string;
let projectId: string;
const open: FakeDevice[] = [];

const core = () => stack.built.core;

/** A Playwright cookie (the contract's strict shape). */
const cookie = (domain: string, value: string, expires = 2_000_000_000) => ({
  name: "sid",
  value,
  domain,
  path: "/",
  expires,
  httpOnly: true,
  secure: false,
  sameSite: "Lax" as const,
});

/** The site's cookie (the canary) and an identity provider's cookie that must never be sealed with it. */
const state = (value = CANARY, expires?: number) => ({
  cookies: [cookie("127.0.0.1", value, expires), cookie("evil.example", `evil-${value}`)],
  origins: [
    { origin: ORIGIN, localStorage: [{ name: "token", value: `ls-${value}` }] },
    { origin: "https://evil.example", localStorage: [{ name: "token", value: "evil" }] },
  ],
});

/** The API's one-use hand-back upload on the session's browser row (07.13-18 mints it; set here by SQL). */
async function mintUpload(sessionId: string, userId: string, origin = ORIGIN, expiresInMs = 5 * 60_000) {
  const uploadId = randomUUID();
  await su.query(
    `insert into app.work_browsers (work_session_id, organization_id, state, origin, upload_id, upload_user_id,
                                    upload_origin, upload_expires_at)
       values ($1, $2, 'open', $3, $4, $5, $3, now() + make_interval(secs => $6))
     on conflict (work_session_id) do update set upload_id = excluded.upload_id,
       upload_user_id = excluded.upload_user_id, upload_origin = excluded.upload_origin,
       upload_expires_at = excluded.upload_expires_at`,
    [sessionId, orgA, origin, uploadId, userId, expiresInMs / 1000],
  );
  return uploadId;
}

async function put(path: string, token: string | null, body: unknown) {
  const res = await fetch(`${stack.baseUrl}${path}`, {
    method: "PUT",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Json | null };
}

const upload = (uploadId: string, token: string | null, body: Json) =>
  put(`/api/v1/runtime/browser-signins/uploads/${uploadId}`, token, body);

const signinRows = async (userId: string) =>
  (await su.query("select * from app.work_browser_signins where user_id = $1 order by created_at", [userId]))
    .rows as Json[];

const browserRow = async (sessionId: string) =>
  (await su.query("select * from app.work_browsers where work_session_id = $1", [sessionId])).rows[0] as Json;

const audits = async (action: string, resourceId: string) =>
  (
    await su.query(
      "select actor_kind, actor_id, user_id, device_id, session_id, metadata from app.audit_events where action = $1 and resource_id = $2 order by occurred_at, id",
      [action, resourceId],
    )
  ).rows as Json[];

/** Opens a sealed secret as `userId` with `aad` (throws when the AAD does not match). */
const reveal = (userId: string, secretId: string, aad: string) =>
  core().db.withTenant({ organizationId: orgA, userId }, (tx) =>
    core().secrets.revealSealed(tx, secretId, aad),
  );

/** Organization B: Eve leaves A and becomes the admin of her own organization (the 07.9 matrix pattern). */
async function moveToOrgB(userId: string): Promise<string> {
  const orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Other', $2)", [
    orgB,
    `o-${orgB}`,
  ]);
  await su.query("delete from auth.member where user_id = $1", [userId]);
  await su.query("delete from app.org_members where user_id = $1", [userId]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    orgB,
    userId,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
    [orgB, userId],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, userId]);
  return orgB;
}

beforeAll(async () => {
  stack = await startTestStack();
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  ada = new TestClient(stack.baseUrl);
  const setup = await ada.request("POST", "/api/v1/setup", {
    token: TEST_SETUP_TOKEN,
    name: "Ada Admin",
    email: "ada@example.test",
    password: "correct-horse-battery",
    orgName: "Autofy Labs",
  });
  expect(setup.status, JSON.stringify(setup.body)).toBe(200);
  orgA = (setup.body!.organization as Json).id as string;
  ({ client: owen, userId: owenId } = await invite(stack, ada, "owen@example.test", "Owen", "developer"));
  ({ client: pia } = await invite(stack, ada, "pia@example.test", "Pia", "developer"));
  const eveInvite = await invite(stack, ada, "eve@example.test", "Eve", "developer");
  eve = eveInvite.client;
  eveId = eveInvite.userId;
  orgB = await moveToOrgB(eveInvite.userId);

  const paired = await pairDevice(stack, owen, "Owen's Mac");
  rawDeviceToken = paired.token;
  d = await FakeDevice.connect(stack.baseUrl, paired.token, undefined, {
    browser: { version: 1, optIn: true },
  });
  open.push(d);
  d.send({
    type: "projects.sync",
    projects: [{ localId: "web", name: "web", gitRemote: null, defaultBranch: "main" }],
  });
  await d.next((f) => f.type === "projects.ack");
  const projects = (await owen.request("GET", "/api/v1/projects")).body!.projects as Array<{
    id: string;
    name: string;
  }>;
  projectId = projects.find((p) => p.name === "web")!.id;
  const second = await pairDevice(stack, owen, "Owen's spare");
  spare = await FakeDevice.connect(stack.baseUrl, second.token, undefined, {
    browser: { version: 1, optIn: true },
  });
  open.push(spare);
}, 240_000);

afterAll(async () => {
  for (const dev of open) await dev.close().catch(() => {});
  await su?.end();
  await stack?.stop();
});

describe("07.13-17 Task 1: a hand-back upload is sealed for the member and listed in their Keychain only", () => {
  let sessionId: string;
  let firstUpload: string;
  let signinId: string;

  it("the session's device uploads with its JWT: sealed with the Work Zone AAD, the site's state only", async () => {
    sessionId = await startSession(owen, d, projectId);
    firstUpload = await mintUpload(sessionId, owenId);
    const res = await upload(firstUpload, d.jwt, {
      sessionId,
      origin: ORIGIN,
      state: state(),
      changed: true,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toEqual({ saved: true });

    const rows = await signinRows(owenId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ site_key: SITE, organization_id: orgA, last_used_at: null });
    signinId = rows[0]!.id as string;
    const secretId = rows[0]!.secret_id as string;

    const sealed = JSON.parse(
      await reveal(owenId, secretId, workSignInAad({ organizationId: orgA, userId: owenId, siteKey: SITE })),
    ) as Json;
    expect(sealed.cookies).toEqual([cookie("127.0.0.1", CANARY)]);
    expect(sealed.origins).toEqual([
      { origin: ORIGIN, localStorage: [{ name: "token", value: `ls-${CANARY}` }] },
    ]);
    // D-30: the bots' AAD shape never opens a Work Zone sign-in.
    await expect(
      reveal(
        owenId,
        secretId,
        browserSessionAad({ organizationId: orgA, userId: owenId, agentId: randomUUID(), siteKey: SITE }),
      ),
    ).rejects.toThrow();
    // The ciphertext never holds the plaintext.
    const secret = (await su.query("select ciphertext as c from app.secrets where id = $1", [secretId]))
      .rows[0] as Json;
    expect(String(secret.c)).not.toContain(CANARY);

    // The upload is consumed; the audit names the origin only.
    const row = await browserRow(sessionId);
    expect(row).toMatchObject({
      upload_id: null,
      upload_user_id: null,
      upload_origin: null,
      upload_expires_at: null,
    });
    const saved = await audits("work_browser.signin_saved", signinId);
    expect(saved).toEqual([
      {
        actor_kind: "device",
        actor_id: expect.any(String),
        user_id: owenId,
        device_id: expect.any(String),
        session_id: sessionId,
        metadata: { origin: ORIGIN },
      },
    ]);
    const leaked = await su.query(
      "select count(*)::int as n from app.audit_events where metadata::text like $1",
      [`%${CANARY}%`],
    );
    expect((leaked.rows[0] as Json).n).toBe(0);
  });

  it("the same upload again is 409 `upload_used`; nothing changes", async () => {
    const before = await signinRows(owenId);
    const res = await upload(firstUpload, d.jwt, {
      sessionId,
      origin: ORIGIN,
      state: state("again"),
      changed: true,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect((res.body!.error as Json).code).toBe("upload_used");
    expect(await signinRows(owenId)).toEqual(before);
  });

  it("another device's JWT is 404, a user JWT and the raw device token are 401; the upload stays usable", async () => {
    const id = await mintUpload(sessionId, owenId);
    const body = { sessionId, origin: ORIGIN, state: state("other"), changed: true };
    expect((await upload(id, spare.jwt, body)).status).toBe(404);
    expect((await upload(id, await owen.token(), body)).status).toBe(401);
    expect((await upload(id, rawDeviceToken, body)).status).toBe(401);
    expect((await upload(id, null, body)).status).toBe(401);
    expect((await browserRow(sessionId)).upload_id).toBe(id);
    // A body naming another session or origin is not this upload either.
    expect((await upload(id, d.jwt, { ...body, sessionId: randomUUID() })).status).toBe(404);
    expect((await upload(id, d.jwt, { ...body, origin: "http://127.0.0.1:4101" })).status).toBe(404);
    expect((await browserRow(sessionId)).upload_id).toBe(id);
    // A malformed body names nothing of itself.
    const bad = await upload(id, d.jwt, { ...body, state: { cookies: "nope" } });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain("nope");
  });

  it("`changed: false` or nothing of the site left: 200 `{ saved: false }`, no row, the upload consumed", async () => {
    const other = "http://127.0.0.1:4200";
    const unchanged = await mintUpload(sessionId, owenId, other);
    const a = await upload(unchanged, d.jwt, { sessionId, origin: other, state: state(), changed: false });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body).toEqual({ saved: false });
    expect((await browserRow(sessionId)).upload_id).toBeNull();

    const empty = await mintUpload(sessionId, owenId, other);
    // The site's own cookies are absent: only the evil.example ones would be left, and they are never kept.
    const onlyEvil = { cookies: [cookie("evil.example", "x")], origins: [] };
    const b = await upload(empty, d.jwt, { sessionId, origin: other, state: onlyEvil, changed: true });
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    expect(b.body).toEqual({ saved: false });
    expect((await signinRows(owenId)).map((r) => r.site_key)).toEqual([SITE]);
  });

  it("an expired upload is 410 and consumed", async () => {
    const id = await mintUpload(sessionId, owenId, ORIGIN, -1_000);
    const res = await upload(id, d.jwt, { sessionId, origin: ORIGIN, state: state(), changed: true });
    expect(res.status).toBe(410);
    expect((await browserRow(sessionId)).upload_id).toBeNull();
  });

  it("GET /work-browser/signins lists the member's own sign-in only (no secret); others, admins and org B see none", async () => {
    const mine = await owen.request("GET", "/api/v1/work-browser/signins");
    expect(mine.status).toBe(200);
    const list = WorkBrowserSignInList.parse(mine.body);
    expect(list.items).toEqual([
      {
        id: signinId,
        site: SITE,
        scope: "work_zone",
        createdAt: expect.any(String),
        lastUsedAt: null,
        expiresAt: expect.any(String),
        status: "active",
      },
    ]);
    expect(JSON.stringify(mine.body)).not.toContain(CANARY);
    expect(JSON.stringify(mine.body)).not.toContain("secret");
    for (const other of [pia, ada, eve]) {
      const res = await other.request("GET", "/api/v1/work-browser/signins");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [] });
    }
  });

  it("nobody else can revoke it (404: another member, an admin, organization B)", async () => {
    for (const other of [pia, ada, eve]) {
      const res = await other.request("DELETE", `/api/v1/work-browser/signins/${signinId}`);
      expect(res.status).toBe(404);
    }
    expect(await signinRows(owenId)).toHaveLength(1);
  });

  it("a second save for the same member and site replaces the secret in place (same row, new expiry)", async () => {
    const [before] = await signinRows(owenId);
    const soon = Math.floor(Date.now() / 1000) + 3 * 24 * 3600;
    const id = await mintUpload(sessionId, owenId);
    const res = await upload(id, d.jwt, {
      sessionId,
      origin: ORIGIN,
      state: state("second", soon),
      changed: true,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [after] = await signinRows(owenId);
    expect(after!.id).toBe(before!.id);
    expect(after!.secret_id).toBe(before!.secret_id);
    expect(new Date(String(after!.expires_at)).getTime()).toBe(soon * 1000);
    const sealed = JSON.parse(
      await reveal(
        owenId,
        after!.secret_id as string,
        workSignInAad({ organizationId: orgA, userId: owenId, siteKey: SITE }),
      ),
    ) as Json;
    expect(sealed.cookies[0].value).toBe("second");
  });
});

describe("07.13-17 Task 3: revoke closes a loaded page, and expired sign-ins are swept", () => {
  const sweeper = () => stack.built.workBrowser.sweeper;
  const SWEPT_ORIGIN = "http://127.0.0.1:4600";
  const SWEPT_SITE = "127.0.0.1:4600";
  let aId: string;
  let bId: string;

  /** A sign-in of `userId` in `organizationId` for `origin`, through the module's own seal (as that member). */
  async function sealAs(
    organizationId: string,
    userId: string,
    origin: string,
    value: string,
  ): Promise<string> {
    const sealed = await core().db.withTenant({ organizationId, userId }, (tx) =>
      sealWorkSignIn(tx, core(), {
        userId,
        origin,
        rawState: JSON.stringify({ cookies: [cookie("127.0.0.1", value)], origins: [] }),
        device: { deviceId: randomUUID(), sessionId: randomUUID() },
      }),
    );
    if (!sealed) throw new Error("nothing sealed");
    return sealed.signinId;
  }

  /** The session's page has `signinId` of `userId` loaded (07.13-17 Task 2 sets it; here by SQL). */
  const loadInto = (sessionId: string, origin: string, signinId: string, userId: string) =>
    su.query(
      `insert into app.work_browsers (work_session_id, organization_id, state, origin, signin_id, signin_user_id)
         values ($1, $2, 'open', $3, $4, $5)
       on conflict (work_session_id) do update set signin_id = excluded.signin_id, signin_user_id = excluded.signin_user_id`,
      [sessionId, orgA, origin, signinId, userId],
    );

  const signinById = async (id: string) =>
    (await su.query("select * from app.work_browser_signins where id = $1", [id])).rows[0] as
      | Json
      | undefined;

  it("the owner revokes a sign-in loaded in a session: row and secret gone, audited, the device closes the page", async () => {
    const s = await startSession(owen, d, projectId);
    const origin = "http://127.0.0.1:4500";
    const id = await sealAs(orgA, owenId, origin, "loaded");
    const secretId = (await signinById(id))!.secret_id as string;
    await loadInto(s, origin, id, owenId);

    const res = await owen.request("DELETE", `/api/v1/work-browser/signins/${id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(204);
    expect(await signinById(id)).toBeUndefined();
    expect((await su.query("select id from app.secrets where id = $1", [secretId])).rows).toEqual([]);
    expect(await audits("work_browser.signin_revoked", id)).toEqual([
      {
        actor_kind: "user",
        actor_id: owenId,
        user_id: owenId,
        device_id: null,
        session_id: expect.anything(),
        metadata: { site: "127.0.0.1:4500" },
      },
    ]);
    expect(await d.next((f) => f.type === "browser.close" && f.sessionId === s)).toEqual({
      type: "browser.close",
      sessionId: s,
      reason: "revoked",
    });
    expect(await browserRow(s)).toMatchObject({ signin_id: null, signin_user_id: null });
    expect(spare.frames.filter((f) => f.type === "browser.close")).toEqual([]);
    // Gone for good: a second revoke is 404.
    expect((await owen.request("DELETE", `/api/v1/work-browser/signins/${id}`)).status).toBe(404);
  });

  it("the sweep removes A's expired sign-in (and closes its page), audited `expired`; B's stays; a rerun does nothing", async () => {
    const now = Date.now();
    aId = await sealAs(orgA, owenId, SWEPT_ORIGIN, "a");
    bId = await sealAs(orgB, eveId, SWEPT_ORIGIN, "b");
    await su.query("update app.work_browser_signins set expires_at = $2 where id = $1", [
      aId,
      new Date(now + 3600_000).toISOString(),
    ]);
    const s = await startSession(owen, d, projectId);
    await loadInto(s, SWEPT_ORIGIN, aId, owenId);
    const kept = (await signinRows(owenId)).map((r) => r.id).filter((id) => id !== aId);

    expect(await sweeper().runOnce(now + 2 * 3600_000)).toEqual({ expired: 1 });
    expect(await signinById(aId)).toBeUndefined();
    expect(await signinById(bId)).toBeDefined();
    expect((await signinRows(owenId)).map((r) => r.id)).toEqual(kept);
    const swept = (await audits("work_browser.signin_revoked", aId)).map(({ actor_id: _, ...r }) => r);
    expect(swept).toEqual([
      {
        actor_kind: "system",
        user_id: owenId,
        device_id: null,
        session_id: null,
        metadata: { site: SWEPT_SITE, reason: "expired" },
      },
    ]);
    expect(await d.next((f) => f.type === "browser.close" && f.sessionId === s)).toEqual({
      type: "browser.close",
      sessionId: s,
      reason: "revoked",
    });
    await eventually(async () => (await browserRow(s)).signin_user_id === null || undefined);

    expect(await sweeper().runOnce(now + 2 * 3600_000)).toEqual({ expired: 0 });
    expect(await audits("work_browser.signin_revoked", aId)).toHaveLength(1);
  });

  it("B's expired sign-in is swept in B alone: A's sign-ins are untouched", async () => {
    const now = Date.now();
    await su.query("update app.work_browser_signins set expires_at = $2 where id = $1", [
      bId,
      new Date(now + 3600_000).toISOString(),
    ]);
    const before = await signinRows(owenId);
    expect(await sweeper().runOnce(now + 2 * 3600_000)).toEqual({ expired: 1 });
    expect(await signinById(bId)).toBeUndefined();
    expect(await signinRows(owenId)).toEqual(before);
    const inB = await su.query(
      "select organization_id, metadata from app.audit_events where action = 'work_browser.signin_revoked' and resource_id = $1",
      [bId],
    );
    expect(inB.rows).toEqual([{ organization_id: orgB, metadata: { site: SWEPT_SITE, reason: "expired" } }]);
  });
});
