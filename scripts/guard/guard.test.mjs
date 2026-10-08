// node --test scripts/guard/guard.test.mjs
//
// `pnpm guard` (scripts/guard/run.mjs): Semgrep with the repository's rules over a temporary tree (`--root`), the rule
// fixtures (`--rule-tests`) and the fail-closed path when no Semgrep runner exists. The tokens and patterns the rules
// look for are assembled at runtime so this file never trips the scan it tests.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

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

  it("the same skip outside the policy test paths passes", () => {
    put("apps/api/src/modules/chat/x.test.ts", `${SKIP}("renders a preview", () => {});\n`);
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

describe("guard: rule fixtures", () => {
  it("--rule-tests passes over .semgrep/tests", () => {
    const res = guard(["--rule-tests"]);
    assert.equal(res.status, 0, res.out);
  });
});
