import { z } from "zod";
import { IsoDateTime } from "./common";

/**
 * Phase 07.12 (headless Work Zone server, HSR-01, D-01, D-10, D-13). The distribution vocabulary: the single-file
 * Local Runtime bundle the API serves from the workspace itself (no npm publish, no third-party host, principle 10),
 * its routes, the install command shown in Settings › Devices and the manifest that describes one build.
 *
 * Written by `apps/local-runtime/scripts/build-bundle.mjs` (07.12-01); served and re-verified by the API's device
 * module (07.12-06); read by `install.sh` (06), `ocw-runtime doctor` (05) and the web's Add a device dialog (07).
 *
 * Imports only `zod` and `./common`.
 */

/** The bundle's file name, everywhere: build output, download attachment name and the installed file. */
export const RUNTIME_BUNDLE_FILE = "ocw-runtime.mjs";

/** The public distribution routes (D-13), all under `/api/v1/runtime/`, all `authz: "public"` (07.12-06). */
export const RUNTIME_ROUTES = {
  installScript: "/api/v1/runtime/install.sh",
  bundle: "/api/v1/runtime/bundle",
  bundleSha256: "/api/v1/runtime/bundle.sha256",
  version: "/api/v1/runtime/version",
  /**
   * 07.17.1 (D-03, PD-16): the served bundle's `RUNTIME_EXTERNAL_LOCK_FILE`, read by the daemon's self-update (the
   * lockfile is otherwise only inside `install.sh`'s heredoc). Same rate limit and verification as the bundle.
   */
  externalLock: "/api/v1/runtime/npm-shrinkwrap.json",
} as const;

/** The one command a server owner pastes (Settings › Devices › Add a device › Server, D-01). */
export function runtimeInstallCommand(apiUrl: string): string {
  return `curl -fsSL ${apiUrl.replace(/\/+$/, "")}${RUNTIME_ROUTES.installScript} | sh`;
}

/**
 * The only licenses a package inlined into the bundle may carry (D-01): permissive, compatible with shipping inside an
 * AGPL file. The build fails on anything else (`build-bundle.mjs` keeps an equal copy; its test checks they match).
 */
export const BUNDLE_LICENSE_ALLOWLIST = [
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "BlueOak-1.0.0",
] as const;
export const BundleLicense = z.enum(BUNDLE_LICENSE_ALLOWLIST);
export type BundleLicense = z.infer<typeof BundleLicense>;

/** The Claude Agent SDK: never inside the bundle, installed beside it from the server's npm registry (D-10). */
export const CLAUDE_AGENT_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/**
 * The npm lockfile of everything installed beside the bundle (07.12 review ME-03): the SDK, its peers and their whole
 * dependency tree at the exact versions and integrity the runtime was built with. Written next to the bundle by the
 * build, embedded in `install.sh` with a `package.json` named `RUNTIME_EXTERNAL_LOCK_ROOT`, installed by `npm ci`.
 * `build-bundle.mjs` keeps equal copies of both names (bundle.test.ts checks them).
 */
export const RUNTIME_EXTERNAL_LOCK_FILE = "npm-shrinkwrap.json";
export const RUNTIME_EXTERNAL_LOCK_ROOT = "ocw-runtime-deps";

const NPM_NAME_RE = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+$/;
const BUNDLE_VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

/** An npm package at one exact version (`x.y.z`): what `install.sh` passes to `npm install` beside the bundle. */
export const NpmPackagePin = z.strictObject({
  name: z.string().max(214).regex(NPM_NAME_RE),
  version: z.string().regex(EXACT_VERSION_RE),
});
export type NpmPackagePin = z.infer<typeof NpmPackagePin>;

/** A third-party package inlined into the bundle, with its license (its notice is in the bundle's footer). */
export const BundledPackage = z.strictObject({
  name: z.string().max(214).regex(NPM_NAME_RE),
  version: z.string().max(64),
  license: BundleLicense,
});
export type BundledPackage = z.infer<typeof BundledPackage>;

/**
 * One build of the runtime (`manifest.json` beside `ocw-runtime.mjs`; `GET /api/v1/runtime/version`). `sha256` and
 * `bytes` are computed over the final file; the API re-hashes before serving and `install.sh` verifies before
 * installing. `external` is the SDK followed by its peer dependencies, each at the exact version the runtime was
 * tested with; `externalLockSha256` is the sha256 of `RUNTIME_EXTERNAL_LOCK_FILE`, which pins their whole tree (the API
 * re-hashes it before embedding it in `install.sh`). `bundled` never names the SDK. `source` points at the corresponding
 * source (AGPL).
 */
export const RuntimeDistManifest = z.strictObject({
  version: z.string().max(64).regex(BUNDLE_VERSION_RE),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive(),
  file: z.literal(RUNTIME_BUNDLE_FILE),
  minNode: z.number().int().min(24),
  external: z
    .array(NpmPackagePin)
    .min(1)
    .max(10)
    .refine((pins) => pins[0]?.name === CLAUDE_AGENT_SDK_PACKAGE, {
      message: `the first external package must be ${CLAUDE_AGENT_SDK_PACKAGE}`,
    }),
  externalLockSha256: z.string().regex(/^[0-9a-f]{64}$/),
  bundled: z
    .array(BundledPackage)
    .max(300)
    .refine((pkgs) => pkgs.every((p) => p.name !== CLAUDE_AGENT_SDK_PACKAGE), {
      message: `${CLAUDE_AGENT_SDK_PACKAGE} is never bundled (D-10)`,
    }),
  source: z.strictObject({
    repository: z.url(),
    commit: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .nullable(),
  }),
  builtAt: IsoDateTime,
});
export type RuntimeDistManifest = z.infer<typeof RuntimeDistManifest>;
