#!/usr/bin/env node
// OCW install gate for the OpenClaw cell (03.1-12, D-14): OpenClaw's operator `security.installPolicy` exec.
//
// OpenClaw runs it (no shell, empty base env + passEnv) after staging a plugin and before committing the install,
// for CLI and Gateway installs alike, and fails closed on anything but a well-formed answer
// (docs/tools/skills-config.md "Operator Install Policy"; dist install-policy-*.mjs). Contract (protocol 1):
//   stdin  { protocolVersion: 1, targetType, targetName, sourcePath, sourcePathKind, source?, origin, request:
//            { kind, mode, requestedSpecifier? }, plugin? }
//   stdout { protocolVersion: 1, decision: "allow" | "block", reason? }   (block always carries a reason)
//
// The decision comes ONLY from the API's authenticated answer. The only installs it can approve are the ones our
// executor stages: `npm-pack:<absolute path>` archives. For every call of such an install (preflight on the archive,
// the unpacked package, its dependency tree) the gate re-reads that archive itself, hashes it (sha256), reads the
// package name and version from the archive's own package.json, cross-checks them with what OpenClaw says it is
// installing, and asks `POST /agent-channel/v1/plugins/verify-install` with the cell token (5 s). Only
// `200 {approved: true}` allows. Missing env, missing token, any other source (clawhub:, npm:, git:, a path),
// a malformed request, an unreachable or slow API, 401, 5xx, a malformed answer: block. It never reads any local
// approval or cache file (the gateway can write those; T-03.1-12-09). Node builtins only.
//
// Env (passEnv): OCW_API_URL, OCW_CELL_TOKEN_FILE.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const VERIFY_PATH = "/agent-channel/v1/plugins/verify-install";
const API_TIMEOUT_MS = 5_000;
/** Same cap as the executor's download. */
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const MAX_INPUT_BYTES = 256 * 1024;

class Refusal extends Error {}

const refuse = (reason) => {
  throw new Refusal(reason);
};

function answer(decision) {
  process.stdout.write(`${JSON.stringify({ protocolVersion: 1, ...decision })}\n`);
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) refuse("policy input too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** `package/package.json` of an npm-pack tarball (ustar, pax `path` and GNU long names supported). */
export function packageJsonOfTarball(gz) {
  let tar;
  try {
    tar = gunzipSync(gz, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch {
    refuse("the staged archive is not a gzip tarball");
  }
  let offset = 0;
  let longName = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, len) =>
      header
        .subarray(start, start + len)
        .toString("utf8")
        .replace(/\0.*$/su, "");
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) refuse("the staged archive has a corrupt tar header");
    const type = field(156, 1);
    const prefix = field(345, 155);
    const shortName = field(0, 100);
    const dataStart = offset + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === "x") {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/u.exec(data.toString("utf8"));
      longName = m ? m[1] : longName;
      continue;
    }
    if (type === "L") {
      longName = data.toString("utf8").replace(/\0.*$/su, "");
      continue;
    }
    if (type === "g") continue;
    const name = longName ?? (prefix ? `${prefix}/${shortName}` : shortName);
    longName = null;
    const parts = name.replace(/^\.\//u, "").split("/");
    if (parts.length === 2 && parts[1] === "package.json" && (type === "0" || type === "")) {
      let pkg;
      try {
        pkg = JSON.parse(data.toString("utf8"));
      } catch {
        refuse("the staged archive's package.json is not JSON");
      }
      const packageName = str(pkg?.name);
      const version = str(pkg?.version);
      if (!packageName || !version) refuse("the staged archive's package.json has no name or version");
      return { packageName, version };
    }
  }
  refuse("the staged archive has no package.json");
}

/** The verified (package, version, sha256) of the staged npm-pack archive named by the request. */
export function stagedArtifact(input) {
  if (!isObject(input)) refuse("malformed policy input");
  if (input.protocolVersion !== 1) refuse("unsupported policy protocol version");
  if (input.targetType !== "plugin") refuse("only marketplace plugin installs are allowed in this cell");
  const spec = isObject(input.request) ? input.request.requestedSpecifier : undefined;
  if (typeof spec !== "string" || !spec.startsWith("npm-pack:")) {
    refuse("only admin-approved marketplace installs staged by the workspace are allowed in this cell");
  }
  const archive = spec.slice("npm-pack:".length);
  if (!path.isAbsolute(archive) || path.normalize(archive) !== archive) {
    refuse("the staged archive path is not absolute");
  }
  let stat;
  try {
    stat = lstatSync(archive);
  } catch {
    refuse("the staged archive is missing");
  }
  if (!stat.isFile()) refuse("the staged archive is not a regular file");
  if (stat.size > MAX_ARCHIVE_BYTES) refuse("the staged archive is too large");
  const bytes = readFileSync(archive);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { packageName, version } = packageJsonOfTarball(bytes);
  // What OpenClaw says it installs must be what the archive is.
  const plugin = isObject(input.plugin) ? input.plugin : {};
  const origin = isObject(input.origin) ? input.origin : {};
  for (const claimed of [plugin.packageName, origin.packageName]) {
    if (claimed !== undefined && claimed !== packageName)
      refuse("the staged package does not match the archive");
  }
  for (const claimed of [plugin.version, origin.version]) {
    if (claimed !== undefined && claimed !== version) refuse("the staged version does not match the archive");
  }
  return { packageName, version, sha256 };
}

function readToken(env) {
  const file = str(env.OCW_CELL_TOKEN_FILE);
  if (!file) refuse("no cell token configured (OCW_CELL_TOKEN_FILE)");
  let token;
  try {
    token = readFileSync(file, "utf8").trim();
  } catch {
    refuse("the cell token file is not readable");
  }
  if (!token) refuse("the cell token file is empty");
  return token;
}

/** Asks the API (the only authority). Anything but `200 {approved: true}` is a refusal. */
export async function verifyWithApi(tuple, env, fetchImpl = fetch) {
  const apiUrl = str(env.OCW_API_URL);
  if (!apiUrl) refuse("no Agent Channel API configured (OCW_API_URL)");
  const token = readToken(env);
  let res;
  try {
    res = await fetchImpl(`${apiUrl.replace(/\/+$/u, "")}${VERIFY_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(tuple),
      redirect: "error",
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    refuse(
      timedOut
        ? `the workspace API did not answer within ${API_TIMEOUT_MS / 1000} s (unreachable): install blocked`
        : "the workspace API is unreachable: install blocked",
    );
  }
  if (res.status !== 200) refuse(`the workspace API refused the check (HTTP ${res.status})`);
  let body;
  try {
    body = JSON.parse(await res.text());
  } catch {
    refuse("the workspace API answered with malformed JSON");
  }
  if (!isObject(body) || typeof body.approved !== "boolean")
    refuse("the workspace API answered malformed data");
  if (body.approved !== true) {
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 120) : "not_approved";
    refuse(`not an admin-approved install in flight (${reason})`);
  }
}

async function main() {
  try {
    let input;
    try {
      input = JSON.parse(await readStdin());
    } catch (error) {
      if (error instanceof Refusal) throw error;
      refuse("malformed policy input");
    }
    const tuple = stagedArtifact(input);
    await verifyWithApi(tuple, process.env);
    answer({ decision: "allow" });
  } catch (error) {
    const reason = error instanceof Refusal ? error.message : "the install gate failed";
    answer({ decision: "block", reason });
  }
}

await main();
