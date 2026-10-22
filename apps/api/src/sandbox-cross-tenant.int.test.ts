import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "./lib/crypto";
import {
  type LiveStack,
  lastState,
  liveSocket,
  startLiveStack,
  waitFor,
} from "./modules/browser/live-testing";
import { keepForSite, sealSession } from "./modules/browser/sessions";
import { WEB_ORIGIN } from "./testing";
import { codeOf, type Json, ok, type Res } from "./testing-sandbox";

/**
 * 07.8-28 Task 1 (C-02, P-17; SBX-01, BRW-02, BRW-04; 07.4 #169): the phase's cross-tenant matrix, derived from the authz
 * registry. Every route whose URL names `/sandbox`, `/browser`, `/browser-sessions` or `/live/browser` has one
 * organization-B case with organization A's ids: a people route answers 404 (or organization B's own, empty answer for
 * a route without an id), a cell route answers 403 `no_trigger`, the live view closes 4403 with zero frames. The cases
 * that name organization A's objects make zero sandboxd calls; the organization-wide ones (settings, kill, packages)
 * change nothing of organization A. The registered set must equal the covered set: a new route without a case fails.
 * Then, within organization A, a bot's turn cannot reach another bot's process, page, files or a member's session.
 * Real PostgreSQL and Redis, the in-memory sandboxd.
 */

const HOST = "panel.fake.test";

let l: LiveStack;
/** A team bot of organization A with its own sandbox and browser, and Sam's DM with it. */
let ops: { id: string; dm: string };
/** Organization B's cell credential (a real row, another organization). */
let tokenB: string;

beforeAll(async () => {
  l = await startLiveStack();
  ops = await l.s.newBot(`Ops ${randomUUID().slice(0, 4)}`);
  await l.s.su.query(
    "update app.agents set capabilities = capabilities || jsonb_build_object('browser', true, 'sandbox', true) where id = $1",
    [ops.id],
  );
  tokenB = `ocw_cell_${randomUUID()}${randomUUID()}`;
  await l.s.su.query(
    "insert into app.agent_credentials (organization_id, kind, token_hash) values ($1, 'channel_plugin', $2)",
    [l.s.orgB, sha256Hex(tokenB)],
  );
}, 240_000);

afterAll(async () => {
  await l?.stop();
});

const core = () => l.s.stack.built.core;
const opsSnapshot = () => JSON.stringify(l.s.sandboxd.stats().calls);
const cellAs = (path: string, body: Json, token?: string) => l.s.cell(path, body, ...(token ? [token] : []));

/** A sealed session of Sam with `agentId` for `site`, through the module's own seal (as Sam). */
async function seal(agentId: string, site = HOST): Promise<string> {
  const kept = keepForSite(
    JSON.stringify({
      cookies: [{ name: "fake_session", value: `v-${randomUUID()}`, domain: site, path: "/", expires: 2e9 }],
      origins: [],
    }),
    site,
  );
  if (!kept) throw new Error("no state");
  const r = await core().db.withTenant({ organizationId: l.s.orgA, userId: l.s.samId }, (tx) =>
    sealSession(tx, core(), { userId: l.s.samId, agentId, siteKey: site, kept, contextId: null }),
  );
  return r.sessionId;
}

/** Organization A's facts every case is about. */
interface Facts {
  ev: Json;
  contextId: string;
  sessionId: string;
  packageId: string;
  conversationId: string;
}

async function factsOfA(): Promise<Facts> {
  const ev = await l.s.turnOf(l.s.sam, l.s.samDm);
  await ok(
    cellAs("/sandbox/write", {
      eventId: ev.eventId,
      agentId: l.s.scoutId,
      path: "tenant/a.txt",
      content: "organization A",
      mode: "overwrite",
    }),
  );
  // A page on a host without a sealed session (no member data in this file's DM).
  const contextId = await l.open(ev, "https://status.fake.test/");
  const sessionId = await seal(l.s.scoutId);
  const reviewed = await ok(
    l.s.victor.request("POST", "/api/v1/sandbox/packages/review", {
      source: "npm",
      name: "kleur",
      version: "4.1.5",
    }) as Promise<Res>,
  );
  const pkg = await ok(
    l.s.victor.request("POST", "/api/v1/sandbox/packages", {
      reviewToken: reviewed.reviewToken,
    }) as Promise<Res>,
  );
  return { ev, contextId, sessionId, packageId: pkg.id as string, conversationId: l.s.samDm };
}

/** The organization-B case of each registered route; `own` = an organization-wide route of B's own organization. */
type Case = { own?: true; run: (a: Facts) => Promise<void> };

const eve = () => l.s.eve;
const asEve = (method: string, path: string, body?: unknown) =>
  eve().request(method, path, body) as Promise<Res>;
const notFoundFor = (method: string, path: (a: Facts) => string, body?: unknown): Case => ({
  run: async (a) => {
    const r = await asEve(method, path(a), body);
    expect(r.status, `${method} ${path(a)}`).toBe(404);
    expect(JSON.stringify(r.body ?? {})).not.toContain(HOST);
  },
});
const noTrigger = (path: string, body: (a: Facts) => Json = () => ({})): Case => ({
  run: async (a) => {
    for (const agentId of [l.s.scoutId, ops.id]) {
      const r = await cellAs(path, { eventId: a.ev.eventId, agentId, ...body(a) }, tokenB);
      expect(r.status, path).toBe(403);
      expect(codeOf(r), path).toBe("no_trigger");
    }
  },
});
const policyOfA = async () =>
  (await l.s.su.query("select * from app.sandbox_policies where organization_id = $1", [l.s.orgA]))
    .rows[0] as Json;

const CASES: Record<string, Case> = {
  // ---- people: a bot's sandbox (07.8-11, 15)
  "GET /api/v1/agents/:id/sandbox": notFoundFor("GET", () => `/api/v1/agents/${l.s.scoutId}/sandbox`),
  "POST /api/v1/agents/:id/sandbox/stop": notFoundFor(
    "POST",
    () => `/api/v1/agents/${l.s.scoutId}/sandbox/stop`,
  ),
  "POST /api/v1/agents/:id/sandbox/restart": notFoundFor(
    "POST",
    () => `/api/v1/agents/${l.s.scoutId}/sandbox/restart`,
  ),
  "GET /api/v1/agents/:id/sandbox/files": notFoundFor(
    "GET",
    () => `/api/v1/agents/${l.s.scoutId}/sandbox/files?path=tenant`,
  ),
  "GET /api/v1/agents/:id/sandbox/files/content": notFoundFor(
    "GET",
    () => `/api/v1/agents/${l.s.scoutId}/sandbox/files/content?path=tenant/a.txt`,
  ),
  "GET /api/v1/agents/:id/sandbox/files/download": notFoundFor(
    "GET",
    () => `/api/v1/agents/${l.s.scoutId}/sandbox/files/download?path=tenant/a.txt`,
  ),
  "DELETE /api/v1/agents/:id/sandbox/files": notFoundFor(
    "DELETE",
    () => `/api/v1/agents/${l.s.scoutId}/sandbox/files?path=tenant/a.txt`,
  ),
  "POST /api/v1/agents/:id/sandbox/files/upload": {
    run: async () => {
      const res = await fetch(
        `${l.s.stack.baseUrl}/api/v1/agents/${l.s.scoutId}/sandbox/files/upload?path=tenant&name=b.txt`,
        {
          method: "POST",
          headers: {
            origin: WEB_ORIGIN,
            cookie: eve().cookieHeader,
            "content-type": "application/octet-stream",
          },
          body: Buffer.from("from B"),
        },
      );
      expect(res.status).toBe(404);
    },
  },
  // ---- people: the organization's sandbox settings, kill switch and packages (B's own organization)
  "GET /api/v1/sandbox/settings": {
    own: true,
    run: async () => {
      const b = await ok(asEve("GET", "/api/v1/sandbox/settings"));
      expect(b.settings.enabled).toBe(false);
      expect((await policyOfA()).enabled).toBe(true);
    },
  },
  "PUT /api/v1/sandbox/settings": {
    own: true,
    run: async () => {
      const before = await policyOfA();
      const b = await ok(asEve("GET", "/api/v1/sandbox/settings"));
      await ok(
        asEve("PUT", "/api/v1/sandbox/settings", {
          expectedVersion: b.settings.version,
          allowHosts: ["evil.example.com"],
        }),
      );
      expect(await policyOfA()).toEqual(before);
    },
  },
  "POST /api/v1/sandbox/kill": {
    own: true,
    run: async () => {
      await ok(asEve("POST", "/api/v1/sandbox/kill"));
      expect((await policyOfA()).killed_at).toBeNull();
      await ok(asEve("POST", "/api/v1/sandbox/resume"));
    },
  },
  "POST /api/v1/sandbox/resume": {
    own: true,
    run: async () => {
      await ok(asEve("POST", "/api/v1/sandbox/resume"));
      expect((await policyOfA()).killed_at).toBeNull();
    },
  },
  "GET /api/v1/sandbox/packages": {
    own: true,
    run: async (a) => {
      const b = await ok(asEve("GET", "/api/v1/sandbox/packages"));
      expect((b.items as Json[]).map((p) => p.id)).not.toContain(a.packageId);
    },
  },
  "POST /api/v1/sandbox/packages/review": {
    own: true,
    run: async () => {
      const r = await asEve("POST", "/api/v1/sandbox/packages/review", {
        source: "npm",
        name: "kleur",
        version: "4.1.5",
      });
      // B's sandbox is off (its own settings): whatever B's answer, A's packages are untouched.
      expect([200, 403, 409]).toContain(r.status);
    },
  },
  "POST /api/v1/sandbox/packages": {
    own: true,
    run: async () => {
      // Organization A's review token is no token of organization B.
      const theirs = await ok(
        l.s.victor.request("POST", "/api/v1/sandbox/packages/review", {
          source: "npm",
          name: "ms",
          version: "2.1.3",
        }) as Promise<Res>,
      );
      const r = await asEve("POST", "/api/v1/sandbox/packages", { reviewToken: theirs.reviewToken });
      expect(r.status).toBe(409);
      expect(codeOf(r)).toBe("review_token_invalid");
    },
  },
  "PATCH /api/v1/sandbox/packages/:id": notFoundFor(
    "PATCH",
    (a) => `/api/v1/sandbox/packages/${a.packageId}`,
    { enabled: false },
  ),
  "DELETE /api/v1/sandbox/packages/:id": notFoundFor(
    "DELETE",
    (a) => `/api/v1/sandbox/packages/${a.packageId}`,
  ),
  // ---- people: browser pages, sessions and the live view (07.8-16, 21, 22, 27)
  "GET /api/v1/agents/:id/browser": notFoundFor("GET", () => `/api/v1/agents/${l.s.scoutId}/browser`),
  "GET /api/v1/conversations/:id/browsers": notFoundFor(
    "GET",
    (a) => `/api/v1/conversations/${a.conversationId}/browsers`,
  ),
  "GET /api/v1/browser-sessions": {
    own: true,
    run: async (a) => {
      const b = await ok(asEve("GET", "/api/v1/browser-sessions"));
      expect(b.items).toEqual([]);
      expect(JSON.stringify(b)).not.toContain(a.sessionId);
    },
  },
  "DELETE /api/v1/browser-sessions/:id": notFoundFor(
    "DELETE",
    (a) => `/api/v1/browser-sessions/${a.sessionId}`,
  ),
  "GET /api/v1/live/browser/:contextId": {
    run: async (a) => {
      const socket = await liveSocket(l.s.stack.baseUrl, await eve().token(), a.contextId);
      const { code } = await socket.closed;
      expect(code).toBe(4403);
      expect(lastState(socket)).toMatchObject({ state: "no_permission", host: null });
      expect(socket.binary).toHaveLength(0);
      expect(JSON.stringify(socket.json)).not.toContain("status.fake.test");
    },
  },
  // ---- cell: the bots' sandbox and browser tools (07.8-10, 14, 21, 25)
  "POST /agent-channel/v1/sandbox/exec": noTrigger("/sandbox/exec", () => ({
    argv: ["cat", "tenant/a.txt"],
  })),
  "POST /agent-channel/v1/sandbox/process": noTrigger("/sandbox/process", () => ({
    processId: "p_0123456789abcdef",
    action: "poll",
  })),
  "POST /agent-channel/v1/sandbox/read": noTrigger("/sandbox/read", () => ({ path: "tenant/a.txt" })),
  "POST /agent-channel/v1/sandbox/write": noTrigger("/sandbox/write", () => ({
    path: "tenant/b.txt",
    content: "from B",
    mode: "overwrite",
  })),
  "POST /agent-channel/v1/sandbox/list": noTrigger("/sandbox/list", () => ({ path: "" })),
  "POST /agent-channel/v1/sandbox/delete": noTrigger("/sandbox/delete", () => ({ path: "tenant/a.txt" })),
  "POST /agent-channel/v1/sandbox/share": noTrigger("/sandbox/share", () => ({ path: "tenant/a.txt" })),
  "POST /agent-channel/v1/sandbox/import": noTrigger("/sandbox/import", () => ({
    attachmentId: randomUUID(),
  })),
  "POST /agent-channel/v1/browser/open": noTrigger("/browser/open", () => ({ url: `https://${HOST}/` })),
  "POST /agent-channel/v1/browser/snapshot": noTrigger("/browser/snapshot"),
  "POST /agent-channel/v1/browser/act": noTrigger("/browser/act", () => ({ action: "click", ref: "r1" })),
  "POST /agent-channel/v1/browser/screenshot": noTrigger("/browser/screenshot"),
  "POST /agent-channel/v1/browser/wait": noTrigger("/browser/wait", () => ({ for: "time", ms: 1 })),
  "POST /agent-channel/v1/browser/signin": noTrigger("/browser/signin", () => ({ reason: "From B" })),
  "POST /agent-channel/v1/browser/close": noTrigger("/browser/close"),
};

const PHASE_ROUTE = /\/sandbox|\/browser|\/browser-sessions|\/live\/browser/u;

describe("the phase's cross-tenant matrix, derived from the authz registry (C-02, P-17)", () => {
  it("every registered sandbox, browser, session and live-view route has an organization-B case; none reaches organization A", async () => {
    const routes = l.s.stack.built.authz.routes;
    const registered = [...routes.keys()].filter((k) => !k.startsWith("HEAD ") && PHASE_ROUTE.test(k)).sort();
    expect(registered).toEqual(Object.keys(CASES).sort());

    const a = await factsOfA();
    const fileBefore = (
      await ok(cellAs("/sandbox/read", { eventId: a.ev.eventId, agentId: l.s.scoutId, path: "tenant/a.txt" }))
    ).content;
    const callsOfA = async () =>
      (
        await l.s.su.query("select count(*)::int as n from app.agent_tool_calls where organization_id = $1", [
          l.s.orgA,
        ])
      ).rows[0].n as number;
    const ledgerBefore = await callsOfA();
    for (const [key, c] of Object.entries(CASES)) {
      expect(routes.get(key), key).toBe(key.startsWith("POST /agent-channel/") ? "cell" : "user");
      const before = opsSnapshot();
      await c.run(a);
      // A case that names organization A's objects never reaches sandboxd.
      if (!c.own) expect(opsSnapshot(), key).toBe(before);
    }
    // Nothing of organization A changed: its turn's ledger, its file, its page, its session and its package.
    expect(await callsOfA()).toBe(ledgerBefore);
    const after = await ok(
      cellAs("/sandbox/read", { eventId: a.ev.eventId, agentId: l.s.scoutId, path: "tenant/a.txt" }),
    );
    expect(after.content).toBe(fileBefore);
    expect(
      (await l.s.su.query("select closed_at from app.browser_contexts where id = $1", [a.contextId])).rows[0]
        .closed_at,
    ).toBeNull();
    expect(
      (await l.s.su.query("select count(*)::int as n from app.browser_sessions where id = $1", [a.sessionId]))
        .rows[0].n,
    ).toBe(1);
    expect(
      (await l.s.su.query("select status, enabled from app.sandbox_packages where id = $1", [a.packageId]))
        .rows[0],
    ).toEqual({ status: "approved", enabled: true });
    expect(
      (
        await l.s.su.query("select count(*)::int as n from app.browser_contexts where organization_id = $1", [
          l.s.orgB,
        ])
      ).rows[0].n,
    ).toBe(0);
  });
});

describe("one bot's turn cannot address another bot's process, page, files or a member's session (P-17)", () => {
  it("Scout's turn with Ops' process id is not_found; Ops' turn used by Scout is no_trigger; neither reaches the other", async () => {
    const opsTurn = await l.s.turnOf(l.s.sam, ops.dm, ops.id);
    const started = await ok(
      cellAs("/sandbox/exec", {
        eventId: opsTurn.eventId,
        agentId: ops.id,
        argv: ["sleep", "30"],
        background: true,
      }),
    );
    expect(started.status).toBe("running");
    const pid = started.processId as string;
    const scoutTurn = await l.s.turnOf(l.s.sam, l.s.samDm);
    const r = await cellAs("/sandbox/process", {
      eventId: scoutTurn.eventId,
      agentId: l.s.scoutId,
      processId: pid,
      action: "kill",
    });
    expect(r.status).toBe(404);
    expect(codeOf(r)).toBe("not_found");
    // Ops' own poll still finds it running: Scout's kill never reached it.
    const polled = await ok(
      cellAs("/sandbox/process", {
        eventId: opsTurn.eventId,
        agentId: ops.id,
        processId: pid,
        action: "poll",
      }),
    );
    expect(polled.status).toBe("running");
    await ok(
      cellAs("/sandbox/process", {
        eventId: opsTurn.eventId,
        agentId: ops.id,
        processId: pid,
        action: "kill",
      }),
    );

    // Scout naming Ops' turn: not its turn.
    const misuse = await cellAs("/sandbox/read", {
      eventId: opsTurn.eventId,
      agentId: l.s.scoutId,
      path: "tenant/a.txt",
    });
    expect(misuse.status).toBe(403);
    expect(codeOf(misuse)).toBe("no_trigger");
  });

  it("a path never leaves the bot's own workspace: Ops cannot read Scout's file by any path", async () => {
    const opsTurn = await l.s.turnOf(l.s.sam, ops.dm, ops.id);
    for (const path of ["tenant/a.txt", `../${l.s.scoutId}/tenant/a.txt`, "/workspace/../tenant/a.txt"]) {
      const r = await cellAs("/sandbox/read", { eventId: opsTurn.eventId, agentId: ops.id, path });
      expect(r.status, path).not.toBe(200);
      expect(JSON.stringify(r.body)).not.toContain("organization A");
    }
  });

  it("Ops' page in a conversation is not Scout's: Scout's turn there has no page (no_context)", async () => {
    // #ops has Scout; Sam's DM with Ops has only Ops. A page of Ops is never a page of Scout's turn.
    const opsTurn = await l.s.turnOf(l.s.sam, ops.dm, ops.id);
    await ok(
      cellAs("/browser/open", {
        eventId: opsTurn.eventId,
        agentId: ops.id,
        url: "https://status.fake.test/",
      }),
    );
    const scoutTurn = await l.turnIn(l.s.sam);
    const closed = await cellAs("/browser/close", { eventId: scoutTurn.eventId, agentId: l.s.scoutId });
    expect([200, 404]).toContain(closed.status);
    const snap = await cellAs("/browser/snapshot", { eventId: scoutTurn.eventId, agentId: l.s.scoutId });
    expect(snap.status).toBe(404);
    expect(codeOf(snap)).toBe("no_context");
    await ok(cellAs("/browser/close", { eventId: opsTurn.eventId, agentId: ops.id }));
  });

  it("Sam's session sealed for Scout never loads for Ops (the AAD binds the bot): Ops opens the site signed out", async () => {
    await seal(l.s.scoutId, "orders.fake.test");
    const opsTurn = await l.s.turnOf(l.s.sam, ops.dm, ops.id);
    const opened = await ok(
      cellAs("/browser/open", {
        eventId: opsTurn.eventId,
        agentId: ops.id,
        url: "https://orders.fake.test/",
      }),
    );
    expect(opened.signedIn).toBe(false);
    const fake = await waitFor(() =>
      l.s.sandboxd.stats().browser.contexts.find((c) => c.contextId === opened.contextId),
    );
    expect(fake).toMatchObject({ loadedState: false });
    expect(
      (await l.s.su.query("select member_data from app.agent_turns where event_id = $1", [opsTurn.eventId]))
        .rows[0].member_data,
    ).toBe(false);
    await ok(cellAs("/browser/close", { eventId: opsTurn.eventId, agentId: ops.id }));
  });
});
