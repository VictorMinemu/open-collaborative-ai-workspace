import { createHash, randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import {
  type PackageTreeEntry,
  packageTreeCanonical,
  ReviewedTreeEntry,
  SANDBOX_LIMITS,
  SANDBOXD_LABELS,
  type SandboxdPackageInstall,
  type SandboxdPackageInstallResult,
  type SandboxdPackageRemove,
  type SandboxdPackageReviewRequest,
  type SandboxdPackageReviewResult,
  type SandboxdTarget,
  type SandboxPackageSource,
} from "@ocw/contracts";
import { z } from "zod";
import { type Docker, DockerUnavailableError, demux } from "./docker";
import type { Egress } from "./egress-attach";
import { OutputTail, SandboxdFailure } from "./sandboxes";
import {
  type DockerRuntime,
  installerSpec,
  PROXY_ENV,
  packageRunNames,
  packageRunNetworkSpec,
  reviewSpec,
  SANDBOX_USER,
  STAGING_DIR,
} from "./spec";

/**
 * Sandbox packages in sandboxd (07.8-17; D-03 as refined by D-11 F-3, P-12, SBX-04).
 *
 * - **Review** resolves the whole dependency tree of one exact (source, name, version) in a throwaway `review`
 *   container on its own network, through the egress proxy with a registries-only policy, with nothing persistent
 *   mounted: npm `install --package-lock-only --ignore-scripts`, PyPI `pip download` of the package and its
 *   dependencies, Debian's download-only closure, ClawHub's single tarball. It returns every (name, version,
 *   integrity) entry, the lockfile and `treeSha256` = sha256(packageTreeCanonical(entries)).
 * - **Install** works from the recorded set only, in a short-lived `installer` container with the bot's packages volume
 *   read-write: npm `ci` over the stored lockfile, pip `--no-deps --require-hashes`, a sha256 check of every Debian and
 *   ClawHub file. Everything lands in the run's scratch volume first; the tree is recomputed from what was downloaded
 *   and compared with the approved `treeSha256`; install scripts run only after that, still in the installer; only then
 *   is the package copied into the bot's volume. Any mismatch refuses (`digest_mismatch`, `tree_changed`) and the
 *   bot's volume is never written.
 * - sandboxd never executes downloaded code itself: every program below runs inside a container. The programs are
 *   constants; a package's name, version or lockfile reaches them only as separate argv items or on stdin, never in
 *   a shell string. Container output is untrusted: parsed with bounds, never logged, never returned as text.
 */

// ---------------------------------------------------------------- configuration

/** The production registries a review or installer run may reach (the configured ClawHub host is added). */
export const DEFAULT_REGISTRIES: readonly string[] = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "deb.debian.org",
  "security.debian.org",
];

export interface RegistryConfig {
  npmRegistry: string;
  pypiIndex: string;
  /** The same value the API uses (OCW_CLAWHUB_URL). */
  clawhubUrl: string;
  /** The egress allow-list of every review and installer run. */
  registries: string[];
}

/** An http(s) URL with no credentials, query or fragment. */
function registryUrl(value: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${what} is not a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${what} must be http(s)`);
  if (url.username || url.password || url.search || url.hash) throw new Error(`${what} must be a plain URL`);
  return url;
}

const HOST_ENTRY = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

/**
 * The registries from sandboxd's environment: `OCW_SANDBOX_NPM_REGISTRY`, `OCW_SANDBOX_PYPI_INDEX`, `OCW_CLAWHUB_URL`
 * and `OCW_SANDBOX_REGISTRIES` (comma list; overrides the allow-list, e.g. a fake registry in tests).
 */
export function registryConfig(env: Record<string, string | undefined>): RegistryConfig {
  const npm = registryUrl(
    env.OCW_SANDBOX_NPM_REGISTRY || "https://registry.npmjs.org/",
    "OCW_SANDBOX_NPM_REGISTRY",
  );
  const pypi = registryUrl(
    env.OCW_SANDBOX_PYPI_INDEX || "https://pypi.org/simple/",
    "OCW_SANDBOX_PYPI_INDEX",
  );
  const claw = registryUrl(env.OCW_CLAWHUB_URL || "https://clawhub.ai", "OCW_CLAWHUB_URL");
  let registries: string[];
  if (env.OCW_SANDBOX_REGISTRIES?.trim()) {
    registries = env.OCW_SANDBOX_REGISTRIES.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
    for (const r of registries)
      if (!HOST_ENTRY.test(r)) throw new Error("OCW_SANDBOX_REGISTRIES: host entries only");
  } else {
    registries = [...DEFAULT_REGISTRIES, claw.host];
  }
  return {
    npmRegistry: npm.href,
    pypiIndex: pypi.href,
    clawhubUrl: claw.href.replace(/\/+$/, ""),
    registries: [...new Set(registries)].slice(0, 64),
  };
}

/** The environment of every review and installer run: the proxy, the registries and the scratch paths. No secret. */
export function runEnv(cfg: RegistryConfig): string[] {
  const env = [
    // System paths only: a run never resolves a program from the packages volume.
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ...PROXY_ENV,
    `TMPDIR=${STAGING_DIR}/tmp`,
    `npm_config_registry=${cfg.npmRegistry}`,
    `npm_config_cache=${STAGING_DIR}/npm-cache`,
    "npm_config_update_notifier=false",
    "npm_config_fund=false",
    "npm_config_audit=false",
    `PIP_INDEX_URL=${cfg.pypiIndex}`,
    "PIP_DISABLE_PIP_VERSION_CHECK=1",
    "PIP_NO_INPUT=1",
    "PYTHONDONTWRITEBYTECODE=1",
    `OCW_CLAWHUB_URL=${cfg.clawhubUrl}`,
  ];
  // pip refuses a plain-http index unless trusted (fake registries in tests); hashes are still required.
  const pypi = new URL(cfg.pypiIndex);
  if (pypi.protocol === "http:") env.push(`PIP_TRUSTED_HOST=${pypi.hostname}`);
  return env;
}

// ---------------------------------------------------------------- the programs that run inside the containers

/** argv[3] of every command names its step (`node -e <js> <step> …`, `python3 -I -c <py> <step> …`). */
export function stepOf(argv: readonly string[]): string {
  return argv[3] ?? "";
}

const node = (js: string, step: string, ...args: string[]) => ["node", "-e", js, step, ...args];
const python = (py: string, step: string, ...args: string[]) => ["python3", "-Ic", py, step, ...args];

const JS_PRELUDE = `"use strict";
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const R = "/opt/ocw-packages";
const S = "/staging";
for (const d of [S + "/home", S + "/tmp"]) fs.mkdirSync(d, { recursive: true });
const args = process.argv.slice(2);
const isId = (x) => typeof x === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
const run = (cmd, a) => cp.execFileSync(cmd, a, { stdio: ["ignore", 2, 2] });
const out = (v) => process.stdout.write(JSON.stringify(v));
`;

/**
 * The view the bot sees: `bin`, `node_modules`, `python`, `skills` under /opt/ocw-packages are links into the current
 * generation of `.views/`, rebuilt from `pkgs/<id>/.ocw-package.json` after every commit and removal and swapped in with
 * one rename. The first package (by id, the approval order) wins a name two packages share.
 */
const JS_RELINK = `
function relink() {
  const pk = R + "/pkgs";
  const ids = fs.existsSync(pk) ? fs.readdirSync(pk).filter(isId).sort() : [];
  const gen = ".views/" + Date.now() + "-" + process.pid;
  const V = R + "/" + gen;
  const kinds = ["bin", "node_modules", "python", "skills"];
  for (const d of kinds) fs.mkdirSync(V + "/" + d, { recursive: true });
  const link = (target, at) => {
    fs.mkdirSync(path.dirname(at), { recursive: true });
    try { fs.symlinkSync(target, at); } catch (e) { if (e.code !== "EEXIST") throw e; }
  };
  const each = (dir, fn) => {
    let names = [];
    try { names = fs.readdirSync(dir).sort(); } catch (e) { if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e; }
    for (const f of names) fn(f);
  };
  for (const id of ids) {
    const P = pk + "/" + id;
    let m;
    try { m = JSON.parse(fs.readFileSync(P + "/.ocw-package.json", "utf8")); } catch { continue; }
    if (typeof m.name !== "string" || m.name.includes("..")) continue;
    if (m.source === "npm") {
      link(P + "/node_modules/" + m.name, V + "/node_modules/" + m.name);
      each(P + "/node_modules/.bin", (f) => link(P + "/node_modules/.bin/" + f, V + "/bin/" + f));
    } else if (m.source === "pypi") {
      each(P + "/site", (f) => { if (f !== "bin" && f !== "__pycache__") link(P + "/site/" + f, V + "/python/" + f); });
      each(P + "/site/bin", (f) => link(P + "/site/bin/" + f, V + "/bin/" + f));
    } else if (m.source === "debian") {
      for (const b of ["usr/local/bin", "usr/bin", "bin", "usr/games"]) {
        each(P + "/root/" + b, (f) => link(P + "/root/" + b + "/" + f, V + "/bin/" + f));
      }
    } else if (m.source === "clawhub") {
      link(P + "/skill", V + "/skills/" + m.name);
    }
  }
  const tmp = R + "/.view-" + process.pid;
  try { fs.unlinkSync(tmp); } catch {}
  fs.symlinkSync(gen, tmp);
  fs.renameSync(tmp, R + "/view");
  for (const d of kinds) {
    try { fs.lstatSync(R + "/" + d); } catch { fs.symlinkSync("view/" + d, R + "/" + d); }
  }
  each(R + "/.views", (g) => { if (".views/" + g !== gen) fs.rmSync(R + "/.views/" + g, { recursive: true, force: true }); });
  for (const f of fs.readdirSync(R)) {
    if (f.startsWith(".incoming-") || f.startsWith(".removing-")) fs.rmSync(R + "/" + f, { recursive: true, force: true });
  }
}
`;

const NPM_REVIEW = `${JS_PRELUDE}
const [name, version] = args;
const w = S + "/review";
fs.mkdirSync(w + "/t", { recursive: true });
process.chdir(w);
fs.writeFileSync("package.json", JSON.stringify({ name: "ocw-sandbox-package", version: "0.0.0", private: true }));
const spec = name + "@" + version;
const npm = (a) => cp.execFileSync("npm", a, { stdio: ["ignore", "pipe", 2], maxBuffer: 64 * 1024 * 1024 });
npm(["install", "--package-lock-only", "--ignore-scripts", "--save-exact", "--no-audit", "--no-fund", spec]);
npm(["pack", "--ignore-scripts", "--pack-destination", w + "/t", spec]);
const tgz = fs.readdirSync(w + "/t").filter((f) => f.endsWith(".tgz"));
if (tgz.length !== 1) throw new Error("expected one tarball");
const buf = fs.readFileSync(path.join(w, "t", tgz[0]));
let view = {};
try { view = JSON.parse(npm(["view", "--json", spec]).toString("utf8")); } catch {}
const pick = (v) => (typeof v === "string" ? v : v && typeof v === "object" && typeof v.name === "string" ? v.name : null);
out({
  lockfile: fs.readFileSync("package-lock.json", "utf8"),
  top: {
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    sha512: "sha512-" + crypto.createHash("sha512").update(buf).digest("base64"),
    sha1: "sha1-" + crypto.createHash("sha1").update(buf).digest("base64"),
    size: buf.length,
  },
  license: pick(view && view.license),
  publisher: pick(view && view._npmUser),
});
`;

/** Install step 1: `npm ci` over the stored lockfile with every script off; prints npm's record of what it installed. */
const NPM_FETCH = `${JS_PRELUDE}
const [id] = args;
if (!isId(id)) throw new Error("bad id");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const dir = S + "/pkg/" + id;
fs.mkdirSync(dir, { recursive: true });
process.chdir(dir);
fs.writeFileSync("package.json", JSON.stringify(input.packageJson));
fs.writeFileSync("package-lock.json", input.lockfile);
run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
const hidden = "node_modules/.package-lock.json";
out({ lockfile: fs.existsSync(hidden) ? fs.readFileSync(hidden, "utf8") : "" });
`;

/** Install step 2, after the tree was verified: the packages' own lifecycle scripts, inside the installer only. */
const NPM_BUILD = `${JS_PRELUDE}
const [id] = args;
if (!isId(id)) throw new Error("bad id");
process.chdir(S + "/pkg/" + id);
run("npm", ["rebuild", "--ignore-scripts=false", "--no-audit", "--no-fund"]);
out({ ok: true });
`;

const STATE = `${JS_PRELUDE}
const [id] = args;
if (!isId(id)) throw new Error("bad id");
let installed = null;
try {
  const m = JSON.parse(fs.readFileSync(R + "/pkgs/" + id + "/.ocw-package.json", "utf8"));
  if (typeof m.treeSha256 === "string") installed = m.treeSha256;
} catch {}
out({ installed });
`;

/** The only step that writes the bot's volume: copy the verified package in, then one rename, then the view. */
const COMMIT = `${JS_PRELUDE}${JS_RELINK}
const [id] = args;
if (!isId(id)) throw new Error("bad id");
const meta = JSON.parse(fs.readFileSync(0, "utf8"));
const src = S + "/pkg/" + id;
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(src + "/.ocw-package.json", JSON.stringify(meta));
fs.mkdirSync(R + "/pkgs", { recursive: true });
const incoming = R + "/.incoming-" + id;
fs.rmSync(incoming, { recursive: true, force: true });
run("cp", ["-a", src, incoming]);
const dest = R + "/pkgs/" + id;
if (fs.existsSync(dest)) {
  const old = R + "/.removing-" + id + "-" + Date.now();
  fs.renameSync(dest, old);
}
fs.renameSync(incoming, dest);
relink();
out({ ok: true });
`;

const REMOVE = `${JS_PRELUDE}${JS_RELINK}
let removed = 0;
for (const id of args) {
  if (!isId(id)) throw new Error("bad id");
  const dest = R + "/pkgs/" + id;
  if (!fs.existsSync(dest)) continue;
  fs.renameSync(dest, R + "/.removing-" + id + "-" + Date.now());
  removed += 1;
}
fs.mkdirSync(R, { recursive: true });
relink();
out({ removed });
`;

const PY_PRELUDE = `import email.parser, hashlib, io, json, os, re, subprocess, sys, tarfile, urllib.error, urllib.parse, urllib.request, zipfile
S = "/staging"
for d in (S + "/home", S + "/tmp"):
    os.makedirs(d, exist_ok=True)
args = sys.argv[2:]
ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

def fail(code):
    print("OCW_FAIL " + code, file=sys.stderr)
    sys.exit(3)

def run(cmd):
    subprocess.run(cmd, stdout=sys.stderr, check=True)

def fetch(url):
    try:
        with urllib.request.urlopen(url, timeout=300) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            fail("not_found")
        raise

def dist_meta(p, f):
    meta = None
    try:
        if f.endswith(".whl"):
            with zipfile.ZipFile(p) as z:
                n = [x for x in z.namelist() if x.endswith(".dist-info/METADATA") and x.count("/") == 1]
                if n:
                    meta = z.read(n[0]).decode("utf-8", "replace")
        else:
            with tarfile.open(p) as t:
                n = [m for m in t.getmembers() if m.name.count("/") == 1 and m.name.endswith("/PKG-INFO")]
                if n:
                    meta = t.extractfile(n[0]).read().decode("utf-8", "replace")
    except Exception:
        meta = None
    m = email.parser.Parser().parsestr(meta) if meta else None
    g = lambda k: (m.get(k) if m else None)
    return {"name": g("Name"), "version": g("Version"), "license": g("License"), "author": g("Author") or g("Author-email")}

def dists(d):
    files = []
    for f in sorted(os.listdir(d)):
        p = os.path.join(d, f)
        data = open(p, "rb").read()
        files.append(dict(file=f, sha256=hashlib.sha256(data).hexdigest(), size=len(data), sdist=not f.endswith(".whl"), **dist_meta(p, f)))
    return files
`;

const PIP = '[sys.executable, "-m", "pip"';

const PYPI_REVIEW = `${PY_PRELUDE}
name, version = args
d = S + "/review/dl"
os.makedirs(d, exist_ok=True)
r = subprocess.run(${PIP}, "download", "--no-cache-dir", "--no-build-isolation", "--dest", d, name + "==" + version], stdout=sys.stderr, stderr=subprocess.PIPE, text=True)
sys.stderr.write(r.stderr[-8000:])
if r.returncode != 0:
    if "No matching distribution" in r.stderr or "Could not find a version" in r.stderr:
        fail("not_found")
    sys.exit(1)
print(json.dumps({"files": dists(d)}))
`;

/** Install step 1: download exactly the recorded files, hash-checked by pip, and report their own sha256. */
const PYPI_FETCH = `${PY_PRELUDE}
id = args[0]
if not ID.match(id):
    sys.exit(2)
inp = json.load(sys.stdin)
req = S + "/req-" + id + ".txt"
open(req, "w").write(inp["lockfile"])
dl = S + "/dl-" + id
os.makedirs(dl, exist_ok=True)
run(${PIP}, "download", "--no-deps", "--require-hashes", "--no-cache-dir", "--no-build-isolation", "--dest", dl, "-r", req])
print(json.dumps({"files": dists(dl)}))
`;

/** Install step 2, after the tree was verified: install from the verified download only (no index, no resolution). */
const PYPI_BUILD = `${PY_PRELUDE}
id = args[0]
if not ID.match(id):
    sys.exit(2)
req = S + "/req-" + id + ".txt"
dl = S + "/dl-" + id
run(${PIP}, "install", "--no-deps", "--require-hashes", "--no-index", "--find-links", dl, "--no-cache-dir", "--no-build-isolation", "--no-compile", "--target", S + "/pkg/" + id + "/site", "-r", req])
print(json.dumps({"ok": True}))
`;

const APT = `APT = ["-o", "Dir::State=/staging/apt/state", "-o", "Dir::State::status=/var/lib/dpkg/status", "-o", "Dir::Cache=/staging/apt/cache", "-o", "Debug::NoLocking=1"]
for x in ("/staging/apt/state/lists/partial", "/staging/apt/cache/archives/partial"):
    os.makedirs(x, exist_ok=True)

def deb_field(p, k):
    return subprocess.run(["dpkg-deb", "-f", p, k], capture_output=True, text=True, check=True).stdout.strip()

def deb_scripts(p):
    ctrl = subprocess.run(["dpkg-deb", "--ctrl-tarfile", p], capture_output=True, check=True).stdout
    with tarfile.open(fileobj=io.BytesIO(ctrl)) as t:
        names = [m.name.split("/")[-1] for m in t.getmembers()]
    return any(n in ("preinst", "postinst", "prerm", "postrm", "config", "triggers") for n in names)
`;

/** Debian: the download-only closure of name=version against the image's signed indexes, each .deb sha256-checked. */
const DEBIAN_REVIEW = String.raw`${PY_PRELUDE}${APT}
name, version = args
run(["apt-get"] + APT + ["-q", "update"])
r = subprocess.run(["apt-get"] + APT + ["-q", "--print-uris", "--no-install-recommends", "-y", "install", name + "=" + version], capture_output=True, text=True)
sys.stderr.write(r.stderr[-8000:])
if r.returncode != 0:
    if "Unable to locate" in r.stderr or "not found" in r.stderr:
        fail("not_found")
    sys.exit(1)
os.makedirs(S + "/debs", exist_ok=True)
debs = []
for line in r.stdout.splitlines():
    m = re.match(r"^'([^']+)' (\S+) (\d+) SHA256:([0-9a-f]{64})$", line.strip())
    if not m:
        continue
    url, fn, size, sha = m.group(1), m.group(2), int(m.group(3)), m.group(4)
    data = fetch(url)
    if hashlib.sha256(data).hexdigest() != sha:
        fail("digest_mismatch")
    p = S + "/debs/" + str(len(debs)) + ".deb"
    open(p, "wb").write(data)
    debs.append({"url": url, "sha256": sha, "size": len(data), "name": deb_field(p, "Package"), "version": deb_field(p, "Version"), "maintainer": deb_field(p, "Maintainer") or None, "scripts": deb_scripts(p)})
print(json.dumps({"debs": debs}))
`;

/** Debian install step 1: download each recorded .deb, check its sha256 and its own name and version. */
const DEBIAN_FETCH = `${PY_PRELUDE}${APT}
id = args[0]
if not ID.match(id):
    sys.exit(2)
inp = json.load(sys.stdin)
d = S + "/debs-" + id
os.makedirs(d, exist_ok=True)
files = []
for i, deb in enumerate(inp["debs"]):
    data = fetch(deb["url"])
    sha = hashlib.sha256(data).hexdigest()
    if sha != deb["sha256"]:
        fail("digest_mismatch")
    p = d + "/" + str(i) + ".deb"
    open(p, "wb").write(data)
    if deb_field(p, "Package") != deb["name"] or deb_field(p, "Version") != deb["version"]:
        fail("digest_mismatch")
    files.append({"name": deb["name"], "version": deb["version"], "sha256": sha})
print(json.dumps({"files": files}))
`;

/** Debian install step 2: `dpkg-deb -x` into the package's own root. Maintainer scripts are never run. */
const DEBIAN_BUILD = `${PY_PRELUDE}
id = args[0]
if not ID.match(id):
    sys.exit(2)
d = S + "/debs-" + id
root = S + "/pkg/" + id + "/root"
os.makedirs(root, exist_ok=True)
for f in sorted(os.listdir(d), key=lambda x: int(x.split(".")[0])):
    run(["dpkg-deb", "-x", d + "/" + f, root])
print(json.dumps({"ok": True}))
`;

const CLAW = `def claw(name, version, tail):
    base = os.environ["OCW_CLAWHUB_URL"].rstrip("/")
    return base + "/api/v1/packages/" + urllib.parse.quote(name, safe="") + tail.replace("{v}", urllib.parse.quote(version, safe=""))

def claw_json(url):
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            return json.loads(r.read(1024 * 1024).decode("utf-8", "replace"))
    except Exception:
        return {}
`;

const CLAWHUB_REVIEW = `${PY_PRELUDE}${CLAW}
name, version = args
data = fetch(claw(name, version, "/versions/{v}/artifact/download"))
pkg = claw_json(claw(name, version, ""))
ver = claw_json(claw(name, version, "/versions/{v}"))
owner = pkg.get("owner") if isinstance(pkg.get("owner"), dict) else {}
p = pkg.get("package") if isinstance(pkg.get("package"), dict) else {}
v = ver.get("version") if isinstance(ver.get("version"), dict) else {}
publisher = owner.get("handle") or p.get("ownerHandle")
lic = v.get("license") or p.get("license")
print(json.dumps({"sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "publisher": publisher if isinstance(publisher, str) else None, "license": lic if isinstance(lic, str) else None}))
`;

/** ClawHub install step 1: download the recorded tarball and check its sha256. */
const CLAWHUB_FETCH = `${PY_PRELUDE}${CLAW}
id = args[0]
if not ID.match(id):
    sys.exit(2)
inp = json.load(sys.stdin)
data = fetch(claw(inp["name"], inp["version"], "/versions/{v}/artifact/download"))
sha = hashlib.sha256(data).hexdigest()
if sha != inp["sha256"]:
    fail("digest_mismatch")
open(S + "/claw-" + id + ".tgz", "wb").write(data)
print(json.dumps({"files": [{"name": inp["name"], "version": inp["version"], "sha256": sha}]}))
`;

/** ClawHub install step 2: extract the bundle as data (no owner, no modes from the archive) into `skill/`. */
const CLAWHUB_BUILD = `${PY_PRELUDE}
id = args[0]
if not ID.match(id):
    sys.exit(2)
dest = S + "/pkg/" + id + "/skill"
os.makedirs(dest, exist_ok=True)
run(["tar", "-xzf", S + "/claw-" + id + ".tgz", "-C", dest, "--strip-components=1", "--no-same-owner", "--no-same-permissions", "--no-overwrite-dir"])
print(json.dumps({"ok": True}))
`;

const REVIEW: Record<SandboxPackageSource, (name: string, version: string) => string[]> = {
  npm: (n, v) => node(NPM_REVIEW, "review-npm", n, v),
  pypi: (n, v) => python(PYPI_REVIEW, "review-pypi", n, v),
  debian: (n, v) => python(DEBIAN_REVIEW, "review-debian", n, v),
  clawhub: (n, v) => python(CLAWHUB_REVIEW, "review-clawhub", n, v),
};

const FETCH: Record<SandboxPackageSource, (id: string) => string[]> = {
  npm: (id) => node(NPM_FETCH, "fetch-npm", id),
  pypi: (id) => python(PYPI_FETCH, "fetch-pypi", id),
  debian: (id) => python(DEBIAN_FETCH, "fetch-debian", id),
  clawhub: (id) => python(CLAWHUB_FETCH, "fetch-clawhub", id),
};

const BUILD: Record<SandboxPackageSource, (id: string) => string[]> = {
  npm: (id) => node(NPM_BUILD, "build-npm", id),
  pypi: (id) => python(PYPI_BUILD, "build-pypi", id),
  debian: (id) => python(DEBIAN_BUILD, "build-debian", id),
  clawhub: (id) => python(CLAWHUB_BUILD, "build-clawhub", id),
};

/** The review of one exact (source, name, version): name and version are their own argv items. */
export function reviewCommand(source: SandboxPackageSource, name: string, version: string): string[] {
  return REVIEW[source](name, version);
}

/** Install step 1 (download and verify into the scratch volume); the recorded set arrives on stdin. */
export function fetchCommand(source: SandboxPackageSource, id: string): string[] {
  return FETCH[source](id);
}

/** Install step 2 (build and install scripts, still in the scratch volume), only after the tree was verified. */
export function buildCommand(source: SandboxPackageSource, id: string): string[] {
  return BUILD[source](id);
}

export const stateCommand = (id: string) => node(STATE, "state", id);
export const commitCommand = (id: string) => node(COMMIT, "commit", id);
export const removeCommand = (ids: readonly string[]) => node(REMOVE, "remove", ...ids);
/** The removal program (its text never changes with the ids). */
export const REMOVE_COMMAND: readonly string[] = node(REMOVE, "remove");

// ---------------------------------------------------------------- trees and recorded sets

/** sha256(packageTreeCanonical(entries)), the value the API approves and sandboxd recomputes. */
export function treeSha256(entries: readonly ReviewedTreeEntry[]): string {
  return createHash("sha256").update(packageTreeCanonical(entries), "utf8").digest("hex");
}

/** A review or install refusal that names its reason (fixed text, never registry or installer output). */
class TreeError extends Error {
  override readonly name = "TreeError";
}

const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;
const SHA1 = /^sha1-[A-Za-z0-9+/]{27}=$/;
const strong = (integrity: string) => SHA512.test(integrity) || /^sha256:[0-9a-f]{64}$/.test(integrity);

function entryOf(name: unknown, version: unknown, integrity: string): ReviewedTreeEntry {
  const parsed = ReviewedTreeEntry.safeParse({ name, version, integrity });
  if (!parsed.success) throw new TreeError("a dependency has an invalid name, version or integrity");
  return parsed.data;
}

function dedupe(entries: ReviewedTreeEntry[]): ReviewedTreeEntry[] {
  const seen = new Set<string>();
  const out: ReviewedTreeEntry[] = [];
  for (const e of entries) {
    const key = `${e.name}\u0000${e.version}\u0000${e.integrity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export interface NpmTree {
  entries: ReviewedTreeEntry[];
  /** Entries npm may legitimately skip on this platform (optional dependencies). */
  optional: ReviewedTreeEntry[];
  top: ReviewedTreeEntry;
  hasInstallScript: boolean;
  license: string | null;
  root: { name: string; version: string; dependencies: Record<string, string> };
}

/** The strongest npm integrity of an SRI list: sha512, else a well-formed sha1 (carried for the API to refuse). */
function npmIntegrity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parts = value.trim().split(/\s+/);
  return parts.find((p) => SHA512.test(p)) ?? parts.find((p) => SHA1.test(p)) ?? null;
}

/** Every package of an npm lockfile (v2/v3 `packages`), keyed by its install path. */
function npmPackages(lockText: string): Record<string, unknown> {
  let lock: unknown;
  try {
    lock = JSON.parse(lockText);
  } catch {
    throw new TreeError("the lockfile is not JSON");
  }
  const packages = asRecord(asRecord(lock).packages);
  if (Object.keys(packages).length === 0) throw new TreeError("the lockfile records no packages");
  return packages;
}

function npmEntries(packages: Record<string, unknown>, opts: { strict: boolean }) {
  const entries: ReviewedTreeEntry[] = [];
  const optional: ReviewedTreeEntry[] = [];
  let hasInstallScript = false;
  for (const [key, raw] of Object.entries(packages)) {
    if (key === "") continue;
    const e = asRecord(raw);
    if (e.inBundle === true) continue; // inside its parent's tarball, covered by the parent's integrity
    if (e.link === true) throw new TreeError("the lockfile links a local folder");
    const i = key.lastIndexOf("node_modules/");
    if (i < 0) throw new TreeError("the lockfile has a package outside node_modules");
    const name = typeof e.name === "string" ? e.name : key.slice(i + "node_modules/".length);
    const integrity = npmIntegrity(e.integrity);
    if (!integrity) throw new TreeError("a dependency has no integrity");
    if (opts.strict && !strong(integrity)) {
      throw new TreeError("a dependency is pinned by sha1 only; it cannot be installed (review it again)");
    }
    const entry = entryOf(name, e.version, integrity);
    entries.push(entry);
    if (e.optional === true) optional.push(entry);
    if (e.hasInstallScript === true) hasInstallScript = true;
  }
  return { entries: dedupe(entries), optional: dedupe(optional), hasInstallScript };
}

/**
 * The tree of a `package-lock.json` resolved for exactly `name@version`: every entry (sha1-only ones carried as such
 * for review), the top entry, install scripts. `strict` refuses anything not pinned by sha512 (installs).
 */
export function npmTree(
  lockText: string,
  want: { name: string; version: string },
  opts: { strict?: boolean } = {},
): NpmTree {
  const packages = npmPackages(lockText);
  const root = asRecord(packages[""]);
  const deps = asRecord(root.dependencies);
  if (Object.keys(deps).length !== 1 || deps[want.name] !== want.version) {
    throw new TreeError("the lockfile is not exactly this package");
  }
  if (
    Object.keys(asRecord(root.devDependencies)).length > 0 ||
    Object.keys(asRecord(root.optionalDependencies)).length > 0
  ) {
    throw new TreeError("the lockfile is not exactly this package");
  }
  const { entries, optional, hasInstallScript } = npmEntries(packages, { strict: opts.strict === true });
  const topRaw = asRecord(packages[`node_modules/${want.name}`]);
  const top = entries.find(
    (e) =>
      e.name === want.name && e.version === want.version && e.integrity === npmIntegrity(topRaw.integrity),
  );
  if (!top || topRaw.version !== want.version)
    throw new TreeError("the lockfile does not resolve this version");
  return {
    entries,
    optional,
    top,
    hasInstallScript,
    license: typeof topRaw.license === "string" ? topRaw.license : null,
    root: {
      name: typeof root.name === "string" ? root.name : "ocw-sandbox-package",
      version: typeof root.version === "string" ? root.version : "0.0.0",
      dependencies: { [want.name]: want.version },
    },
  };
}

/** PEP 503 normalisation: lower case, runs of `-`, `_`, `.` become one `-`. */
export const pypiName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

const PIN = /^([A-Za-z0-9][A-Za-z0-9._-]*)==(\S+) --hash=sha256:([0-9a-f]{64})$/;

/** The requirement set pip installs with `--require-hashes`: one `name==version --hash=sha256:<hex>` per file. */
export function pypiRequirements(entries: readonly ReviewedTreeEntry[]): string {
  const lines = entries.map((e) => {
    if (!e.integrity.startsWith("sha256:")) throw new TreeError("a PyPI file has no sha256");
    return `${e.name}==${e.version} --hash=${e.integrity}`;
  });
  return `${lines.join("\n")}\n`;
}

export function parsePypiRequirements(text: string): ReviewedTreeEntry[] {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new TreeError("the requirement set is empty");
  return lines.map((line) => {
    const m = PIN.exec(line.trim());
    if (!m) throw new TreeError("the requirement set has a line that is not a hashed pin");
    return entryOf(m[1], m[2], `sha256:${m[3]}`);
  });
}

export interface DebianFile {
  name: string;
  version: string;
  sha256: string;
  size: number;
  url: string;
}

const DEB_LINE = /^(\S+) (\S+) sha256:([0-9a-f]{64}) (\d{1,12}) (https?:\/\/\S{1,2000})$/;

/** The Debian closure: `<package> <version> sha256:<hex> <size> <url>` per .deb. */
export function debianLockfile(debs: readonly DebianFile[]): string {
  return `${debs.map((d) => `${d.name} ${d.version} sha256:${d.sha256} ${d.size} ${d.url}`).join("\n")}\n`;
}

export function parseDebianLockfile(text: string): DebianFile[] {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new TreeError("the Debian closure is empty");
  return lines.map((line) => {
    const m = DEB_LINE.exec(line.trim());
    if (!m) throw new TreeError("the Debian closure has an invalid line");
    const e = entryOf(m[1], m[2], `sha256:${m[3]}`);
    return {
      name: e.name,
      version: e.version,
      sha256: m[3] as string,
      size: Number(m[4]),
      url: m[5] as string,
    };
  });
}

/** A ClawHub bundle: `<name> <version> sha256:<hex> <size>` (the tarball's URL is derived from the configured host). */
export function clawhubLockfile(t: { name: string; version: string; sha256: string; size: number }): string {
  return `${t.name} ${t.version} sha256:${t.sha256} ${t.size}\n`;
}

function parseClawhubLockfile(text: string): ReviewedTreeEntry {
  const m = /^(\S+) (\S+) sha256:([0-9a-f]{64}) \d{1,12}$/.exec(text.trim());
  if (!m) throw new TreeError("the ClawHub record is invalid");
  return entryOf(m[1], m[2], `sha256:${m[3]}`);
}

type InstallPackage = SandboxdPackageInstall["packages"][number];

export type InstallPlan =
  | { ok: true; entries: PackageTreeEntry[]; optional: PackageTreeEntry[]; stdin: string }
  | { ok: false; detail: string; code?: "tree_changed" };

/**
 * What an install will fetch, from the recorded lockfile only: it must describe exactly this package, every entry must
 * be pinned by sha512 or sha256, and its tree must hash to the approved `treeSha256` (else `tree_changed`).
 */
export function installPlan(p: InstallPackage): InstallPlan {
  let entries: ReviewedTreeEntry[];
  let optional: ReviewedTreeEntry[] = [];
  let input: Record<string, unknown>;
  try {
    if (p.source === "npm") {
      const t = npmTree(p.lockfile, p, { strict: true });
      entries = t.entries;
      optional = t.optional;
      input = { lockfile: p.lockfile, packageJson: { ...t.root, private: true } };
    } else if (p.source === "pypi") {
      entries = parsePypiRequirements(p.lockfile);
      input = { lockfile: pypiRequirements(entries) };
    } else if (p.source === "debian") {
      const debs = parseDebianLockfile(p.lockfile);
      entries = debs.map((d) => entryOf(d.name, d.version, `sha256:${d.sha256}`));
      input = { debs: debs.map((d) => ({ name: d.name, version: d.version, sha256: d.sha256, url: d.url })) };
    } else {
      entries = [parseClawhubLockfile(p.lockfile)];
      input = { name: p.name, version: p.version, sha256: p.sha256 };
    }
  } catch (err) {
    return { ok: false, detail: err instanceof TreeError ? err.message : "the recorded set is invalid" };
  }
  if (entries.some((e) => !strong(e.integrity))) {
    return {
      ok: false,
      detail: "a dependency is pinned by sha1 only; it cannot be installed (review it again)",
    };
  }
  if (p.source !== "npm") {
    const top = entries.find((e) =>
      p.source === "pypi" ? pypiName(e.name) === pypiName(p.name) : e.name === p.name,
    );
    if (!top || top.version !== p.version || top.integrity !== `sha256:${p.sha256}`) {
      return {
        ok: false,
        detail: "the recorded set does not name the approved artifact",
        code: "tree_changed",
      };
    }
  }
  if (treeSha256(entries) !== p.treeSha256) {
    return { ok: false, detail: "the recorded set does not match the approved tree", code: "tree_changed" };
  }
  return {
    ok: true,
    entries: entries as PackageTreeEntry[],
    optional: optional as PackageTreeEntry[],
    stdin: JSON.stringify(input),
  };
}

// ---------------------------------------------------------------- container output (untrusted; bounded parsing)

const Text = (max: number) => z.string().max(max);
const Hex = z.string().regex(/^[0-9a-f]{64}$/);

const NpmReviewOut = z.object({
  lockfile: Text(SANDBOX_LIMITS.packageLockfileMaxBytes),
  top: z.object({
    sha256: Hex,
    sha512: z.string().regex(SHA512),
    sha1: z.string().regex(SHA1).optional(),
    size: z.number().int().nonnegative(),
  }),
  license: z.string().nullish(),
  publisher: z.string().nullish(),
});

const DistFile = z.object({
  file: Text(300),
  sha256: Hex,
  size: z.number().int().nonnegative(),
  sdist: z.boolean().optional(),
  name: z.string().nullish(),
  version: z.string().nullish(),
  license: z.string().nullish(),
  author: z.string().nullish(),
});
const PypiOut = z.object({ files: z.array(DistFile).max(SANDBOX_LIMITS.packageTreeMaxEntries) });

const DebOut = z.object({
  debs: z
    .array(
      z.object({
        url: z.string().regex(/^https?:\/\/\S{1,2000}$/),
        sha256: Hex,
        size: z.number().int().nonnegative(),
        name: z.string(),
        version: z.string(),
        maintainer: z.string().nullish(),
        scripts: z.boolean(),
      }),
    )
    .max(SANDBOX_LIMITS.packageTreeMaxEntries),
});

const ClawOut = z.object({
  sha256: Hex,
  size: z.number().int().nonnegative(),
  publisher: z.string().nullish(),
  license: z.string().nullish(),
});

const FetchedFiles = z.object({
  files: z
    .array(z.object({ name: z.string(), version: z.string(), sha256: Hex }))
    .max(SANDBOX_LIMITS.packageTreeMaxEntries),
});
const NpmFetched = z.object({ lockfile: Text(64 * 1024 * 1024) });
const State = z.object({ installed: Hex.nullable() });
const Removed = z.object({ removed: z.number().int().nonnegative() });

function parseOut<T>(schema: z.ZodType<T>, stdout: string): T | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** A person's name from `Name <email>` (never the address), bounded. */
function personName(v: string | null | undefined, max: number): string | null {
  if (typeof v !== "string") return null;
  const name = v
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return name.length > 0 ? name.slice(0, max) : null;
}
const license = (v: string | null | undefined) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, 100) : null;

// ---------------------------------------------------------------- runs

export interface RunOutput {
  /** -1 when it could not be read. */
  exitCode: number;
  stdout: string;
  /** The last bytes only (classification); never logged or returned. */
  stderr: string;
  timedOut: boolean;
  overflow: boolean;
}

export interface PackageRun {
  exec(argv: string[], opts?: { stdin?: string; timeoutMs?: number }): Promise<RunOutput>;
  close(): Promise<void>;
}

export interface PackageRunner {
  /**
   * A `review` (target.agentId is a fresh run id: no bot) or an `installer` (the bot's packages volume read-write)
   * container on its own network through the egress proxy (`network: false`: no network at all).
   */
  open(
    kind: "review" | "installer",
    target: SandboxdTarget,
    opts: { network: boolean; lifetimeMs: number },
  ): Promise<PackageRun>;
  /**
   * 07.8-28 (WINDOWS #260): at boot, the review and installer objects of this namespace that a run of a sandboxd process
   * that died left behind (its `ocw-prun-*` container, still running until its lifetime, and its own `ocw-pnet-*`
   * network, which nothing else removes). Found by labels (namespace and kind), named like a run; never a bot's object
   * or another namespace's.
   */
  sweepOrphans?(): Promise<{ containers: number; networks: number }>;
}

/** Under the API's 600 s per package (07.8-18) and 180 s per review, with room for the HTTP round trip. */
export const INSTALL_DEADLINE_MS = 540_000;
export const REVIEW_DEADLINE_MS = 150_000;
const STEP_FLOOR_MS = 5_000;

export interface Packages {
  review(input: SandboxdPackageReviewRequest): Promise<SandboxdPackageReviewResult>;
  install(input: SandboxdPackageInstall): Promise<SandboxdPackageInstallResult>;
  remove(input: SandboxdPackageRemove): Promise<{ removed: number }>;
}

export interface PackagesOptions {
  runner: PackageRunner;
  installDeadlineMs?: number;
  reviewDeadlineMs?: number;
  now?: () => number;
}

type Code = "digest_mismatch" | "tree_changed" | "timeout";
type Result = SandboxdPackageInstallResult["results"][number];

const failure = (code: ConstructorParameters<typeof SandboxdFailure>[0], status: number, message: string) =>
  new SandboxdFailure(code, status, message);

/** Integrity refusals of npm, pip and the Debian/ClawHub programs (download steps only: no install script ran yet). */
const DIGEST = /EINTEGRITY|DO NOT MATCH THE HASHES|OCW_FAIL digest_mismatch/;
const NOT_FOUND =
  /\bE404\b|404 Not Found|OCW_FAIL not_found|No matching distribution|Could not find a version/;

export function createPackages(options: PackagesOptions): Packages {
  const { runner } = options;
  const now = options.now ?? (() => Date.now());
  const installDeadline = options.installDeadlineMs ?? INSTALL_DEADLINE_MS;
  const reviewDeadline = options.reviewDeadlineMs ?? REVIEW_DEADLINE_MS;
  const locks = new Map<string, Promise<unknown>>();

  /** One install or removal at a time per bot (the API may call twice at once, 07.8-18). */
  async function locked<T>(target: SandboxdTarget, fn: () => Promise<T>): Promise<T> {
    const key = `${target.orgId}:${target.agentId}`;
    const prev = locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    locks.set(key, settled);
    try {
      return await run;
    } finally {
      if (locks.get(key) === settled) locks.delete(key);
    }
  }

  async function step(run: PackageRun, argv: string[], deadline: number, stdin?: string): Promise<RunOutput> {
    const left = deadline - now();
    if (left <= 0) return { exitCode: -1, stdout: "", stderr: "", timedOut: true, overflow: false };
    return run.exec(argv, { stdin, timeoutMs: Math.max(STEP_FLOOR_MS, left) });
  }

  // ------------------------------------------------------------ review

  function reviewOf(input: SandboxdPackageReviewRequest, stdout: string): SandboxdPackageReviewResult {
    const bad = () => failure("docker_unavailable", 503, "the review produced no usable result");
    const base = { source: input.source, name: input.name, version: input.version };
    let entries: ReviewedTreeEntry[];
    let lockfile: string;
    let sha256: string;
    let sizeBytes: number;
    let lic: string | null = null;
    let publisher: string | null = null;
    let hasInstallScript = false;
    try {
      if (input.source === "npm") {
        const o = parseOut(NpmReviewOut, stdout);
        if (!o) throw bad();
        const t = npmTree(o.lockfile, input);
        // The tarball npm packed must be the one the lockfile pins, in the lockfile's own algorithm (a sha1-only
        // package is carried through for the API to refuse, never installed).
        const packed = t.top.integrity.startsWith("sha1-") ? o.top.sha1 : o.top.sha512;
        if (t.top.integrity !== packed) {
          throw failure("digest_mismatch", 409, "the tarball does not match the resolved tree");
        }
        entries = t.entries;
        lockfile = o.lockfile;
        sha256 = o.top.sha256;
        sizeBytes = o.top.size;
        lic = license(o.license ?? t.license);
        publisher = personName(o.publisher, 200);
        hasInstallScript = t.hasInstallScript;
      } else if (input.source === "pypi") {
        const o = parseOut(PypiOut, stdout);
        if (!o || o.files.length === 0) throw bad();
        const files = o.files.map((f) => {
          // Name and version from the file's own metadata, else from its file name (`name-version…`).
          const m = /^([A-Za-z0-9][A-Za-z0-9_.]*)-([A-Za-z0-9][A-Za-z0-9.+!_]*?)(?:-|\.tar\.gz$|\.zip$)/.exec(
            f.file,
          );
          const name = pypiName(f.name ?? m?.[1] ?? "");
          const version = f.version ?? m?.[2] ?? "";
          return { f, entry: entryOf(name, version, `sha256:${f.sha256}`) };
        });
        const top = files.find(
          (x) => x.entry.name === pypiName(input.name) && x.entry.version === input.version,
        );
        if (!top) throw failure("not_found", 404, "the download does not contain this version");
        entries = dedupe(files.map((x) => x.entry));
        lockfile = pypiRequirements(entries);
        sha256 = top.f.sha256;
        sizeBytes = top.f.size;
        lic = license(top.f.license);
        publisher = personName(top.f.author, 200);
        hasInstallScript = files.some((x) => x.f.sdist === true);
      } else if (input.source === "debian") {
        const o = parseOut(DebOut, stdout);
        if (!o) throw bad();
        const top = o.debs.find((d) => d.name === input.name && d.version === input.version);
        if (!top)
          throw failure("not_found", 404, "this version is not available or is already in the sandbox image");
        const debs = o.debs.map((d) => {
          const e = entryOf(d.name, d.version, `sha256:${d.sha256}`);
          return { name: e.name, version: e.version, sha256: d.sha256, size: d.size, url: d.url };
        });
        entries = dedupe(debs.map((d) => entryOf(d.name, d.version, `sha256:${d.sha256}`)));
        lockfile = debianLockfile(debs);
        sha256 = top.sha256;
        sizeBytes = top.size;
        publisher = personName(top.maintainer, 200);
        hasInstallScript = o.debs.some((d) => d.scripts);
      } else {
        const o = parseOut(ClawOut, stdout);
        if (!o) throw bad();
        const e = entryOf(input.name, input.version, `sha256:${o.sha256}`);
        entries = [e];
        lockfile = clawhubLockfile({ name: e.name, version: e.version, sha256: o.sha256, size: o.size });
        sha256 = o.sha256;
        sizeBytes = o.size;
        lic = license(o.license);
        publisher = personName(o.publisher, 200);
      }
    } catch (err) {
      if (err instanceof SandboxdFailure) throw err;
      if (err instanceof TreeError) throw failure("invalid_request", 422, err.message);
      throw bad();
    }
    if (entries.length > SANDBOX_LIMITS.packageTreeMaxEntries) {
      throw failure("too_large", 413, "the dependency tree is too large");
    }
    if (Buffer.byteLength(lockfile, "utf8") > SANDBOX_LIMITS.packageLockfileMaxBytes) {
      throw failure("too_large", 413, "the lockfile is too large");
    }
    return {
      ...base,
      sha256,
      sizeBytes,
      license: lic,
      publisher,
      hasInstallScript,
      dependencyCount: Math.max(0, entries.length - 1),
      treeSha256: treeSha256(entries),
      entries,
      lockfile,
    };
  }

  // ------------------------------------------------------------ install

  /** The tree recomputed from what the fetch step actually downloaded. */
  function fetchedTree(
    p: InstallPackage,
    plan: Extract<InstallPlan, { ok: true }>,
    stdout: string,
  ): string | null {
    try {
      if (p.source === "npm") {
        const o = parseOut(NpmFetched, stdout);
        if (!o) return null;
        const installed = npmEntries(npmPackages(o.lockfile), { strict: false }).entries;
        const key = (e: ReviewedTreeEntry) => `${e.name}\u0000${e.version}`;
        const have = new Set(installed.map(key));
        // An optional dependency npm skipped on this platform is not a change; anything else is.
        const skipped = plan.optional.filter((e) => !have.has(key(e)));
        return treeSha256([...installed, ...skipped]);
      }
      const o = parseOut(FetchedFiles, stdout);
      if (!o) return null;
      const entries = o.files.map((f) =>
        entryOf(p.source === "pypi" ? pypiName(f.name) : f.name, f.version, `sha256:${f.sha256}`),
      );
      return treeSha256(entries);
    } catch {
      return null;
    }
  }

  async function installOne(target: SandboxdTarget, p: InstallPackage): Promise<Result> {
    const fail = (detail: string, code?: Code): Result =>
      code ? { id: p.id, status: "failed", detail, code } : { id: p.id, status: "failed", detail };
    const plan = installPlan(p);
    if (!plan.ok) return fail(plan.detail, plan.code);
    const deadline = now() + installDeadline;
    const run = await runner.open("installer", target, {
      network: true,
      lifetimeMs: installDeadline + 60_000,
    });
    try {
      const state = await step(run, stateCommand(p.id), deadline);
      if (state.timedOut) return fail("the install took too long", "timeout");
      const held = state.exitCode === 0 ? parseOut(State, state.stdout) : null;
      if (!held) return fail("could not read the packages volume");
      if (held.installed === p.treeSha256) return { id: p.id, status: "installed", detail: "installed" };

      const fetched = await step(run, fetchCommand(p.source, p.id), deadline, plan.stdin);
      if (fetched.timedOut) return fail("the install took too long", "timeout");
      if (fetched.exitCode !== 0) {
        if (DIGEST.test(fetched.stderr))
          return fail("a downloaded file does not match its approved digest", "digest_mismatch");
        return fail("the download failed");
      }
      const tree = fetchedTree(p, plan, fetched.stdout);
      if (tree !== p.treeSha256)
        return fail("the installed tree differs from the approved one", "tree_changed");

      // Only now does any package code run (lifecycle scripts, builds), still inside the installer.
      const built = await step(run, buildCommand(p.source, p.id), deadline);
      if (built.timedOut) return fail("the install took too long", "timeout");
      if (built.exitCode !== 0) return fail("the install step failed");

      const meta = JSON.stringify({
        id: p.id,
        source: p.source,
        name: p.name,
        version: p.version,
        treeSha256: p.treeSha256,
      });
      const committed = await step(run, commitCommand(p.id), deadline, meta);
      if (committed.timedOut) return fail("the install took too long", "timeout");
      if (committed.exitCode !== 0) return fail("could not write the packages volume");
      return { id: p.id, status: "installed", detail: "installed" };
    } finally {
      await run.close();
    }
  }

  return {
    async review(input) {
      const target = { orgId: input.orgId, agentId: randomUUID() };
      const deadline = now() + reviewDeadline;
      const run = await runner.open("review", target, { network: true, lifetimeMs: reviewDeadline + 60_000 });
      try {
        const r = await step(run, reviewCommand(input.source, input.name, input.version), deadline);
        if (r.timedOut) throw failure("timeout", 504, "the review took too long");
        if (r.exitCode !== 0) {
          if (NOT_FOUND.test(r.stderr)) throw failure("not_found", 404, "no such package or version");
          if (DIGEST.test(r.stderr))
            throw failure("digest_mismatch", 409, "a downloaded file does not match its digest");
          throw failure("docker_unavailable", 503, "the package could not be resolved");
        }
        if (r.overflow) throw failure("too_large", 413, "the review result is too large");
        return reviewOf(input, r.stdout);
      } finally {
        await run.close();
      }
    },

    async install(input) {
      return locked(input.target, async () => {
        const results: Result[] = [];
        for (const p of input.packages) results.push(await installOne(input.target, p));
        return { results };
      });
    },

    async remove(input) {
      return locked(input.target, async () => {
        const run = await runner.open("installer", input.target, { network: false, lifetimeMs: 120_000 });
        try {
          const r = await run.exec(removeCommand(input.ids), { timeoutMs: 60_000 });
          const o = r.exitCode === 0 ? parseOut(Removed, r.stdout) : null;
          if (!o) throw failure("docker_unavailable", 503, "could not remove the packages");
          return o;
        } finally {
          await run.close();
        }
      });
    },
  };
}

// ---------------------------------------------------------------- the Docker runner

export interface DockerRunnerOptions {
  docker: Docker;
  sandboxes: {
    dockerRuntime(): Promise<DockerRuntime>;
    packagesVolume(target: SandboxdTarget): Promise<string>;
  };
  /** The namespace's egress proxy: a networked run without it would have no way out, so it is refused. */
  egress: Egress | null;
  ns: string;
  /** The configured `sbx` image, never a caller's. */
  image: string;
  /** `runEnv(registryConfig(...))`. */
  env: readonly string[];
}

/** A step's stdout is a JSON document (a lockfile at most, plus a little): more is refused as `overflow`. */
const RUN_MAX_STDOUT = 8 * 1024 * 1024;
const RUN_STDERR_TAIL = 16_384;
const EXEC_POLL_MS = 200;

/**
 * Review and installer containers over the Engine API (07.8-17): each run has its own internal network (labelled with
 * its kind and owner, the proxy attached with the registries-only policy) and its own container from `reviewSpec` /
 * `installerSpec`, removed with its scratch volume when the run closes (and by Docker on its own when it outlives
 * sandboxd: AutoRemove after its lifetime).
 */
export function dockerPackageRunner(options: DockerRunnerOptions): PackageRunner {
  const { docker, sandboxes, egress, ns, image, env } = options;
  const down = (what: string) => new SandboxdFailure("docker_unavailable", 503, what);

  async function call(method: "GET" | "POST" | "DELETE", path: string, body?: unknown) {
    try {
      return await docker.request(method, path, body);
    } catch (err) {
      if (err instanceof DockerUnavailableError) throw down("the Docker daemon is unavailable");
      throw err;
    }
  }

  async function execIn(
    containerId: string,
    argv: string[],
    opts: { stdin?: string; timeoutMs?: number } = {},
  ): Promise<RunOutput> {
    const withStdin = opts.stdin !== undefined;
    const created = await call("POST", `/containers/${encodeURIComponent(containerId)}/exec`, {
      User: SANDBOX_USER,
      Cmd: argv,
      WorkingDir: STAGING_DIR,
      AttachStdin: withStdin,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    const execId = String((created.body as { Id?: unknown } | null)?.Id ?? "");
    if (created.status !== 201 || !execId) throw down("cannot run a package step");
    let stream: Duplex;
    try {
      stream = await docker.hijack(`/exec/${encodeURIComponent(execId)}/start`, {
        Detach: false,
        Tty: false,
      });
    } catch {
      throw down("cannot run a package step");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    const stderr = new OutputTail(RUN_STDERR_TAIL);
    const ended = demux(stream, (frame) => {
      if (frame.stream === 2) {
        stderr.push(frame.data);
        return;
      }
      if (overflow) return;
      if (size + frame.data.length > RUN_MAX_STDOUT) {
        overflow = true;
        return;
      }
      chunks.push(frame.data);
      size += frame.data.length;
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stream.destroy();
    }, opts.timeoutMs ?? INSTALL_DEADLINE_MS);
    timer.unref();
    try {
      if (withStdin) stream.end(Buffer.from(opts.stdin as string, "utf8"));
      await ended;
    } finally {
      clearTimeout(timer);
    }
    let exitCode = -1;
    if (!timedOut) {
      for (let i = 0; i < 50; i++) {
        const res = await call("GET", `/exec/${encodeURIComponent(execId)}/json`);
        const body = (res.body ?? {}) as { Running?: unknown; ExitCode?: unknown };
        if (res.status === 200 && body.Running !== true) {
          exitCode = typeof body.ExitCode === "number" ? body.ExitCode : -1;
          break;
        }
        await new Promise((r) => setTimeout(r, EXEC_POLL_MS));
      }
    }
    return {
      exitCode,
      stdout: Buffer.concat(chunks, size).toString("utf8"),
      stderr: stderr.text(),
      timedOut,
      overflow,
    };
  }

  const runFilter = (kind: "installer" | "review") =>
    encodeURIComponent(
      JSON.stringify({
        label: [
          `${SANDBOXD_LABELS.sandbox}=1`,
          `${SANDBOXD_LABELS.namespace}=${ns}`,
          `${SANDBOXD_LABELS.kind}=${kind}`,
        ],
      }),
    );
  const runPrefix = (kind: "pnet" | "prun") => `ocw-${kind}-`;

  return {
    async sweepOrphans() {
      let containers = 0;
      let networks = 0;
      for (const kind of ["installer", "review"] as const) {
        const listed = await call("GET", `/containers/json?all=1&filters=${runFilter(kind)}`);
        const rows = Array.isArray(listed.body)
          ? (listed.body as Array<{ Id: string; Names?: string[] }>)
          : [];
        for (const c of rows) {
          const name = (c.Names?.[0] ?? "").replace(/^\//, "");
          if (!name.startsWith(runPrefix("prun"))) continue;
          const res = await call("DELETE", `/containers/${encodeURIComponent(c.Id)}?force=1&v=1`);
          if (res.status === 204 || res.status === 404) containers += 1;
        }
        const nets = await call("GET", `/networks?filters=${runFilter(kind)}`);
        const netRows = Array.isArray(nets.body) ? (nets.body as Array<{ Name: string }>) : [];
        for (const n of netRows) {
          if (!n.Name.startsWith(runPrefix("pnet"))) continue;
          await egress?.detachNetwork(n.Name).catch(() => undefined);
          const res = await call("DELETE", `/networks/${encodeURIComponent(n.Name)}`);
          if (res.status === 204 || res.status === 404) networks += 1;
        }
      }
      return { containers, networks };
    },

    async open(kind, target, opts) {
      if (opts.network && !egress) throw down("no egress proxy is configured for package runs");
      const runId = randomUUID();
      const names = packageRunNames(ns, runId);
      const runtime = await sandboxes.dockerRuntime();
      const packagesVolume = kind === "installer" ? await sandboxes.packagesVolume(target) : null;
      let networkCreated = false;
      let attached = false;
      let containerId: string | null = null;

      const close = async () => {
        if (containerId) {
          // v=1: the run's anonymous scratch volume goes with it (never the bot's named packages volume).
          await call("DELETE", `/containers/${encodeURIComponent(containerId)}?force=1&v=1`).catch(
            () => undefined,
          );
          containerId = null;
        }
        if (attached && egress) {
          await egress.detachNetwork(names.network).catch(() => undefined);
          attached = false;
        }
        if (networkCreated) {
          await call("DELETE", `/networks/${encodeURIComponent(names.network)}`).catch(() => undefined);
          networkCreated = false;
        }
      };

      try {
        let networkMode = "none";
        let egressAddress: string | null = null;
        if (opts.network && egress) {
          const spec = packageRunNetworkSpec({
            ns,
            orgId: target.orgId,
            agentId: target.agentId,
            runId,
            kind,
          });
          const created = await call("POST", "/networks/create", spec);
          if (created.status !== 201) throw down("cannot create the package run's network");
          networkCreated = true;
          attached = true;
          // A fresh run on a fresh network: the proxy's address there goes into the run's /etc/hosts (gVisor DNS).
          egressAddress = await egress.attach(target, kind, names.network);
          networkMode = names.network;
        }
        const base = {
          ns,
          orgId: target.orgId,
          agentId: target.agentId,
          runId,
          image,
          runtime,
          network: networkMode,
          env,
          lifetimeSeconds: Math.ceil(opts.lifetimeMs / 1000),
          egressAddress,
        };
        const spec =
          kind === "installer"
            ? installerSpec({ ...base, packagesVolume: packagesVolume as string })
            : reviewSpec(base);
        const created = await call(
          "POST",
          `/containers/create?name=${encodeURIComponent(names.container)}`,
          spec,
        );
        if (created.status !== 201) throw down("cannot create the package run");
        containerId = String((created.body as { Id?: unknown } | null)?.Id ?? "") || names.container;
        const started = await call("POST", `/containers/${encodeURIComponent(containerId)}/start`);
        if (started.status !== 204 && started.status !== 304) throw down("cannot start the package run");
      } catch (err) {
        await close();
        throw err;
      }
      const id = containerId as string;
      return { exec: (argv, o) => execIn(id, argv, o), close };
    },
  };
}
