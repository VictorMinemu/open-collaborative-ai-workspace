import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestClient } from "../../testing";
import { WEB_ORIGIN } from "../../testing";
import { codeOf, type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";

/**
 * 07.8-11 Tasks 1–2 (SBX-05, SBX-01; D-01, D-04, F-9; P-04, P-17): people who may configure a bot reach its sandbox
 * files through the API. The resolver decides `sandbox.files` on the bot (it needs `bot.configure` on that bot and the
 * Sandbox module not denied); everyone else gets the same 404 as an unknown bot. Downloads come from the API as an
 * attachment, never a sandbox URL; nothing is audited beyond ids, counts and sizes.
 *
 * Cast: Sam owns the personal bot "Sam's assistant" (the plan's Ana); Alex is a member who configures nothing (the
 * plan's Sam); Víctor is the admin and configures the team bot Scout; Eve is organization B's admin.
 */

let s: SandboxStack;
let mine: string;

const Q3 = "month,revenue\njul,1200\naug,1450\n";
const Q3_SIZE = Buffer.byteLength(Q3);

const MODULE_PUT = "/api/v1/module-access";

/** A file written straight into the fake sandboxd (the bot's workspace), as the bot would have. */
async function seed(agentId: string, path: string, content: string, orgId = s.orgA) {
  const res = await fetch(`${s.sandboxd.url}/v1/files/write`, {
    method: "POST",
    headers: { authorization: `Bearer ${s.sandboxd.token}`, "content-type": "application/json" },
    body: JSON.stringify({ target: { orgId, agentId }, path, content, encoding: "utf8", mode: "overwrite" }),
  });
  expect(res.status).toBe(200);
}

type RawRes = { status: number; headers: Headers; bytes: Buffer; json: Json | null };

/** A request whose answer may be bytes (downloads) or whose body is raw bytes (uploads). */
async function raw(
  who: TestClient,
  method: string,
  path: string,
  body?: Buffer,
  headers: Record<string, string> = {},
): Promise<RawRes> {
  const res = await fetch(`${s.stack.baseUrl}${path}`, {
    method,
    headers: {
      origin: WEB_ORIGIN,
      cookie: who.cookieHeader,
      ...(body ? { "content-type": "application/octet-stream" } : {}),
      ...headers,
    },
    ...(body ? { body } : {}),
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  let json: Json | null = null;
  if ((res.headers.get("content-type") ?? "").includes("application/json") && bytes.length > 0) {
    json = JSON.parse(bytes.toString("utf8")) as Json;
  }
  return { status: res.status, headers: res.headers, bytes, json };
}

const files = (who: TestClient, agentId: string, path: string) =>
  who.request(
    "GET",
    `/api/v1/agents/${agentId}/sandbox/files?path=${encodeURIComponent(path)}`,
  ) as Promise<Res>;
const download = (who: TestClient, agentId: string, path: string) =>
  raw(who, "GET", `/api/v1/agents/${agentId}/sandbox/files/download?path=${encodeURIComponent(path)}`);

const audits = async (action: string, orgId = s.orgA) =>
  (
    await s.su.query(
      "select actor_kind, actor_id, user_id, agent_id, resource_type, resource_id, metadata from app.audit_events where organization_id = $1 and action = $2 order by occurred_at",
      [orgId, action],
    )
  ).rows as Json[];

const setModule = (subject: Json, enabled: boolean) =>
  ok(
    s.victor.request("PUT", MODULE_PUT, {
      module: "sandbox",
      scopeUnitId: null,
      subject,
      enabled,
    }) as Promise<Res>,
  );

beforeAll(async () => {
  s = await startSandboxStack();
  mine = (await ok(s.sam.request("POST", "/api/v1/agents/personal", {}) as Promise<Res>)).agent.id as string;
  await seed(mine, "reports/q3.csv", Q3);
}, 240_000);

afterAll(async () => {
  await s?.stop();
});

describe("a configurer downloads a file from the bot's sandbox through the API (tracer)", () => {
  it("lists the folder with sizes", async () => {
    const list = await ok(files(s.sam, mine, "reports"));
    expect(list).toEqual({
      path: "reports",
      entries: [
        expect.objectContaining({
          path: "reports/q3.csv",
          name: "q3.csv",
          kind: "file",
          size: Q3_SIZE,
          hidden: false,
        }),
      ],
      more: 0,
    });
  });

  it("downloads the exact bytes as an attachment, never active content; audited with the bot and the size", async () => {
    const before = (await audits("sandbox.file_downloaded")).length;
    const r = await download(s.sam, mine, "reports/q3.csv");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toMatch(/^attachment; filename="q3\.csv"/);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.bytes.toString("utf8")).toBe(Q3);
    const rows = await audits("sandbox.file_downloaded");
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({
      actor_kind: "user",
      user_id: s.samId,
      agent_id: mine,
      resource_type: "agent",
      resource_id: mine,
      metadata: { size: Q3_SIZE },
    });
    // Ids and sizes only: never the path or the file's name.
    expect(JSON.stringify(rows.at(-1)?.metadata)).not.toContain("q3");
  });

  it("an empty workspace lists as an empty root, not an error", async () => {
    const fresh = await s.newBot("Empty Bot");
    expect(await ok(files(s.victor, fresh.id, ""))).toEqual({ path: "", entries: [], more: 0 });
  });
});

describe("nobody else can tell the files exist (T-07.8-11-01)", () => {
  const unknown = "00000000-0000-4000-8000-000000000000";

  it("a member who does not configure the bot gets the same 404 as an unknown bot, on list and download", async () => {
    const ghost = await files(s.alex, unknown, "reports");
    expect(ghost.status).toBe(404);
    for (const r of [await files(s.alex, mine, "reports"), await files(s.alex, s.scoutId, "")]) {
      expect(r.status).toBe(404);
      expect(r.body).toEqual(ghost.body);
    }
    const d = await download(s.alex, mine, "reports/q3.csv");
    expect(d.status).toBe(404);
    expect(d.json).toEqual(ghost.body);
  });

  it("an admin configures the team bot and gets its files, but not a member's personal bot", async () => {
    await seed(s.scoutId, "notes.txt", "team notes\n");
    const r = await download(s.victor, s.scoutId, "notes.txt");
    expect(r.status).toBe(200);
    expect(r.bytes.toString("utf8")).toBe("team notes\n");
    expect((await files(s.victor, mine, "reports")).status).toBe(404);
  });

  it("the owner with the Sandbox module off for them gets 404", async () => {
    await setModule({ kind: "user", userId: s.samId }, false);
    try {
      expect((await files(s.sam, mine, "reports")).status).toBe(404);
      expect((await download(s.sam, mine, "reports/q3.csv")).status).toBe(404);
    } finally {
      await setModule({ kind: "user", userId: s.samId }, true);
    }
    expect((await files(s.sam, mine, "reports")).status).toBe(200);
  });

  it("organization B's admin with organization A's bot id gets 404 (the id resolves inside the tenant)", async () => {
    expect((await files(s.eve, s.scoutId, "")).status).toBe(404);
    expect((await download(s.eve, s.scoutId, "notes.txt")).status).toBe(404);
  });
});

describe("bad paths and a missing service", () => {
  it("a path outside the workspace → 422 invalid_path", async () => {
    for (const path of ["../etc", "/etc/passwd", "a/../../b", "reports\\q3.csv"]) {
      const r = await files(s.sam, mine, path);
      expect(r.status, path).toBe(422);
      expect(codeOf(r)).toBe("invalid_path");
    }
    const d = await download(s.sam, mine, "../etc/passwd");
    expect(d.status).toBe(422);
    expect(d.json?.error?.code).toBe("invalid_path");
  });

  it("a missing file → 404 not_found from the sandbox", async () => {
    const d = await download(s.sam, mine, "reports/nope.csv");
    expect(d.status).toBe(404);
    expect(d.json?.error?.code).toBe("not_found");
  });

  it("sandboxd down → 503 service_unavailable; nothing of sandboxd's answer is echoed", async () => {
    s.sandboxd.fake.setDown(true);
    try {
      const r = await files(s.sam, mine, "reports");
      expect(r.status).toBe(503);
      expect(codeOf(r)).toBe("service_unavailable");
      expect(JSON.stringify(r.body)).not.toContain("docker");
      expect((await download(s.sam, mine, "reports/q3.csv")).status).toBe(503);
    } finally {
      s.sandboxd.fake.setDown(false);
    }
  });
});
