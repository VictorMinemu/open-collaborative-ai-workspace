#!/usr/bin/env node
// Gate step: backup → change → restore on a real compose stack (SELF-04, D-03, D-18). Seeds an admin, a member, a
// channel with two messages and an image attachment, and a marker in the cell's state volume; takes `ocw backup`;
// deletes a message, posts another with a new attachment, removes the first attachment's objects and the marker;
// `ocw restore --yes` must bring back exactly the backed-up state (rows, bytes, sign-in, migrations, cell state) with
// RLS and the role split intact. Then the same backup onto brand-new volumes (`down -v` + `up`), and finally row
// counts, sign-in and the download must be identical across `docker compose up -d --force-recreate --wait`.
// `runVault(ctx)` (vault profile on, 07-10): `ocw backup` also takes OpenBao's data and secrets/; after `down -v` and
// with secrets/ gone (a new machine with only .env), `ocw restore` brings back an api that boots on openbao://
// references, the same sessions (same BETTER_AUTH_SECRET) and the same rows. Behind the proxy profile, Caddy's local
// root is trusted for this process (and again after fresh volumes, which give Caddy a new root).
//
//   node scripts/gate/backup-roundtrip.mjs --up [--run-id <id>] [--keep]   own gate stack (lib.mjs withGateStack)
//   node scripts/gate/backup-roundtrip.mjs --attach <envFile>              a stack left by --keep
//
// Only ever runs `ocw backup` / `ocw restore` with --env-file pointing at the gate stack's temp env file; backups go
// to a temp dir that is removed afterwards. stdout: one JSON summary; exit 0 = every check ok.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  ADMIN,
  ApiClient,
  behindProxy,
  demoSnapshot,
  diffDemo,
  ensureAdmin,
  newRunId,
  REPO_ROOT,
  trustCaddyRoot,
  withGateStack,
} from "./lib.mjs";

const OCW = path.join(REPO_ROOT, "scripts", "ocw.mjs");
const CELL_DIR = "/home/node/.openclaw";
const MARKER = `${CELL_DIR}/ocw-gate-backup-marker`;
/** A 1×1 PNG (the API sniffs and keeps image/png). */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
/** Lists the bucket's keys (after deleting those under OCW_GATE_DELETE_PREFIX, when set), inside the api image. */
const S3_SCRIPT = `
import { DeleteObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
const e = process.env;
const s3 = new S3Client({ endpoint: e.OCW_S3_ENDPOINT, region: e.OCW_S3_REGION, forcePathStyle: true,
  credentials: { accessKeyId: e.OCW_S3_ACCESS_KEY_ID, secretAccessKey: e.OCW_S3_SECRET_ACCESS_KEY },
  requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });
const Bucket = e.OCW_S3_BUCKET;
const keys = [];
let t;
do {
  const p = await s3.send(new ListObjectsV2Command({ Bucket, ContinuationToken: t }));
  for (const o of p.Contents ?? []) keys.push(o.Key);
  t = p.IsTruncated ? p.NextContinuationToken : undefined;
} while (t);
const prefix = e.OCW_GATE_DELETE_PREFIX;
if (prefix) for (const Key of keys.filter((k) => k.startsWith(prefix))) await s3.send(new DeleteObjectCommand({ Bucket, Key }));
console.log(JSON.stringify(keys.filter((k) => !prefix || !k.startsWith(prefix)).sort()));
`;

/** Docker's environment for the CLI: nothing inherited that could redirect compose (OCW_*, COMPOSE_*). */
function cliEnv() {
  const env = {};
  for (const k of [
    "PATH",
    "HOME",
    "USER",
    "TMPDIR",
    "LANG",
    "DOCKER_HOST",
    "DOCKER_CONFIG",
    "DOCKER_CONTEXT",
  ]) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return env;
}

/** `pnpm ocw <args>` against the gate stack; its output goes to stderr (stdout stays the JSON summary). */
function ocw(args) {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, ["--", OCW, ...args], {
    cwd: REPO_ROOT,
    env: cliEnv(),
    encoding: "utf8",
    timeout: 45 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  process.stderr.write(res.stdout ?? "");
  process.stderr.write(res.stderr ?? "");
  return { status: res.status, ms: Date.now() - t0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function modes(dir) {
  const bad = [];
  const walk = (d) => {
    if ((statSync(d).mode & 0o777) !== 0o700) bad.push(`${path.relative(dir, d) || "."} dir`);
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if ((statSync(p).mode & 0o777) !== 0o600) bad.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return bad;
}

const sqlId = (id) => {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`not a uuid: ${id}`);
  return `'${id}'`;
};

async function api(client, method, pathname, body) {
  const res = await client.request(method, pathname, body);
  if (res.status !== 200)
    throw new Error(`${method} ${pathname} → ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** presign → PUT to object storage → complete; returns the attachment id. */
async function upload(client, conversationId, filename) {
  const presign = await api(client, "POST", `/api/v1/conversations/${conversationId}/attachments`, {
    filename,
    contentType: "image/png",
    size: PNG.length,
  });
  const put = await fetch(presign.upload.url, { method: "PUT", headers: presign.upload.headers, body: PNG });
  if (put.status !== 200) throw new Error(`PUT to object storage → ${put.status}`);
  const done = await api(client, "POST", `/api/v1/attachments/${presign.attachment.id}/complete`);
  if (done.status !== "ready") throw new Error(`attachment ${done.status}`);
  return presign.attachment.id;
}

/**
 * Retries `fn` while a port is not answering yet (`fetch failed`: Docker's port forward or Garage's S3 listener right
 * after a container start; Garage has no healthcheck for `--wait`). Any HTTP answer is final. Bounded at 60 s.
 */
async function reachable(what, fn, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const cause = err?.cause?.code ?? err?.cause?.message ?? "";
      if (!(err instanceof TypeError) || Date.now() >= deadline) {
        throw new Error(`${what}: ${err.message}${cause ? ` (${cause})` : ""}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/** The attachment's bytes through the API's authorized 302 (null when storage answers anything but 200). */
async function download(client, id) {
  const cookie = [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await reachable("api download", () =>
    fetch(`${client.baseUrl}/api/v1/attachments/${id}/download`, {
      redirect: "manual",
      headers: { origin: client.origin, cookie },
    }),
  );
  await res.arrayBuffer();
  if (res.status !== 302) return null;
  const obj = await reachable("object storage", () => fetch(res.headers.get("location")));
  const bytes = Buffer.from(await obj.arrayBuffer());
  return obj.status === 200 ? bytes : null;
}

async function signIn(ctx, user) {
  const client = new ApiClient(ctx.urls.api, ctx.env.OCW_PUBLIC_WEB_URL || ctx.urls.web);
  const res = await reachable("api sign-in", () =>
    client.request("POST", "/api/auth/sign-in/email", { email: user.email, password: user.password }),
  );
  return res.status === 200 ? client : null;
}

/** Bucket keys (after removing those under `deletePrefix`), read through the S3 API inside the api image. */
function bucketKeys(ctx, deletePrefix) {
  const res = ctx.compose(
    [
      "run",
      "--rm",
      "--no-deps",
      "-T",
      ...(deletePrefix ? ["-e", `OCW_GATE_DELETE_PREFIX=${deletePrefix}`] : []),
      "api",
      "node",
      "--input-type=module",
      "-e",
      S3_SCRIPT,
    ],
    { check: true, timeoutMs: 5 * 60_000 },
  );
  return JSON.parse(res.stdout.trim().split("\n").at(-1));
}

function cell(ctx, script) {
  return ctx.compose(["exec", "-T", "openclaw", "sh", "-c", script], { timeoutMs: 60_000 });
}

/** Rows the backup must bring back exactly, read as the postgres superuser. */
function snapshot(ctx, s) {
  const q = (sql) => ctx.psql(sql).trim();
  return {
    messages: q(
      `select id || '|' || (deleted_at is null) || '|' || md5(body) from app.messages where conversation_id = ${sqlId(s.channelId)} order by seq`,
    ),
    attachments: q(
      `select id || '|' || status || '|' || coalesce(message_id::text, '-') from app.attachments where conversation_id = ${sqlId(s.channelId)} order by created_at, id`,
    ),
    users: q(
      `select email from auth."user" where email in ('${ADMIN.email}', '${s.member.email}') order by email`,
    ),
    members: q(`select count(*) from app.org_members`),
    migrations: q(`select name || ':' || hash from drizzle.__drizzle_migrations order by id`),
    policies: q(`select count(*) from pg_policies`),
    forcedRls: q(
      `select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relkind = 'r' and c.relforcerowsecurity`,
    ),
    // 07.6 (ADR-0028): the job queue's schema comes back with every queue, so the API boots after a restore.
    jobQueue: q(
      `select (select version from pgboss.version) || ':' || (select string_agg(name, ',' order by name) from pgboss.queue where name not like '\\_\\_pgboss%')`,
    ),
  };
}

/** Row counts that must not change across a container recreate. */
function counts(ctx) {
  return ctx
    .psql(
      `select (select count(*) from auth."user") || ',' || (select count(*) from app.org_members) || ',' ||
        (select count(*) from app.conversations) || ',' || (select count(*) from app.messages) || ',' ||
        (select count(*) from app.attachments) || ',' || (select count(*) from drizzle.__drizzle_migrations)`,
    )
    .trim();
}

/** `ocw_app` without a tenant context must see no organization rows (RLS, FORCE). */
function appRoleRows(ctx) {
  const res = ctx.compose(
    [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "ocw_app",
      "-d",
      "ocw",
      "-X",
      "-At",
      "-c",
      "select count(*) from app.org_members",
    ],
    { check: true },
  );
  return Number(res.stdout.trim());
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The step (gate convention): pushes one entry per check to ctx.steps. */
export async function run(ctx) {
  const checks = [];
  const check = async (name, fn) => {
    const t0 = Date.now();
    let res;
    try {
      res = await fn();
    } catch (err) {
      res = { ok: false, error: String(err.message ?? err).slice(0, 2000) };
    }
    const { ok, ...details } = res;
    const step = { name, ok: ok === true, ms: Date.now() - t0, details };
    checks.push(step);
    ctx.steps.push(step);
    return step.ok;
  };
  const tmp = mkdtempSync(path.join(tmpdir(), "ocw-gate-backup-"));
  const b1 = path.join(tmp, "b1");
  const tag = randomBytes(3).toString("hex");
  const s = {
    member: { name: "Backup Member", email: `backup-${tag}@ocw.test`, password: `backup-pw-${tag}-123456` },
  };
  const restore = () => ocw(["restore", b1, "--yes", "--env-file", ctx.envFile]);
  try {
    // Presigned object URLs point at the https origin when the stack runs behind Caddy.
    if (behindProxy(ctx)) await trustCaddyRoot(ctx);
    const seeded = await check("seed", async () => {
      const { client: admin } = await ensureAdmin(ctx);
      s.admin = admin;
      const inv = await api(admin, "POST", "/api/v1/invitations", {
        email: s.member.email,
        role: "developer",
      });
      const anon = new ApiClient(ctx.urls.api, ctx.env.OCW_PUBLIC_WEB_URL || ctx.urls.web);
      await api(anon, "POST", `/api/v1/invitations/${inv.id}/accept`, {
        name: s.member.name,
        password: s.member.password,
      });
      const member = await signIn(ctx, s.member);
      if (!member) throw new Error("member sign-in failed");
      s.channelId = (
        await api(admin, "POST", "/api/v1/channels", { name: `backup-${tag}`, visibility: "public" })
      ).id;
      await api(member, "POST", `/api/v1/channels/${s.channelId}/join`);
      const post = (client, body, attachmentIds) =>
        api(client, "POST", `/api/v1/conversations/${s.channelId}/messages`, {
          body,
          clientMessageId: randomBytes(16).toString("hex"),
          ...(attachmentIds ? { attachmentIds } : {}),
        });
      s.post = post;
      s.msg1 = (await post(admin, `first message ${tag}`)).id;
      s.att1 = await upload(admin, s.channelId, `dot-${tag}.png`);
      s.msg2 = (await post(admin, `second message, with a picture ${tag}`, [s.att1])).id;
      const orgId = ctx
        .psql(`select organization_id from app.conversations where id = ${sqlId(s.channelId)}`)
        .trim();
      s.att1Prefix = `org/${orgId}/conv/${s.channelId}/att/${s.att1}/`;
      const bytes = await download(admin, s.att1);
      const marker = cell(ctx, `echo ${tag} > ${MARKER}`);
      s.before = snapshot(ctx, s);
      return {
        ok: bytes?.equals(PNG) === true && marker.status === 0,
        messages: s.before.messages.split("\n").length,
      };
    });
    if (!seeded) return summary(checks);

    await check("backup", async () => {
      const res = ocw(["backup", "--env-file", ctx.envFile, "--out", b1]);
      const files = res.status === 0 ? readdirSync(b1).sort() : [];
      const bad = res.status === 0 ? modes(b1) : [];
      const size = (f) => statSync(path.join(b1, f)).size;
      s.backupKeys = res.status === 0 ? bucketKeys(ctx) : [];
      const need = ["db.dump", "manifest.json", "objects", "objects.json", "openclaw-state.tar"];
      const printed = Object.entries(ctx.env).filter(
        ([k, v]) =>
          /PASSWORD|SECRET|KEY|TOKEN/.test(k) && v.length >= 8 && `${res.stdout}${res.stderr}`.includes(v),
      );
      return {
        ok:
          res.status === 0 &&
          need.every((f) => files.includes(f)) &&
          bad.length === 0 &&
          printed.length === 0,
        exit: res.status,
        ms: res.ms,
        files,
        ...(bad.length ? { badModes: bad } : {}),
        bytes:
          res.status === 0
            ? Object.fromEntries(["db.dump", "openclaw-state.tar"].map((f) => [f, size(f)]))
            : {},
        objects: s.backupKeys.length,
        secretsPrinted: printed.map(([k]) => k),
      };
    });

    await check("change", async () => {
      await api(s.admin, "DELETE", `/api/v1/messages/${s.msg1}`);
      s.att2 = await upload(s.admin, s.channelId, `later-${tag}.png`);
      s.msg3 = (await s.post(s.admin, `after the backup ${tag}`, [s.att2])).id;
      const left = bucketKeys(ctx, s.att1Prefix);
      const gone = (await download(s.admin, s.att1)) === null;
      const rm = cell(ctx, `rm -f ${MARKER}`);
      const changed = snapshot(ctx, s);
      return {
        ok: gone && rm.status === 0 && changed.messages !== s.before.messages,
        objectsNow: left.length,
      };
    });

    await check("restore", async () => {
      const res = restore();
      return { ok: res.status === 0, exit: res.status, ms: res.ms };
    });

    const verifyRestored = async (label) =>
      check(label, async () => {
        const after = snapshot(ctx, s);
        const admin = await signIn(ctx, ADMIN);
        const member = await signIn(ctx, s.member);
        const bytes = admin ? await download(admin, s.att1) : null;
        const keys = bucketKeys(ctx);
        const marker = cell(ctx, `cat ${MARKER}`);
        const appRows = appRoleRows(ctx);
        const result = {
          rowsIdentical: same(after, s.before),
          msg3Gone: !after.messages.includes(s.msg3),
          attachmentBytes: bytes?.equals(PNG) === true,
          adminSignIn: admin !== null,
          memberSignIn: member !== null,
          bucketEqualsBackup: same(keys, s.backupKeys),
          cellState: marker.status === 0 && marker.stdout.trim() === tag,
          appRoleSeesNoRowsWithoutTenant: appRows === 0,
          superuserSeesRows: Number(after.members) > 0,
        };
        const ok = Object.values(result).every(Boolean);
        return { ok, ...result, ...(ok ? {} : { before: s.before, after }) };
      });
    await verifyRestored("restored");

    await check("fresh-volumes", async () => {
      const down = ctx.compose(["down", "-v", "--remove-orphans", "--timeout", "30"], {
        timeoutMs: 10 * 60_000,
      });
      const up = ctx.compose(["up", "-d", "--wait", "--wait-timeout", "1200"], {
        stdio: ["ignore", 2, 2],
        timeoutMs: 1500 * 1000,
      });
      // A new caddy-data volume is a new local CA.
      if (behindProxy(ctx)) await trustCaddyRoot(ctx);
      const empty = (await signIn(ctx, ADMIN)) === null;
      const res = restore();
      return {
        ok: down.status === 0 && up.status === 0 && empty && res.status === 0,
        freshWasEmpty: empty,
        restoreMs: res.ms,
      };
    });
    await verifyRestored("restored-on-fresh-volumes");

    await check("consistent-backup", async () => {
      const res = ocw(["backup", "--consistent", "--env-file", ctx.envFile, "--out", path.join(tmp, "b2")]);
      const running = ctx
        .compose(["ps", "--services", "--status", "running"], { check: true })
        .stdout.split("\n")
        .map((l) => l.trim());
      const back = ["api", "web", "openclaw"].every((svc) => running.includes(svc));
      return { ok: res.status === 0 && back, exit: res.status, ms: res.ms, writersRunningAfter: back };
    });

    await check("force-recreate", async () => {
      const probe = async () => {
        const admin = await signIn(ctx, ADMIN);
        const bytes = admin ? await download(admin, s.att1) : null;
        return { counts: counts(ctx), signIn: admin !== null, download: bytes?.equals(PNG) === true };
      };
      const before = await probe();
      const t0 = Date.now();
      const up = ctx.compose(["up", "-d", "--force-recreate", "--wait", "--wait-timeout", "1200"], {
        stdio: ["ignore", 2, 2],
        timeoutMs: 1500 * 1000,
      });
      const recreateMs = Date.now() - t0;
      const after = await probe();
      return {
        ok: up.status === 0 && before.signIn && before.download && same(before, after),
        recreateMs,
        before,
        after,
      };
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return summary(checks);
}

/**
 * Vault profile round trip (07-10): with OpenBao holding the API-only secrets, a backup must be enough (with .env) to
 * bring the install back on a machine that has neither the volumes nor secrets/. Pushes one entry per check.
 */
export async function runVault(ctx) {
  const checks = [];
  const check = async (name, fn) => {
    const t0 = Date.now();
    let res;
    try {
      res = await fn();
    } catch (err) {
      res = { ok: false, error: String(err.message ?? err).slice(0, 2000) };
    }
    const { ok, ...details } = res;
    const step = { name, ok: ok === true, ms: Date.now() - t0, details };
    checks.push(step);
    ctx.steps.push(step);
    return step.ok;
  };
  const tmp = mkdtempSync(path.join(tmpdir(), "ocw-gate-vault-backup-"));
  const out = path.join(tmp, "v1");
  const sealFile = ctx.env.OCW_OPENBAO_SEAL_KEY_FILE ?? "";
  const secretsDir = path.dirname(sealFile);
  const s = {};
  try {
    const taken = await check("vault-backup", async () => {
      const profiles = (ctx.env.COMPOSE_PROFILES ?? "").split(",");
      if (!profiles.includes("vault") || !existsSync(sealFile)) {
        return { ok: false, error: "the vault profile is not on (run the vault step first)" };
      }
      if (behindProxy(ctx)) await trustCaddyRoot(ctx);
      // A session from before the backup: it must survive the restore (BETTER_AUTH_SECRET comes back from OpenBao).
      s.session = await signIn(ctx, ADMIN);
      if (!s.session) return { ok: false, error: "admin sign-in failed before the backup" };
      s.counts = counts(ctx);
      s.seal = readFileSync(sealFile);
      const res = ocw(["backup", "--env-file", ctx.envFile, "--out", out]);
      const manifest =
        res.status === 0 ? JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8")) : {};
      const files = Object.keys(manifest.files ?? {}).sort();
      const bad = res.status === 0 ? modes(out) : [];
      const printed = Object.entries(ctx.env).filter(
        ([k, v]) =>
          /PASSWORD|SECRET|KEY|TOKEN/.test(k) &&
          !v.startsWith("openbao://") &&
          v.length >= 8 &&
          `${res.stdout}${res.stderr}`.includes(v),
      );
      return {
        ok:
          res.status === 0 &&
          manifest.components?.vault === true &&
          ["openbao-data.tar", "openbao-seal.key", "openbao-init.json"].every((f) => files.includes(f)) &&
          readFileSync(path.join(out, "openbao-seal.key")).equals(s.seal) &&
          bad.length === 0 &&
          printed.length === 0,
        exit: res.status,
        ms: res.ms,
        files,
        components: manifest.components,
        ...(bad.length ? { badModes: bad } : {}),
        openbaoBytes: res.status === 0 ? statSync(path.join(out, "openbao-data.tar")).size : 0,
        secretsPrinted: printed.map(([k]) => k),
      };
    });
    if (!taken) return vaultSummary(checks);

    await check("vault-new-machine", async () => {
      // Nothing but .env survives: every volume (openbao-data included) and the secrets/ directory are gone.
      const down = ctx.compose(["down", "-v", "--remove-orphans", "--timeout", "30"], {
        timeoutMs: 10 * 60_000,
      });
      renameSync(secretsDir, `${secretsDir}.gone`);
      rmSync(`${secretsDir}.gone`, { recursive: true, force: true });
      const volumes = ctx
        .docker(["volume", "ls", "-q", "--filter", `name=${ctx.project}_`], { check: true })
        .stdout.split("\n")
        .filter(Boolean);
      return {
        ok: down.status === 0 && volumes.length === 0 && !existsSync(secretsDir),
        volumesLeft: volumes.length,
        secretsDirGone: !existsSync(secretsDir),
      };
    });

    await check("vault-restore", async () => {
      const res = ocw(["restore", out, "--yes", "--env-file", ctx.envFile]);
      return { ok: res.status === 0, exit: res.status, ms: res.ms };
    });

    await check("vault-restored", async () => {
      if (behindProxy(ctx)) await trustCaddyRoot(ctx);
      ctx.reload();
      const refs = ["BETTER_AUTH_SECRET", "OCW_ENCRYPTION_KEY", "OCW_SETUP_TOKEN"].every((k) =>
        ctx.env[k]?.startsWith("openbao://"),
      );
      const health = await reachable("api health", async () => {
        const r = await fetch(`${ctx.urls.api}/health`, { signal: AbortSignal.timeout(10_000) });
        await r.arrayBuffer();
        return r.status;
      });
      const oldSession = await s.session.request("GET", "/api/v1/me");
      const fresh = await signIn(ctx, ADMIN);
      const sealBack = existsSync(sealFile) && readFileSync(sealFile).equals(s.seal);
      const sealMode = existsSync(sealFile) ? (statSync(sealFile).mode & 0o777).toString(8) : "missing";
      const initBack = existsSync(path.join(secretsDir, "openbao-init.json"));
      const after = counts(ctx);
      const result = {
        envStillReferencesOnly: refs,
        apiHealth: health === 200,
        sessionFromBeforeValid: oldSession.status === 200,
        freshSignIn: fresh !== null,
        sealKeyRestored: sealBack,
        sealKeyMode600: sealMode === "600",
        initMaterialRestored: initBack,
        rowsIdentical: after === s.counts,
      };
      return { ok: Object.values(result).every(Boolean), ...result, counts: after };
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return vaultSummary(checks);
}

function vaultSummary(checks) {
  return {
    name: "vault-backup",
    ok: checks.length === 4 && checks.every((c) => c.ok),
    details: { checks: checks.map((c) => c.name) },
  };
}

function summary(checks) {
  return {
    name: "backup-roundtrip",
    ok: checks.every((c) => c.ok),
    details: { checks: checks.map((c) => c.name) },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      up: { type: "boolean", default: false },
      attach: { type: "string" },
      keep: { type: "boolean", default: false },
      "run-id": { type: "string" },
    },
  });
  if (!values.up && !values.attach) {
    process.stderr.write("usage: backup-roundtrip.mjs --up [--keep] [--run-id ID] | --attach <envFile>\n");
    process.exitCode = 2;
    return;
  }
  const runId = values["run-id"] ?? newRunId();
  const steps = [];
  const started = Date.now();
  const before = await demoSnapshot();
  let error;
  let target = {};
  let result;
  try {
    await withGateStack({ runId, keep: values.keep, attachEnvFile: values.attach, steps }, async (ctx) => {
      target = { project: ctx.project, imageTag: ctx.imageTag };
      result = await run(ctx);
    });
  } catch (err) {
    error = String(err.message ?? err).slice(0, 2000);
  }
  const diff = diffDemo(before, await demoSnapshot());
  steps.push({
    name: "demo-untouched",
    ok: diff.length === 0,
    ...(diff.length ? { details: { diff } } : {}),
  });
  const ok = !error && result?.ok === true && steps.every((s) => s.ok);
  const out = { ok, runId, ...target, totalMs: Date.now() - started, steps, ...(error ? { error } : {}) };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
