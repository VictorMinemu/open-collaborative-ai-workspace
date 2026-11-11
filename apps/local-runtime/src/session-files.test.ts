// 07.17.1.1 (D-02, D-03, D-04, D-09, PD-09, PD-10): containment of a session's files on the device. Scratch trees only.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionFileForRead, resolveSessionPath, SessionFileError } from "./session-files.js";

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "ocw-sf-")));
  root = join(base, "repo");
  outside = join(base, "outside");
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, "docs", "a.md"), "abc");
  writeFileSync(join(root, ".git", "config"), "[core]\n");
  writeFileSync(join(outside, "secret.txt"), "outside");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** The code a call failed with (a SessionFileError), or "ok". */
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    const v = await p;
    if (v && typeof v === "object" && "handle" in v) {
      await (v as { handle: { close(): Promise<void> } }).handle.close();
    }
    return "ok";
  } catch (err) {
    if (err instanceof SessionFileError) return err.code;
    throw err;
  }
}

// A secret-looking name built at runtime (no literal in the source, PD-03).
const DOT_ENV = [".", "env"].join("");

describe("resolveSessionPath (PD-10)", () => {
  it("returns the realpath-based target of a file inside the tree", async () => {
    const r = await resolveSessionPath(root, "docs/a.md", { create: false });
    expect(r).toEqual({
      root: realpathSync(root),
      parent: join(realpathSync(root), "docs"),
      target: join(realpathSync(root), "docs", "a.md"),
      relReal: "docs/a.md",
    });
  });

  it("refuses traversal, absolute and malformed paths with invalid_path", async () => {
    for (const rel of [
      "../a",
      "/etc/hosts",
      "a/../../b",
      "~/x",
      "C:\\x",
      "a\\b",
      "a//b",
      "./a",
      "",
      "a\u0000b",
    ]) {
      expect(await codeOf(resolveSessionPath(root, rel, { create: false })), rel).toBe("invalid_path");
    }
  });

  it("refuses the shared deny list with path_not_allowed; .env.example passes", async () => {
    for (const rel of [
      ".git/config",
      ".GIT/config",
      ".ocw-worktrees/x/a.md",
      ".claude/settings.json",
      ".Claude/settings.json",
      ".codex/config.toml",
      ".mcp.json",
      DOT_ENV,
      `${DOT_ENV}.local`,
      "keys/id_ed25519",
      "deploy.pem",
    ]) {
      expect(await codeOf(resolveSessionPath(root, rel, { create: false })), rel).toBe("path_not_allowed");
    }
    writeFileSync(join(root, `${DOT_ENV}.example`), "A=1\n");
    expect(await codeOf(resolveSessionPath(root, `${DOT_ENV}.example`, { create: false }))).toBe("ok");
  });

  it("a directory symlink inside the tree pointing outside, or at .git, is path_not_allowed", async () => {
    symlinkSync(outside, join(root, "out"));
    symlinkSync(join(root, ".git"), join(root, "g"));
    expect(await codeOf(resolveSessionPath(root, "out/secret.txt", { create: false }))).toBe(
      "path_not_allowed",
    );
    expect(await codeOf(resolveSessionPath(root, "g/config", { create: false }))).toBe("path_not_allowed");
  });

  it("a directory symlink that stays inside the tree resolves to its real place", async () => {
    symlinkSync(join(root, "docs"), join(root, "d"));
    const r = await resolveSessionPath(root, "d/a.md", { create: false });
    expect(r.relReal).toBe("docs/a.md");
  });
});

describe("openSessionFileForRead (PD-10)", () => {
  it("opens a regular file and reports its size; over maxBytes is too_large with the size", async () => {
    const r = await openSessionFileForRead(root, "docs/a.md", 10);
    expect(r.size).toBe(3);
    await r.handle.close();
    try {
      await openSessionFileForRead(root, "docs/a.md", 2);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SessionFileError);
      expect((err as SessionFileError).code).toBe("too_large");
      expect((err as SessionFileError).detail).toBe("3");
      expect((err as SessionFileError).message).toBe("too_large: 3");
    }
  });

  it("a directory is not_a_file; a missing file or folder is not_found", async () => {
    expect(await codeOf(openSessionFileForRead(root, "docs", 10))).toBe("not_a_file");
    expect(await codeOf(openSessionFileForRead(root, "docs/missing.md", 10))).toBe("not_found");
    expect(await codeOf(openSessionFileForRead(root, "nope/missing.md", 10))).toBe("not_found");
  });

  it("a symlink as the final component is not_a_file, wherever it points", async () => {
    symlinkSync(join(root, "docs", "a.md"), join(root, "link.md"));
    symlinkSync(join(outside, "secret.txt"), join(root, "leak.txt"));
    expect(await codeOf(openSessionFileForRead(root, "link.md", 10))).toBe("not_a_file");
    expect(await codeOf(openSessionFileForRead(root, "leak.txt", 10))).toBe("not_a_file");
  });

  it("never names the absolute path in its error", async () => {
    try {
      await openSessionFileForRead(root, "docs", 10);
    } catch (err) {
      expect(String((err as Error).message)).not.toContain(base);
    }
  });
});
