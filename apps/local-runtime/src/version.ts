// The Local Runtime's version (07.12, D-05). The bundle build (`scripts/build-bundle.mjs`) replaces
// `__OCW_RUNTIME_VERSION__` with the package version through esbuild's `define`; under tsx (a checkout of this
// monorepo) nothing defines it and the runtime reports `0.0.0-dev`. Reported as the daemon's `daemonVersion` in the
// Device Link hello, printed by `ocw-runtime version`, and compared by `ocw-runtime doctor` with the served manifest.

declare const __OCW_RUNTIME_VERSION__: string | undefined;

/** The development fallback: a checkout run through tsx, never a served bundle. */
export const DEV_RUNTIME_VERSION = "0.0.0-dev";

// `typeof` on an undeclared global never throws, so tsx (no define) falls through to the development version.
export const RUNTIME_VERSION: string =
  typeof __OCW_RUNTIME_VERSION__ === "string" ? __OCW_RUNTIME_VERSION__ : DEV_RUNTIME_VERSION;
