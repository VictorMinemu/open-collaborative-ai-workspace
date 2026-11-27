// Build-time flags of the main process (07.13.1, D-02). scripts/build.mjs replaces `__OCW_RELEASE_BUILD__` through
// esbuild's `define`: `true` only when `OCW_RELEASE_BUILD=1`, which only the release workflow sets, and only for a
// tag's build. A local `pnpm package`, a pull request build, a fork's build and the tests see `false`, so such a build
// never replaces itself with an upstream release.

declare const __OCW_RELEASE_BUILD__: boolean | undefined;

// `typeof` on an undeclared global never throws, so an undefined flag (vitest, tsx) is simply false.
export const RELEASE_BUILD: boolean = typeof __OCW_RELEASE_BUILD__ === "boolean" && __OCW_RELEASE_BUILD__;
