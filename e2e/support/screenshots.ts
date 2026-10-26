/**
 * Which specs may write review screenshots (07.9 polish, WINDOWS #320, #329). A run that names specs on the command
 * line (`scripts/e2e-isolated.sh work-zone-title work-zone.spec`) writes the screenshots of exactly those specs: a
 * filter that also matches other files (`work-zone-visibility` matches `work-zone-visibility-marker.spec.ts`) and the
 * `setup` project, which runs before every run, leave the folder alone, so another plan's reviewed captures are never
 * overwritten. A run without spec filters (a full run, the compose gate) writes every spec's screenshots, as before.
 * `OCW_E2E_SCREENSHOT_SPECS` (comma-separated names, `*` for all) overrides what the command line says.
 */

/** Playwright `test` options that take their value as the next argument (`--project desktop`). */
const VALUE_OPTIONS = new Set([
  "-c",
  "--config",
  "-g",
  "--grep",
  "-G",
  "--grep-invert",
  "--project",
  "--reporter",
  "-j",
  "--workers",
  "--retries",
  "--timeout",
  "--global-timeout",
  "--output",
  "--repeat-each",
  "-x",
  "--max-failures",
  "--shard",
  "--trace",
  "--tsconfig",
  "--only-changed",
]);
/** `-u` / `--update-snapshots` take an optional mode. */
const SNAPSHOT_MODES = new Set(["all", "changed", "missing", "none"]);

/** A spec path, file name or command-line filter reduced to the spec's bare name (`work-zone-title`). */
export function specName(fileOrFilter: string): string {
  const base = fileOrFilter.split(/[\\/]/).pop() ?? fileOrFilter;
  return base
    .replace(/:\d+(:\d+)?$/, "")
    .replace(/\.ts$/, "")
    .replace(/\.spec$/, "");
}

/**
 * The spec names given to `playwright test` in `argv` (comma-separated), or undefined when the run names none or
 * `argv` is not a `playwright test` command line (a worker process).
 */
export function screenshotSpecsFromArgv(argv: readonly string[]): string | undefined {
  const at = argv.indexOf("test");
  if (at < 0) return undefined;
  const names: string[] = [];
  for (let i = at + 1; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (VALUE_OPTIONS.has(arg)) {
      i++;
      continue;
    }
    if (arg === "-u" || arg === "--update-snapshots") {
      if (SNAPSHOT_MODES.has(argv[i + 1] ?? "")) i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    names.push(specName(arg));
  }
  return names.length > 0 ? names.join(",") : undefined;
}

/** Whether the spec in `specFile` writes its screenshots, given the run's spec list (undefined: every spec). */
export function writesScreenshots(specFile: string, specs: string | undefined): boolean {
  if (specs === undefined || specs.trim() === "*") return true;
  const wanted = new Set(
    specs
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(specName),
  );
  return wanted.has(specName(specFile));
}
