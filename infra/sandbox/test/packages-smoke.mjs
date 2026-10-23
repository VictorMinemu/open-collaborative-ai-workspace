// The real-Docker sandbox packages smoke's driver (07.8-17), started by run-packages-smoke.sh after it built the images
// and started the fake registries. It runs sandboxd as its own child process (a host process on 127.0.0.1 and a free
// port) and drives it only through its HTTP API, as the API does; `docker` is used only to connect the fixtures to the
// proxy (as the stack smoke does), to republish through the fake's control route and to look at what sandboxd built.
//
//   node packages-smoke.mjs --ns <ns> --work <dir> --fixtures <net> --fake <container> --sbx <img> --egress <img>
//                           [--only npm|all]
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { openSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const NS = opt("--ns");
const WORK = opt("--work");
const NET_FIX = opt("--fixtures");
const FAKE = opt("--fake");
const IMAGES = { sbx: opt("--sbx"), egress: opt("--egress") };
const ONLY = opt("--only") ?? "all";

const REGISTRY = "registry.fake.test:8080";
const TOKEN = randomBytes(32).toString("hex");
const MiB = 1024 * 1024;

let checks = 0;
let failures = 0;
const log = (s) => process.stderr.write(`${s}\n`);
function ok(cond, what, detail = "") {
  checks += 1;
  if (cond) log(`ok   ${what}`);
  else {
    failures += 1;
    log(`FAIL ${what}${detail ? `: ${detail}` : ""}`);
  }
  return cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- docker (observation and fixtures only)

function docker(...a) {
  const r = spawnSync("docker", a, { encoding: "utf8" });
  return { status: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}
const EGRESS = `ocw-egress-${NS}`;
function republish(source, name, version) {
  const body = JSON.stringify({ source, name, version });
  const r = docker(
    "exec",
    FAKE,
    "node",
    "-e",
    `fetch("http://127.0.0.1:8080/__control/republish",{method:"POST",body:${JSON.stringify(body)}}).then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))`,
  );
  return r.status === 0;
}
/** Objects of a kind sandboxd made for package runs in this namespace (they must be gone after each run). */
function runObjects() {
  const out = [];
  for (const kind of ["installer", "review"]) {
    const f = ["--filter", `label=ocw.namespace=${NS}`, "--filter", `label=ocw.kind=${kind}`];
    out.push(
      ...docker("ps", "-aq", ...f)
        .out.split("\n")
        .filter(Boolean),
    );
    out.push(
      ...docker("network", "ls", "-q", ...f)
        .out.split("\n")
        .filter(Boolean),
    );
    out.push(
      ...docker("volume", "ls", "-q", ...f)
        .out.split("\n")
        .filter(Boolean),
    );
  }
  return out;
}

// ---------------------------------------------------------------- sandboxd as a child process

let sandboxd = null;
let PORT = 0;
const LOG = join(WORK, "sandboxd.log");

async function startSandboxd() {
  const fd = openSync(LOG, "a");
  sandboxd = spawn("node", ["--import", "tsx", "apps/sandboxd/src/main.ts"], {
    stdio: ["ignore", fd, fd],
    env: {
      ...process.env,
      OCW_SANDBOX_TOKEN: TOKEN,
      OCW_SANDBOX_NAMESPACE: NS,
      OCW_SANDBOXD_HOST: "127.0.0.1",
      OCW_SANDBOXD_PORT: "0",
      OCW_SANDBOX_RUNTIME: "auto",
      OCW_SANDBOX_SBX_IMAGE: IMAGES.sbx,
      OCW_SANDBOX_EGRESS_IMAGE: IMAGES.egress,
      OCW_SANDBOXD_SWEEP_MS: "60000",
      OCW_SANDBOX_NPM_REGISTRY: `http://${REGISTRY}/npm/`,
      OCW_SANDBOX_PYPI_INDEX: `http://${REGISTRY}/simple/`,
      OCW_CLAWHUB_URL: `http://${REGISTRY}`,
      OCW_SANDBOX_REGISTRIES: REGISTRY,
    },
  });
  writeFileSync(join(WORK, "sandboxd.pid"), String(sandboxd.pid));
  for (let i = 0; i < 150; i++) {
    const text = readFileSync(LOG, "utf8");
    for (const line of text.split("\n")) {
      try {
        const j = JSON.parse(line);
        if (j.msg === "listening") PORT = j.port;
      } catch {}
    }
    if (PORT) return;
    if (sandboxd.exitCode !== null) throw new Error("sandboxd exited");
    await sleep(200);
  }
  throw new Error("sandboxd did not listen");
}

async function stopSandboxd() {
  const p = sandboxd;
  if (!p || p.exitCode !== null) return;
  const done = new Promise((r) => p.on("exit", r));
  p.kill("SIGTERM");
  await Promise.race([done, sleep(8000)]);
}

async function post(path, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, body: json };
}
const codeOf = (r) => r.body?.error?.code ?? `status ${r.status}`;

// ---------------------------------------------------------------- the API's view

const ORG = randomUUID();
const A = randomUUID();
const B = randomUUID();
const C = randomUUID();
const tA = { orgId: ORG, agentId: A };
const tB = { orgId: ORG, agentId: B };
const tC = { orgId: ORG, agentId: C };
let version = 1;

function policy(over = {}) {
  return {
    orgId: ORG,
    // The bot's shell has no egress at all: installs still reach the registries (their own policy, P-12).
    sandboxEgress: "off",
    browserEgress: "off",
    allowHosts: [],
    privateHosts: [REGISTRY],
    limits: {
      nanoCpus: 1e9,
      memoryBytes: 1024 * MiB,
      pids: 256,
      diskQuotaBytes: 2048 * MiB,
      idleStopMs: 900_000,
    },
    browserLimits: {
      nanoCpus: 1e9,
      memoryBytes: 1024 * MiB,
      pids: 256,
      diskQuotaBytes: 2048 * MiB,
      idleStopMs: 300_000,
    },
    killed: false,
    version: version++,
    ...over,
  };
}

async function exec(target, argv) {
  const r = await post("/v1/sandboxes/exec", { target, argv, cwd: "", timeoutMs: 60_000, yieldMs: 25_000 });
  if (r.status !== 200) return { exitCode: -1, stdout: "", stderr: codeOf(r) };
  return r.body;
}
const sh = (target, script) => exec(target, ["sh", "-c", script]);
const volumeOf = async (target) => (await sh(target, "ls -A /opt/ocw-packages")).stdout.trim();

const canonical = (entries) => {
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const sorted = [...entries].sort(
    (x, y) => cmp(x.name, y.name) || cmp(x.version, y.version) || cmp(x.integrity, y.integrity),
  );
  return JSON.stringify(sorted.map((e) => ({ name: e.name, version: e.version, integrity: e.integrity })));
};
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

const review = (source, name, v) => post("/v1/packages/review", { orgId: ORG, source, name, version: v });
const asInstall = (id, r) => ({
  id,
  source: r.source,
  name: r.name,
  version: r.version,
  sha256: r.sha256,
  treeSha256: r.treeSha256,
  lockfile: r.lockfile,
});
const install = (target, pkg) => post("/v1/packages/install", { target, packages: [pkg] });

// ---------------------------------------------------------------- sections

async function sectionNpm() {
  log("--- npm");
  const r = await review("npm", "ocw-smoke-cli", "1.0.0");
  if (!ok(r.status === 200, "packageReview npm ocw-smoke-cli 1.0.0", JSON.stringify(r.body))) return null;
  const rv = r.body;
  ok(rv.entries.length === 2 && rv.dependencyCount === 1, "the whole tree: two entries, dependencyCount 1");
  ok(
    rv.entries.every((e) => /^sha512-/.test(e.integrity)),
    "every entry pinned by sha512",
  );
  ok(rv.hasInstallScript === true, "the postinstall is reported (hasInstallScript)");
  ok(rv.treeSha256 === sha256(canonical(rv.entries)), "treeSha256 is sha256(packageTreeCanonical(entries))");
  ok(
    JSON.parse(rv.lockfile).packages?.["node_modules/ocw-smoke-dep"]?.version === "1.0.0",
    "the lockfile pins the dependency",
  );
  ok(
    rv.license === "MIT" && rv.publisher === "ocw-smoke",
    "license and publisher (no email)",
    `${rv.license} ${rv.publisher}`,
  );
  ok(runObjects().length === 0, "the review container, network and scratch volume are gone");

  const npmId = randomUUID();
  const pkg = asInstall(npmId, rv);
  const inst = await install(tA, pkg);
  ok(
    inst.status === 200 && inst.body?.results?.[0]?.status === "installed",
    "packageInstall for A from the recorded lockfile",
    JSON.stringify(inst.body),
  );
  const v = await exec(tA, ["ocw-smoke-cli", "--version"]);
  ok(
    v.exitCode === 0 && v.stdout.trim() === "1.0.0",
    "A's exec runs the package's bin: --version → 1.0.0",
    JSON.stringify(v),
  );
  const hi = await exec(tA, ["ocw-smoke-cli", "world"]);
  ok(hi.stdout.trim() === "hello world", "the CLI's call into its dependency works", JSON.stringify(hi));
  const req = await exec(tA, ["node", "-e", 'console.log(require("ocw-smoke-cli/package.json").version)']);
  ok(req.stdout.trim() === "1.0.0", "NODE_PATH finds the approved package");
  const marker = await exec(tA, ["cat", "/opt/ocw-packages/node_modules/ocw-smoke-cli/postinstall-ran"]);
  let m = null;
  try {
    m = JSON.parse(marker.stdout);
  } catch {}
  ok(
    m !== null && m.uid === 10001 && String(m.cwd).startsWith("/staging/pkg/") && m.host !== hostname(),
    "the postinstall ran in the installer (staging, uid 10001), not in sandboxd's process",
    marker.stdout,
  );
  const ro = await sh(tA, "touch /opt/ocw-packages/x");
  const ro2 = await sh(tA, `touch /opt/ocw-packages/pkgs/${npmId}/x`);
  ok(ro.exitCode !== 0 && ro2.exitCode !== 0, "the packages volume is read-only in sbx");
  const pathOrder = await exec(tA, ["sh", "-c", 'echo "$PATH"']);
  ok(pathOrder.stdout.trim().endsWith(":/opt/ocw-packages/bin"), "package bins come after the system paths");

  await post("/v1/sandboxes/ensure", { target: tB });
  const bSees = await sh(tB, "command -v ocw-smoke-cli || echo none");
  ok(bSees.stdout.trim() === "none" && (await volumeOf(tB)) === "", "bot B does not see A's package");

  const again = await install(tA, pkg);
  ok(again.body?.results?.[0]?.status === "installed", "a second install of the same id is idempotent");
  const [x, y] = await Promise.all([install(tA, pkg), install(tA, pkg)]);
  ok(
    x.body?.results?.[0]?.status === "installed" && y.body?.results?.[0]?.status === "installed",
    "two concurrent installs of one id both answer installed",
  );
  ok(
    (await sh(tA, "ls /opt/ocw-packages/pkgs")).stdout.trim() === npmId,
    "one copy of the package in A's volume",
  );

  // WINDOWS #233: a package pinned by sha1 only is reviewed (for the API to refuse) and never installed.
  const old = await review("npm", "ocw-smoke-old", "1.0.0");
  ok(
    old.status === 200 && /^sha1-/.test(old.body?.entries?.[0]?.integrity ?? ""),
    "a sha1-only package is reviewed with its sha1 entry",
    JSON.stringify(old.body),
  );
  const before = await volumeOf(tA);
  const weak = await install(tA, asInstall(randomUUID(), old.body));
  ok(
    weak.body?.results?.[0]?.status === "failed" && /sha1/.test(weak.body?.results?.[0]?.detail ?? ""),
    "a sha1-only install is refused with a clear reason",
    JSON.stringify(weak.body),
  );
  ok((await volumeOf(tA)) === before, "A's volume is unchanged after the sha1 refusal");

  await post("/v1/sandboxes/ensure", { target: tC });
  const forged = await install(tC, { ...pkg, id: randomUUID(), treeSha256: sha256("forged") });
  ok(
    forged.body?.results?.[0]?.code === "tree_changed",
    "a lockfile that is not the approved tree is tree_changed",
  );

  ok((await post("/v1/policy", policy({ killed: true }))).status === 200, "the organization is killed");
  const killed = await install(tC, { ...pkg, id: randomUUID() });
  ok(
    killed.status === 409 && codeOf(killed) === "killed",
    "the kill switch refuses an install",
    codeOf(killed),
  );
  ok((await post("/v1/policy", policy())).status === 200, "the organization is live again");
  await post("/v1/sandboxes/ensure", { target: tA });
  await post("/v1/sandboxes/ensure", { target: tC });

  // P-12: a dependency republished after approval.
  ok(
    republish("npm", "ocw-smoke-dep", "1.0.0"),
    "the fake registry republishes ocw-smoke-dep@1.0.0 with new bytes",
  );
  const moved = await install(tC, { ...pkg, id: randomUUID() });
  ok(
    moved.body?.results?.[0]?.status === "failed" && moved.body?.results?.[0]?.code === "digest_mismatch",
    "the approved lockfile now fails integrity: digest_mismatch",
    JSON.stringify(moved.body),
  );
  ok((await volumeOf(tC)) === "", "C's packages volume stays empty");
  const still = await exec(tA, ["ocw-smoke-cli", "world"]);
  ok(still.stdout.trim() === "hello world", "A's install is untouched");
  ok(runObjects().length === 0, "no installer container, network or scratch volume is left");
  return { npmId };
}

async function sectionPypi() {
  log("--- pypi");
  const r = await review("pypi", "ocw_smoke_py", "1.0.0");
  if (!ok(r.status === 200, "packageReview pypi ocw_smoke_py 1.0.0", JSON.stringify(r.body))) return null;
  const rv = r.body;
  ok(
    JSON.stringify(rv.entries.map((e) => e.name).sort()) ===
      JSON.stringify(["ocw-smoke-py", "ocw-smoke-pydep"]),
    "both distributions recorded",
  );
  ok(
    rv.entries.every((e) => /^sha256:[0-9a-f]{64}$/.test(e.integrity)),
    "each file's sha256 recorded",
  );
  ok(
    rv.lockfile
      .trim()
      .split("\n")
      .every((l) => /^[a-z0-9-]+==1\.0\.0 --hash=sha256:[0-9a-f]{64}$/.test(l)),
    "the requirement set has one hashed pin per file",
  );
  ok(rv.dependencyCount === 1 && rv.hasInstallScript === false, "dependencyCount 1, wheels only (no build)");
  const pyId = randomUUID();
  const pkg = asInstall(pyId, rv);
  const inst = await install(tA, pkg);
  ok(
    inst.body?.results?.[0]?.status === "installed",
    "install with --no-deps --require-hashes",
    JSON.stringify(inst.body),
  );
  const v = await exec(tA, ["python3", "-c", "import ocw_smoke_py; print(ocw_smoke_py.VERSION)"]);
  ok(v.stdout.trim() === "1.0.0", "A imports the package: VERSION 1.0.0", JSON.stringify(v));
  const g = await exec(tA, ["python3", "-c", "import ocw_smoke_py; print(ocw_smoke_py.greet('py'))"]);
  ok(g.stdout.trim() === "hello py", "and its dependency");
  ok(
    republish("pypi", "ocw-smoke-pydep", "1.0.0"),
    "the fake republishes ocw_smoke_pydep 1.0.0 with new bytes",
  );
  const moved = await install(tC, { ...pkg, id: randomUUID() });
  ok(
    moved.body?.results?.[0]?.code === "digest_mismatch",
    "the next install refuses: digest_mismatch",
    JSON.stringify(moved.body),
  );
  ok((await volumeOf(tC)) === "", "C's volume is unchanged");
  return { pyId };
}

async function sectionClawhub() {
  log("--- clawhub");
  const r = await review("clawhub", "ocw-smoke-skill", "1.0.0");
  if (!ok(r.status === 200, "packageReview clawhub ocw-smoke-skill 1.0.0", JSON.stringify(r.body)))
    return null;
  const rv = r.body;
  ok(rv.entries.length === 1 && rv.dependencyCount === 0, "a single tarball entry");
  ok(rv.publisher === "ocw-smoke", "publisher from ClawHub");
  const skillId = randomUUID();
  const pkg = asInstall(skillId, rv);
  const inst = await install(tA, pkg);
  ok(inst.body?.results?.[0]?.status === "installed", "the bundle installs", JSON.stringify(inst.body));
  const md = await exec(tA, ["cat", "/opt/ocw-packages/skills/ocw-smoke-skill/SKILL.md"]);
  ok(md.stdout.includes("OCW smoke skill"), "SKILL.md is readable from A's sandbox");
  ok(republish("clawhub", "ocw-smoke-skill", "1.0.0"), "the fake swaps the bundle's bytes");
  const moved = await install(tC, { ...pkg, id: randomUUID() });
  ok(
    moved.body?.results?.[0]?.code === "digest_mismatch",
    "a swapped tarball is digest_mismatch",
    JSON.stringify(moved.body),
  );
  ok((await volumeOf(tC)) === "", "C's volume is unchanged");
  return { skillId };
}

async function sectionRemove(ids) {
  log("--- remove");
  const r = await post("/v1/packages/remove", { target: tA, ids: [ids.npmId] });
  ok(
    r.status === 200 && r.body?.removed === 1,
    "packageRemove deletes the npm package",
    JSON.stringify(r.body),
  );
  const gone = await sh(tA, "command -v ocw-smoke-cli || echo none");
  ok(gone.stdout.trim() === "none", "its bin is gone");
  const py = await exec(tA, ["python3", "-c", "import ocw_smoke_py; print(ocw_smoke_py.VERSION)"]);
  ok(py.stdout.trim() === "1.0.0", "the PyPI package stays");
  const md = await exec(tA, ["cat", "/opt/ocw-packages/skills/ocw-smoke-skill/SKILL.md"]);
  ok(md.stdout.includes("OCW smoke skill"), "the skill stays");
  ok(runObjects().length === 0, "no installer is left after the removal");
}

// ---------------------------------------------------------------- the run

async function main() {
  await startSandboxd();
  ok(
    (await post("/v1/policy", policy())).status === 200,
    "policy pushed (shell egress off, registry a private host)",
  );
  const ensured = await post("/v1/sandboxes/ensure", { target: tA });
  ok(ensured.status === 200, "A's sandbox runs", JSON.stringify(ensured.body));
  // The proxy exists now (created on the first attach): give it the fixtures, as the stack smoke does.
  const connect = docker("network", "connect", NET_FIX, EGRESS);
  ok(connect.status === 0, "the fixtures network is connected to the egress proxy", connect.err);
  const pkgMount = JSON.parse(
    docker("inspect", `ocw-sbx-${NS}-${createHash("sha256").update(A).digest("hex").slice(0, 12)}`).out,
  )[0]?.Mounts?.find((mnt) => mnt.Destination === "/opt/ocw-packages");
  ok(pkgMount?.RW === false, "sbx mounts the packages volume read-only", JSON.stringify(pkgMount));

  const npm = await sectionNpm();
  if (ONLY === "all") {
    const py = await sectionPypi();
    const skill = await sectionClawhub();
    if (npm && py && skill) await sectionRemove({ ...npm, ...py, ...skill });
    else ok(false, "remove (needs npm, pypi and clawhub)");
  }
  await stopSandboxd();
  log(`${checks - failures}/${checks} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  log(`FAIL ${err instanceof Error ? err.message : String(err)}`);
  await stopSandboxd();
  process.exit(1);
});
