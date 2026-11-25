// The automated legitimacy check of playwright-core in the Local Runtime (07.13 PD-22, RESEARCH § Package Legitimacy
// Audit; it replaces the human checkpoint): the runtime pins the exact version the bots' brw image runs, the pnpm
// lockfile's tarball integrity equals brw's npm lockfile and the audited sha512, and the package runs no install
// script anywhere (no lifecycle entry in either lockfile, not allowed to build, none in its package.json).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PKG_ROOT = join(import.meta.dirname, "..");
const REPO = join(PKG_ROOT, "..", "..");
const NAME = "playwright-core";
const VERSION = "1.64.1";
/** The audited tarball integrity of playwright-core 1.64.1 (07.13-RESEARCH.md, brw's package-lock.json). */
const INTEGRITY =
  "sha512-BC4s8y6SEVA6Q1rSxZTto8hI1KUI3xXlHGZgvGqP4IqPdI/a6FX9H29IDNz7vKo9l21b6LfYosScPL6M3xxyDQ==";

const read = (path: string) => readFileSync(path, "utf8");
const pkg = JSON.parse(read(join(PKG_ROOT, "package.json"))) as { dependencies: Record<string, string> };
const pnpmLock = read(join(REPO, "pnpm-lock.yaml"));

/** The lines of one top-level key's block in a section of pnpm-lock.yaml (`packages:` or `snapshots:`). */
function lockBlock(section: string, key: string): string[] {
  const lines = pnpmLock.split("\n");
  const start = lines.indexOf(`${section}:`);
  expect(start, `${section}: in pnpm-lock.yaml`).toBeGreaterThan(-1);
  const head = lines.findIndex((l, i) => i > start && (l === `  ${key}:` || l === `  ${key}: {}`));
  expect(head, `${key} in ${section}`).toBeGreaterThan(-1);
  const out = [lines[head] ?? ""];
  for (let i = head + 1; i < lines.length && /^ {4}/.test(lines[i] ?? ""); i++) out.push(lines[i] ?? "");
  return out;
}

describe("playwright-core in the Local Runtime (07.13 PD-22)", () => {
  it("is pinned to the brw engine's exact version, beside the shared engine package", () => {
    expect(pkg.dependencies[NAME]).toBe(VERSION);
    expect(pkg.dependencies["@ocw/browser-engine"]).toBe("workspace:*");
    const brw = JSON.parse(read(join(REPO, "infra", "sandbox", "browser", "package.json"))) as {
      dependencies: Record<string, string>;
    };
    expect(brw.dependencies[NAME]).toBe(VERSION);
  });

  it("the pnpm lockfile resolves the runtime's playwright-core to that version", () => {
    const lines = pnpmLock.split("\n");
    const importer = lines.indexOf("  apps/local-runtime:");
    expect(importer).toBeGreaterThan(-1);
    const next = lines.findIndex((l, i) => i > importer && /^ {2}\S/.test(l));
    const block = lines.slice(importer, next === -1 ? undefined : next).join("\n");
    expect(block).toMatch(
      new RegExp(`\\n {6}${NAME}:\\n {8}specifier: ${VERSION}\\n {8}version: ${VERSION}\\n`),
    );
  });

  it("its lockfile integrity equals brw's npm lockfile and the audited sha512", () => {
    const entry = lockBlock("packages", `${NAME}@${VERSION}`);
    expect(entry[1]).toBe(`    resolution: {integrity: ${INTEGRITY}}`);
    const brwLock = JSON.parse(read(join(REPO, "infra", "sandbox", "browser", "package-lock.json"))) as {
      packages: Record<string, { version?: string; integrity?: string; hasInstallScript?: boolean }>;
    };
    const brw = brwLock.packages[`node_modules/${NAME}`];
    expect(brw?.version).toBe(VERSION);
    expect(brw?.integrity).toBe(INTEGRITY);
    expect(brw?.hasInstallScript).toBeUndefined();
  });

  it("runs no install script: none in the lockfile, not allowed to build, none in its package.json", () => {
    for (const line of [
      ...lockBlock("packages", `${NAME}@${VERSION}`),
      ...lockBlock("snapshots", `${NAME}@${VERSION}`),
    ])
      expect(line).not.toMatch(/requiresBuild|hasInstallScript/);
    const workspace = read(join(REPO, "pnpm-workspace.yaml"));
    const allowBuilds = /\nallowBuilds:\n((?: {2}.*\n|\s*#.*\n)*)/.exec(workspace)?.[1] ?? "";
    expect(allowBuilds).toContain("esbuild");
    expect(allowBuilds).not.toContain(NAME);
    const installed = JSON.parse(
      read(createRequire(join(PKG_ROOT, "package.json")).resolve(`${NAME}/package.json`)),
    ) as { version: string; scripts?: Record<string, string> };
    expect(installed.version).toBe(VERSION);
    for (const hook of ["preinstall", "install", "postinstall", "prepare"])
      expect(installed.scripts?.[hook]).toBeUndefined();
  });
});
