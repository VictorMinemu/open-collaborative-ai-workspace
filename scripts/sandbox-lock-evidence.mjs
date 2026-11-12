#!/usr/bin/env node
// Supply-chain evidence for the sbx document toolkit's Python lock (07.17.1.1.1 D-01, PD-14, A-06; ADR-0043).
//
//   node scripts/sandbox-lock-evidence.mjs --out <file> [--now <ISO>] [--legitimacy <seam json>]
//        [--installed <json>] [--ci-run <url>] [--min-days <n>] [--full]
//
// Dev-time and gate-time only, never on CI: the CLI is the only part with network calls (pypi.org's JSON API per
// `name==version` and https://api.osv.dev/v1/querybatch), each through `fetch` with a 30 s timeout. The checks are
// pure and exported for the offline tests (scripts/sandbox-lock-evidence.test.mjs). Writes one JSON document:
//   (a) every file whose sha256 the lock pins is a file of that exact PyPI release, uploaded at least `minAgeDays`
//       (14) before the run (the file's own `upload_time_iso_8601`); a failing pin is listed in `holdBack` as
//       `name<version` for `requirements.in`, then `tools/lock.sh` re-resolves;
//   (b) no pinned release or matched file is yanked;
//   (c) OSV returns no advisory for any `name==version` (ecosystem PyPI);
//   (d) no legitimacy verdict (the GSD seam's `[{ name, verdict, signals, reasons }]`) is SLOP, and a SUS verdict
//       passes only when the release's project URLs or home page match the name's KNOWN_PROJECTS repository;
//   (e) every pin is a `requirements.in` name or reached from one through the lock's `# via` annotations, and every
//       `requirements.in` name is pinned;
//   (f) when `--installed` is given (the images workflow's installed versions), they equal the lock.
// `ok` is true only when (a)-(e) pass and, when given, (f). The document carries the lock's sha256 so it cannot be
// reused for another lock. The approval itself is a person's (or the orchestrator's under the owner's grant) before
// merge (07.17.1.1.1-07 T3), never this script's.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DAY_MS = 86_400_000;
const FETCH_TIMEOUT_MS = 30_000;

/**
 * The source repository each pinned project documents for itself (its README, docs or website), written by hand and
 * reviewed in 07.17.1.1.1-02's SUMMARY, never copied from the PyPI metadata it checks. Host and path prefixes,
 * lowercase; a URL matches at a path-segment boundary.
 */
export const KNOWN_PROJECTS = {
  beautifulsoup4: [
    "www.crummy.com/software/beautifulsoup",
    "code.launchpad.net/beautifulsoup",
    "git.launchpad.net/beautifulsoup",
  ],
  cffi: ["github.com/python-cffi/cffi"],
  "charset-normalizer": ["github.com/jawah/charset_normalizer"],
  cryptography: ["github.com/pyca/cryptography"],
  defusedxml: ["github.com/tiran/defusedxml"],
  "et-xmlfile": ["foss.heptapod.net/openpyxl/et_xmlfile"],
  lxml: ["github.com/lxml/lxml"],
  numpy: ["github.com/numpy/numpy"],
  openpyxl: ["foss.heptapod.net/openpyxl/openpyxl"],
  packaging: ["github.com/pypa/packaging"],
  pandas: ["github.com/pandas-dev/pandas"],
  "pdfminer-six": ["github.com/pdfminer/pdfminer.six"],
  pdfplumber: ["github.com/jsvine/pdfplumber"],
  pillow: ["github.com/python-pillow/pillow"],
  pycparser: ["github.com/eliben/pycparser"],
  pypdf: ["github.com/py-pdf/pypdf"],
  pypdfium2: ["github.com/pypdfium2-team/pypdfium2"],
  pytesseract: ["github.com/madmaze/pytesseract"],
  "python-dateutil": ["github.com/dateutil/dateutil"],
  "python-docx": ["github.com/python-openxml/python-docx"],
  "python-pptx": ["github.com/scanny/python-pptx"],
  six: ["github.com/benjaminp/six"],
  soupsieve: ["github.com/facelessuser/soupsieve"],
  "typing-extensions": ["github.com/python/typing_extensions"],
  tzdata: ["github.com/python/tzdata"],
  xlsxwriter: ["github.com/jmcnamara/xlsxwriter"],
};

/** PEP 503: lowercase, every run of `-`, `_` and `.` becomes one `-`. */
const normalize = (name) => name.toLowerCase().replace(/[-_.]+/g, "-");
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** The pins of a pip-compile lock: `{ name, version, hashes[], via[] }` (via entries: PEP 503 names or `-r …`). */
export function parseLock(text) {
  const pins = [];
  let pin = null;
  let inVia = false;
  for (const line of text.split(/\r?\n/)) {
    const top = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?==([^\s;\\]+)/.exec(line);
    if (top) {
      pin = { name: normalize(top[1]), version: top[2], hashes: [], via: [] };
      pins.push(pin);
      inVia = false;
      continue;
    }
    if (!pin || !/^\s/.test(line)) {
      if (!/^\s/.test(line)) {
        pin = null;
        inVia = false;
      }
      continue;
    }
    for (const m of line.matchAll(/--hash=sha256:([0-9a-f]{64})/g)) pin.hashes.push(m[1]);
    const via = /^\s+# via(?:\s+(.*))?$/.exec(line);
    if (via) {
      if (via[1]) pin.via.push(viaEntry(via[1]));
      inVia = !via[1];
      continue;
    }
    const more = /^\s+#\s{2,}(\S.*)$/.exec(line);
    if (inVia && more) pin.via.push(viaEntry(more[1]));
  }
  return pins;
}

const viaEntry = (raw) => (raw.trim().startsWith("-") ? raw.trim() : normalize(raw.trim()));

/** The names `requirements.in` lists (specifiers, markers and comments dropped), PEP 503. */
export function parseRequirementsIn(text) {
  const names = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line.replace(/#.*/, ""));
    if (m) names.add(normalize(m[1]));
  }
  return [...names].sort();
}

const filesOf = (release) => (Array.isArray(release?.urls) ? release.urls : []);

/** (a) Every lock hash is a file of that release, each uploaded at least `minDays` before `now`. */
export function ageCheck(pin, release, now, minDays = 14) {
  const byHash = new Map(filesOf(release).map((f) => [f.digests?.sha256, f]));
  const nowMs = Date.parse(now);
  const files = [];
  const unknownHashes = [];
  const tooNew = [];
  for (const sha256 of pin.hashes) {
    const f = byHash.get(sha256);
    if (!f) {
      unknownHashes.push(sha256);
      continue;
    }
    const uploaded = f.upload_time_iso_8601;
    const ageDays = (nowMs - Date.parse(uploaded)) / DAY_MS;
    files.push({ filename: f.filename, sha256, uploaded, ageDays: Math.floor(ageDays * 100) / 100 });
    if (!(ageDays >= minDays)) tooNew.push(f.filename);
  }
  files.sort((x, y) => (x.filename < y.filename ? -1 : x.filename > y.filename ? 1 : 0));
  tooNew.sort();
  const ok = pin.hashes.length > 0 && unknownHashes.length === 0 && tooNew.length === 0;
  return {
    ok,
    files,
    unknownHashes,
    tooNew,
    holdBack: tooNew.length > 0 ? `${pin.name}<${pin.version}` : null,
  };
}

/** (b) Neither the release nor (with a pin: any matched file; without: any file) is yanked; no release fails. */
export function yankCheck(release, pin) {
  if (!release?.info) return { ok: false, releaseYanked: null, yanked: [] };
  const hashes = pin ? new Set(pin.hashes) : null;
  const yanked = filesOf(release)
    .filter((f) => (hashes ? hashes.has(f.digests?.sha256) : true) && f.yanked === true)
    .map((f) => f.filename)
    .sort();
  const releaseYanked = release.info.yanked === true;
  return { ok: !releaseYanked && yanked.length === 0, releaseYanked, yanked };
}

/** (c) One OSV querybatch result: no `vulns` passes; a missing result fails. */
export function osvCheck(result) {
  if (!result || typeof result !== "object") return { ok: false, advisories: [], error: "no OSV result" };
  const advisories = (Array.isArray(result.vulns) ? result.vulns : []).map((v) => v.id).sort();
  return { ok: advisories.length === 0, advisories };
}

const urlKey = (url) => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.toLowerCase().replace(/\/+$/, "");
  } catch {
    return null;
  }
};

/** (d) SLOP fails; a name outside KNOWN_PROJECTS fails; OK passes; SUS passes only on a known-repository URL. */
export function legitimacyCheck(verdict, release, known = KNOWN_PROJECTS) {
  const name = verdict?.name ? normalize(verdict.name) : null;
  const v = verdict?.verdict ?? null;
  const reasons = Array.isArray(verdict?.reasons) ? [...verdict.reasons] : [];
  const fail = (reason) => ({ ok: false, verdict: v, reasons, matched: null, reason });
  if (!verdict || !name) return fail("no legitimacy verdict");
  if (v === "SLOP") return fail("SLOP verdict");
  const prefixes = known[name];
  if (!prefixes) return fail(`${name} is not in KNOWN_PROJECTS`);
  if (v === "OK") return { ok: true, verdict: v, reasons, matched: null, reason: "OK verdict" };
  if (v !== "SUS") return fail(`unknown verdict ${v}`);
  const info = release?.info ?? {};
  const urls = [...Object.values(info.project_urls ?? {}), info.home_page].filter(
    (u) => typeof u === "string" && u !== "",
  );
  for (const url of urls) {
    const key = urlKey(url);
    if (!key) continue;
    if (prefixes.some((p) => key === p || key.startsWith(`${p}/`))) {
      return { ok: true, verdict: v, reasons, matched: url, reason: "SUS with the known repository" };
    }
  }
  return fail("SUS and no project URL matches the known repository");
}

/** (e) Every pin is a requirements.in name or has a `# via` parent inside the closure; every in-name is pinned. */
export function closureCheck(pins, inNames) {
  const wanted = new Set(inNames.map(normalize));
  const pinned = new Set(pins.map((p) => p.name));
  const closure = new Set(pins.filter((p) => wanted.has(p.name)).map((p) => p.name));
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of pins) {
      if (!closure.has(p.name) && p.via.some((parent) => closure.has(parent))) {
        closure.add(p.name);
        grew = true;
      }
    }
  }
  const unreachable = pins
    .filter((p) => !closure.has(p.name))
    .map((p) => p.name)
    .sort();
  const unpinned = [...wanted].filter((n) => !pinned.has(n)).sort();
  return { ok: unreachable.length === 0 && unpinned.length === 0, unreachable, unpinned };
}

/** (f) The installed `name → version` map (object or `[{ name, version }]`) equals the lock. */
export function installedCheck(pins, installed) {
  const map = new Map(
    (Array.isArray(installed)
      ? installed.map((e) => [e.name, e.version])
      : Object.entries(installed ?? {})
    ).map(([n, v]) => [normalize(n), v]),
  );
  const missing = [];
  const mismatched = [];
  for (const p of [...pins].sort(byName)) {
    if (!map.has(p.name)) missing.push(p.name);
    else if (map.get(p.name) !== p.version) {
      mismatched.push(`${p.name}: installed ${map.get(p.name)}, locked ${p.version}`);
    }
  }
  return { ok: missing.length === 0 && mismatched.length === 0, missing, mismatched };
}

const summarizeFiles = (files) => {
  if (files.length === 0) return { count: 0 };
  const byTime = [...files].sort((x, y) => Date.parse(x.uploaded) - Date.parse(y.uploaded));
  const newest = byTime[byTime.length - 1];
  return {
    count: files.length,
    oldestUpload: byTime[0].uploaded,
    newestUpload: newest.uploaded,
    newestFile: newest.filename,
    minAgeDays: Math.min(...files.map((f) => f.ageDays)),
    digest: createHash("sha256")
      .update(files.map((f) => `${f.filename} ${f.sha256} ${f.uploaded}\n`).join(""))
      .digest("hex"),
  };
};

/**
 * The evidence document. `releases` and `osv` are keyed by PEP 503 name; `legitimacy` is the seam's array.
 * Without `full`, each pin's hashed files are summarized (count, oldest and newest upload, the newest file, the
 * smallest age and a sha256 over `filename sha256 upload` lines); with it, every file is listed.
 */
export function evidence({
  lockText,
  inText,
  releases,
  osv,
  legitimacy = [],
  installed = null,
  ciRun = null,
  now,
  minDays = 14,
  known = KNOWN_PROJECTS,
  full = false,
}) {
  const pins = parseLock(lockText).sort(byName);
  const inNames = parseRequirementsIn(inText);
  const verdicts = new Map(legitimacy.map((v) => [normalize(v.name ?? ""), v]));
  const rows = pins.map((pin) => {
    const release = releases[pin.name];
    const age = ageCheck(pin, release, now, minDays);
    const yank = yankCheck(release, pin);
    const advisories = osvCheck(osv[pin.name]);
    const legit = legitimacyCheck(verdicts.get(pin.name), release, known);
    return {
      name: pin.name,
      version: pin.version,
      via: [...pin.via],
      files: full ? age.files : summarizeFiles(age.files),
      age: { ok: age.ok, tooNew: age.tooNew, unknownHashes: age.unknownHashes },
      yanked: yank,
      osv: advisories,
      legitimacy: legit,
    };
  });
  const closure = { inNames, ...closureCheck(pins, inNames) };
  const installedResult = installed ? installedCheck(pins, installed) : null;
  const pass = {
    a: rows.every((r) => r.age.ok),
    b: rows.every((r) => r.yanked.ok),
    c: rows.every((r) => r.osv.ok),
    d: rows.every((r) => r.legitimacy.ok),
    e: closure.ok,
    f: installedResult ? installedResult.ok : null,
  };
  const holdBack = pins
    .map((pin) => ageCheck(pin, releases[pin.name], now, minDays).holdBack)
    .filter(Boolean)
    .sort();
  return {
    generatedAt: now,
    minAgeDays: minDays,
    lockSha256: createHash("sha256").update(lockText).digest("hex"),
    pins: rows,
    closure,
    holdBack,
    ci:
      installedResult || ciRun
        ? { run: ciRun, installedMatches: installedResult ? installedResult.ok : null }
        : null,
    ...(installedResult ? { installed: installedResult } : {}),
    pass,
    ok: pass.a && pass.b && pass.c && pass.d && pass.e && pass.f !== false,
  };
}

/** The failing checks of a document, one line each (the CLI prints them). */
export function failingChecks(doc) {
  const lines = [];
  for (const r of doc.pins) {
    if (!r.age.ok) {
      const why = [
        ...(r.age.tooNew.length
          ? [
              `${r.age.tooNew.length} hashed file(s) younger than ${doc.minAgeDays} days (${r.age.tooNew[0]} …)`,
            ]
          : []),
        ...r.age.unknownHashes.map((h) => `hash ${h} is not a file of this release`),
      ];
      lines.push(`(a) ${r.name}==${r.version}: ${why.join("; ") || "no hashed file"}`);
    }
    if (!r.yanked.ok)
      lines.push(`(b) ${r.name}==${r.version}: yanked ${r.yanked.yanked.join(", ") || "release"}`);
    if (!r.osv.ok) lines.push(`(c) ${r.name}==${r.version}: ${r.osv.advisories.join(", ") || r.osv.error}`);
    if (!r.legitimacy.ok) lines.push(`(d) ${r.name}==${r.version}: ${r.legitimacy.reason}`);
  }
  if (!doc.closure.ok) {
    if (doc.closure.unreachable.length) lines.push(`(e) unreachable: ${doc.closure.unreachable.join(", ")}`);
    if (doc.closure.unpinned.length) lines.push(`(e) not pinned: ${doc.closure.unpinned.join(", ")}`);
  }
  if (doc.pass.f === false) {
    const f = doc.installed;
    lines.push(
      `(f) installed differs: ${[...f.missing.map((m) => `${m} missing`), ...f.mismatched].join("; ")}`,
    );
  }
  if (doc.holdBack.length) lines.push(`hold back in requirements.in: ${doc.holdBack.join(" ")}`);
  return lines;
}

async function getJson(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

function parseArgs(argv) {
  const opts = { full: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === "--out") opts.out = value();
    else if (flag === "--now") opts.now = value();
    else if (flag === "--legitimacy") opts.legitimacy = value();
    else if (flag === "--installed") opts.installed = value();
    else if (flag === "--ci-run") opts.ciRun = value();
    else if (flag === "--min-days") opts.minDays = Number(value());
    else if (flag === "--lock") opts.lock = value();
    else if (flag === "--in") opts.in = value();
    else if (flag === "--full") opts.full = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!opts.out) throw new Error("--out <file> is required");
  return opts;
}

async function main(argv) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const opts = parseArgs(argv);
  const lockText = readFileSync(opts.lock ?? join(repo, "infra/sandbox/sbx/tools/requirements.lock"), "utf8");
  const inText = readFileSync(opts.in ?? join(repo, "infra/sandbox/sbx/tools/requirements.in"), "utf8");
  const pins = parseLock(lockText);
  const releases = {};
  await Promise.all(
    pins.map(async (p) => {
      releases[p.name] = await getJson(
        `https://pypi.org/pypi/${encodeURIComponent(p.name)}/${encodeURIComponent(p.version)}/json`,
      );
    }),
  );
  const batch = await getJson("https://api.osv.dev/v1/querybatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      queries: pins.map((p) => ({ package: { name: p.name, ecosystem: "PyPI" }, version: p.version })),
    }),
  });
  const osv = {};
  pins.forEach((p, i) => {
    osv[p.name] = batch.results?.[i];
  });
  const doc = evidence({
    lockText,
    inText,
    releases,
    osv,
    legitimacy: opts.legitimacy ? JSON.parse(readFileSync(opts.legitimacy, "utf8")) : [],
    installed: opts.installed ? JSON.parse(readFileSync(opts.installed, "utf8")) : null,
    ciRun: opts.ciRun ?? null,
    now: opts.now ?? new Date().toISOString(),
    minDays: opts.minDays ?? 14,
    full: opts.full,
  });
  writeFileSync(opts.out, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(
    `evidence: ${doc.pins.length} pins, lock sha256 ${doc.lockSha256}, ok ${doc.ok} -> ${opts.out}`,
  );
  for (const line of failingChecks(doc)) console.error(line);
  return doc.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`sandbox-lock-evidence: ${error.message}`);
      process.exitCode = 2;
    },
  );
}
