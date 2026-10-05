// Deterministic fake ClawHub (03.1-11, D-14 / D-15). No dependencies; mounted by the fake-model server under
// `/api/v1/` (no clash with the `/v1/*` model routes), and usable in-process by the API tests.
//
// Read-only public API, shapes as observed on clawhub.ai (2026-10-04) and in OpenClaw 2026.9.7's client:
//   GET /api/v1/packages/search?q&family&limit      → { results: [{ score, package }] }
//   GET /api/v1/plugins?limit&cursor                → { items: [package], nextCursor }
//   GET /api/v1/plugins/search?q&limit              → { results: [{ score, package }] }
//   GET /api/v1/packages/{name}                     → { package, owner }
//   GET /api/v1/packages/{name}/detail?version      → { package, owner, versions, version, security, readme }
//   GET /api/v1/packages/{name}/versions            → { items: [{ version, createdAt, changelog, distTags }], nextCursor }
//   GET /api/v1/packages/{name}/versions/{v}        → { package, version }
//   GET /api/v1/packages/{name}/versions/{v}/security            → { overview, verdict, securityAuditUrl, trust }
//   GET /api/v1/packages/{name}/versions/{v}/artifact            → { package, version: { version, artifact }, artifact }
//   GET /api/v1/packages/{name}/versions/{v}/artifact/download   → the npm-pack tarball + X-ClawHub-* digest headers
//
// Fixtures: fixtures/clawhub/catalog.json. When the artifact dir (`FAKE_CLAWHUB_ARTIFACT_DIR` or
// `opts.artifactDir`) holds `<artifact.npmTarballName>`, its real sha256 / sha512 integrity / sha1 shasum / size
// replace the fixture values everywhere and the download serves it; otherwise the download answers 404.
//
// In-process controls (tests): `fake.requests` (method, path, query, headers), `fake.version(name, v)` and
// `fake.pkg(name)` return the live (mutable) fixture records, `fake.setOutage({ status } | { delayMs } | null)`,
// `fake.reset()` (fixtures, outage and request log).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const FIXTURE = new URL("./fixtures/clawhub/catalog.json", import.meta.url);

function loadCatalog() {
  return JSON.parse(readFileSync(FIXTURE, "utf8")).packages;
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

const notFound = (res, what) => sendJson(res, 404, { error: `${what} not found` });

/** npm's tarball name for a package version (`@scope/name` → `scope-name-<v>.tgz`). */
function tarballName(name, version) {
  return `${name.replace(/^@/u, "").replace("/", "-")}-${version}.tgz`;
}

const summaryOf = (entry) => {
  const { name, displayName, family, channel, isOfficial, ownerHandle, ownerOfficial, runtimeId, summary } =
    entry.package;
  return {
    name,
    displayName,
    family,
    channel,
    isOfficial,
    ownerHandle,
    ownerOfficial,
    runtimeId,
    summary,
    categories: entry.package.categories ?? [],
    latestVersion: latestOf(entry).version,
    stats: entry.package.stats,
    verificationTier: entry.package.verificationTier ?? null,
    createdAt: entry.package.createdAt,
    updatedAt: entry.package.updatedAt,
    topics: [],
  };
};

function latestOf(entry) {
  return entry.versions.find((v) => v.distTags?.includes("latest")) ?? entry.versions.at(-1);
}

function matches(entry, q) {
  if (!q) return true;
  const hay =
    `${entry.package.name} ${entry.package.displayName} ${entry.package.summary ?? ""}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

export function createFakeClawhub(opts = {}) {
  const artifactDir = opts.artifactDir ?? process.env.FAKE_CLAWHUB_ARTIFACT_DIR ?? "";
  let catalog = loadCatalog();
  let outage = null;
  const requests = [];

  const find = (name) => catalog.find((p) => p.package.name === name) ?? null;

  /** The version's artifact, with real digests when its tarball is on disk. */
  function artifactOf(entry, v) {
    const fixture = v.artifact ?? {};
    const file = artifactDir
      ? path.join(artifactDir, fixture.npmTarballName ?? tarballName(entry.package.name, v.version))
      : "";
    if (!file || !existsSync(file) || !statSync(file).isFile()) return { artifact: fixture, file: null };
    const bytes = readFileSync(file);
    return {
      file,
      artifact: {
        ...fixture,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        npmIntegrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        npmShasum: createHash("sha1").update(bytes).digest("hex"),
        npmTarballName: path.basename(file),
        size: bytes.length,
      },
    };
  }

  function versionRecord(entry, v) {
    const { security: _security, ...rest } = v;
    return { ...rest, artifact: artifactOf(entry, v).artifact };
  }

  function packageRecord(entry) {
    const latest = latestOf(entry);
    return {
      ...entry.package,
      latestVersion: latest.version,
      tags: entry.package.tags ?? { latest: latest.version },
      compatibility: latest.compatibility ?? null,
      verification: latest.verification ?? null,
      artifact: artifactOf(entry, latest).artifact,
    };
  }

  function securityOf(entry, v) {
    const art = artifactOf(entry, v).artifact;
    return {
      ...v.security,
      package: {
        name: entry.package.name,
        displayName: entry.package.displayName,
        family: entry.package.family,
      },
      release: {
        version: v.version,
        artifactKind: art.kind ?? "npm-pack",
        artifactSha256: art.sha256 ?? null,
        npmIntegrity: art.npmIntegrity ?? null,
        createdAt: v.createdAt,
      },
    };
  }

  const versionsList = (entry) => ({
    items: [...entry.versions]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((v) => ({
        version: v.version,
        createdAt: v.createdAt,
        changelog: v.changelog ?? "",
        distTags: v.distTags ?? [],
      })),
    nextCursor: null,
  });

  function route(res, url) {
    const p = url.pathname;
    if (p === "/api/v1/packages/search" || p === "/api/v1/plugins/search") {
      const q = url.searchParams.get("q")?.trim() ?? "";
      const family = url.searchParams.get("family");
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 20) || 20, 100);
      const results = catalog
        .filter((e) => matches(e, q) && (!family || e.package.family === family))
        .slice(0, limit)
        .map((e, i) => ({ score: 100 - i, package: summaryOf(e) }));
      return sendJson(res, 200, { results });
    }
    if (p === "/api/v1/plugins") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 20) || 20, 100);
      const start = Number(url.searchParams.get("cursor") ?? 0) || 0;
      const sorted = [...catalog].sort((a, b) => b.package.stats.downloads - a.package.stats.downloads);
      const items = sorted.slice(start, start + limit).map(summaryOf);
      const next = start + limit < sorted.length ? String(start + limit) : null;
      return sendJson(res, 200, { items, nextCursor: next });
    }
    const m =
      /^\/api\/v1\/packages\/([^/]+)(\/detail|\/versions(?:\/([^/]+)(\/security|\/artifact(\/download)?)?)?)?$/u.exec(
        p,
      );
    if (!m) return notFound(res, "route");
    const name = decodeURIComponent(m[1]);
    const entry = find(name);
    if (!entry) return notFound(res, "package");
    const sub = m[2] ?? "";

    if (sub === "") return sendJson(res, 200, { package: packageRecord(entry), owner: entry.owner });
    if (sub === "/versions") return sendJson(res, 200, versionsList(entry));
    if (sub === "/detail") {
      const wanted = url.searchParams.get("version");
      const v = wanted ? entry.versions.find((x) => x.version === wanted) : latestOf(entry);
      if (!v) return notFound(res, "version");
      return sendJson(res, 200, {
        package: packageRecord(entry),
        owner: entry.owner,
        versions: versionsList(entry),
        version: versionRecord(entry, v),
        readme: entry.readme ?? null,
        security: securityOf(entry, v),
      });
    }
    const v = entry.versions.find((x) => x.version === decodeURIComponent(m[3]));
    if (!v) return notFound(res, "version");
    const pkgRef = {
      name: entry.package.name,
      displayName: entry.package.displayName,
      family: entry.package.family,
    };
    if (!m[4]) return sendJson(res, 200, { package: pkgRef, version: versionRecord(entry, v) });
    if (m[4] === "/security") return sendJson(res, 200, securityOf(entry, v));
    const { artifact, file } = artifactOf(entry, v);
    if (!m[5])
      return sendJson(res, 200, { package: pkgRef, version: { version: v.version, artifact }, artifact });
    if (!file) return notFound(res, "artifact");
    const bytes = readFileSync(file);
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": bytes.length,
      "x-clawhub-artifact-sha256": artifact.sha256,
      "x-clawhub-npm-integrity": artifact.npmIntegrity,
      "x-clawhub-npm-shasum": artifact.npmShasum,
      "x-clawhub-npm-tarball-name": artifact.npmTarballName,
    });
    res.end(bytes);
  }

  /** Handles `GET /api/v1/*`; returns false for anything else (so the caller can route it). */
  function handle(req, res, url) {
    if (!url.pathname.startsWith("/api/v1/")) return false;
    requests.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: { ...req.headers },
    });
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    }
    const current = outage;
    if (current?.delayMs) {
      const timer = setTimeout(() => {
        if (!res.destroyed) route(res, url);
      }, current.delayMs);
      res.on("close", () => clearTimeout(timer));
      return true;
    }
    if (current?.status) {
      sendJson(res, current.status, { error: "fake outage" });
      return true;
    }
    route(res, url);
    return true;
  }

  handle.requests = requests;
  handle.pkg = (name) => find(name)?.package ?? null;
  handle.version = (name, version) => find(name)?.versions.find((v) => v.version === version) ?? null;
  handle.setOutage = (o) => {
    outage = o;
  };
  handle.reset = () => {
    catalog = loadCatalog();
    outage = null;
    requests.length = 0;
  };
  return handle;
}
