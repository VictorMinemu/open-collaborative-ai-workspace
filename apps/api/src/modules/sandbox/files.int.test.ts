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

// ---------------------------------------------------------------- Task 2: upload, delete, preview, status, stop, restart

const enc = encodeURIComponent;
const MiB = 1024 * 1024;
const upload = (who: TestClient, agentId: string, folder: string, name: string, body: Buffer, extra = "") =>
  raw(
    who,
    "POST",
    `/api/v1/agents/${agentId}/sandbox/files/upload?path=${enc(folder)}&name=${enc(name)}${extra}`,
    body,
  );
const preview = (who: TestClient, agentId: string, path: string) =>
  who.request("GET", `/api/v1/agents/${agentId}/sandbox/files/content?path=${enc(path)}`) as Promise<Res>;
const remove = (who: TestClient, agentId: string, path: string, recursive = false) =>
  who.request(
    "DELETE",
    `/api/v1/agents/${agentId}/sandbox/files?path=${enc(path)}${recursive ? "&recursive=1" : ""}`,
  ) as Promise<Res>;
const status = (who: TestClient, agentId: string) =>
  who.request("GET", `/api/v1/agents/${agentId}/sandbox`) as Promise<Res>;
const lifecycle = (who: TestClient, agentId: string, op: "stop" | "restart") =>
  who.request("POST", `/api/v1/agents/${agentId}/sandbox/${op}`) as Promise<Res>;
const fakeCalls = (op: string) => s.sandboxd.stats().calls[op] ?? 0;

describe("upload and delete for configurers (D-01, F-9)", () => {
  it("uploads 1 MB into a folder; audited with count and total size, never the name", async () => {
    const body = Buffer.alloc(MiB, "x");
    const r = await upload(s.sam, mine, "reports", "new.csv", body);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toEqual({ path: "reports/new.csv", size: MiB });
    const list = await ok(files(s.sam, mine, "reports"));
    expect(list.entries.map((e: Json) => e.name)).toEqual(["new.csv", "q3.csv"]);
    const row = (await audits("sandbox.files_uploaded")).at(-1);
    expect(row).toMatchObject({ user_id: s.samId, agent_id: mine, metadata: { count: 1, totalBytes: MiB } });
    expect(JSON.stringify(row?.metadata)).not.toContain("new");
  });

  it("the same name again → 409 upload_exists unless replace=1", async () => {
    const body = Buffer.from("replaced\n");
    const again = await upload(s.sam, mine, "reports", "new.csv", body);
    expect(again.status).toBe(409);
    expect(again.json?.error?.code).toBe("upload_exists");
    const replaced = await upload(s.sam, mine, "reports", "new.csv", body, "&replace=1");
    expect(replaced.status).toBe(200);
    expect(replaced.json).toEqual({ path: "reports/new.csv", size: body.length });
  });

  it("51 MB → 413 too_large before sandboxd is called, with or without a declared length", async () => {
    const before = fakeCalls("filesUpload");
    const big = Buffer.alloc(51 * MiB, "y");
    const r = await upload(s.sam, mine, "", "big.bin", big);
    expect(r.status).toBe(413);
    expect(r.json?.error?.code).toBe("too_large");
    // Chunked: no Content-Length, the body grows past the route's limit.
    const chunk = Buffer.alloc(MiB, "z");
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 51) return controller.close();
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const res = await fetch(
      `${s.stack.baseUrl}/api/v1/agents/${mine}/sandbox/files/upload?path=&name=big.bin`,
      {
        method: "POST",
        headers: {
          origin: WEB_ORIGIN,
          cookie: s.sam.cookieHeader,
          "content-type": "application/octet-stream",
        },
        body: stream,
        duplex: "half",
      } as RequestInit,
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as Json).error.code).toBe("too_large");
    expect(fakeCalls("filesUpload")).toBe(before);
  });

  it("the bot's quota has no room → 409 disk_full before writing", async () => {
    await s.setPolicy({});
    await s.su.query("update app.sandbox_policies set disk_per_bot_mb = 64 where organization_id = $1", [
      s.orgA,
    ]);
    await s.su.query(
      `insert into app.bot_sandboxes (organization_id, agent_id, kind, state, disk_bytes)
       values ($1, $2, 'sbx', 'stopped', $3)
       on conflict (organization_id, agent_id, kind) do update set disk_bytes = excluded.disk_bytes`,
      [s.orgA, mine, 63.5 * MiB],
    );
    const before = fakeCalls("filesUpload");
    try {
      const r = await upload(s.sam, mine, "reports", "more.csv", Buffer.alloc(MiB, "q"));
      expect(r.status).toBe(409);
      expect(r.json?.error?.code).toBe("disk_full");
      expect(fakeCalls("filesUpload")).toBe(before);
      // A small one still fits.
      expect((await upload(s.sam, mine, "reports", "tiny.csv", Buffer.from("a\n"))).status).toBe(200);
    } finally {
      await s.su.query("update app.sandbox_policies set disk_per_bot_mb = 2048 where organization_id = $1", [
        s.orgA,
      ]);
      await s.su.query("update app.bot_sandboxes set disk_bytes = 0 where agent_id = $1", [mine]);
    }
  });

  it("a name with / or starting with .., or a folder outside the workspace → 422 invalid_path", async () => {
    for (const [folder, name] of [
      ["reports", "a/b.csv"],
      ["reports", "..secret"],
      ["reports", ".."],
      ["../etc", "x.csv"],
      ["", ""],
    ] as const) {
      const r = await upload(s.sam, mine, folder, name, Buffer.from("x"));
      expect(r.status, `${folder}/${name}`).toBe(422);
      expect(r.json?.error?.code).toBe("invalid_path");
    }
  });

  it("deletes a file, then a folder with recursive=1; audited with the count; never the root", async () => {
    await seed(mine, "old/a.txt", "a");
    await seed(mine, "old/deep/b.txt", "b");
    expect(await ok(remove(s.sam, mine, "reports/tiny.csv"))).toEqual({
      path: "reports/tiny.csv",
      deleted: 1,
    });
    expect((await audits("sandbox.file_deleted")).at(-1)).toMatchObject({
      agent_id: mine,
      metadata: { count: 1 },
    });
    const notEmpty = await remove(s.sam, mine, "old");
    expect(notEmpty.status).toBe(409);
    expect(codeOf(notEmpty)).toBe("busy");
    const folder = await ok(remove(s.sam, mine, "old", true));
    expect(folder.deleted).toBe(4);
    expect((await audits("sandbox.file_deleted")).at(-1)?.metadata).toEqual({ count: 4 });
    const root = await remove(s.sam, mine, "");
    expect(root.status).toBe(422);
    expect(codeOf(root)).toBe("invalid_path");
  });

  it("a non-configurer cannot upload, preview or delete (404) and sandboxd is never asked", async () => {
    const before = s.sandboxd.stats().calls;
    expect((await upload(s.alex, mine, "reports", "x.csv", Buffer.from("x"))).status).toBe(404);
    expect((await preview(s.alex, mine, "reports/q3.csv")).status).toBe(404);
    expect((await remove(s.alex, mine, "reports/q3.csv")).status).toBe(404);
    expect((await upload(s.eve, mine, "reports", "x.csv", Buffer.from("x"))).status).toBe(404);
    expect(s.sandboxd.stats().calls).toEqual(before);
  });
});

describe("preview: text as JSON text, raster images by magic bytes, nothing rendered (T-07.8-11-02)", () => {
  it("UTF-8 text up to 256 KB → text", async () => {
    const p = await ok(preview(s.sam, mine, "reports/q3.csv"));
    expect(p).toEqual({ kind: "text", text: Q3, size: Q3_SIZE, modifiedAt: expect.any(String) });
  });

  it("300 KB of text → too_large", async () => {
    await seed(mine, "big.txt", "a".repeat(300 * 1024));
    expect(await ok(preview(s.sam, mine, "big.txt"))).toMatchObject({ kind: "too_large", size: 300 * 1024 });
  });

  it("a GIF and a WebP → image with the sniffed type (bytes come from the download route)", async () => {
    // ASCII-safe magic bytes: the in-memory sandboxd keeps files as UTF-8 text (PNG and JPEG: files.test.ts).
    await seed(mine, "chart.gif", "GIF89a\u0001\u0002rest-of-image");
    await seed(mine, "chart.webp", "RIFF\u0010\u0010\u0010\u0010WEBPVP8 data");
    expect(await ok(preview(s.sam, mine, "chart.gif"))).toMatchObject({
      kind: "image",
      mimeType: "image/gif",
    });
    expect(await ok(preview(s.sam, mine, "chart.webp"))).toMatchObject({
      kind: "image",
      mimeType: "image/webp",
    });
  });

  it("SVG, HTML (by name or by markup) and binary → binary; their markup never reaches the response", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    await seed(mine, "pic.svg", svg);
    await seed(mine, "page.html", "<p>hi</p><script>alert(2)</script>");
    await seed(mine, "page.txt", "<!DOCTYPE html><html><script>alert(3)</script></html>");
    await seed(mine, "blob.bin", "abc\u0000def");
    for (const path of ["pic.svg", "page.html", "page.txt", "blob.bin"]) {
      const r = await preview(s.sam, mine, path);
      expect(r.status, path).toBe(200);
      expect(r.body, path).toMatchObject({ kind: "binary" });
      expect(JSON.stringify(r.body)).not.toContain("script");
    }
  });

  it("a folder or a path outside the workspace → 422 invalid_path; a missing file → 404", async () => {
    expect(codeOf(await preview(s.sam, mine, "reports"))).toBe("invalid_path");
    expect(codeOf(await preview(s.sam, mine, "../x"))).toBe("invalid_path");
    expect(codeOf(await preview(s.sam, mine, "nope.txt"))).toBe("not_found");
  });
});

describe("status, stop and restart (R4, UI-SPEC §3.1, §3.5)", () => {
  let bot: { id: string; dm: string };

  beforeAll(async () => {
    await s.setPolicy({ enabled: true });
    bot = await s.newBot("Status Bot");
  });

  it("a bot with no sandbox yet: absent, the quota, the organization's CPU and cap, the fixed limits", async () => {
    const v = await ok(status(s.victor, bot.id));
    expect(v).toEqual({
      agentId: bot.id,
      state: "absent",
      runtime: null,
      lastActiveAt: null,
      diskBytes: 0,
      diskQuotaBytes: 2048 * MiB,
      cpuMsToday: 0,
      org: { cpuMinutesToday: expect.any(Number), cpuMinutesPerDay: 600 },
      limits: { cpus: 1, memoryBytes: 1024 * MiB, pids: 256, idleStopMinutes: 15 },
      packages: 0,
      teamBot: true,
      stopReason: null,
      viewerCan: { files: true, control: true },
    });
    expect((await ok(status(s.sam, mine))).teamBot).toBe(false);
  });

  it("running after an exec, with today's CPU of the bot and of the organization", async () => {
    const ev = await s.turnOf(s.sam, bot.dm, bot.id);
    expect(
      (await s.cell("/sandbox/exec", { eventId: ev.eventId, agentId: bot.id, argv: ["true"] })).status,
    ).toBe(200);
    const today = new Date().toISOString().slice(0, 10);
    await s.su.query(
      `insert into app.sandbox_usage_daily (organization_id, agent_id, day, cpu_ms) values ($1, $2, $3, 120000)
       on conflict (organization_id, agent_id, day) do update set cpu_ms = 120000`,
      [s.orgA, bot.id, today],
    );
    const v = await ok(status(s.victor, bot.id));
    expect(v).toMatchObject({ state: "running", runtime: "gvisor", cpuMsToday: 120000, stopReason: null });
    expect(v.lastActiveAt).toEqual(expect.any(String));
    expect(v.org.cpuMinutesToday).toBeGreaterThanOrEqual(2);
    await s.su.query("delete from app.sandbox_usage_daily where agent_id = $1", [bot.id]);
  });

  it("stop → stopped by the user, audited; restart → running again, audited", async () => {
    const stopped = await ok(lifecycle(s.victor, bot.id, "stop"));
    expect(stopped).toMatchObject({ state: "stopped", stopReason: "user" });
    expect(s.sandboxd.fake.stateOf({ orgId: s.orgA, agentId: bot.id })).toBe("stopped");
    expect((await audits("sandbox.stopped")).at(-1)).toMatchObject({
      user_id: s.victorId,
      agent_id: bot.id,
      metadata: { kind: "sbx", reason: "user" },
    });
    const restarted = await ok(lifecycle(s.victor, bot.id, "restart"));
    expect(restarted).toMatchObject({ state: "running", stopReason: null });
    expect(s.sandboxd.fake.stateOf({ orgId: s.orgA, agentId: bot.id })).toBe("running");
    expect((await audits("sandbox.restarted")).at(-1)).toMatchObject({
      agent_id: bot.id,
      metadata: { kind: "sbx" },
    });
  });

  it("restart while an admin stopped everything → 403 killed; sandboxd is not asked", async () => {
    await s.setPolicy({ killed: true });
    const before = fakeCalls("restart");
    try {
      const r = await lifecycle(s.victor, bot.id, "restart");
      expect(r.status).toBe(403);
      expect(codeOf(r)).toBe("killed");
      expect(fakeCalls("restart")).toBe(before);
      expect((await ok(status(s.victor, bot.id))).state).toBe("killed");
    } finally {
      await s.setPolicy({ killed: false });
    }
  });

  it("a non-configurer and organization B get 404 on status, stop and restart", async () => {
    for (const who of [s.sam, s.alex, s.eve]) {
      expect((await status(who, bot.id)).status).toBe(404);
      expect((await lifecycle(who, bot.id, "stop")).status).toBe(404);
      expect((await lifecycle(who, bot.id, "restart")).status).toBe(404);
    }
    expect(s.sandboxd.fake.stateOf({ orgId: s.orgA, agentId: bot.id })).toBe("running");
  });
});
