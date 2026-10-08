// node --test 'scripts/**/*.test.mjs'
//
// The `pnpm ocw` dispatcher (scripts/ocw.mjs): help lists the commands found in scripts/ocw/, an unknown command
// exits 2, and `ocw <cmd> [<sub>]` runs scripts/ocw/<cmd>-<sub>.mjs or scripts/ocw/<cmd>.mjs by file name, so later
// plans add commands without editing the dispatcher. Routing cases use a temporary commands directory.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const OCW = path.join(path.dirname(fileURLToPath(import.meta.url)), "ocw.mjs");
let fixtures;
const run = (args, commandsDir) =>
  spawnSync(process.execPath, [OCW, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...(commandsDir ? { OCW_CLI_COMMANDS_DIR: commandsDir } : {}) },
  });
const echo = (name) =>
  `// ${name}: test fixture\nconsole.log(${JSON.stringify(name)}, JSON.stringify(process.argv.slice(2)));\n`;

beforeEach(() => {
  fixtures = mkdtempSync(path.join(tmpdir(), "ocw-cli-"));
});
afterEach(() => rmSync(fixtures, { recursive: true, force: true }));

describe("ocw dispatcher", () => {
  it("help lists setup (and never the helpers or tests)", () => {
    for (const args of [["help"], ["--help"], []]) {
      const res = run(args);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /^ {2}setup\b/m);
      assert.doesNotMatch(res.stdout, /env-file|\.test/);
    }
  });

  it("an unknown command exits 2 and names it", () => {
    const res = run(["nope"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Unknown command: ocw nope/);
  });

  it("a command name that is not a plain word is refused (no path tricks)", () => {
    for (const bad of ["../setup", "env-file", "setup.test", "Setup"]) {
      assert.equal(run([bad]).status, 2, bad);
    }
  });

  it("routes `ocw <cmd> <sub>` to <cmd>-<sub>.mjs with the remaining arguments", () => {
    writeFileSync(path.join(fixtures, "enable-demo.mjs"), echo("enable-demo"));
    const res = run(["enable", "demo", "--no-up", "x"], fixtures);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), 'enable-demo ["--no-up","x"]');
    assert.match(run(["help"], fixtures).stdout, /^ {2}enable demo\b.*test fixture/m);
  });

  it("`ocw <cmd>` alone runs <cmd>.mjs when it exists, else exits 2", () => {
    writeFileSync(path.join(fixtures, "enable-demo.mjs"), echo("enable-demo"));
    const missing = run(["enable"], fixtures);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /Unknown command: ocw enable/);

    writeFileSync(path.join(fixtures, "enable.mjs"), echo("enable"));
    const res = run(["enable", "other", "--flag"], fixtures);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), 'enable ["other","--flag"]');
  });

  it("passes the command's exit status through", () => {
    writeFileSync(path.join(fixtures, "fail.mjs"), "process.exit(3);\n");
    assert.equal(run(["fail"], fixtures).status, 3);
  });
});
