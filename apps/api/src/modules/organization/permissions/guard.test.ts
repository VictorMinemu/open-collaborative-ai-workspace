import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static guard (research §Pattern 4): no role check may live outside the permission resolver. A file that
 * still holds an interim check carries `authz-legacy: 02-NN` naming the plan that migrates it; each plan
 * deletes its marker, and 02-15 proves none is left.
 */

const ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));

const ROLE_LITERAL = /\brole\s*[!=]==\s*["'](standard|developer|lead|admin)["']/;
const API_PATTERNS: readonly RegExp[] = [/\brequireRole\s*\(/, /\bisAdmin\b/, ROLE_LITERAL];
const WEB_PATTERNS: readonly RegExp[] = [/\buseIsAdmin\b/, /\bisAdmin\b/, ROLE_LITERAL];
const MARKER = /authz-legacy: 02-\d\d\b/;
const ANY_MARKER = /authz-legacy/;

function walk(dir: string, accept: (file: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, accept, out);
    else if (accept(full)) out.push(full);
  }
  return out;
}

const rel = (file: string) => relative(ROOT, file).split("\\").join("/");

function apiFiles(): string[] {
  return walk(join(ROOT, "apps/api/src"), (f) => {
    const r = rel(f);
    return r.endsWith(".ts") && !r.endsWith(".test.ts") && !r.includes("modules/organization/permissions/");
  });
}

function webFiles(): string[] {
  return ["app", "components", "lib"].flatMap((d) =>
    walk(join(ROOT, "apps/web", d), (f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f)),
  );
}

/** `file:line  code` for every legacy check in an unmarked file, plus every marker without a plan id. */
function scan(files: readonly string[], patterns: readonly RegExp[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    const marked = lines.some((l) => MARKER.test(l));
    lines.forEach((line, i) => {
      if (ANY_MARKER.test(line) && !MARKER.test(line))
        hits.push(`${rel(file)}:${i + 1}  marker without a plan id`);
      if (marked) return;
      if (patterns.some((p) => p.test(line))) hits.push(`${rel(file)}:${i + 1}  ${line.trim()}`);
    });
  }
  return hits;
}

describe("legacy authorization guard", () => {
  it("self-check: every pattern matches a sample legacy line", () => {
    const samples: Array<[readonly RegExp[], string[]]> = [
      [
        API_PATTERNS,
        [
          'preHandler: identity.requireRole("admin"),',
          'const isAdmin = auth.role === "admin";',
          "if (auth.role !== 'lead') throw forbidden();",
        ],
      ],
      [
        WEB_PATTERNS,
        [
          "const admin = useIsAdmin();",
          "{isAdmin ? <Button /> : null}",
          'me.organization.role === "developer"',
        ],
      ],
    ];
    for (const [patterns, lines] of samples) {
      for (const p of patterns)
        expect(
          lines.some((l) => p.test(l)),
          String(p),
        ).toBe(true);
    }
    expect(ROLE_LITERAL.test('role: "admin"')).toBe(false);
    expect(MARKER.test("// authz-legacy: 02-04 migrates this file to the resolver")).toBe(true);
    expect(MARKER.test("// authz-legacy: later")).toBe(false);
  });

  it("scans real files (the trees are found)", () => {
    expect(apiFiles().length).toBeGreaterThan(20);
    expect(webFiles().length).toBeGreaterThan(20);
    expect(apiFiles().some((f) => rel(f) === "apps/api/src/app.ts")).toBe(true);
  });

  it("no unmarked legacy role check in the API", () => {
    expect(scan(apiFiles(), API_PATTERNS)).toEqual([]);
  });

  it("no unmarked legacy role check in the web", () => {
    expect(scan(webFiles(), WEB_PATTERNS)).toEqual([]);
  });
});
