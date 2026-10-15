// node --test scripts/guard/guard.test.mjs
//
// `pnpm guard` (scripts/guard/run.mjs): Semgrep with the repository's rules over a temporary tree (`--root`), the rule
// fixtures (`--rule-tests`), the fail-closed path when no Semgrep runner exists, the license policy (licenses.mjs),
// CODEOWNERS lint (codeowners.mjs) and the repository itself. The tokens and patterns the rules look for are assembled
// at runtime so this file never trips the scan it tests.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { lint as lintCodeowners } from "./codeowners.mjs";
import { checkFields, checkGraph, collectLockfile, evaluate, NPM_LOCKFILES } from "./licenses.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN = path.join(HERE, "run.mjs");
const TOKEN = ["bypass", "Permissions"].join("");

let root;
const put = (rel, text) => {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const guard = (args, env = process.env) => {
  const res = spawnSync(process.execPath, [RUN, ...args], { encoding: "utf8", env });
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
};
const semgrep = () => guard(["--only", "semgrep", "--root", root]);

beforeEach(() => {
  // A git repository like the real one: Semgrep anchors rule path patterns at the git root.
  root = mkdtempSync(path.join(tmpdir(), "ocw-guard-"));
  spawnSync("git", ["init", "-q", root]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("guard: ocw.permission-bypass-token", () => {
  it("a bypass token outside the ADR-0012 path fails, naming the rule and the file", () => {
    put("apps/api/src/x.ts", `export const mode = "${TOKEN}";\n`);
    const res = semgrep();
    assert.notEqual(res.status, 0, res.out);
    assert.match(res.out, /ocw\.permission-bypass-token/);
    assert.match(res.out, /apps\/api\/src\/x\.ts/);
  });

  it("the same token inside the ADR-0012 path passes, and rule fixtures are never scanned", () => {
    put("apps/local-runtime/src/claude/x.ts", `export const mode = "${TOKEN}";\n`);
    put(".semgrep/tests/rules.ts", `// ruleid: ocw.permission-bypass-token\nconst m = "${TOKEN}";\n`);
    const res = semgrep();
    assert.equal(res.status, 0, res.out);
  });

  it("the allowlist is anchored at the repository root, not matched anywhere in a path", () => {
    put("apps/api/src/apps/local-runtime/src/claude/x.ts", `export const mode = "${TOKEN}";\n`);
    const res = semgrep();
    assert.notEqual(res.status, 0, res.out);
    assert.match(res.out, /apps\/api\/src\/apps\/local-runtime\/src\/claude\/x\.ts/);
  });

  it("fails closed with an install hint when neither uvx nor docker is available", () => {
    put("apps/api/src/x.ts", "export const ok = 1;\n");
    const res = guard(["--only", "semgrep", "--root", root], {
      ...process.env,
      PATH: path.join(root, "no-bin"),
    });
    assert.equal(res.status, 1, res.out);
    assert.match(res.out, /install/i);
    assert.match(res.out, /uv/);
    assert.match(res.out, /docker/i);
  });
});

describe("guard: policy tests, RLS and focused tests", () => {
  const SKIP = ["it", "skip"].join(".");
  const ONLY = ["it", "only"].join(".");
  const RLS_ATTR = ["BYPASS", "RLS"].join("");

  it("a skipped test in a policy test path fails, naming ocw.skipped-policy-test", () => {
    put("packages/db/src/x.int.test.ts", `${SKIP}("denies cross-tenant reads", () => {});\n`);
    const res = semgrep();
    assert.notEqual(res.status, 0, res.out);
    assert.match(res.out, /ocw\.skipped-policy-test/);
    assert.match(res.out, /packages\/db\/src\/x\.int\.test\.ts/);
  });

  it("a skipped test anywhere in the API or the packages fails: tenant isolation lives in many modules", () => {
    put("apps/api/src/modules/search/x.int.test.ts", `${SKIP}("org B never sees org A's hits", () => {});\n`);
    const res = semgrep();
    assert.notEqual(res.status, 0, res.out);
    assert.match(res.out, /ocw\.skipped-policy-test/);
    assert.match(res.out, /apps\/api\/src\/modules\/search\/x\.int\.test\.ts/);
  });

  it("the same skip outside the API and the packages passes", () => {
    put("apps/web/lib/x.test.ts", `${SKIP}("renders a preview", () => {});\n`);
    const res = semgrep();
    assert.equal(res.status, 0, res.out);
  });

  it("a focused test anywhere under apps fails, naming ocw.focused-test", () => {
    put("apps/web/components/x.test.tsx", `${ONLY}("narrows the suite", () => {});\n`);
    const res = semgrep();
    assert.notEqual(res.status, 0, res.out);
    assert.match(res.out, /ocw\.focused-test/);
  });

  it("an RLS bypass grant fails outside bootstrap.sql; a SQL comment naming it passes", () => {
    put("packages/db/sql/bootstrap.sql", `ALTER ROLE ocw_migrator ${RLS_ATTR};\n`);
    put("packages/db/sql/post-migrate.sql", `-- runs as ocw_migrator (${RLS_ATTR})\nselect 1;\n`);
    assert.equal(semgrep().status, 0);
    put("packages/db/drizzle/0099_x.sql", `ALTER ROLE ocw_app ${RLS_ATTR};\n`);
    const res = semgrep();
    assert.notEqual(res.status, 0, res.out);
    assert.match(res.out, /ocw\.rls-bypass packages\/db\/drizzle\/0099_x\.sql/);
  });
});

describe("guard: ocw.raw-egress", () => {
  const RULE = /ocw\.raw-egress/;

  it("a raw network call in the connectors, keychain or proxy files fails, naming the rule and each file", () => {
    put("apps/api/src/modules/keychain/a.ts", `export const a = () => fetch("https://example.com");\n`);
    put("apps/api/src/modules/keychain/b.ts", `import { request } from "node:https";\nexport { request };\n`);
    put("apps/api/src/modules/keychain/c.ts", `import { Agent } from "undici";\nexport { Agent };\n`);
    put(
      "apps/api/src/modules/connectors/d.ts",
      `export const d = () => globalThis.fetch("https://x.test");\n`,
    );
    put("apps/api/src/modules/connectors/e.ts", `import net from "node:net";\nexport const e = net;\n`);
    put(
      "apps/api/src/modules/agent-channel/http-requests.ts",
      `export const f = () => fetch("https://x");\n`,
    );
    put(
      "apps/api/src/modules/agent-channel/connectors.ts",
      `const http = require("http");\nexport { http };\n`,
    );
    const res = semgrep();
    assert.notEqual(res.status, 0, res.out);
    for (const file of [
      "apps/api/src/modules/keychain/a.ts",
      "apps/api/src/modules/keychain/b.ts",
      "apps/api/src/modules/keychain/c.ts",
      "apps/api/src/modules/connectors/d.ts",
      "apps/api/src/modules/connectors/e.ts",
      "apps/api/src/modules/agent-channel/http-requests.ts",
      "apps/api/src/modules/agent-channel/connectors.ts",
    ]) {
      assert.match(res.out, new RegExp(`ocw\\.raw-egress ${file.replaceAll(".", "\\.")}`), res.out);
    }
  });

  it("the same calls outside those modules, in their tests, or through the guard pass", () => {
    put("apps/api/src/modules/chat/x.ts", `export const x = () => fetch("https://example.com");\n`);
    put("apps/api/src/modules/agent-channel/memories.ts", `export const m = () => fetch("https://x");\n`);
    put(
      "apps/api/src/modules/keychain/x.test.ts",
      `import { Agent } from "undici";\nfetch("http://127.0.0.1");\n`,
    );
    put(
      "apps/api/src/modules/keychain/ok.ts",
      [
        `import { isIP } from "node:net";`,
        `import type { Socket } from "node:net";`,
        `import { egressFor } from "../../lib/egress";`,
        `export const ok = (env: never, s?: Socket) => isIP("1.1.1.1") && egressFor(env).fetch("https://x.test");`,
        "",
      ].join("\n"),
    );
    const res = semgrep();
    assert.equal(res.status, 0, res.out);
    assert.doesNotMatch(res.out, RULE);
  });
});

describe("guard: ocw.raw-egress in the sandbox egress entrypoint (07.8-12)", () => {
  it("a raw socket or http client in apps/sandboxd/src/egress outside proxy.ts fails", () => {
    put("apps/sandboxd/src/egress/main.ts", `import net from "node:net";\nnet.connect(80, "x");\n`);
    put("apps/sandboxd/src/egress/extra.ts", `import http from "node:http";\nhttp.request("http://x");\n`);
    const res = semgrep();
    assert.notEqual(res.status, 0, res.out);
    assert.match(res.out, /ocw\.raw-egress apps\/sandboxd\/src\/egress\/main\.ts/);
    assert.match(res.out, /ocw\.raw-egress apps\/sandboxd\/src\/egress\/extra\.ts/);
  });

  it("proxy.ts, the one allowed file, passes; the allowance is that exact file", () => {
    put(
      "apps/sandboxd/src/egress/proxy.ts",
      `import http from "node:http";\nimport net from "node:net";\nnet.connect(443, "93.184.216.34");\n`,
    );
    assert.equal(semgrep().status, 0);
    put("apps/sandboxd/src/egress/sub/proxy.ts", `import net from "node:net";\nnet.connect(1, "x");\n`);
    const res = semgrep();
    assert.notEqual(res.status, 0, res.out);
    assert.match(res.out, /ocw\.raw-egress apps\/sandboxd\/src\/egress\/sub\/proxy\.ts/);
  });
});

describe("guard: rule fixtures", () => {
  it("--rule-tests passes over .semgrep/tests", () => {
    const res = guard(["--rule-tests"]);
    assert.equal(res.status, 0, res.out);
  });
});

describe("guard: dependency licenses", () => {
  const policy = JSON.parse(readFileSync(path.join(HERE, "license-policy.json"), "utf8"));
  const entry = (name, license, version = "1.0.0") => ({ name, version, license, source: "pnpm" });

  it("evaluates SPDX expressions: OR needs one allowed operand, AND needs all, anything unparseable is denied", () => {
    assert.equal(evaluate("MIT", policy), "allow");
    assert.equal(evaluate("GPL-2.0-only", policy), "deny");
    assert.equal(evaluate("(MIT OR GPL-2.0-only)", policy), "allow");
    assert.equal(evaluate("(MIT AND GPL-2.0-only)", policy), "deny");
    assert.equal(evaluate("(MIT AND Zlib)", policy), "allow");
    assert.equal(evaluate("((MIT OR GPL-2.0-only) AND (Apache-2.0 OR SSPL-1.0))", policy), "allow");
    assert.equal(evaluate("Unknown", policy), "deny");
    assert.equal(evaluate("SEE LICENSE IN README.md", policy), "deny");
    assert.equal(evaluate("(MIT OR", policy), "deny");
    assert.equal(evaluate("", policy), "deny");
    assert.equal(evaluate("BUSL-1.1", policy), "deny");
  });

  it("a denied package fails naming it; an allowed graph passes", () => {
    assert.deepEqual(checkGraph([entry("left-pad", "MIT"), entry("isc-thing", "ISC")], policy), []);
    const failures = checkGraph(
      [entry("left-pad", "MIT"), entry("copyleft-v2", "GPL-2.0-only", "2.1.0")],
      policy,
    );
    assert.equal(failures.length, 1);
    assert.match(failures[0], /copyleft-v2@2\.1\.0/);
    assert.match(failures[0], /GPL-2\.0-only/);
  });

  it("the claude-agent-sdk exception admits it and its platform binaries, and says so", () => {
    const notes = [];
    const failures = checkGraph(
      [
        entry("@anthropic-ai/claude-agent-sdk", "Unknown", "0.3.287"),
        entry("@anthropic-ai/claude-agent-sdk-linux-x64", "SEE LICENSE IN README.md", "0.3.287"),
      ],
      policy,
      notes,
    );
    assert.deepEqual(failures, []);
    assert.equal(notes.length, 1);
    assert.match(
      notes[0],
      /^exception: @anthropic-ai\/claude-agent-sdk \(pending owner\/legal confirmation, ADR-0021\)/,
    );
    // A look-alike name is not covered.
    assert.equal(checkGraph([entry("@anthropic-ai/claude-agent-sdkx", "Unknown")], policy).length, 1);
  });

  it("reads the browser agent's npm lockfile; an unknown license there fails naming it", () => {
    const rel = "infra/sandbox/browser/package-lock.json";
    assert.ok(NPM_LOCKFILES.includes(rel));
    const real = collectLockfile(path.join(HERE, "..", ".."), rel);
    assert.deepEqual(
      real.map((e) => `${e.name}@${e.version} ${e.license}`),
      ["playwright-core@1.63.0 Apache-2.0"],
    );
    assert.deepEqual(checkGraph(real, policy), []);
    put(
      rel,
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "ocw-sandbox-browser", license: "AGPL-3.0-only" },
          "node_modules/playwright-core": { version: "1.63.0", license: "Apache-2.0" },
          "node_modules/odd-codec": { version: "2.0.0", license: "SEE LICENSE IN EULA.txt" },
        },
      }),
    );
    const failures = checkGraph(collectLockfile(root, rel), policy);
    assert.equal(failures.length, 1);
    assert.match(
      failures[0],
      /odd-codec@2\.0\.0 \(SEE LICENSE IN EULA\.txt\) \[infra\/sandbox\/browser\/package-lock\.json\]/,
    );
  });

  it("a clarification applies only to the pinned version", () => {
    const pinned = entry("@modelcontextprotocol/server-everything", "SEE LICENSE IN LICENSE", "2026.8.31");
    assert.deepEqual(checkGraph([pinned], policy), []);
    assert.equal(checkGraph([{ ...pinned, version: "2026.9.30" }], policy).length, 1);
  });
});

describe("guard: package license fields", () => {
  const pkg = (dir, license, hasLicenseFile = true) => ({
    dir,
    json: { name: `@ocw/${path.basename(dir)}`, ...(license ? { license } : {}) },
    hasLicenseFile,
  });

  it("passes AGPL apps and Apache packages that ship a LICENSE", () => {
    assert.deepEqual(
      checkFields([pkg("apps/api", "AGPL-3.0-only"), pkg("packages/contracts", "Apache-2.0")]),
      [],
    );
  });

  it("a missing license, a non-project license, or an Apache package without LICENSE fails naming the package", () => {
    const failures = checkFields([
      pkg("apps/api"),
      pkg("apps/web", "MIT"),
      pkg("packages/realtime-client", "Apache-2.0", false),
      pkg("packages/contracts", "AGPL-3.0-only"),
    ]);
    assert.equal(failures.length, 4, failures.join("\n"));
    assert.match(failures.join("\n"), /@ocw\/api/);
    assert.match(failures.join("\n"), /@ocw\/web/);
    assert.match(failures.join("\n"), /@ocw\/realtime-client.*LICENSE/);
    assert.match(failures.join("\n"), /@ocw\/contracts.*Apache-2\.0/);
  });

  it("packages/protocol is checked as Apache once it exists", () => {
    assert.equal(checkFields([pkg("packages/protocol", "AGPL-3.0-only")]).length, 1);
    assert.deepEqual(checkFields([pkg("packages/protocol", "Apache-2.0")]), []);
  });
});

describe("guard: CODEOWNERS", () => {
  const tracked = [
    "packages/db/sql/bootstrap.sql",
    "apps/api/src/authz.ts",
    "apps/api/src/modules/identity/auth.ts",
  ];
  const areas = [
    { area: "db policies", file: "packages/db/sql/bootstrap.sql" },
    { area: "auth", file: "apps/api/src/modules/identity/auth.ts" },
  ];
  const good = "/packages/db/sql/ @VictorMinemu\n/apps/api/src/modules/identity/ @VictorMinemu\n";

  it("passes when every pattern matches a tracked file and every required area is owned", () => {
    assert.deepEqual(lintCodeowners(good, tracked, areas), []);
  });

  it("a pattern that matches no tracked file fails", () => {
    const failures = lintCodeowners(`${good}/apps/api/src/gone.ts @VictorMinemu\n`, tracked, areas);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /apps\/api\/src\/gone\.ts/);
  });

  it("a required area without an owner fails, and so does a pattern without owners", () => {
    const failures = lintCodeowners(
      "/packages/db/sql/ @VictorMinemu\n/apps/api/src/authz.ts\n",
      tracked,
      areas,
    );
    assert.equal(failures.length, 2, failures.join("\n"));
    assert.match(failures.join("\n"), /auth/);
    assert.match(failures.join("\n"), /no owner/);
  });

  it("the shipped .github/CODEOWNERS passes against the repository", () => {
    const res = guard(["--only", "codeowners"]);
    assert.equal(res.status, 0, res.out);
  });
});

describe("guard: the repository", () => {
  it("pnpm guard passes and prints the claude-agent-sdk exception", () => {
    const res = guard([]);
    assert.equal(res.status, 0, res.out);
    assert.match(
      res.out,
      /exception: @anthropic-ai\/claude-agent-sdk \(pending owner\/legal confirmation, ADR-0021\)/,
    );
  });
});
