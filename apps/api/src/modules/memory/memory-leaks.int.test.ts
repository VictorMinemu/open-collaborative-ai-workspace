import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SNIPPET_MARK_END, SNIPPET_MARK_START, WS_AUTH_PROTOCOL_PREFIX, WS_PROTOCOL } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack, WEB_ORIGIN } from "../../testing";

/**
 * 07.2-15 Task 1 (MEM-07, MEM-01, SC5, D-08, T-07.2-15-01/02): one canary per memory write path travels through the
 * real stack, and every surface the platform has is swept for it. Each write carries a content canary
 * `MEMCANARY-<id>` and a path canary `canary-<id>/…`.
 *
 * Who may read what decides where a canary may appear:
 * - private canaries (Sam's REST write, its edit, restore and rename, the bot's `ocw_memory_write` append in Sam's DM,
 *   the legacy `ocw_memory_save`): Sam only (and his own bot, which reads them in its turns);
 * - Ventas canaries (Lena's REST write, the three proposals pending, approved and denied): Ventas' readers, so Sam,
 *   Lena and Víctor (an admin reads unit memory, ADR-0023 decision 2), never Olga (outside Ventas) or Eve (org B).
 *
 * Swept: memory search and global search as each person who may not read a canary; every realtime frame Víctor's,
 * Olga's and Eve's sockets receive during the run (user and org topics; memory events are ids-only, so none may carry
 * any canary); every stored stream event (allowed only on Sam's DM topic, where the proposal card shows its excerpt,
 * and on the cell topic for the turns of Sam's own bot in that DM); every API log line at debug level; every audit row;
 * every notification row. And `withPersonalOwner` (the personal-owner lens) is called only from reviewed files.
 */

const CELL_TOKEN = "ocw-test-cell-token-memory-leaks-0123456789abcdef";

let stack: TestStack;
let su: pg.Client;
let admin: TestClient;
let sam: TestClient;
let lena: TestClient;
let olga: TestClient;
let eve: TestClient;
let orgId: string;
let orgB: string;
let adminId: string;
let samId: string;
let lenaId: string;
let olgaId: string;
let eveId: string;
let ventas: string;
let scoutId: string;
let dmId: string;
let privateScope: string;
let ventasScope: string;
const logLines: string[] = [];

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Record<string, unknown> | null };

async function ok(res: Promise<Res>, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

/** One write path's two canaries. */
interface Canary {
  name: string;
  content: string;
  path: string;
  audience: "private" | "ventas";
}
const canaries: Canary[] = [];
function canary(name: string, audience: Canary["audience"], file = "plan.md"): Canary {
  const id = randomUUID().replaceAll("-", "").slice(0, 16);
  const c = { name, content: `MEMCANARY-${id}`, path: `canary-${id}/${file}`, audience };
  canaries.push(c);
  return c;
}
const words = (c: Canary) => [c.content, c.path, c.path.split("/")[0] as string];
const privateCanaries = () => canaries.filter((c) => c.audience === "private");
const allWords = () => canaries.flatMap(words);
/** The canary words found in a text, named (search snippets carry highlight markers inside words: dropped first). */
const found = (raw: string, list = canaries) => {
  const text = raw.replaceAll(SNIPPET_MARK_START, "").replaceAll(SNIPPET_MARK_END, "");
  return list.flatMap((c) =>
    words(c)
      .filter((w) => text.includes(w))
      .map((w) => `${c.name}: ${w}`),
  );
};

// ---------------------------------------------------------------- people, sockets, turns

async function joinAs(email: string, name: string, role: "standard" | "lead") {
  const inv = await ok(admin.request("POST", "/api/v1/invitations", { email, role }));
  const c = new TestClient(stack.baseUrl);
  const acc = await ok(
    c.request("POST", `/api/v1/invitations/${inv.id}/accept`, { name, password: "another-long-password" }),
  );
  return [c, acc.user.id as string] as const;
}

/** A socket recording every frame as raw text, subscribed to `topics` (each answered `subscribed`). */
async function socketOf(client: TestClient, topics: string[]) {
  const ws = new WebSocket(
    `${stack.baseUrl.replace("http", "ws")}/ws`,
    [WS_PROTOCOL, `${WS_AUTH_PROTOCOL_PREFIX}${await client.token()}`],
    { headers: { origin: WEB_ORIGIN } },
  );
  const frames: string[] = [];
  ws.on("message", (m) => frames.push(String(m)));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  for (const topic of topics) {
    ws.send(JSON.stringify({ op: "sub", topic }));
    const until = Date.now() + 5000;
    while (!frames.some((f) => f.includes('"subscribed"') && f.includes(`"${topic}"`))) {
      if (Date.now() > until) throw new Error(`no subscribed frame for ${topic}: ${frames.join("\n")}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  return { ws, frames };
}
let sockets: Array<{ who: string; ws: WebSocket; frames: string[] }> = [];

async function cell(path: string, body: unknown): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${stack.baseUrl}/agent-channel/v1${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${CELL_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

/** Sam writes in his DM with Scout; returns the delivered turn's event id. */
async function turn(text: string): Promise<string> {
  const msg = await ok(
    sam.request("POST", `/api/v1/conversations/${dmId}/messages`, { body: text, mentions: [] }),
  );
  const rows = (
    await su.query(
      `select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1'
        and payload->'message'->>'id' = $2`,
      [`cell:${orgId}`, msg.id],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  return rows[0].payload.eventId as string;
}

const propose = async (eventId: string, c: Canary) =>
  cell("/memory/propose", {
    eventId,
    agentId: scoutId,
    scope: ventasScope,
    path: c.path,
    op: "create",
    content: `# Plan\n- ${c.content}\n`,
  });

async function decide(id: string, outcome: "approved" | "denied") {
  const detail = await ok(lena.request("GET", `/api/v1/approvals/${id}`));
  return ok(
    lena.request("POST", `/api/v1/approvals/${id}/decision`, { outcome, actionHash: detail.actionHash }),
  );
}

// ---------------------------------------------------------------- setup and the writes

beforeAll(async () => {
  stack = await startTestStack({
    env: {
      OCW_CELL_TOKEN: CELL_TOKEN,
      OCW_MODEL_PROVIDER: "mock",
      LOG_LEVEL: "debug",
      OCW_SEARCH_RATE_LIMIT_PER_MINUTE: "1000",
    },
    logStream: { write: (line: string) => void logLines.push(line) },
  });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  admin = new TestClient(stack.baseUrl);
  const setup = await ok(
    admin.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  orgId = setup.organization.id;
  adminId = setup.user.id;
  [sam, samId] = await joinAs("sam@example.test", "Sam Lee", "standard");
  [lena, lenaId] = await joinAs("lena@example.test", "Lena Gil", "lead");
  [olga, olgaId] = await joinAs("olga@example.test", "Olga Ruiz", "standard");
  [eve, eveId] = await joinAs("eve@example.test", "Eve", "standard");
  const comercial = (
    await ok(
      admin.request("POST", "/api/v1/units", { kind: "department", name: "Comercial", parentId: null }),
    )
  ).id;
  ventas = (
    await ok(admin.request("POST", "/api/v1/units", { kind: "team", name: "Ventas", parentId: comercial }))
  ).id;
  await ok(admin.request("POST", `/api/v1/units/${ventas}/members`, { userId: lenaId, role: "lead" }));
  await ok(admin.request("POST", `/api/v1/units/${ventas}/members`, { userId: samId }));

  // Eve moves to her own organization (org B) as its admin.
  orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
    orgB,
    `evil-${orgB}`,
  ]);
  await su.query("delete from auth.member where user_id = $1", [eveId]);
  await su.query("delete from app.org_members where user_id = $1", [eveId]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    orgB,
    eveId,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
    [orgB, eveId],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, eveId]);

  const bot = await ok(sam.request("POST", "/api/v1/agents/personal", {}));
  scoutId = bot.agent.id;
  dmId = bot.dmId;
  await ok(sam.request("PATCH", `/api/v1/agents/${scoutId}/capabilities`, { dailyLimit: 100 }));
  privateScope = (
    await ok(sam.request("POST", "/api/v1/memory/scopes", { kind: "personal", agentId: scoutId }))
  ).id;
  for (const s of (await ok(admin.request("GET", "/api/v1/memory/scopes"))).scopes as Json[]) {
    if (s.kind === "unit" && s.unitId === ventas) ventasScope = s.id;
  }
  expect(ventasScope).toBeTruthy();

  // Sockets of the people who may not read private memory, open during every write.
  sockets = [
    { who: "Víctor", ...(await socketOf(admin, [`user:${adminId}`, `org:${orgId}`])) },
    { who: "Olga", ...(await socketOf(olga, [`user:${olgaId}`, `org:${orgId}`])) },
    { who: "Eve", ...(await socketOf(eve, [`user:${eveId}`, `org:${orgB}`])) },
  ];

  // 1. Sam's REST write in his private scope, then an edit, a restore and a rename.
  const priv = canary("sam-rest", "private");
  const created = await ok(
    sam.request("POST", `/api/v1/memory/scopes/${privateScope}/files`, {
      path: priv.path,
      content: `# Plan\n- ${priv.content}\n`,
    }),
  );
  const edit = canary("sam-edit", "private");
  await ok(
    sam.request("PUT", `/api/v1/memory/files/${created.id}`, {
      content: `# Plan\n- ${edit.content}\n`,
      expectedVersion: 1,
    }),
  );
  await ok(
    sam.request("POST", `/api/v1/memory/files/${created.id}/restore`, { version: 1, expectedVersion: 2 }),
  );
  const renamed = canary("sam-rename", "private", "renamed.md");
  await ok(
    sam.request("POST", `/api/v1/memory/files/${created.id}/rename`, {
      path: renamed.path,
      expectedVersion: 3,
    }),
  );

  // 2. Lena's REST write in Ventas.
  const team = canary("lena-rest", "ventas");
  await ok(
    lena.request("POST", `/api/v1/memory/scopes/${ventasScope}/files`, {
      path: team.path,
      content: `# Plan\n- ${team.content}\n`,
    }),
  );

  // 3. Scout's ocw_memory_write append in Sam's DM, and 4. a legacy ocw_memory_save.
  const write = canary("bot-write", "private");
  const ev1 = await turn("keep a plan for me");
  expect(
    (
      await cell("/memory/write", {
        eventId: ev1,
        agentId: scoutId,
        scope: "personal",
        path: write.path,
        mode: "append",
        content: `- ${write.content}`,
      })
    ).body,
  ).toMatchObject({ version: 1 });
  const legacy = canary("legacy-save", "private");
  const ev2 = await turn("remember this too");
  const saved = await cell("/memories", { eventId: ev2, agentId: scoutId, text: legacy.content });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);

  // 5. Three proposals into Ventas from Sam's DM: one left pending, one approved and one denied by Lena.
  const pending = canary("proposal-pending", "ventas");
  const approved = canary("proposal-approved", "ventas");
  const denied = canary("proposal-denied", "ventas");
  const ev3 = await turn("save these for the team");
  const ids: string[] = [];
  for (const c of [pending, approved, denied]) {
    const r = await propose(ev3, c);
    expect(r.body, c.name).toMatchObject({ approvalId: expect.any(String) });
    ids.push(r.body.approvalId as string);
  }
  expect((await decide(ids[1] as string, "approved")).status).toBe("applied");
  expect((await decide(ids[2] as string, "denied")).status).toBe("denied");

  // Let every after-commit fan-out and log line land before the sweep.
  await new Promise((r) => setTimeout(r, 500));
}, 300_000);

afterAll(async () => {
  for (const s of sockets) s.ws.close();
  await su?.end();
  await stack?.stop();
});

// ---------------------------------------------------------------- the sweep

describe("one canary per memory write path never reaches anyone who may not read it (MEM-07, SC5)", () => {
  it("covers every write path: nine canaries, all stored where they were written", async () => {
    expect(canaries.map((c) => c.name)).toEqual([
      "sam-rest",
      "sam-edit",
      "sam-rename",
      "lena-rest",
      "bot-write",
      "legacy-save",
      "proposal-pending",
      "proposal-approved",
      "proposal-denied",
    ]);
    const stored = (
      await su.query(
        `select f.path, f.content from app.memory_files f where f.organization_id = $1 and f.deleted_at is null
         union all select r.path, r.content from app.memory_file_revisions r where r.organization_id = $1
         union all select p.path, p.content from app.memory_proposals p where p.organization_id = $1`,
        [orgId],
      )
    ).rows
      .map((r) => `${r.path}\n${r.content}`)
      .join("\n");
    // Every content canary is stored (the rename carries only a path; the legacy note lives in MEMORY.md).
    for (const c of canaries) expect(stored, c.name).toContain(c.name === "sam-rename" ? c.path : c.content);
  });

  it("memory search: each canary is found by its readers and by nobody else", async () => {
    const hits = async (who: TestClient, q: string) =>
      JSON.stringify(await ok(who.request("GET", `/api/v1/memory/search?q=${encodeURIComponent(q)}`)));
    // Positive controls: the readers find the live files (the denied and pending proposals were never written).
    for (const c of canaries.filter((x) => ["sam-rest", "bot-write", "legacy-save"].includes(x.name))) {
      expect(await hits(sam, c.content), c.name).not.toBe('{"hits":[]}');
    }
    for (const name of ["lena-rest", "proposal-approved"]) {
      const c = canaries.find((x) => x.name === name) as Canary;
      expect(await hits(lena, c.content), name).not.toBe('{"hits":[]}');
      expect(await hits(admin, c.content), name).not.toBe('{"hits":[]}');
    }
    for (const c of canaries) {
      const forbidden: Array<[string, TestClient]> =
        c.audience === "private"
          ? [
              ["Víctor", admin],
              ["Lena", lena],
              ["Olga", olga],
              ["Eve", eve],
            ]
          : [
              ["Olga", olga],
              ["Eve", eve],
            ];
      for (const [who, client] of forbidden) {
        for (const q of [c.content, c.path.split("/")[0] as string]) {
          const text = await hits(client, q);
          expect(found(text, [c]), `${who} searching ${c.name}`).toEqual([]);
        }
      }
    }
  });

  it("global search: the DM card excerpt is found by Sam only", async () => {
    const pending = canaries.find((c) => c.name === "proposal-pending") as Canary;
    const search = async (who: TestClient, q: string) =>
      JSON.stringify(await ok(who.request("GET", `/api/v1/search?q=${encodeURIComponent(q)}`)));
    expect(found(await search(sam, pending.content), [pending]), "positive control").not.toEqual([]);
    for (const [who, client] of [
      ["Víctor", admin],
      ["Lena", lena],
      ["Olga", olga],
      ["Eve", eve],
    ] as const) {
      for (const c of canaries) {
        expect(found(await search(client, c.content), [c]), `${who} searching ${c.name}`).toEqual([]);
      }
    }
  });

  it("no realtime frame to Víctor, Olga or Eve carries any canary (memory events are ids-only)", () => {
    for (const s of sockets) {
      expect(s.frames.length, `${s.who} received frames`).toBeGreaterThan(0);
      expect(found(s.frames.join("\n")), `${s.who}'s frames`).toEqual([]);
    }
    // The live events did reach them (Víctor reads Ventas: its memory.changed and approval updates are on his stream).
    expect(sockets[0]?.frames.some((f) => f.includes("memory.changed"))).toBe(true);
  });

  it("stored stream events: canaries only on Sam's DM topic and on the cell topic for Scout's turns there", async () => {
    const rows = (
      await su.query("select stream_id, type, payload from app.stream_events order by stream_id, seq")
    ).rows as Array<{ stream_id: string; type: string; payload: Json }>;
    const carrying = rows.filter((r) => found(JSON.stringify(r.payload)).length > 0);
    expect(
      carrying.length,
      "the excerpt and the turns do carry canaries (the sweep sees them)",
    ).toBeGreaterThan(0);
    // The people who may read each audience; a user: stream is that person's own.
    const readers = { private: [samId], ventas: [samId, lenaId, adminId] };
    const misplaced = carrying.flatMap((r) =>
      canaries
        .filter((c) => found(JSON.stringify(r.payload), [c]).length > 0)
        .filter((c) => {
          if (r.stream_id.startsWith("user:")) return !readers[c.audience].includes(r.stream_id.slice(5));
          // Sam's DM: the proposal card's excerpt only (Sam asked for it and reads Ventas).
          if (r.stream_id === `conv:${dmId}`) return c.audience !== "ventas";
          // The cell topic: only the turns of Sam's own bot in that DM (the bot's read path, D-01).
          if (r.stream_id === `cell:${orgId}`) {
            const p = r.payload;
            const inDm = p.conversation?.id === dmId && p.agent?.id === scoutId;
            return !(inDm && ["agent.mention.v1", "agent.card_action.v1"].includes(r.type));
          }
          return true;
        })
        .map((c) => `${r.stream_id} ${r.type}: ${c.name}`),
    );
    expect(misplaced).toEqual([]);
    // Nothing on the organization topic, and nothing on Olga's or Eve's streams.
    expect(carrying.filter((r) => r.stream_id.startsWith("org:"))).toEqual([]);
    expect(carrying.filter((r) => [`user:${olgaId}`, `user:${eveId}`].includes(r.stream_id))).toEqual([]);
    // Private canaries never reach the DM topic either: only the proposal excerpts do.
    const dm = carrying.filter((r) => r.stream_id === `conv:${dmId}`).map((r) => JSON.stringify(r.payload));
    expect(found(dm.join("\n"), privateCanaries())).toEqual([]);
  });

  it("no API log line, at debug level, carries any canary", () => {
    expect(logLines.length).toBeGreaterThan(100);
    expect(stack.built.app.log.level).toBe("debug");
    const leaking = logLines.filter((l) => found(l).length > 0);
    expect(leaking.map((l) => `${found(l).join(", ")} in ${l.slice(0, 300)}`)).toEqual([]);
  });

  it("no audit row carries any canary (ids, versions and byte counts only)", async () => {
    const rows = (
      await su.query("select row_to_json(a)::text as row from app.audit_events a order by occurred_at")
    ).rows.map((r) => r.row as string);
    expect(rows.some((r) => r.includes("memory.file_"))).toBe(true);
    expect(rows.some((r) => r.includes("approval.decided"))).toBe(true);
    expect(rows.filter((r) => found(r).length > 0).map((r) => found(r).join(", "))).toEqual([]);
  });

  it("no notification row carries any canary", async () => {
    const rows = (await su.query("select row_to_json(n)::text as row from app.notifications n")).rows.map(
      (r) => r.row as string,
    );
    expect(rows.filter((r) => found(r).length > 0)).toEqual([]);
  });

  it("the sweep's own words are real: every canary word is distinct and unguessable", () => {
    const all = allWords();
    expect(new Set(all).size).toBe(all.length);
    for (const w of all) expect(w.length).toBeGreaterThan(16);
  });
});

// ---------------------------------------------------------------- the personal-owner lens is pinned

/**
 * The only files that may reference `withPersonalOwner` (ADR-0023 decision 3, T-07.2-15-02). Each switches the
 * transaction's `app.user_id` to the human an agent or an approved apply acts for, and nothing else. Adding a call
 * elsewhere is a reviewed change to this list.
 */
const PERSONAL_OWNER_CALL_SITES = [
  "apps/api/src/modules/agent-channel/memory-files.ts",
  "apps/api/src/modules/memory/access.ts",
  "apps/api/src/modules/memory/index.ts",
  "apps/api/src/modules/memory/proposals.ts",
  "apps/api/src/modules/memory/scopes.ts",
  "apps/api/src/modules/memory/search.ts",
];
/** Files that name it without calling it (the re-export that keeps one definition). */
const PERSONAL_OWNER_RE_EXPORTS = ["apps/api/src/modules/memory/files.ts"];

const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".next" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe("withPersonalOwner is called only from the reviewed call sites (T-07.2-15-02)", () => {
  const files = ["apps", "packages"].flatMap((root) => sources(join(REPO, root)));
  const rel = (f: string) => relative(REPO, f).split("\\").join("/");

  it("calls appear exactly in the pinned files", () => {
    expect(files.length).toBeGreaterThan(500);
    const calling = files
      .filter((f) => /\bwithPersonalOwner\s*\(/.test(readFileSync(f, "utf8")))
      .map(rel)
      .sort();
    expect(calling).toEqual(PERSONAL_OWNER_CALL_SITES);
  });

  it("no other file names it (no alias, no import elsewhere)", () => {
    const naming = files
      .filter((f) => readFileSync(f, "utf8").includes("withPersonalOwner"))
      .map(rel)
      .sort();
    expect(naming).toEqual([...PERSONAL_OWNER_CALL_SITES, ...PERSONAL_OWNER_RE_EXPORTS].sort());
  });
});
