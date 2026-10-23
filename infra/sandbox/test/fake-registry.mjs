// Offline fake package registries for the sandbox packages smoke (07.8-17, P-12, P-13). Dependency-free (Node 24
// built-ins only); every artifact is generated in memory at start from the small fixtures below, so no real registry
// is ever contacted. It serves, on one port (default 8080):
//
//   npm      GET /npm/<name>                          full packument (dist.tarball, dist.integrity, dist.shasum)
//            GET /npm/<name>/-/<name>-<v>.tgz         the npm-pack tarball
//   PyPI     GET /simple/<normalized>/                PEP 503 HTML with #sha256= links
//            GET /files/<file>                        the wheel
//   ClawHub  GET /api/v1/packages/<name>                               { package, owner }
//            GET /api/v1/packages/<name>/versions/<v>                  { package, version }
//            GET /api/v1/packages/<name>/versions/<v>/artifact/download   the bundle tarball (package/SKILL.md)
//   control  POST /__control/republish {source, name, version}   the same version again with new bytes (a dependency
//                                                                republished after approval)
//            GET /__stats                                         request counts per path (no bodies)
//
// Packages: npm `ocw-smoke-cli@1.0.0` (a bin, a postinstall that writes a marker, depends on `ocw-smoke-dep@1.0.0`),
// npm `ocw-smoke-old@1.0.0` (an old package with a sha1 shasum and no integrity), PyPI `ocw_smoke_py==1.0.0`
// (depends on `ocw_smoke_pydep==1.0.0`), ClawHub `ocw-smoke-skill@1.0.0`.
//
//   node fake-registry.mjs [port]
import { createHash } from "node:crypto";
import http from "node:http";
import { crc32, gzipSync } from "node:zlib";

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8080);

/** Republish counters: `${source}/${name}@${version}` → n (0 = the original bytes). */
const nonces = new Map();
const stats = new Map();

const nonceOf = (source, name, version) => nonces.get(`${source}/${name}@${version}`) ?? 0;
/** Changes the bytes of a republished artifact (a comment or a file), never its name or version. */
const stamp = (source, name, version) => {
  const n = nonceOf(source, name, version);
  return n === 0 ? "" : `republished ${n}`;
};

// ---------------------------------------------------------------- archive writers (deterministic)

const octal = (n, len) => `${n.toString(8).padStart(len - 1, "0")}\0`;

/** A ustar tarball, gzipped: [{ name, data, mode }]. mtime 0, uid/gid 0, so the same input gives the same bytes. */
function tgz(files) {
  const blocks = [];
  for (const f of files) {
    const data = Buffer.from(f.data);
    const h = Buffer.alloc(512);
    h.write(f.name, 0, 100, "utf8");
    h.write(octal(f.mode ?? 0o644, 8), 100);
    h.write(octal(0, 8), 108);
    h.write(octal(0, 8), 116);
    h.write(octal(data.length, 12), 124);
    h.write(octal(0, 12), 136);
    h.write("        ", 148);
    h.write("0", 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

/** A stored (uncompressed) zip: [{ name, data }]. */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const data = Buffer.from(f.data);
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const digest = (algo, buf, enc) => createHash(algo).update(buf).digest(enc);

// ---------------------------------------------------------------- npm

const NPM = {
  "ocw-smoke-dep": {
    version: "1.0.0",
    manifest: { main: "index.js", license: "MIT" },
    files: (s) => [
      { name: "package/index.js", data: `module.exports = { greet: (n) => "hello " + n };\n// ${s}\n` },
    ],
  },
  "ocw-smoke-cli": {
    version: "1.0.0",
    manifest: {
      main: "index.js",
      license: "MIT",
      bin: { "ocw-smoke-cli": "bin/cli.js" },
      dependencies: { "ocw-smoke-dep": "1.0.0" },
      scripts: { postinstall: "node postinstall.js" },
    },
    hasInstallScript: true,
    files: (s) => [
      { name: "package/index.js", data: `module.exports = require("ocw-smoke-dep");\n// ${s}\n` },
      {
        name: "package/bin/cli.js",
        mode: 0o755,
        data: [
          "#!/usr/bin/env node",
          'const dep = require("ocw-smoke-dep");',
          'if (process.argv[2] === "--version") console.log("1.0.0");',
          'else console.log(dep.greet(process.argv[2] || "world"));',
          "",
        ].join("\n"),
      },
      {
        name: "package/postinstall.js",
        data: [
          'const fs = require("node:fs");',
          'const os = require("node:os");',
          "// Records where it ran: the installer's staging, as the installer's user.",
          'fs.writeFileSync(__dirname + "/postinstall-ran", JSON.stringify({ uid: process.getuid(), cwd: process.cwd(), host: os.hostname() }));',
          "",
        ].join("\n"),
      },
    ],
  },
  "ocw-smoke-old": {
    version: "1.0.0",
    manifest: { main: "index.js", license: "MIT" },
    sha1Only: true,
    files: (s) => [{ name: "package/index.js", data: `module.exports = 1;\n// ${s}\n` }],
  },
};

function npmArtifact(name) {
  const p = NPM[name];
  const s = stamp("npm", name, p.version);
  const manifest = { name, version: p.version, ...p.manifest };
  const tarball = tgz([
    { name: "package/package.json", data: `${JSON.stringify(manifest, null, 2)}\n` },
    ...p.files(s),
  ]);
  return { p, manifest, tarball };
}

function packument(name, base) {
  const { p, manifest, tarball } = npmArtifact(name);
  const dist = {
    tarball: `${base}/npm/${name}/-/${name}-${p.version}.tgz`,
    shasum: digest("sha1", tarball, "hex"),
  };
  if (!p.sha1Only) dist.integrity = `sha512-${digest("sha512", tarball, "base64")}`;
  return {
    _id: name,
    name,
    "dist-tags": { latest: p.version },
    versions: {
      [p.version]: {
        ...manifest,
        _id: `${name}@${p.version}`,
        _npmUser: { name: "ocw-smoke", email: "smoke@example.test" },
        ...(p.hasInstallScript ? { hasInstallScript: true } : {}),
        dist,
      },
    },
    time: { [p.version]: "2026-10-01T00:00:00.000Z" },
    license: manifest.license,
  };
}

// ---------------------------------------------------------------- PyPI

const b64url = (buf) =>
  digest("sha256", buf, "base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const PYPI = {
  "ocw-smoke-py": {
    dist: "ocw_smoke_py",
    version: "1.0.0",
    requires: ["ocw_smoke_pydep==1.0.0"],
    files: (s) => [
      {
        name: "ocw_smoke_py/__init__.py",
        data: `from ocw_smoke_pydep import greet\nVERSION = "1.0.0"\n# ${s}\n`,
      },
    ],
  },
  "ocw-smoke-pydep": {
    dist: "ocw_smoke_pydep",
    version: "1.0.0",
    requires: [],
    files: (s) => [
      { name: "ocw_smoke_pydep/__init__.py", data: `def greet(n):\n    return "hello " + n\n# ${s}\n` },
    ],
  },
};

function wheel(norm) {
  const p = PYPI[norm];
  const s = stamp("pypi", norm, p.version);
  const info = `${p.dist}-${p.version}.dist-info`;
  const files = [
    ...p.files(s),
    {
      name: `${info}/METADATA`,
      data: [
        "Metadata-Version: 2.1",
        `Name: ${p.dist}`,
        `Version: ${p.version}`,
        "Summary: OCW sandbox packages smoke fixture",
        "Author: OCW Smoke",
        "License: MIT",
        ...p.requires.map((r) => `Requires-Dist: ${r}`),
        "",
      ].join("\n"),
    },
    {
      name: `${info}/WHEEL`,
      data: "Wheel-Version: 1.0\nGenerator: ocw-fake-registry\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
    },
  ];
  const record = [
    ...files.map((f) => `${f.name},sha256=${b64url(Buffer.from(f.data))},${Buffer.byteLength(f.data)}`),
    `${info}/RECORD,,`,
    "",
  ].join("\n");
  files.push({ name: `${info}/RECORD`, data: record });
  return { file: `${p.dist}-${p.version}-py3-none-any.whl`, bytes: zip(files) };
}

const wheelByFile = (file) => {
  for (const norm of Object.keys(PYPI)) {
    const w = wheel(norm);
    if (w.file === file) return w;
  }
  return null;
};

// ---------------------------------------------------------------- ClawHub

const CLAWHUB = {
  "ocw-smoke-skill": { version: "1.0.0" },
};

function bundle(name) {
  const p = CLAWHUB[name];
  const s = stamp("clawhub", name, p.version);
  return tgz([
    { name: "package/package.json", data: `${JSON.stringify({ name, version: p.version })}\n` },
    {
      name: "package/SKILL.md",
      data: `---\nname: ${name}\ndescription: OCW smoke skill\n---\n\n# OCW smoke skill\n\nSays hello.\n<!-- ${s} -->\n`,
    },
  ]);
}

// ---------------------------------------------------------------- server

function send(res, status, body, type = "application/json") {
  const buf = Buffer.isBuffer(body)
    ? body
    : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(status, { "content-type": type, "content-length": buf.length, "cache-control": "no-store" });
  res.end(buf);
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve(null);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://registry");
  const path = decodeURIComponent(url.pathname);
  stats.set(path, (stats.get(path) ?? 0) + 1);
  const base = `http://${req.headers.host ?? `127.0.0.1:${PORT}`}`;

  if (req.method === "GET" && path === "/__stats") return send(res, 200, Object.fromEntries(stats));
  if (req.method === "POST" && path === "/__control/republish") {
    const b = await readJson(req);
    const ok =
      b &&
      ((b.source === "npm" && NPM[b.name]?.version === b.version) ||
        (b.source === "pypi" && PYPI[b.name]?.version === b.version) ||
        (b.source === "clawhub" && CLAWHUB[b.name]?.version === b.version));
    if (!ok) return send(res, 400, { error: "unknown package" });
    const key = `${b.source}/${b.name}@${b.version}`;
    nonces.set(key, (nonces.get(key) ?? 0) + 1);
    return send(res, 200, { republished: key });
  }
  if (req.method !== "GET") return send(res, 405, { error: "method" });

  // npm: /npm/<name> and /npm/<name>/-/<file>.tgz (scoped names are not used by the fixtures)
  let m = /^\/npm\/([^/]+)$/.exec(path);
  if (m) return NPM[m[1]] ? send(res, 200, packument(m[1], base)) : send(res, 404, { error: "Not found" });
  m = /^\/npm\/([^/]+)\/-\/([^/]+)$/.exec(path);
  if (m) {
    const name = m[1];
    if (!NPM[name] || m[2] !== `${name}-${NPM[name].version}.tgz`)
      return send(res, 404, { error: "Not found" });
    return send(res, 200, npmArtifact(name).tarball, "application/octet-stream");
  }

  // PyPI simple index
  m = /^\/simple\/([^/]+)\/?$/.exec(path);
  if (m) {
    const norm = m[1].toLowerCase().replace(/[-_.]+/g, "-");
    if (!PYPI[norm]) return send(res, 404, "not found", "text/plain");
    const w = wheel(norm);
    const sha = digest("sha256", w.bytes, "hex");
    const html = `<!DOCTYPE html><html><body><a href="/files/${w.file}#sha256=${sha}">${w.file}</a></body></html>\n`;
    return send(res, 200, html, "text/html; charset=utf-8");
  }
  m = /^\/files\/([^/]+)$/.exec(path);
  if (m) {
    const w = wheelByFile(m[1]);
    return w
      ? send(res, 200, w.bytes, "application/octet-stream")
      : send(res, 404, "not found", "text/plain");
  }

  // ClawHub
  m = /^\/api\/v1\/packages\/([^/]+)(?:\/versions\/([^/]+)(\/artifact\/download)?)?$/.exec(path);
  if (m) {
    const name = m[1];
    const p = CLAWHUB[name];
    if (!p || (m[2] !== undefined && m[2] !== p.version))
      return send(res, 404, { error: "package not found" });
    const pkg = { name, displayName: "OCW smoke skill", family: "skill", ownerHandle: "ocw-smoke" };
    if (m[3]) return send(res, 200, bundle(name), "application/octet-stream");
    if (m[2]) return send(res, 200, { package: pkg, version: { version: p.version, license: "MIT" } });
    return send(res, 200, { package: pkg, owner: { handle: "ocw-smoke" } });
  }

  return send(res, 404, { error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  process.stdout.write(`${JSON.stringify({ msg: "listening", port: PORT })}\n`);
});
