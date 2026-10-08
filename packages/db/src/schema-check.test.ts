import { describe, expect, it } from "vitest";
import { compareMigrations, describeSchemaMismatch, type SchemaCheck } from "./schema-check";

const m = (name: string, hash = `h-${name}`) => ({ name, hash });
const LOCAL = [m("20260101000000_a"), m("20260102000000_b"), m("20260103000000_c")];

describe("compareMigrations", () => {
  it("is ok when the database applied exactly the shipped migrations", () => {
    expect(compareMigrations(LOCAL, [...LOCAL])).toEqual({
      status: "ok",
      pending: [],
      unknown: [],
      modified: [],
    });
  });

  it("is behind when the applied list is a strict prefix, with the pending names in order", () => {
    expect(compareMigrations(LOCAL, LOCAL.slice(0, 1))).toEqual({
      status: "behind",
      pending: ["20260102000000_b", "20260103000000_c"],
      unknown: [],
      modified: [],
    });
  });

  it("is ahead when the database applied a migration this release does not ship", () => {
    const applied = [...LOCAL, m("20260104000000_newer")];
    expect(compareMigrations(LOCAL, applied)).toEqual({
      status: "ahead",
      pending: [],
      unknown: ["20260104000000_newer"],
      modified: [],
    });
  });

  it("is diverged when a migration with the same name has a different hash", () => {
    const applied = [LOCAL[0], m("20260102000000_b", "edited"), LOCAL[2]].filter((x) => x !== undefined);
    expect(compareMigrations(LOCAL, applied)).toEqual({
      status: "diverged",
      pending: [],
      unknown: [],
      modified: ["20260102000000_b"],
    });
  });

  it("is missing when nothing was ever applied", () => {
    expect(compareMigrations(LOCAL, [])).toEqual({
      status: "missing",
      pending: LOCAL.map((x) => x.name),
      unknown: [],
      modified: [],
    });
  });

  it("prefers diverged over ahead and behind (an edited migration is the most serious mismatch)", () => {
    const applied = [m("20260101000000_a", "edited"), m("20260109000000_newer")];
    const res = compareMigrations(LOCAL, applied);
    expect(res.status).toBe("diverged");
    expect(res.modified).toEqual(["20260101000000_a"]);
    expect(res.unknown).toEqual(["20260109000000_newer"]);
  });

  it("prefers ahead over behind (a newer release must never be 'fixed' by migrating with an older one)", () => {
    const res = compareMigrations(
      LOCAL,
      [LOCAL[0], m("20260109000000_newer")].filter((x) => x !== undefined),
    );
    expect(res.status).toBe("ahead");
    expect(res.pending).toEqual(["20260102000000_b", "20260103000000_c"]);
  });
});

describe("describeSchemaMismatch", () => {
  const base: SchemaCheck = { status: "ok", pending: [], unknown: [], modified: [] };

  it("names the case and the migrate command when behind", () => {
    const msg = describeSchemaMismatch({ ...base, status: "behind", pending: ["x_1", "x_2"] });
    expect(msg).toContain("Database schema is behind this API (2 pending, newest x_2)");
    expect(msg).toContain("docker compose run --rm migrate");
  });

  it("names the unknown migrations when ahead", () => {
    const msg = describeSchemaMismatch({ ...base, status: "ahead", unknown: ["y_1"] });
    expect(msg).toContain("Database was migrated by a newer release (unknown: y_1)");
    expect(msg).toContain("Restore a backup or run the newer image");
  });

  it("names the modified migration when diverged", () => {
    expect(describeSchemaMismatch({ ...base, status: "diverged", modified: ["z_1"] })).toContain(
      "Migration z_1 was modified after it was applied.",
    );
  });

  it("explains a never-migrated database and how to fix it", () => {
    const msg = describeSchemaMismatch({ ...base, status: "missing", pending: ["x_1"] });
    expect(msg).toContain("Database has never been migrated");
    expect(msg).toContain("cannot read drizzle.__drizzle_migrations");
    expect(msg).toContain("docker compose run --rm migrate");
  });

  it("says ok when there is no mismatch", () => {
    expect(describeSchemaMismatch(base)).toMatch(/up to date/);
  });
});
