import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static guard (research §Pattern 4): no role check may live outside the permission resolver. During the
 * Phase 2 migration a file holding an interim check carried a legacy marker naming the plan that migrated
 * it; 02-15 removed the last one, so a marker anywhere is now a failure, as is any legacy helper name, the
 * deleted role preHandler, an `isAdmin` identifier or a role compared against an org-role literal.
 */

const ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));

const ROLE_LITERAL = /\brole\s*[!=]==\s*["'](standard|developer|lead|admin)["']/;
/** Helpers deleted by 02-04, 02-05, 02-07, 02-10 and 02-15; none may come back under the same name. */
const LEGACY_HELPERS =
  /\b(canRead|requireReadable|requireWritable|canUseDevice|listUsableProjects|assertCanApprove|requireActiveAgent|requireMembership|requireRole)\b/;
const API_PATTERNS: readonly RegExp[] = [LEGACY_HELPERS, /\bisAdmin\b/, ROLE_LITERAL];
const WEB_PATTERNS: readonly RegExp[] = [/\buseIsAdmin\b/, LEGACY_HELPERS, /\bisAdmin\b/, ROLE_LITERAL];
// Assembled so this file does not match its own marker scan.
const MARKER = new RegExp(["authz", "legacy"].join("-"));
const SELF = "apps/api/src/modules/organization/permissions/guard.test.ts";

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

/** Every .ts/.tsx file of both apps, tests included (for the marker scan), except this guard. */
function allSourceFiles(): string[] {
  return [
    ...walk(join(ROOT, "apps/api/src"), (f) => f.endsWith(".ts")),
    ...["app", "components", "lib"].flatMap((d) =>
      walk(join(ROOT, "apps/web", d), (f) => /\.(ts|tsx)$/.test(f)),
    ),
  ].filter((f) => rel(f) !== SELF);
}

/** `file:line  code` for every line matching one of the patterns. */
function scan(files: readonly string[], patterns: readonly RegExp[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
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
        [LEGACY_HELPERS],
        [
          "await requireReadable(tx, conversationId);",
          "if (!canRead(member)) return;",
          "requireWritable(tx, id)",
          "await canUseDevice(tx, deviceId)",
          "const projects = await listUsableProjects(tx);",
          "assertCanApprove(session, auth)",
          "await requireActiveAgent(tx, agentId);",
          "await requireMembership(tx, channelId, userId);",
        ],
      ],
      [
        WEB_PATTERNS,
        [
          "const admin = useIsAdmin();",
          "const readable = channels.filter(canRead);",
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
    // Every legacy helper name is caught on its own.
    for (const name of LEGACY_HELPERS.source.replace(/^\\b\(|\)\\b$/g, "").split("|"))
      expect(LEGACY_HELPERS.test(`${name}(`), name).toBe(true);
    expect(LEGACY_HELPERS.test("loadUnitMembership(tx, unitId, userId)")).toBe(false);
    expect(ROLE_LITERAL.test('role: "admin"')).toBe(false);
    expect(MARKER.test(`// ${["authz", "legacy"].join("-")}: 02-04 migrates this file`)).toBe(true);
  });

  it("scans real files (the trees are found)", () => {
    expect(apiFiles().length).toBeGreaterThan(20);
    expect(webFiles().length).toBeGreaterThan(20);
    expect(apiFiles().some((f) => rel(f) === "apps/api/src/app.ts")).toBe(true);
  });

  it("no legacy marker is left anywhere in either app (tests included)", () => {
    expect(allSourceFiles().length).toBeGreaterThan(apiFiles().length);
    expect(scan(allSourceFiles(), [MARKER])).toEqual([]);
  });

  it("no legacy role check or legacy helper in the API", () => {
    expect(scan(apiFiles(), API_PATTERNS)).toEqual([]);
  });

  it("no legacy role check or legacy helper in the web", () => {
    expect(scan(webFiles(), WEB_PATTERNS)).toEqual([]);
  });
});
