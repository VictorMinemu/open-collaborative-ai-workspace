// node --test infra/fake-model/fake-sandboxd.test.mjs
// The in-memory sandboxd (07.8-05): the bearer token, the tiny exec interpreter over a per-bot workspace, bot
// isolation, the organization kill, the down switch and the call counters (never bodies). The API's integration tests
// run against this fake; the real broker is proven by the sandbox smokes (P-13).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { createFakeSandboxd } from "./fake-sandboxd.mjs";

const TOKEN = "fake-sandboxd-token-0123456789abcdef0123";
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const A = { orgId: ORG, agentId: randomUUID() };
const B = { orgId: ORG, agentId: randomUUID() };
const C = { orgId: OTHER_ORG, agentId: randomUUID() };

let fake;
let server;
let base;

before(async () => {
  fake = createFakeSandboxd({ token: TOKEN });
  server = createServer((req, res) => fake.handle(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));
beforeEach(async () => {
  assert.equal((await fetch(`${base}/__control/reset`, { method: "POST" })).status, 200);
});

async function op(path, body, token = TOKEN, method = "POST") {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const ensure = (target) => op("/v1/sandboxes/ensure", { target });
const exec = (target, argv, extra = {}) =>
  op("/v1/sandboxes/exec", { target, argv, cwd: "", timeoutMs: 60_000, yieldMs: 25_000, ...extra });
const stats = async () => (await fetch(`${base}/__control/stats`)).json();

describe("fake sandboxd", () => {
  it("refuses every op without the bearer token (401, no body echo)", async () => {
    const none = await op("/v1/sandboxes/exec", { target: A, argv: ["echo", "secret-argv"] }, null);
    assert.equal(none.status, 401);
    assert.equal(none.body.error.code, "unauthorized");
    assert.ok(!JSON.stringify(none.body).includes("secret-argv"));
    assert.equal((await op("/v1/info", undefined, "wrong-token", "GET")).status, 401);
  });

  it("info answers the contract shape", async () => {
    const r = await op("/v1/info", undefined, TOKEN, "GET");
    assert.equal(r.status, 200);
    assert.equal(r.body.dockerOk, true);
    assert.equal(r.body.runtime, "gvisor");
    assert.equal(typeof r.body.namespace, "string");
  });

  it("ensure, then a shell writes and reads a file in bot A's workspace", async () => {
    const e = await ensure(A);
    assert.equal(e.status, 200);
    assert.equal(e.body.state, "running");
    assert.deepEqual(e.body.target, A);
    const r = await exec(A, ["sh", "-c", "echo hi > note.txt && cat note.txt"]);
    assert.equal(r.status, 200);
    assert.deepEqual(
      { status: r.body.status, exitCode: r.body.exitCode, stdout: r.body.stdout, stderr: r.body.stderr },
      { status: "exited", exitCode: 0, stdout: "hi\n", stderr: "" },
    );
    assert.equal(r.body.truncated, false);
    assert.equal(typeof r.body.durationMs, "number");
  });

  it("bot B never sees bot A's file", async () => {
    await ensure(A);
    await exec(A, ["sh", "-c", "echo hi > note.txt"]);
    await ensure(B);
    const r = await exec(B, ["cat", "note.txt"]);
    assert.equal(r.status, 200);
    assert.equal(r.body.exitCode, 1);
    assert.match(r.body.stderr, /No such file/);
  });

  it("interprets id -u, env (no OCW_ variable), ls, append, exit N and an unknown program", async () => {
    await ensure(A);
    assert.equal((await exec(A, ["id", "-u"])).body.stdout, "10001\n");
    const env = (await exec(A, ["env"])).body.stdout;
    assert.match(env, /HOME=\/workspace/);
    assert.ok(!env.includes("OCW_"));
    await exec(A, ["sh", "-c", "echo a > f.txt; echo b >> f.txt"]);
    assert.equal((await exec(A, ["cat", "f.txt"])).body.stdout, "a\nb\n");
    assert.equal((await exec(A, ["ls"])).body.stdout, "f.txt\n");
    assert.equal((await exec(A, ["sh", "-c", "exit 3"])).body.exitCode, 3);
    const missing = await exec(A, ["nope"]);
    assert.equal(missing.body.exitCode, 127);
    // `&&` stops at the first failure.
    assert.equal((await exec(A, ["sh", "-c", "cat gone.txt && echo never"])).body.stdout, "");
  });

  it("a sleep longer than the yield returns a process id that a later poll finishes", async () => {
    await ensure(A);
    const r = await exec(A, ["sleep", "1"], { yieldMs: 0 });
    assert.equal(r.body.status, "running");
    assert.match(r.body.processId, /^[A-Za-z0-9_-]{1,64}$/);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const polled = await op("/v1/sandboxes/process", {
      target: A,
      processId: r.body.processId,
      action: "poll",
    });
    assert.equal(polled.body.status, "exited");
    assert.equal(polled.body.exitCode, 0);
  });

  it("killOrg stops every sandbox of that organization only; exec then answers 409 killed until ensure", async () => {
    await ensure(A);
    await ensure(B);
    await ensure(C);
    const killed = await op("/v1/orgs/kill", { orgId: ORG });
    assert.equal(killed.status, 200);
    assert.equal(killed.body.removed, 2);
    const r = await exec(A, ["echo", "hi"]);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "killed");
    assert.equal((await exec(C, ["echo", "still"])).body.stdout, "still\n");
    await ensure(A);
    assert.equal((await exec(A, ["echo", "back"])).body.stdout, "back\n");
  });

  it("exec before any ensure answers 404 not_found", async () => {
    const r = await exec(A, ["echo", "hi"]);
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, "not_found");
  });

  it("down: every op answers 503 docker_unavailable until up", async () => {
    await fetch(`${base}/__control/down`, { method: "POST" });
    assert.equal((await ensure(A)).status, 503);
    const info = await op("/v1/info", undefined, TOKEN, "GET");
    assert.equal(info.status, 503);
    assert.equal(info.body.error.code, "docker_unavailable");
    await fetch(`${base}/__control/up`, { method: "POST" });
    assert.equal((await ensure(A)).status, 200);
  });

  it("an unknown op is 404; a body failing the shape is 400", async () => {
    assert.equal((await op("/v1/nothing", {})).status, 404);
    const bad = await op("/v1/sandboxes/exec", { target: A, argv: "echo hi" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "invalid_request");
  });

  it("stats count calls per op and per organization, never bodies", async () => {
    await ensure(A);
    await exec(A, ["echo", "OCW-SENTINEL-FAKE-1234"]);
    const s = await stats();
    assert.equal(s.calls.ensure, 1);
    assert.equal(s.calls.exec, 1);
    assert.equal(s.orgs[ORG].exec, 1);
    assert.ok(!JSON.stringify(s).includes("OCW-SENTINEL-FAKE-1234"));
  });

  it("files: write, list, read, delete over the same workspace the shell sees", async () => {
    await ensure(A);
    const w = await op("/v1/files/write", {
      target: A,
      path: "docs/a.txt",
      content: "hello",
      encoding: "utf8",
      mode: "create",
    });
    assert.deepEqual(w.body, { path: "docs/a.txt", size: 5 });
    assert.equal((await exec(A, ["cat", "docs/a.txt"])).body.stdout, "hello");
    const list = await op("/v1/files/list", { target: A, path: "" });
    assert.deepEqual(
      list.body.entries.map((e) => [e.name, e.kind]),
      [["docs", "dir"]],
    );
    const read = await op("/v1/files/read", { target: A, path: "docs/a.txt" });
    assert.equal(read.body.content, "hello");
    const del = await op("/v1/files/delete", { target: A, path: "docs", recursive: true });
    assert.equal(del.body.deleted, 2);
  });

  it("events: an emitted event is returned after its seq", async () => {
    const ev = { type: "state", target: A, kind: "sbx", state: "stopped", reason: "idle" };
    assert.equal(
      (
        await fetch(`${base}/__control/emit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(ev),
        })
      ).status,
      200,
    );
    const r = await op("/v1/events?after=0&waitMs=0", undefined, TOKEN, "GET");
    assert.equal(r.status, 200);
    assert.equal(r.body.events.length, 1);
    assert.equal(r.body.events[0].seq, 1);
    assert.equal(r.body.nextSeq, 1);
  });
});
