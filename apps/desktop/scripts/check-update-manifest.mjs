// After `package` (07.13.1, D-03, D-04): proves that the update manifest electron-builder wrote on this runner points
// every device at exactly the files this runner built, under their release names, and that the packaged app asks the
// canonical repository for updates. The release workflow runs it on all three runners, for pull requests and tags.
//   node scripts/check-update-manifest.mjs [--release <dir>] [--version <x.y.z>] [--platform darwin|win32|linux] [--no-seal]
//                                          [--release-build]
//
// Checks, for this platform's manifest (`latest-mac.yml`, `latest.yml`, `latest-linux.yml`):
//   - `version` is the expected one (the tag in CI, else apps/desktop/package.json);
//   - every `files[].url` is a plain release file name (`OCW-v<version>-…`, no folder, no `..`) that exists, with the
//     base64 sha512 and the size recomputed from its bytes; the legacy top-level `path` / `sha512` match their file;
//   - the file the updater installs is listed (macOS zip, Windows setup, Linux AppImage), and the zip / setup
//     blockmap exists;
//   - the packaged `app-update.yml` names the GitHub provider, the canonical owner and repository, a plain
//     `updaterCacheDirName` and no `publisherName` (unsigned until Phase 9);
//   - with `--release-build` (the release workflow's tag builds, review WR-05): the packaged `app.asar` holds
//     `dist/main/build-flags.json` with `releaseBuild: true`, so the build that ships really turned its updater on.
// On macOS (unless `--no-seal`) it also extracts the zip with `ditto` into a temporary folder, runs `codesign --verify
// --deep --strict`, checks the bundle id `dev.ocw.desktop` and the version, and runs the extracted app's daemon the way
// the app starts it. Every child process takes an argv array, never a shell string. Messages name files relative to
// the release folder, never an absolute path. YAML is parsed with the js-yaml electron-updater itself loads.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const OWNER = "VictorMinemu";
const REPO = "open-collaborative-ai-workspace";
const BUNDLE_ID = "dev.ocw.desktop";
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const yaml = createRequire(require.resolve("electron-updater"))("js-yaml");

const { values } = parseArgs({
  options: {
    release: { type: "string" },
    version: { type: "string" },
    platform: { type: "string" },
    "no-seal": { type: "boolean", default: false },
    "release-build": { type: "boolean", default: false },
  },
  strict: true,
});

const release = values.release ?? join(here, "..", "release");
const version = values.version ?? JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version;
const platform = values.platform ?? process.platform;
const seal = !values["no-seal"];

/** Per platform: the manifest, the packaged resources folder, the file the updater installs and its blockmap. */
const LAYOUTS = {
  darwin: {
    manifest: "latest-mac.yml",
    resources: "mac-arm64/OCW.app/Contents/Resources",
    installs: `OCW-v${version}-macos-arm64.zip`,
    blockmap: true,
  },
  win32: {
    manifest: "latest.yml",
    resources: "win-unpacked/resources",
    installs: `OCW-v${version}-windows-x64-setup.exe`,
    blockmap: true,
  },
  linux: {
    manifest: "latest-linux.yml",
    resources: "linux-unpacked/resources",
    installs: `OCW-v${version}-linux-x86_64.AppImage`,
    // AppImage blockmaps are embedded in the file.
    blockmap: false,
  },
};

const problems = [];
const fail = (message) => problems.push(message);

/** Replaces any absolute folder the script knows about, so a tool's own message never leaks a host path. */
function scrub(text, ...folders) {
  let out = String(text);
  for (const f of folders) if (f) out = out.split(f).join("<folder>");
  return out.trim();
}

function loadYaml(rel, base = release) {
  const file = join(base, rel);
  if (!existsSync(file)) {
    fail(`${rel} is missing`);
    return null;
  }
  try {
    const doc = yaml.load(readFileSync(file, "utf8"));
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
      fail(`${rel} is not a YAML mapping`);
      return null;
    }
    return doc;
  } catch (err) {
    fail(`${rel} does not parse: ${scrub(err?.reason ?? "invalid YAML", base)}`);
    return null;
  }
}

async function sha512Of(file) {
  const hash = createHash("sha512");
  await pipeline(createReadStream(file), hash);
  return hash.digest("base64");
}

/** A release file name: plain (no folder, no `..`, no scheme) and carrying the expected version. */
function isReleaseName(url) {
  return (
    typeof url === "string" &&
    PLAIN_NAME.test(url) &&
    !url.includes("..") &&
    url.startsWith(`OCW-v${version}-`)
  );
}

async function checkManifest(layout) {
  const doc = loadYaml(layout.manifest);
  if (!doc) return;
  if (doc.version !== version) {
    fail(
      `${layout.manifest}: version is ${JSON.stringify(doc.version)}, expected ${JSON.stringify(version)}`,
    );
  }
  const files = Array.isArray(doc.files) ? doc.files : [];
  if (files.length === 0) fail(`${layout.manifest}: no files listed`);
  const hashes = new Map();
  for (const [i, entry] of files.entries()) {
    const url = entry?.url;
    if (!isReleaseName(url)) {
      fail(
        `${layout.manifest}: files[${i}].url ${JSON.stringify(url)} is not a plain release file name (OCW-v${version}-…)`,
      );
      continue;
    }
    const file = join(release, url);
    if (!existsSync(file) || !statSync(file).isFile()) {
      fail(`${url}: listed in ${layout.manifest} but missing`);
      continue;
    }
    const size = statSync(file).size;
    if (entry.size !== size) fail(`${url}: size ${size} does not match ${layout.manifest} (${entry.size})`);
    const digest = await sha512Of(file);
    hashes.set(url, digest);
    if (entry.sha512 !== digest) fail(`${url}: sha512 does not match ${layout.manifest}`);
  }
  if (!files.some((e) => e?.url === layout.installs)) {
    fail(`${layout.manifest}: does not list ${layout.installs}`);
  }
  // The legacy top-level fields (electron-updater < 2.15); when present they must describe a listed file.
  if (doc.path !== undefined) {
    if (!hashes.has(doc.path))
      fail(`${layout.manifest}: path ${JSON.stringify(doc.path)} is not a checked file`);
    else if (doc.sha512 !== undefined && doc.sha512 !== hashes.get(doc.path)) {
      fail(`${layout.manifest}: sha512 does not match ${doc.path}`);
    }
  }
  if (layout.blockmap) {
    const blockmap = `${layout.installs}.blockmap`;
    if (!existsSync(join(release, blockmap))) fail(`${blockmap} is missing`);
  }
}

/** The packaged `app-update.yml`: the canonical GitHub source, a plain cache folder name, no publisher to verify. */
function checkAppUpdate(rel, base = release) {
  const doc = loadYaml(rel, base);
  if (!doc) return;
  if (doc.provider !== "github")
    fail(`${rel}: provider is ${JSON.stringify(doc.provider)}, expected "github"`);
  if (doc.owner !== OWNER)
    fail(`${rel}: owner is ${JSON.stringify(doc.owner)}, expected ${JSON.stringify(OWNER)}`);
  if (doc.repo !== REPO)
    fail(`${rel}: repo is ${JSON.stringify(doc.repo)}, expected ${JSON.stringify(REPO)}`);
  if ("publisherName" in doc)
    fail(`${rel}: has a publisherName (no build is Authenticode-signed until Phase 9)`);
  const cache = doc.updaterCacheDirName;
  if (
    typeof cache !== "string" ||
    cache.length === 0 ||
    cache === "." ||
    cache === ".." ||
    /[/\\\0]/.test(cache) ||
    cache.includes("..")
  ) {
    fail(`${rel}: updaterCacheDirName ${JSON.stringify(cache)} is not a plain folder name`);
  }
}

/**
 * Review WR-05: the packaged app was built with `OCW_RELEASE_BUILD=1` (scripts/build.mjs writes the flag beside the
 * main bundle; electron-builder packs it into app.asar). Read with the @electron/asar electron-builder packs with.
 */
function checkReleaseBuild(resources) {
  const rel = join(resources, "app.asar");
  const file = join(release, rel);
  if (!existsSync(file)) {
    fail(`${rel} is missing, so the release-build flag cannot be checked`);
    return;
  }
  let flags = null;
  try {
    const lib = createRequire(require.resolve("electron-builder")).resolve("app-builder-lib");
    const asar = createRequire(lib)("@electron/asar");
    flags = JSON.parse(asar.extractFile(file, "dist/main/build-flags.json").toString("utf8"));
  } catch {
    flags = null;
  }
  if (flags?.releaseBuild !== true) {
    fail(`${rel}: the packaged app was not built with OCW_RELEASE_BUILD=1, so its updater would be off`);
    return;
  }
  console.log(`${rel}: release build (the updater is on)`);
}

/** macOS: the zip the updater installs keeps its seal, its identity and a daemon that runs. */
function checkMacZip(zipName) {
  const zip = join(release, zipName);
  if (!existsSync(zip)) return; // already reported by the manifest check
  const tmp = mkdtempSync(join(tmpdir(), "ocw-update-check-"));
  const run = (cmd, args, opts = {}) =>
    execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
  const said = (err) =>
    scrub(`${err?.stderr ?? ""}${err?.stdout ?? ""}` || err?.message || err, tmp, release);
  try {
    try {
      run("/usr/bin/ditto", ["-x", "-k", zip, tmp]);
    } catch (err) {
      fail(`${zipName}: ditto cannot extract it: ${said(err)}`);
      return;
    }
    const app = join(tmp, "OCW.app");
    if (!existsSync(app)) {
      fail(`${zipName}: has no OCW.app at its root`);
      return;
    }
    try {
      run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
      console.log(`${zipName}: codesign --verify --deep --strict passes on the extracted OCW.app`);
    } catch (err) {
      fail(`${zipName}: the extracted OCW.app fails codesign --verify --deep --strict: ${said(err)}`);
    }
    const plist = join(app, "Contents", "Info.plist");
    const read = (key) => {
      try {
        return run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist]).trim();
      } catch {
        return null;
      }
    };
    const id = read("CFBundleIdentifier");
    if (id !== BUNDLE_ID)
      fail(`${zipName}: bundle id is ${JSON.stringify(id)}, expected ${JSON.stringify(BUNDLE_ID)}`);
    const shortVersion = read("CFBundleShortVersionString");
    if (shortVersion !== version) {
      fail(
        `${zipName}: CFBundleShortVersionString is ${JSON.stringify(shortVersion)}, expected ${JSON.stringify(version)}`,
      );
    }
    checkAppUpdate("OCW.app/Contents/Resources/app-update.yml", tmp);
    const exe = join(app, "Contents", "MacOS", "OCW");
    const entry = join(app, "Contents", "Resources", "daemon", "bin", "ocw-runtime");
    if (!existsSync(exe) || !existsSync(entry)) {
      fail(`${zipName}: the extracted OCW.app has no app binary or bundled daemon`);
      return;
    }
    try {
      const out = run(exe, [entry, "version"], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        timeout: 60_000,
      }).trim();
      if (!/^\d+\.\d+\.\d+/.test(out))
        fail(`${zipName}: unexpected daemon version output ${JSON.stringify(scrub(out, tmp))}`);
      else console.log(`${zipName}: the extracted app's daemon runs: ocw-runtime ${out}`);
    } catch (err) {
      fail(`${zipName}: the extracted app's daemon does not run: ${said(err)}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const layout = LAYOUTS[platform];
if (!layout) {
  console.error(`check-update-manifest: no desktop build for ${JSON.stringify(platform)}`);
  process.exit(1);
}
if (typeof version !== "string" || !VERSION.test(version)) {
  console.error(`check-update-manifest: not a version: ${JSON.stringify(version)}`);
  process.exit(1);
}

await checkManifest(layout);
checkAppUpdate(join(layout.resources, "app-update.yml"));
if (values["release-build"]) checkReleaseBuild(layout.resources);
if (platform === "darwin" && seal) checkMacZip(layout.installs);

if (problems.length > 0) {
  for (const p of problems) console.error(`check-update-manifest: ${p}`);
  process.exit(1);
}
console.log(
  `${layout.manifest}: v${version}, every file matches its sha512 and size; app-update.yml points at ${OWNER}/${REPO}`,
);
