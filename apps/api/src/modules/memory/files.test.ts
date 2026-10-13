import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it } from "vitest";
import { HttpError } from "../../lib/errors";
import { assertNoSecret, guarded, isRootPath, lineChanges } from "./files";

/** 07.2-08: the pure parts of the file operations (line counts, the root file, secrets, driver errors). */

describe("lineChanges", () => {
  it("counts added and removed lines and numbers the added ones in the new text", () => {
    expect(lineChanges("", "# Memory\n")).toEqual({ added: 1, removed: 0, addedLines: [1] });
    expect(lineChanges("# Memory\n", "# Memory\n\n- one\n")).toEqual({
      added: 2,
      removed: 0,
      addedLines: [2, 3],
    });
    expect(lineChanges("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual({ added: 2, removed: 1, addedLines: [2, 4] });
    expect(lineChanges("one\n", "one\n")).toEqual({ added: 0, removed: 0, addedLines: [] });
  });

  it("past the edit budget a change counts as a full replacement instead of doing quadratic work", () => {
    const before = Array.from({ length: 3_000 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 3_000 }, (_, i) => `new ${i}`).join("\n");
    const started = performance.now();
    const out = lineChanges(before, after);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(out.added).toBe(3_000);
    expect(out.removed).toBe(3_000);
    expect(out.addedLines).toHaveLength(3_000);
  });
});

describe("isRootPath", () => {
  it("is MEMORY.md at the scope root, any casing; a nested MEMORY.md is an ordinary file", () => {
    expect(isRootPath("MEMORY.md")).toBe(true);
    expect(isRootPath("memory.md")).toBe(true);
    expect(isRootPath("notes/MEMORY.md")).toBe(false);
  });
});

describe("assertNoSecret", () => {
  const key = ["sk", "ant", "api03", "Zq7Lm2Np9Rt4Vx8Bc1Df6Gh3Jk5"].join("-");

  it("blocks a secret on the added lines with masked samples only", () => {
    let err: unknown;
    try {
      assertNoSecret(`ok\nkey ${key}\n`, [2]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ statusCode: 422, code: "secret_detected" });
    expect(JSON.stringify((err as HttpError).details)).not.toContain(key);
  });

  it("ignores lines the write did not add, and warnings (PII is for approvers, not a block)", () => {
    expect(() => assertNoSecret(`key ${key}\nnew line\n`, [2])).not.toThrow();
    expect(() => assertNoSecret("mail ana@example.com, IBAN ES9121000418450200051332\n")).not.toThrow();
  });
});

describe("guarded (driver errors never carry content into logs)", () => {
  it("drops the query parameters and the failing row of a driver error", async () => {
    const cause = Object.assign(new Error('new row violates check constraint "x"'), {
      code: "23514",
      detail: "Failing row contains (secret content canary-55)",
    });
    const driver = new DrizzleQueryError(
      "insert into app.memory_files …",
      ["clients/acme.md", "canary-55"],
      cause,
    );
    const err = await guarded(() => Promise.reject(driver)).catch((e: unknown) => e as Error);
    expect(err.message).toBe("memory query failed (sqlstate 23514)");
    expect(JSON.stringify({ message: err.message, stack: err.stack, cause: err.cause })).not.toMatch(
      /canary-55|acme/,
    );
  });

  it("turns the unique path index into memory_path_exists and lets domain errors through", async () => {
    const unique = new DrizzleQueryError(
      "insert …",
      ["x"],
      Object.assign(new Error("duplicate key"), { code: "23505", constraint: "memory_files_scope_path_uq" }),
    );
    await expect(guarded(() => Promise.reject(unique))).rejects.toMatchObject({
      statusCode: 409,
      code: "memory_path_exists",
    });
    const domain = new HttpError(409, "memory_version_conflict", "changed");
    await expect(guarded(() => Promise.reject(domain))).rejects.toBe(domain);
  });
});
