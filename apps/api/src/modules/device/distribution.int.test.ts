import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_ROUTES, RuntimeDistManifest } from "@ocw/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, type TestStack } from "../../testing";
import { writeRuntimeDist } from "../../testing-runtime-dist";

/**
 * Phase 07.12-06 (HSR-01, D-01, D-13, PD-05): the workspace serves its own Local Runtime. Public, read-only,
 * rate-limited routes over one dist directory (`OCW_RUNTIME_DIST_DIR`): the manifest, the bundle (re-hashed against the
 * manifest before it is ever served), its checksum line, `install.sh`, whose server URL is `OCW_PUBLIC_API_URL`
 * whatever the request's Host says, and (07.17.1-03, D-03, PD-16) the npm lockfile the daemon's self-update installs
 * from. The stack trusts one proxy hop so each case speaks from its own client IP.
 *
 * The cases run in order on one stack: the dist directory starts empty, then gets a corrupt bundle, then a good one
 * (a missing or corrupt dist is re-checked on every request; only a verified one is cached).
 */

const PUBLIC_API_URL = "http://localhost:4999";
const BUNDLE = Buffer.from('#!/usr/bin/env node\nconsole.log("ocw-runtime test bundle");\n');
const ROUTES = Object.values(RUNTIME_ROUTES);

let stack: TestStack;
let dist: string;
let ipSeq = 10;
/** A fresh documentation-range client IP per case, so the per-IP limits of one case never touch another. */
const nextIp = () => `203.0.113.${ipSeq++}`;

/** The npm lockfile install.sh embeds (07.12 review ME-03), rooted at the manifest's pins. */
const LOCK = `${JSON.stringify(
  {
    name: "ocw-runtime-deps",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "ocw-runtime-deps",
        dependencies: { "@anthropic-ai/claude-agent-sdk": "0.3.282", zod: "4.6.5" },
      },
    },
  },
  null,
  2,
)}\n`;

const manifest = RuntimeDistManifest.parse({
  version: "0.1.0",
  sha256: createHash("sha256").update(BUNDLE).digest("hex"),
  bytes: BUNDLE.length,
  file: "ocw-runtime.mjs",
  minNode: 24,
  external: [
    { name: "@anthropic-ai/claude-agent-sdk", version: "0.3.282" },
    { name: "zod", version: "4.6.5" },
  ],
  externalLockSha256: createHash("sha256").update(LOCK).digest("hex"),
  bundled: [{ name: "ws", version: "8.21.3", license: "MIT" }],
  source: { repository: "https://github.com/VictorMinemu/open-collaborative-ai-workspace", commit: null },
  builtAt: "2026-10-29T08:00:00.000Z",
});

function get(url: string, headers: Record<string, string> = {}, ip = nextIp()) {
  return stack.built.app.inject({ method: "GET", url, headers: { "x-forwarded-for": ip, ...headers } });
}

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "ocw-runtime-dist-"));
  stack = await startTestStack({ env: { OCW_TRUST_PROXY: "1", OCW_RUNTIME_DIST_DIR: dist } });
});

afterAll(async () => {
  await stack?.stop();
  if (dist) await rm(dist, { recursive: true, force: true });
});

describe("runtime distribution routes (07.12-06, D-01, D-13, PD-05)", () => {
  it("an empty dist directory answers 404 runtime_unavailable on every route", async () => {
    for (const route of ROUTES) {
      const res = await get(route);
      expect(res.statusCode, route).toBe(404);
      expect(res.json().error.code, route).toBe("runtime_unavailable");
    }
  });

  it("a bundle whose bytes differ from the manifest answers 503 runtime_corrupt (re-checked, never cached)", async () => {
    await writeFile(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(dist, "npm-shrinkwrap.json"), LOCK);
    await writeFile(
      join(dist, "ocw-runtime.mjs"),
      Buffer.concat([BUNDLE.subarray(0, -2), Buffer.from("!\n")]),
    );
    for (const route of ROUTES) {
      const res = await get(route);
      expect(res.statusCode, route).toBe(503);
      expect(res.json().error.code, route).toBe("runtime_corrupt");
    }
    // A lockfile whose bytes differ from the manifest's externalLockSha256 is corrupt too (ME-03).
    await writeFile(join(dist, "ocw-runtime.mjs"), BUNDLE);
    await writeFile(join(dist, "npm-shrinkwrap.json"), LOCK.replace("4.6.5", "4.6.6"));
    for (const route of ROUTES) expect((await get(route)).statusCode, route).toBe(503);
    // A manifest that does not parse is corrupt too.
    await writeFile(join(dist, "manifest.json"), '{"version":"0.1.0"}');
    const res = await get(RUNTIME_ROUTES.version);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("runtime_corrupt");
  });

  it("once the files are right the next request answers 200: version is the manifest, no-cache", async () => {
    await writeFile(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(dist, "npm-shrinkwrap.json"), LOCK);
    await writeFile(join(dist, "ocw-runtime.mjs"), BUNDLE);
    const res = await get(RUNTIME_ROUTES.version);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.json()).toEqual(manifest);
  });

  it("bundle: the bytes hash to the manifest's sha256, with ETag, x-content-sha256 and a JavaScript type", async () => {
    const res = await get(RUNTIME_ROUTES.bundle);
    expect(res.statusCode).toBe(200);
    const body = res.rawPayload;
    expect(createHash("sha256").update(body).digest("hex")).toBe(manifest.sha256);
    expect(body.length).toBe(manifest.bytes);
    expect(res.headers.etag).toBe(`"${manifest.sha256}"`);
    expect(res.headers["x-content-sha256"]).toBe(manifest.sha256);
    expect(res.headers["content-type"]).toMatch(/^application\/javascript/);
    expect(res.headers["content-disposition"]).toBe('attachment; filename="ocw-runtime.mjs"');
    expect(res.headers["cache-control"]).toBe("no-cache");

    const again = await get(RUNTIME_ROUTES.bundle, { "if-none-match": `"${manifest.sha256}"` });
    expect(again.statusCode).toBe(304);
    expect(again.rawPayload.length).toBe(0);
  });

  it("bundle.sha256 is the sha256sum line of the bundle", async () => {
    const res = await get(RUNTIME_ROUTES.bundleSha256);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
    expect(res.body).toBe(`${manifest.sha256}  ocw-runtime.mjs\n`);
  });

  it("install.sh points at OCW_PUBLIC_API_URL even when Host and X-Forwarded-Host say otherwise", async () => {
    const res = await get(RUNTIME_ROUTES.installScript, {
      host: "evil.example",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/x-shellscript/);
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.body.split("\n")[0]).toBe("#!/bin/sh");
    expect(res.body).toContain(`'${PUBLIC_API_URL}'`);
    expect(res.body).toContain(`'${manifest.sha256}'`);
    expect(res.body).toContain(`'${manifest.version}'`);
    expect(res.body).not.toContain("evil.example");
    // The lockfile npm ci installs from (ME-03).
    expect(res.body).toContain(`<<'OCW_EXTERNAL_LOCK'\n${LOCK}OCW_EXTERNAL_LOCK\n`);
  });

  it("the 31st bundle request in a minute from one IP answers 429; another IP is unaffected", async () => {
    const ip = nextIp();
    for (let i = 0; i < 30; i++) {
      const res = await get(RUNTIME_ROUTES.bundle, {}, ip);
      expect(res.statusCode, `request ${i + 1}`).toBe(200);
    }
    expect((await get(RUNTIME_ROUTES.bundle, {}, ip)).statusCode).toBe(429);
    expect((await get(RUNTIME_ROUTES.bundle)).statusCode).toBe(200);
  });

  it("the routes need no session and are declared public", () => {
    for (const route of ROUTES) expect(stack.built.authz.routes.get(`GET ${route}`)).toBe("public");
  });
});

/**
 * 07.17.1-03 (D-03, PD-16): the lockfile route on its own stack over a dist written by `writeRuntimeDist`. The body is
 * the exact bytes the store hashed against the manifest's `externalLockSha256`; the route reads no input.
 */
describe("runtime lockfile route (07.17.1-03, D-03, PD-16)", () => {
  let lockStack: TestStack;
  let lockDist: string;
  let served: Awaited<ReturnType<typeof writeRuntimeDist>>;
  const lockGet = (url: string, ip = nextIp()) =>
    lockStack.built.app.inject({ method: "GET", url, headers: { "x-forwarded-for": ip } });

  beforeAll(async () => {
    lockDist = await mkdtemp(join(tmpdir(), "ocw-runtime-lock-"));
    served = await writeRuntimeDist(lockDist);
    lockStack = await startTestStack({ env: { OCW_TRUST_PROXY: "1", OCW_RUNTIME_DIST_DIR: lockDist } });
  });

  afterAll(async () => {
    await lockStack?.stop();
    if (lockDist) await rm(lockDist, { recursive: true, force: true });
  });

  it("answers the verified lockfile: its sha256 is the manifest's externalLockSha256, JSON, no-cache", async () => {
    const res = await lockGet(RUNTIME_ROUTES.externalLock);
    expect(res.statusCode).toBe(200);
    expect(createHash("sha256").update(res.rawPayload).digest("hex")).toBe(served.manifest.externalLockSha256);
    expect(res.rawPayload.toString("utf8")).toBe(served.lock);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.headers["x-content-sha256"]).toBe(served.manifest.externalLockSha256);
  });

  it("reads no input: a query string answers the same bytes", async () => {
    const plain = await lockGet(RUNTIME_ROUTES.externalLock);
    const withQuery = await lockGet(`${RUNTIME_ROUTES.externalLock}?x=1`);
    expect(withQuery.statusCode).toBe(200);
    expect(withQuery.rawPayload.equals(plain.rawPayload)).toBe(true);
  });

  it("the 31st lockfile request in a minute from one IP answers 429; another IP is unaffected", async () => {
    const ip = nextIp();
    for (let i = 0; i < 30; i++) {
      const res = await lockGet(RUNTIME_ROUTES.externalLock, ip);
      expect(res.statusCode, `request ${i + 1}`).toBe(200);
    }
    expect((await lockGet(RUNTIME_ROUTES.externalLock, ip)).statusCode).toBe(429);
    expect((await lockGet(RUNTIME_ROUTES.externalLock)).statusCode).toBe(200);
  });

  it("is declared public", () => {
    expect(lockStack.built.authz.routes.get(`GET ${RUNTIME_ROUTES.externalLock}`)).toBe("public");
  });
});
