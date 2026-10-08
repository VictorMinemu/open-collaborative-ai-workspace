// node --test scripts/ocw/backup.test.mjs
//
// `ocw backup` / `ocw restore` without Docker: every compose call goes through an injected runner that records it and
// fakes its output. Proves the refusal rules (no --yes, tampered files, newer or unknown backups, the demo), the
// restore order, that pg_dump runs as ocw_migrator with its password outside argv, that --consistent always restarts
// what it stopped and that nothing from the env file is printed or stored. Temp dirs only; the repo's .env is never read.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { main as backup } from "./backup.mjs";
import { REPO_ROOT } from "./env-file.mjs";
import { main as restore } from "./restore.mjs";

const OCW = path.join(REPO_ROOT, "scripts", "ocw.mjs");
const LOCAL_MIGRATIONS = readdirSync(path.join(REPO_ROOT, "packages/db/drizzle")).sort();
const SECRETS = {
  POSTGRES_PASSWORD: "pg-super-secret-value-1111",
  OCW_DB_MIGRATOR_PASSWORD: "migrator-secret-value-2222",
  OCW_DB_APP_PASSWORD: "app-secret-value-3333",
  BETTER_AUTH_SECRET: "better-auth-secret-value-4444",
  OCW_ENCRYPTION_KEY: "encryption-key-secret-value-5555",
  OCW_S3_ACCESS_KEY_ID: "GKaccesskeyidvalue6666",
  OCW_S3_SECRET_ACCESS_KEY: "s3-secret-access-key-value-7777",
};
const OBJECT = {
  key: "org/o1/conv/c1/att/a1/original",
  body: Buffer.from("png-bytes"),
  contentType: "image/png",
};
const sha = (b) => createHash("sha256").update(b).digest("hex");

let root;
let envFile;
let calls;
let lines;
const log = (l) => lines.push(l);

function writeEnv(file, extra = {}) {
  const all = { COMPOSE_PROJECT_NAME: "ocw-test-backup", ...SECRETS, ...extra };
  writeFileSync(
    file,
    `${Object.entries(all)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n")}\n`,
    { mode: 0o600 },
  );
}

/** A fake `docker compose`: records each call (argv + extra env) and fakes what the real services would output. */
function fakeRunner({ fail, migrations = LOCAL_MIGRATIONS } = {}) {
  return (args, opts = {}) => {
    calls.push({ args, env: opts.env ?? {}, stdin: opts.stdin });
    const joined = args.join(" ");
    if (fail?.(joined)) return { status: 1, stdout: "" };
    if (args[0] === "ps") return { status: 0, stdout: "postgres\nredis\ngarage\napi\nweb\nopenclaw\n" };
    if (joined.includes("__drizzle_migrations")) return { status: 0, stdout: `${migrations.join("\n")}\n` };
    if (args.includes("pg_dump")) writeSync(opts.stdout, "PGDMP fake dump");
    if (args.includes("tar")) writeSync(opts.stdout, "fake tar bytes");
    if (args.includes("export")) {
      const mount = args[args.indexOf("-v") + 1];
      const dir = mount.slice(0, mount.lastIndexOf(":/backup"));
      const file = `objects/${sha(OBJECT.key)}`;
      mkdirSync(path.join(dir, "objects"), { recursive: true });
      writeFileSync(path.join(dir, file), OBJECT.body);
      const index = [
        {
          key: OBJECT.key,
          file,
          size: OBJECT.body.length,
          etag: '"e"',
          contentType: OBJECT.contentType,
          sha256: sha(OBJECT.body),
        },
      ];
      writeFileSync(path.join(dir, "objects.json"), JSON.stringify(index));
    }
    return { status: 0, stdout: "" };
  };
}

async function makeBackup(name = "b1", runnerOpts) {
  const out = path.join(root, name);
  await backup(["--env-file", envFile, "--out", out], { runner: fakeRunner(runnerOpts), log });
  return out;
}

function rewriteManifest(dir, fn) {
  const file = path.join(dir, "manifest.json");
  writeFileSync(file, JSON.stringify(fn(JSON.parse(readFileSync(file, "utf8")))));
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "ocw-backup-test-"));
  envFile = path.join(root, ".env");
  writeEnv(envFile);
  calls = [];
  lines = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ocw backup", () => {
  it("writes the dump, the objects, the cell state and a manifest of checksums (dir 0700, files 0600)", async () => {
    const out = await makeBackup();
    for (const f of ["db.dump", "objects.json", "openclaw-state.tar", "manifest.json"]) {
      assert.equal(statSync(path.join(out, f)).mode & 0o777, 0o600, f);
    }
    assert.equal(statSync(out).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(out, "objects")).mode & 0o777, 0o700);
    const m = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
    assert.equal(m.format, 1);
    assert.deepEqual(m.migrations, LOCAL_MIGRATIONS);
    assert.deepEqual(m.components, { database: true, objects: true, cellState: true });
    for (const [name, sum] of Object.entries(m.files)) {
      assert.equal(sha(readFileSync(path.join(out, name))), sum, name);
    }
    assert.deepEqual(Object.keys(m.files).sort(), ["db.dump", "objects.json", "openclaw-state.tar"]);
  });

  it("dumps the whole database as ocw_migrator, password in the environment only, never -n", async () => {
    await makeBackup();
    const dump = calls.find((c) => c.args.includes("pg_dump"));
    assert.ok(dump);
    assert.deepEqual(dump.args.slice(dump.args.indexOf("pg_dump")), [
      "pg_dump",
      "-U",
      "ocw_migrator",
      "-d",
      "ocw",
      "-Fc",
    ]);
    assert.equal(dump.env.PGPASSWORD, SECRETS.OCW_DB_MIGRATOR_PASSWORD);
    for (const c of calls) {
      for (const v of Object.values(SECRETS))
        assert.ok(!c.args.join(" ").includes(v), "a secret reached argv");
    }
    // The cell is paused only around its own copy.
    const stop = calls.findIndex((c) => c.args.join(" ") === "stop openclaw");
    const tar = calls.findIndex((c) => c.args.includes("tar"));
    const start = calls.findIndex((c) => c.args.join(" ") === "start openclaw");
    assert.ok(stop >= 0 && stop < tar && tar < start, "openclaw stopped for the copy, then started");
  });

  it("prints and stores no value from the env file", async () => {
    const out = await makeBackup();
    const text = `${lines.join("\n")}\n${readFileSync(path.join(out, "manifest.json"), "utf8")}`;
    for (const [k, v] of Object.entries(SECRETS)) assert.ok(!text.includes(v), `${k}'s value appears`);
    assert.ok(!existsSync(path.join(out, ".env")));
  });

  it("--consistent stops api, web and openclaw before the dump and starts them after, even on failure", async () => {
    const out = path.join(root, "c1");
    await backup(["--env-file", envFile, "--out", out, "--consistent"], { runner: fakeRunner(), log });
    const seq = calls.map((c) => c.args.join(" "));
    const stop = seq.indexOf("stop api web openclaw");
    const dump = seq.findIndex((s) => s.includes("pg_dump"));
    const start = seq.indexOf("start api web openclaw");
    assert.ok(stop >= 0 && stop < dump && dump < start);
    assert.equal(seq.filter((s) => s === "stop openclaw").length, 0, "no second pause of the cell");

    calls = [];
    await assert.rejects(
      backup(["--env-file", envFile, "--out", path.join(root, "c2"), "--consistent"], {
        runner: fakeRunner({ fail: (s) => s.includes("pg_dump") }),
        log,
      }),
      /pg_dump failed/,
    );
    assert.equal(calls.at(-1).args.join(" "), "start api web openclaw");
  });

  it("refuses the demo's project before any Docker call", async () => {
    writeEnv(envFile, { COMPOSE_PROJECT_NAME: "t3code-81d72154" });
    await assert.rejects(makeBackup(), /running demo/);
    assert.equal(calls.length, 0);
  });
});

describe("ocw restore", () => {
  const order = () => calls.map((c) => c.args.join(" "));

  it("without --yes exits non-zero and runs nothing", async () => {
    const out = await makeBackup();
    calls = [];
    await assert.rejects(restore([out, "--env-file", envFile], { runner: fakeRunner(), log }), /--yes/);
    assert.equal(calls.length, 0);
    const res = spawnSync(process.execPath, ["--", OCW, "restore", out, "--env-file", envFile], {
      encoding: "utf8",
    });
    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, /--yes/);
  });

  for (const victim of ["db.dump", "openclaw-state.tar", "objects.json", "object"]) {
    it(`a changed byte in ${victim} → checksum error naming it, nothing run`, async () => {
      const out = await makeBackup();
      calls = [];
      const file = victim === "object" ? path.join(out, "objects", sha(OBJECT.key)) : path.join(out, victim);
      const bytes = readFileSync(file);
      bytes[bytes.length - 1] ^= 0x01;
      writeFileSync(file, bytes);
      const name = victim === "object" ? `objects/${sha(OBJECT.key)}` : victim;
      await assert.rejects(
        restore([out, "--yes", "--env-file", envFile], { runner: fakeRunner(), log }),
        (err) => err.message.includes("checksum mismatch") && err.message.includes(name),
      );
      assert.equal(calls.length, 0);
    });
  }

  it("a backup from a newer release (unknown migration) is refused", async () => {
    const out = await makeBackup("b1", {
      migrations: [...LOCAL_MIGRATIONS, "29991231000000_from_the_future"],
    });
    calls = [];
    await assert.rejects(
      restore([out, "--yes", "--env-file", envFile], { runner: fakeRunner(), log }),
      /made by a newer release.*29991231000000_from_the_future/,
    );
    assert.equal(calls.length, 0);
  });

  it("an unknown manifest format, or a manifest naming an unknown file, is refused", async () => {
    const out = await makeBackup();
    calls = [];
    rewriteManifest(out, (m) => ({ ...m, format: 2 }));
    await assert.rejects(
      restore([out, "--yes", "--env-file", envFile], { runner: fakeRunner(), log }),
      /format 2/,
    );
    rewriteManifest(out, (m) => ({ ...m, format: 1, files: { ...m.files, "../.env": "0".repeat(64) } }));
    await assert.rejects(
      restore([out, "--yes", "--env-file", envFile], { runner: fakeRunner(), log }),
      /unknown file/,
    );
    assert.equal(calls.length, 0);
  });

  it("an older backup (a subset of this release's migrations) restores in the verified order, as ocw_migrator", async () => {
    const out = await makeBackup("b1", { migrations: LOCAL_MIGRATIONS.slice(0, 14) });
    calls = [];
    await restore([out, "--yes", "--env-file", envFile], { runner: fakeRunner(), log });
    const seq = order();
    const at = (pred) => seq.findIndex(pred);
    const steps = [
      at((s) => s === "stop api web openclaw"),
      at((s) => s === "up -d --wait postgres redis garage"),
      at((s) => s === "run --rm migrate"),
      at((s) => s.includes("DROP SCHEMA IF EXISTS app, auth, drizzle CASCADE")),
      at((s) => s.includes("pg_restore")),
      seq.lastIndexOf("run --rm migrate"),
      at((s) => s.includes("object-store.ts import /backup --delete-extra")),
      at((s) => s.includes("tar -C /home/node/.openclaw -xf -") || s.includes("-xf -")),
      seq.lastIndexOf("up -d --wait"),
    ];
    for (const [i, idx] of steps.entries()) assert.ok(idx >= 0, `step ${i} missing: ${seq.join(" | ")}`);
    assert.deepEqual(
      [...steps].sort((a, b) => a - b),
      steps,
      seq.join(" | "),
    );
    assert.ok(steps[2] < steps[5], "migrate runs before and after the restore");
    const drop = calls[steps[3]];
    const pgRestore = calls[steps[4]];
    for (const c of [drop, pgRestore]) {
      assert.ok(c.args.includes("ocw_migrator"));
      assert.equal(c.env.PGPASSWORD, SECRETS.OCW_DB_MIGRATOR_PASSWORD);
    }
    assert.ok(pgRestore.args.includes("--single-transaction") && pgRestore.args.includes("--exit-on-error"));
    assert.equal(typeof pgRestore.stdin, "number", "the dump is streamed on stdin");
    for (const l of lines) for (const v of Object.values(SECRETS)) assert.ok(!l.includes(v));
  });

  it("never reaches the demo: its project, its env file or the demo directory's default project", async () => {
    const out = await makeBackup();
    calls = [];
    writeEnv(envFile, { COMPOSE_PROJECT_NAME: "t3code-81d72154" });
    await assert.rejects(
      restore([out, "--yes", "--env-file", envFile], { runner: fakeRunner(), log }),
      /running demo/,
    );

    const demoEnv = path.join(root, ".env.demo");
    writeEnv(demoEnv, { COMPOSE_PROJECT_NAME: "ocw-not-the-demo" });
    await assert.rejects(
      restore([out, "--yes", "--env-file", demoEnv], { runner: fakeRunner(), log }),
      /running demo/,
    );

    const demoDir = path.join(root, "t3code-81d72154");
    mkdirSync(demoDir);
    const noProject = path.join(root, "no-project.env");
    writeFileSync(noProject, "OCW_DB_MIGRATOR_PASSWORD=x\n");
    await assert.rejects(
      restore([out, "--yes", "--env-file", noProject], { runner: fakeRunner(), log, projectDir: demoDir }),
      /running demo/,
    );
    assert.equal(calls.length, 0);
  });
});
