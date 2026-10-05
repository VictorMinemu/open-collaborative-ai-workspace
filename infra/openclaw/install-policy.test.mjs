// node --test 'infra/**/*.test.mjs'
//
// The cell's install gate (OpenClaw `security.installPolicy` exec, 03.1-12 / D-14): run exactly as OpenClaw runs
// it (a child process, the policy request on stdin, only the passEnv variables), against an in-process fake
// Agent Channel API on a random port. The decision may come only from the API's authenticated answer.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const POLICY = path.join(path.dirname(fileURLToPath(import.meta.url)), "install-policy.mjs");
const TOKEN = "policy-test-cell-token-0123456789";
const NAME = "@ocw-test/echo-plugin";
const VERSION = "0.1.0";

/** Minimal ustar writer: enough for an npm-pack-shaped tarball (`package/…` entries). */
function tgz(files) {
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write(`${(0).toString(8).padStart(11, "0")}\0`, 136, 12, "ascii");
    header.write("        ", 148, 8, "ascii");
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

let dir;
let archive;
let digest;
let tokenFile;
let server;
let apiUrl;
/** What the fake API answers next: `{ status, body, delayMs }`. */
let answer;
let calls;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "ocw-install-policy-"));
  const bytes = tgz({
    "package/package.json": JSON.stringify({ name: NAME, version: VERSION }),
    "package/openclaw.plugin.json": JSON.stringify({ id: "ocw-echo" }),
    "package/index.js": "export default {};\n",
  });
  archive = path.join(dir, "ocw-test-echo-plugin-0.1.0.tgz");
  writeFileSync(archive, bytes);
  digest = sha256(bytes);
  tokenFile = path.join(dir, "cell_token");
  writeFileSync(tokenFile, `${TOKEN}\n`);
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: raw });
    const a = answer;
    const send = () => {
      if (res.destroyed) return;
      res.writeHead(a.status, { "content-type": "application/json" });
      res.end(typeof a.body === "string" ? a.body : JSON.stringify(a.body));
    };
    if (a.delayMs) setTimeout(send, a.delayMs);
    else send();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  answer = { status: 200, body: { approved: true, reason: null } };
  calls = [];
});

/** The policy request OpenClaw 2026.9.7 sends for the preflight of an `npm-pack:` install. */
function request(over = {}) {
  return {
    protocolVersion: 1,
    openclawVersion: "2026.9.7",
    targetType: "plugin",
    targetName: "ocw-echo",
    sourcePath: archive,
    sourcePathKind: "file",
    source: { kind: "archive", authority: "user", mutable: true, network: false },
    origin: { type: "plugin-npm", packageName: NAME },
    request: { kind: "plugin-npm", mode: "install", requestedSpecifier: `npm-pack:${archive}` },
    plugin: { contentType: "package", pluginId: "ocw-echo", packageName: NAME },
    ...over,
  };
}

/** Runs the policy like OpenClaw does: no shell, empty base env + passEnv, request on stdin. */
function runPolicy(input, env = { OCW_API_URL: apiUrl, OCW_CELL_TOKEN_FILE: tokenFile }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [POLICY], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("close", (code) => {
      let decision = null;
      try {
        decision = JSON.parse(stdout);
      } catch {
        /* reported below */
      }
      resolve({ code, stdout, stderr, decision });
    });
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

function assertBlocked(r, reasonPart) {
  assert.equal(r.code, 0, `exit 0 with a decision (stderr: ${r.stderr})`);
  assert.equal(r.decision?.protocolVersion, 1);
  assert.equal(r.decision?.decision, "block", JSON.stringify(r.decision));
  assert.equal(typeof r.decision.reason, "string");
  assert.ok(r.decision.reason.length > 0);
  if (reasonPart) assert.match(r.decision.reason, reasonPart);
}

describe("install-policy (security.installPolicy exec)", () => {
  it("allows only when the API approves exactly this package, version and digest, asked with the cell token", async () => {
    const r = await runPolicy(request());
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.decision, { protocolVersion: 1, decision: "allow" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, "/agent-channel/v1/plugins/verify-install");
    assert.equal(calls[0].authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(calls[0].body), { packageName: NAME, version: VERSION, sha256: digest });
  });

  it("the later package and dependency-tree checks of the same install verify the same staged archive", async () => {
    const pkg = await runPolicy(
      request({
        sourcePath: path.join(dir, "managed", "node_modules", NAME),
        sourcePathKind: "directory",
        origin: { type: "plugin-package", packageName: NAME, version: VERSION },
        plugin: { contentType: "package", pluginId: "ocw-echo", packageName: NAME, version: VERSION },
      }),
    );
    assert.deepEqual(pkg.decision, { protocolVersion: 1, decision: "allow" });
    const tree = await runPolicy(
      request({
        sourcePath: path.join(dir, "managed"),
        sourcePathKind: "directory",
        origin: { type: "plugin-dependency-tree" },
        plugin: { contentType: "dependency-tree", pluginId: "ocw-echo" },
      }),
    );
    assert.deepEqual(tree.decision, { protocolVersion: 1, decision: "allow" });
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.deepEqual(JSON.parse(c.body), { packageName: NAME, version: VERSION, sha256: digest });
    }
  });

  it("blocks when the API refuses, and says why", async () => {
    answer = { status: 200, body: { approved: false, reason: "not_in_flight" } };
    assertBlocked(await runPolicy(request()), /not_in_flight/);
  });

  it("blocks on 401, 5xx and malformed answers (fail closed)", async () => {
    for (const a of [
      { status: 401, body: { error: { code: "invalid_cell_token" } } },
      { status: 500, body: { error: { code: "internal" } } },
      { status: 200, body: "not json" },
      { status: 200, body: { approved: "yes" } },
      { status: 201, body: { approved: true, reason: null } },
    ]) {
      answer = a;
      assertBlocked(await runPolicy(request()));
    }
  });

  it("blocks when the API answers slower than 5 s", async () => {
    answer = { status: 200, body: { approved: true, reason: null }, delayMs: 6_000 };
    const started = Date.now();
    const r = await runPolicy(request());
    assertBlocked(r, /unreachable|timed out|did not answer/);
    assert.ok(Date.now() - started < 5_900, "gave up before the slow answer arrived");
  });

  it("blocks when the API is unreachable (fail closed)", async () => {
    const dead = createServer();
    await new Promise((r) => dead.listen(0, "127.0.0.1", r));
    const port = dead.address().port;
    await new Promise((r) => dead.close(r));
    assertBlocked(
      await runPolicy(request(), { OCW_API_URL: `http://127.0.0.1:${port}`, OCW_CELL_TOKEN_FILE: tokenFile }),
      /unreachable/,
    );
  });

  it("blocks without an API URL or with a missing or empty token file, without asking anyone", async () => {
    const empty = path.join(dir, "empty_token");
    writeFileSync(empty, "  \n");
    for (const env of [
      { OCW_CELL_TOKEN_FILE: tokenFile },
      { OCW_API_URL: apiUrl },
      { OCW_API_URL: apiUrl, OCW_CELL_TOKEN_FILE: path.join(dir, "missing") },
      { OCW_API_URL: apiUrl, OCW_CELL_TOKEN_FILE: empty },
    ]) {
      assertBlocked(await runPolicy(request(), env));
    }
    assert.equal(calls.length, 0);
  });

  it("blocks malformed input, other targets and anything that is not a staged npm-pack archive", async () => {
    const cases = [
      "not json",
      JSON.stringify([]),
      request({ protocolVersion: 2 }),
      request({ targetType: "skill" }),
      request({
        request: { kind: "plugin-npm", mode: "install", requestedSpecifier: `npm:${NAME}@${VERSION}` },
      }),
      request({ request: { kind: "plugin-npm", mode: "install", requestedSpecifier: `clawhub:${NAME}` } }),
      request({ request: { kind: "plugin-dir", mode: "install", requestedSpecifier: dir } }),
      request({
        request: { kind: "plugin-npm", mode: "install", requestedSpecifier: "npm-pack:relative.tgz" },
      }),
      request({
        request: {
          kind: "plugin-npm",
          mode: "install",
          requestedSpecifier: `npm-pack:${path.join(dir, "missing.tgz")}`,
        },
      }),
      // The archive is not what OpenClaw says it is installing.
      request({ plugin: { contentType: "package", pluginId: "ocw-echo", packageName: "@evil/other" } }),
      request({
        plugin: { contentType: "package", pluginId: "ocw-echo", packageName: NAME, version: "9.9.9" },
      }),
    ];
    for (const input of cases) assertBlocked(await runPolicy(input));
    assert.equal(calls.length, 0, "never asked the API for a request it cannot verify");
  });

  it("blocks a staged archive that is not an npm-pack tarball", async () => {
    const junk = path.join(dir, "junk.tgz");
    writeFileSync(junk, "definitely not gzip");
    const noPkg = path.join(dir, "nopkg.tgz");
    writeFileSync(noPkg, tgz({ "package/index.js": "x" }));
    for (const file of [junk, noPkg]) {
      assertBlocked(
        await runPolicy(
          request({
            sourcePath: file,
            request: { kind: "plugin-npm", mode: "install", requestedSpecifier: `npm-pack:${file}` },
          }),
        ),
      );
    }
    assert.equal(calls.length, 0);
  });

  it("a local cache listing the tuple never turns a refusal into an allow (the cache is not read)", async () => {
    const state = path.join(dir, "state");
    rmSync(state, { recursive: true, force: true });
    const cache = path.join(state, "ocw-plugins.json");
    await import("node:fs/promises").then((fs) => fs.mkdir(state, { recursive: true }));
    writeFileSync(
      cache,
      JSON.stringify({
        plugins: [{ pluginId: "ocw-echo", packageName: NAME, version: VERSION, sha256: digest }],
        approved: [{ packageName: NAME, version: VERSION, sha256: digest }],
      }),
    );
    answer = { status: 200, body: { approved: false, reason: "not_in_flight" } };
    const r = await runPolicy(request(), {
      OCW_API_URL: apiUrl,
      OCW_CELL_TOKEN_FILE: tokenFile,
      OPENCLAW_STATE_DIR: state,
      HOME: dir,
    });
    assertBlocked(r, /not_in_flight/);
  });
});
