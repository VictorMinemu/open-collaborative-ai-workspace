import { readFileSync } from "node:fs";
import { RUNTIME_BUNDLE_FILE, RUNTIME_ROUTES, RuntimeDistManifest } from "@ocw/contracts";

/**
 * Phase 07.12-06 (HSR-01, D-01, D-10, PD-04, PD-05): the POSIX installer served at `/api/v1/runtime/install.sh`.
 *
 * The script body is `install-script.sh` beside this file (plain sh, readable and lintable as such); rendering only
 * replaces its `@NAME@` placeholders with single-quoted values: the server URL (validated by `assertScriptSafeUrl`,
 * always `OCW_PUBLIC_API_URL`, never a request header) and the version, sha256 and npm pins of the served manifest
 * (each already constrained by the manifest's own regexes). The script installs for the current user only, verifies the
 * bundle's sha256 with node before using it, installs the Claude Agent SDK and its peers beside it with
 * `--omit=optional --ignore-scripts`, never elevates, never evaluates text and pipes nothing to a shell; its body runs
 * from `main()` on the last line, so a truncated download does nothing.
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
}

/** The install script for one served bundle (see the module comment). Throws on an unsafe URL or manifest. */
export function renderInstallScript({ serverUrl, manifest }: InstallScriptInput): string {
  const server = assertScriptSafeUrl(serverUrl);
  const m = RuntimeDistManifest.parse(manifest);
  const sdk = m.external[0];
  if (!sdk) throw new Error("the manifest names no external package");
  const values: Record<string, string> = {
    SERVER_URL: shellQuote(server),
    VERSION: shellQuote(m.version),
    SHA256: shellQuote(m.sha256),
    SHA12: shellQuote(m.sha256.slice(0, 12)),
    MIN_NODE: shellQuote(String(m.minNode)),
    BUNDLE_ROUTE: shellQuote(RUNTIME_ROUTES.bundle),
    BUNDLE_FILE: shellQuote(RUNTIME_BUNDLE_FILE),
    SDK_PACKAGE: shellQuote(sdk.name),
    PINS: m.external.map((p) => shellQuote(`${p.name}@${p.version}`)).join(" "),
  };
  return TEMPLATE.replace(/@([A-Z0-9_]+)@/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`install script template: unknown placeholder ${key}`);
    return value;
  });
}
