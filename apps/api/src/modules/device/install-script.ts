import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  RUNTIME_BUNDLE_FILE,
  RUNTIME_EXTERNAL_LOCK_FILE,
  RUNTIME_EXTERNAL_LOCK_ROOT,
  RUNTIME_ROUTES,
  RuntimeDistManifest,
} from "@ocw/contracts";

/**
 * Phase 07.12-06 (HSR-01, D-01, D-10, PD-04, PD-05): the POSIX installer served at `/api/v1/runtime/install.sh`.
 *
 * The script body is `install-script.sh` beside this file (plain sh, readable and lintable as such); rendering only
 * replaces its `@NAME@` placeholders with single-quoted values: the server URL (validated by `assertScriptSafeUrl`,
 * always `OCW_PUBLIC_API_URL`, never a request header) and the version, sha256 and npm pins of the served manifest
 * (each already constrained by the manifest's own regexes), plus the bundle's npm lockfile and its package.json inside
 * quoted heredocs (07.12 review ME-03). The script installs for the current user only, verifies the bundle's sha256
 * with node before using it, installs the Claude Agent SDK, its peers and their whole tree beside it with
 * `npm ci --omit=optional --ignore-scripts` (exact versions and integrity from the lockfile), never elevates, never
 * evaluates text and pipes nothing to a shell; its body runs from `main()` on the last line, so a truncated download
 * does nothing.
 */

const TEMPLATE = readFileSync(new URL("./install-script.sh", import.meta.url), "utf8");

/** The only characters a URL embedded in the script may hold (no quotes, `$`, backticks, spaces, `?`, `#` or `@`). */
const SCRIPT_SAFE_URL = /^https?:\/\/[A-Za-z0-9.:/_-]+$/;

/**
 * The server URL as the script embeds it (without trailing slashes), or a thrown error: `http`/`https` only, a host,
 * no credentials, query or fragment, and only `[A-Za-z0-9.:/_-]` characters.
 */
export function assertScriptSafeUrl(url: string): string {
  if (!SCRIPT_SAFE_URL.test(url)) {
    throw new Error(
      "the install script URL must be http(s) and use only the characters A-Z a-z 0-9 . : / _ -",
    );
  }
  const parsed = new URL(url);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("the install script URL must be a plain http(s) origin and path");
  }
  return url.replace(/\/+$/, "");
}

/** `'value'` for sh; a `'` inside becomes `'\''` (the validated values never hold one, this is belt and braces). */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export interface InstallScriptInput {
  /** `OCW_PUBLIC_API_URL`. */
  serverUrl: string;
  /** The verified manifest of the bundle the API serves. */
  manifest: RuntimeDistManifest;
  /** The bundle's `npm-shrinkwrap.json`, as built (its sha256 is the manifest's `externalLockSha256`). */
  externalLock: string;
}

/** Heredoc delimiters of the two embedded files; JSON.stringify output never has a line equal to either. */
const LOCK_MARKER = "OCW_EXTERNAL_LOCK";
const PACKAGE_MARKER = "OCW_PACKAGE_JSON";

/**
 * The lockfile, checked against the manifest (ME-03): the bytes it hashed, lockfile v3, rooted at
 * `RUNTIME_EXTERNAL_LOCK_ROOT` with exactly the manifest's pins. Returns the matching `package.json` text `npm ci`
 * needs beside it.
 */
function externalLockFiles(m: RuntimeDistManifest, lockText: string): { lock: string; packageJson: string } {
  if (createHash("sha256").update(lockText).digest("hex") !== m.externalLockSha256) {
    throw new Error("the external lockfile does not match the manifest's externalLockSha256");
  }
  const lock = JSON.parse(lockText) as {
    lockfileVersion?: unknown;
    packages?: Record<string, { name?: unknown; dependencies?: unknown }>;
  };
  const root = lock.packages?.[""];
  const pins = Object.fromEntries(m.external.map((p) => [p.name, p.version]));
  if (
    lock.lockfileVersion !== 3 ||
    root?.name !== RUNTIME_EXTERNAL_LOCK_ROOT ||
    JSON.stringify(root.dependencies) !== JSON.stringify(pins)
  ) {
    throw new Error("the external lockfile is not rooted at the manifest's pins");
  }
  const packageJson = `${JSON.stringify({ name: RUNTIME_EXTERNAL_LOCK_ROOT, private: true, dependencies: pins }, null, 2)}\n`;
  for (const text of [lockText, packageJson]) {
    const lines = text.split("\n");
    if (lines.includes(LOCK_MARKER) || lines.includes(PACKAGE_MARKER)) {
      throw new Error("the external lockfile cannot be embedded in the install script");
    }
  }
  return { lock: lockText.replace(/\n$/, ""), packageJson: packageJson.replace(/\n$/, "") };
}

/** The install script for one served bundle (see the module comment). Throws on an unsafe URL, manifest or lock. */
export function renderInstallScript({ serverUrl, manifest, externalLock }: InstallScriptInput): string {
  const server = assertScriptSafeUrl(serverUrl);
  const m = RuntimeDistManifest.parse(manifest);
  const sdk = m.external[0];
  if (!sdk) throw new Error("the manifest names no external package");
  const files = externalLockFiles(m, externalLock);
  const values: Record<string, string> = {
    SERVER_URL: shellQuote(server),
    VERSION: shellQuote(m.version),
    SHA256: shellQuote(m.sha256),
    SHA12: shellQuote(m.sha256.slice(0, 12)),
    MIN_NODE: shellQuote(String(m.minNode)),
    BUNDLE_ROUTE: shellQuote(RUNTIME_ROUTES.bundle),
    BUNDLE_FILE: shellQuote(RUNTIME_BUNDLE_FILE),
    SDK_PACKAGE: shellQuote(sdk.name),
    LOCK_FILE: shellQuote(RUNTIME_EXTERNAL_LOCK_FILE),
    // Raw file contents, each inside a quoted heredoc (no expansion), checked above.
    EXTERNAL_LOCK: files.lock,
    PACKAGE_JSON: files.packageJson,
  };
  return TEMPLATE.replace(/@([A-Z0-9_]+)@/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`install script template: unknown placeholder ${key}`);
    return value;
  });
}
