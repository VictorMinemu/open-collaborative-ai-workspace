// node --test scripts/shell-syntax.test.mjs
// Every tracked shell script parses (`bash -n`). A broken quote in a script that runs only at the end of a long CI job
// (scripts/sandbox-proof.sh line 209, PR #52: an apostrophe inside a single-quoted `node -e` program) fails that job
// after every check passed; this catches it in `script-tests` instead. Parsing only: nothing is executed.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function trackedShellScripts() {
  return execFileSync("git", ["ls-files", "-z", "--", "*.sh"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

/** `bash -n` of a script, as text on stdin (the file is never sourced or run). */
function parseError(source) {
  const res = spawnSync("bash", ["-n"], { input: source, encoding: "utf8" });
  return res.status === 0 ? null : (res.stderr || `bash -n exited ${res.status}`).trim();
}

describe("shell scripts parse", () => {
  it("lists the repository's shell scripts", () => {
    const files = trackedShellScripts();
    assert.ok(files.includes("scripts/sandbox-proof.sh"), "scripts/sandbox-proof.sh is tracked");
    assert.ok(files.length > 10, `found ${files.length} tracked *.sh files`);
  });

  it("every tracked *.sh passes bash -n", () => {
    const failures = [];
    for (const file of trackedShellScripts()) {
      const res = spawnSync("bash", ["-n", file], { cwd: ROOT, encoding: "utf8" });
      if (res.status !== 0) failures.push(`${file}: ${(res.stderr || "").trim()}`);
    }
    assert.deepEqual(failures, []);
  });

  it("the tripwire fires on the PR #52 mistake (an apostrophe inside a single-quoted node -e program)", () => {
    assert.equal(parseError(`node -e 'console.log(\`ok\`)' "$OUT"\n`), null);
    assert.match(
      parseError(`node -e 'console.log(\`the command's exit (x)\`)' "$OUT"\n`) ?? "",
      /syntax error/,
    );
  });
});
