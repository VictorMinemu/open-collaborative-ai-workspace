// node --test 'scripts/**/*.test.mjs'
//
// Shared helpers of every `pnpm ocw` command (scripts/ocw/env-file.mjs), on temporary files only. The repository's
// .env and .env.demo are never read or written; demo paths are refused by name, without being created or read.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  addProfile,
  composeArgs,
  DEMO,
  gen,
  parseArgs,
  REPO_ROOT,
  readEnv,
  reportWritten,
  resolveEnvFile,
  runCompose,
  setKeys,
} from "./env-file.mjs";

let dir;
const file = () => path.join(dir, ".env");
const mode = (f) => statSync(f).mode & 0o777;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ocw-env-file-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("parseArgs", () => {
  const spec = { boolean: ["force", "yes"], string: ["dir", "ports"] };

  it("reads booleans, string options in both forms and positionals", () => {
    const { opts, positionals } = parseArgs(["a", "--force", "--dir", "/x", "--ports=34", "b"], spec);
    assert.deepEqual(opts, { force: true, dir: "/x", ports: "34" });
    assert.deepEqual(positionals, ["a", "b"]);
  });

  it("rejects unknown flags, a missing value and a value on a boolean", () => {
    assert.throws(() => parseArgs(["--nope"], spec), /Unknown option --nope/);
    assert.throws(() => parseArgs(["--dir"], spec), /--dir needs a value/);
    assert.throws(() => parseArgs(["--dir", "--force"], spec), /--dir needs a value/);
    assert.throws(() => parseArgs(["--force=1"], spec), /--force takes no value/);
  });
});

describe("resolveEnvFile", () => {
  it("--env-file, then --dir/.env, then the repository's .env", () => {
    assert.equal(resolveEnvFile({ "env-file": path.join(dir, "x.env") }), path.join(dir, "x.env"));
    assert.equal(resolveEnvFile({ dir }), file());
    assert.equal(resolveEnvFile({}), path.join(REPO_ROOT, ".env"));
    assert.throws(() => resolveEnvFile({ dir, "env-file": file() }), /either --env-file or --dir/);
  });
});

describe("readEnv", () => {
  it("parses KEY=value lines, ignores comments and strips matching quotes", () => {
    writeFileSync(file(), '# c\nA=1\n\nB="two words"\n# C=commented\nD=x=y\n');
    const { text, values } = readEnv(file());
    assert.equal(text, '# c\nA=1\n\nB="two words"\n# C=commented\nD=x=y\n');
    assert.deepEqual(
      [...values],
      [
        ["A", "1"],
        ["B", "two words"],
        ["D", "x=y"],
      ],
    );
  });
});

describe("setKeys", () => {
  it("replaces existing lines in place, appends missing keys under the header and keeps every other byte", () => {
    const before = "# top comment\nA=old\n\n# section\nB=keep  # not a comment for us\nC=old-c";
    writeFileSync(file(), before, { mode: 0o644 });
    setKeys(
      file(),
      [
        ["C", "new-c"],
        ["A", "new-a"],
        ["Z", "added"],
      ],
      { header: "Added by ocw test" },
    );
    const after = readFileSync(file(), "utf8");
    assert.equal(
      after,
      "# top comment\nA=new-a\n\n# section\nB=keep  # not a comment for us\nC=new-c\n\n# Added by ocw test\nZ=added\n",
    );
    assert.equal(mode(file()), 0o600, "every write leaves the file at 0600");
  });

  it("accepts an object, appends without a header, and creates a missing file at 0600", () => {
    setKeys(file(), { A: "1" });
    setKeys(file(), { B: "2" });
    assert.equal(readFileSync(file(), "utf8"), "A=1\nB=2\n");
    assert.equal(mode(file()), 0o600);
  });

  it("refuses names that are not env keys and values with a newline", () => {
    assert.throws(() => setKeys(file(), { "bad key": "1" }), /Invalid env key/);
    assert.throws(() => setKeys(file(), { A: "1\nB=2" }), /newline/);
  });
});

describe("addProfile", () => {
  it("adds to COMPOSE_PROFILES once and keeps the existing order", () => {
    writeFileSync(file(), "X=1\n");
    addProfile(file(), "vault");
    addProfile(file(), "proxy");
    addProfile(file(), "vault");
    assert.equal(readEnv(file()).values.get("COMPOSE_PROFILES"), "vault,proxy");
    assert.equal(readFileSync(file(), "utf8").match(/^COMPOSE_PROFILES=/gm).length, 1);
    assert.throws(() => addProfile(file(), "Bad,Profile"), /Invalid profile/);
  });
});

describe("gen", () => {
  it("produces random values in the expected encodings", () => {
    assert.match(gen.hex(12), /^[0-9a-f]{24}$/);
    assert.equal(Buffer.from(gen.base64(32), "base64").length, 32);
    assert.match(gen.base64url(32), /^[A-Za-z0-9_-]{43}$/);
    assert.match(gen.password(), /^[0-9a-f]{48}$/);
    assert.notEqual(gen.hex(16), gen.hex(16));
  });
});

describe("reportWritten", () => {
  it("prints key names and the path, never a value", () => {
    const secret = gen.hex(32);
    writeFileSync(file(), `OCW_SETUP_TOKEN=${secret}\n`);
    const lines = [];
    const line = reportWritten(["OCW_SETUP_TOKEN", "OCW_WEB_PORT"], file(), { log: (l) => lines.push(l) });
    assert.equal(line, `Wrote OCW_SETUP_TOKEN, OCW_WEB_PORT to ${file()}`);
    assert.deepEqual(lines, [line]);
    assert.ok(!line.includes(secret));
    // A KEY=value pair passed by mistake is refused instead of printed.
    assert.throws(
      () => reportWritten([`OCW_SETUP_TOKEN=${secret}`], file(), { log: () => {} }),
      /names only/,
    );
  });
});

describe("composeArgs", () => {
  it("passes the project directory, the env file and an explicit project from the file", () => {
    writeFileSync(file(), "COMPOSE_PROJECT_NAME=ocw-gate-abc\n");
    assert.deepEqual(composeArgs(file()), [
      "--project-directory",
      REPO_ROOT,
      "--env-file",
      file(),
      "-p",
      "ocw-gate-abc",
    ]);
  });

  it("without COMPOSE_PROJECT_NAME uses Compose's default (the project directory name, normalized)", () => {
    writeFileSync(file(), "X=1\n");
    assert.deepEqual(composeArgs(file(), { projectDir: "/srv/My.OCW_Install" }).slice(-2), [
      "-p",
      "myocw_install",
    ]);
  });

  it("resolves COMPOSE_FILE entries against the project directory (Compose resolves them against the cwd)", () => {
    writeFileSync(file(), "COMPOSE_PROJECT_NAME=ocw-x\nCOMPOSE_FILE=compose.yaml:compose.e2e.yaml\n");
    assert.deepEqual(composeArgs(file(), { projectDir: "/srv/ocw" }).slice(4), [
      "-p",
      "ocw-x",
      "-f",
      "/srv/ocw/compose.yaml",
      "-f",
      "/srv/ocw/compose.e2e.yaml",
    ]);
  });

  it("refuses the running demo's project, whether it comes from the file or from the directory name", () => {
    writeFileSync(file(), `COMPOSE_PROJECT_NAME=${DEMO.project}\n`);
    assert.throws(() => composeArgs(file()), /demo/);
    writeFileSync(file(), "X=1\n");
    assert.throws(() => composeArgs(file(), { projectDir: `/Users/x/worktrees/${DEMO.project}` }), /demo/);
  });

  it("refuses the demo's env files by path, without reading them", () => {
    for (const demoFile of [
      path.join(REPO_ROOT, ".env.demo"),
      path.join(homedir(), ".ocw-demo", ".env"),
      path.join(homedir(), ".ocw", "anything.env"),
    ]) {
      assert.throws(() => composeArgs(demoFile), /demo/, demoFile);
    }
  });

  it("names the missing env file and the command that creates it", () => {
    assert.throws(() => composeArgs(file()), /ocw setup/);
  });
});

describe("runCompose", () => {
  it("never builds images under the demo's :local tag (refused before Docker runs)", () => {
    writeFileSync(file(), "COMPOSE_PROJECT_NAME=ocw-gate-abc\n");
    const env = { PATH: "" }; // Docker would not even be found: the refusal comes first.
    assert.throws(() => runCompose(file(), ["up", "-d", "--build"], { env }), /:local/);
    assert.throws(() => runCompose(file(), ["build"], { env }), /:local/);
    writeFileSync(file(), "COMPOSE_PROJECT_NAME=ocw-gate-abc\nOCW_IMAGE_TAG=local\n");
    assert.throws(() => runCompose(file(), ["up", "--build"], { env }), /:local/);
    // A shell OCW_IMAGE_TAG wins over the file in Compose interpolation, so it is what counts.
    writeFileSync(file(), "COMPOSE_PROJECT_NAME=ocw-gate-abc\nOCW_IMAGE_TAG=gate-1\n");
    assert.throws(() => runCompose(file(), ["build"], { env: { ...env, OCW_IMAGE_TAG: "local" } }), /:local/);
  });

  it("refuses the demo project before spawning anything", () => {
    writeFileSync(file(), `COMPOSE_PROJECT_NAME=${DEMO.project}\n`);
    assert.throws(() => runCompose(file(), ["ps"], { env: { PATH: "" } }), /demo/);
  });
});
