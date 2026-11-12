// 07.17.1.1 (D-02, D-03, D-04, D-09, PD-09, PD-10): containment of a session's files on the device. Scratch trees only.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openSessionFileForRead,
  resolveSessionPath,
  SessionFileError,
  writeSessionFile,
} from "./session-files.js";

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

  it("a case-folded alias of a denied name is path_not_allowed, also where the volume opens it (review CR-01)", async () => {
    // On APFS and NTFS (case-insensitive by default) "id_r<U+017F>a" opens "id_rsa"; on a case-sensitive volume it
    // names a new file. Refused either way, before anything is opened.
    const longS = String.fromCharCode(0x17f);
    writeFileSync(join(root, "id_rsa"), "key");
    mkdirSync(join(root, ".ocw-worktrees", "other"), { recursive: true });
    writeFileSync(join(root, ".ocw-worktrees", "other", "a.md"), "theirs");
    writeFileSync(join(root, ".mcp.json"), "{}");
    for (const rel of [
      `id_r${longS}a`,
      `credential${longS}`,
      `.mcp.j${longS}on`,
      `.ocw-worktree${longS}/other/a.md`,
    ]) {
      expect(await codeOf(resolveSessionPath(root, rel, { create: false })), rel).toBe("path_not_allowed");
      expect(await codeOf(openSessionFileForRead(root, rel, 1024)), rel).toBe("path_not_allowed");
    }
    expect(await codeOf(resolveSessionPath(root, `up/id_r${longS}a`, { create: true }))).toBe(
      "path_not_allowed",
    );
    expect(existsSync(join(root, "up"))).toBe(false);
  });

  it("refuses NTFS stream and short names, and on Windows a device name as any segment (review CR-02)", async () => {
    for (const rel of [`${DOT_ENV}::$DATA`, "ENV~1", "GIT~1/config"]) {
      expect(await codeOf(resolveSessionPath(root, rel, { create: false })), rel).toBe("invalid_path");
    }
    writeFileSync(join(root, "docs", "nul.txt"), "x");
    for (const rel of ["docs/nul.txt", "CON/a.md", "docs/com1"]) {
      expect(await codeOf(resolveSessionPath(root, rel, { create: true, windows: true })), rel).toBe(
        "path_not_allowed",
      );
    }
    expect(existsSync(join(root, "CON"))).toBe(false);
    expect(await codeOf(resolveSessionPath(root, "docs/nul.txt", { create: false, windows: false }))).toBe(
      "ok",
    );
  });

  it("the second check decides on the names as stored on the volume, the file's own included (review CR-01)", async () => {
    // A case-insensitive volume opens "DOCS/A.MD" as "docs/a.md"; the native realpath names the stored spelling.
    const r = await resolveSessionPath(root, "docs/a.md", { create: false });
    expect(r.relReal).toBe("docs/a.md");
    if (existsSync(join(root, "DOCS", "A.MD"))) {
      const folded = await resolveSessionPath(root, "DOCS/A.MD", { create: false });
      expect(folded.parent).toBe(join(realpathSync(root), "docs"));
      expect(folded.target).toBe(join(realpathSync(root), "docs", "a.md"));
      expect(folded.relReal).toBe("docs/a.md");
    }
  });

  it("a directory symlink inside the tree pointing outside, or at .git, is path_not_allowed", async () => {
    symlinkSync(outside, join(root, "out"));
    symlinkSync(join(root, ".git"), join(root, "g"));
    expect(await codeOf(resolveSessionPath(root, "out/secret.txt", { create: false }))).toBe(
      "path_not_allowed",
    );
    expect(await codeOf(resolveSessionPath(root, "g/config", { create: false }))).toBe("path_not_allowed");
  });

  it("a name that only starts with two dots is an ordinary file, never a traversal (review IN-05)", async () => {
    writeFileSync(join(root, "..notes.md"), "dots");
    mkdirSync(join(root, "..cache"));
    writeFileSync(join(root, "..cache", "a.md"), "x");
    expect((await resolveSessionPath(root, "..notes.md", { create: false })).relReal).toBe("..notes.md");
    expect((await resolveSessionPath(root, "..cache/a.md", { create: false })).relReal).toBe("..cache/a.md");
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

  it("a hard link to a file outside the tree is path_not_allowed; so is any file with a second link (review WR-03)", async () => {
    linkSync(join(outside, "secret.txt"), join(root, "docs", "notes.txt"));
    expect(await codeOf(openSessionFileForRead(root, "docs/notes.txt", 1024))).toBe("path_not_allowed");
    // A second name inside the tree cannot be told from one outside it: refused too.
    linkSync(join(root, "docs", "a.md"), join(root, "docs", "b.md"));
    expect(await codeOf(openSessionFileForRead(root, "docs/b.md", 1024))).toBe("path_not_allowed");
    // A file with one name still reads.
    writeFileSync(join(root, "docs", "c.md"), "solo");
    expect(await codeOf(openSessionFileForRead(root, "docs/c.md", 1024))).toBe("ok");
  });

  it("a folder swapped for a link to outside the tree between the checks and the open is path_not_allowed (review WR-03)", async () => {
    writeFileSync(join(outside, "a.md"), "outside bytes");
    const swap = () => {
      renameSync(join(root, "docs"), join(root, "docs-old"));
      symlinkSync(outside, join(root, "docs"));
    };
    expect(await codeOf(openSessionFileForRead(root, "docs/a.md", 1024, { afterResolve: swap }))).toBe(
      "path_not_allowed",
    );
  });
});

// ---------------------------------------------------------------- the write side (D-02, D-13, PD-10, E2, E4, E21, E22, E25)

function sha(b: Uint8Array | string): string {
  return createHash("sha256").update(b).digest("hex");
}

/** A body of the given parts; `seen.started` tells whether anything read it. */
function bodyOf(parts: Array<string | Uint8Array>, seen: { started: boolean } = { started: false }) {
  return (async function* () {
    seen.started = true;
    for (const p of parts) yield typeof p === "string" ? Buffer.from(p) : p;
  })();
}

/** Files a write left behind in `dir` (the temp files must never stay). */
function leftovers(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith(".ocw-upload-")) : [];
}

const HELLO = { sizeBytes: 5, sha256: sha("hello") };

describe("writeSessionFile (PD-10)", () => {
  it("creates missing folders and the file with exactly the bytes, mode 0o644; no temp file remains", async () => {
    await writeSessionFile(root, "notes/new.md", {
      transferId: "t1",
      ...HELLO,
      overwrite: false,
      body: bodyOf(["he", "llo"]),
    });
    const target = join(root, "notes", "new.md");
    expect(readFileSync(target, "utf8")).toBe("hello");
    expect(statSync(target).mode & 0o777).toBe(0o644);
    expect(leftovers(join(root, "notes"))).toEqual([]);
  });

  it("an existing file without overwrite is exists (unchanged); with overwrite it is replaced", async () => {
    writeFileSync(join(root, "docs", "b.md"), "old");
    const again = writeSessionFile(root, "docs/b.md", {
      transferId: "t2",
      ...HELLO,
      overwrite: false,
      body: bodyOf(["hello"]),
    });
    expect(await codeOf(again)).toBe("exists");
    expect(readFileSync(join(root, "docs", "b.md"), "utf8")).toBe("old");
    await writeSessionFile(root, "docs/b.md", {
      transferId: "t3",
      ...HELLO,
      overwrite: true,
      body: bodyOf(["hello"]),
    });
    expect(readFileSync(join(root, "docs", "b.md"), "utf8")).toBe("hello");
    expect(leftovers(join(root, "docs"))).toEqual([]);
  });

  it("a folder or a link at the target is not_a_file, overwrite or not; the link's target is untouched", async () => {
    symlinkSync(join(outside, "secret.txt"), join(root, "leak.txt"));
    for (const overwrite of [false, true]) {
      for (const rel of ["docs", "leak.txt"]) {
        const w = writeSessionFile(root, rel, {
          transferId: `t-${rel.length}-${overwrite}`,
          ...HELLO,
          overwrite,
          body: bodyOf(["hello"]),
        });
        expect(await codeOf(w), `${rel} ${overwrite}`).toBe("not_a_file");
      }
    }
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("outside");
    expect(lstatSync(join(root, "leak.txt")).isSymbolicLink()).toBe(true);
    expect(leftovers(root)).toEqual([]);
  });

  it("a folder link pointing outside or at .git is path_not_allowed; nothing is written outside", async () => {
    symlinkSync(outside, join(root, "out"));
    symlinkSync(join(root, ".git"), join(root, "g"));
    symlinkSync(join(root, "docs"), join(root, "d"));
    for (const rel of ["out/x.md", "out/new/x.md", "g/hooks/pre-commit", "d/sub/x.md"]) {
      const w = writeSessionFile(root, rel, {
        transferId: "t4",
        ...HELLO,
        overwrite: false,
        body: bodyOf(["hello"]),
      });
      expect(await codeOf(w), rel).toBe("path_not_allowed");
    }
    expect(readdirSync(outside)).toEqual(["secret.txt"]);
    expect(existsSync(join(root, ".git", "hooks"))).toBe(false);
    expect(existsSync(join(root, "docs", "sub"))).toBe(false);
  });

  it("the deny list and malformed paths are refused before anything is created", async () => {
    for (const [rel, code] of [
      [".ocw-worktrees/other/a.md", "path_not_allowed"],
      [".claude/settings.json", "path_not_allowed"],
      [".mcp.json", "path_not_allowed"],
      [DOT_ENV, "path_not_allowed"],
      ["../escape.md", "invalid_path"],
    ] as const) {
      const w = writeSessionFile(root, rel, {
        transferId: "t5",
        ...HELLO,
        overwrite: false,
        body: bodyOf(["hello"]),
      });
      expect(await codeOf(w), rel).toBe(code);
    }
    expect(existsSync(join(root, ".ocw-worktrees"))).toBe(false);
    expect(existsSync(join(root, ".claude"))).toBe(false);
    expect(existsSync(join(base, "escape.md"))).toBe(false);
  });

  it("bytes of the wrong size or sha256 are mismatch: nothing at the target, no temp file", async () => {
    for (const [parts, expected] of [
      [["hell"], HELLO],
      [["hello!"], HELLO],
      [["jello"], HELLO],
    ] as const) {
      const w = writeSessionFile(root, "docs/m.md", {
        transferId: "t6",
        ...expected,
        overwrite: false,
        body: bodyOf([...parts]),
      });
      expect(await codeOf(w), parts.join("")).toBe("mismatch");
      expect(existsSync(join(root, "docs", "m.md"))).toBe(false);
      expect(leftovers(join(root, "docs"))).toEqual([]);
    }
    // A null sha256 checks the size only.
    await writeSessionFile(root, "docs/m.md", {
      transferId: "t6b",
      sizeBytes: 5,
      sha256: null,
      overwrite: false,
      body: bodyOf(["jello"]),
    });
    expect(readFileSync(join(root, "docs", "m.md"), "utf8")).toBe("jello");
  });

  it("a body that fails mid-way is transfer_failed; a SessionFileError from the body is kept; no temp file", async () => {
    const failing = (err: Error) =>
      (async function* () {
        yield Buffer.from("he");
        throw err;
      })();
    const w = writeSessionFile(root, "docs/f.md", {
      transferId: "t7",
      ...HELLO,
      overwrite: false,
      body: failing(new Error(`socket closed near ${root}`)),
    });
    try {
      await w;
      expect.unreachable();
    } catch (err) {
      expect((err as SessionFileError).code).toBe("transfer_failed");
      expect((err as Error).message).not.toContain(base);
    }
    const expired = writeSessionFile(root, "docs/f.md", {
      transferId: "t8",
      ...HELLO,
      overwrite: false,
      body: failing(new SessionFileError("expired")),
    });
    expect(await codeOf(expired)).toBe("expired");
    expect(existsSync(join(root, "docs", "f.md"))).toBe(false);
    expect(leftovers(join(root, "docs"))).toEqual([]);
  });

  it("too little free space is no_space before the body is read (E25)", async () => {
    const seen = { started: false };
    const w = writeSessionFile(root, "docs/big.bin", {
      transferId: "t9",
      ...HELLO,
      overwrite: false,
      body: bodyOf(["hello"], seen),
      statfs: async () => ({ bavail: 1, bsize: 4 }),
    });
    expect(await codeOf(w)).toBe("no_space");
    expect(seen.started).toBe(false);
    expect(leftovers(join(root, "docs"))).toEqual([]);
  });

  it("a transfer id that is not an id is refused before any temp file", async () => {
    const w = writeSessionFile(root, "docs/t.md", {
      transferId: "../../x",
      ...HELLO,
      overwrite: false,
      body: bodyOf(["hello"]),
    });
    expect(await codeOf(w)).toBe("transfer_failed");
    expect(existsSync(join(root, "x"))).toBe(false);
  });

  it("17 MiB of random bytes written then read back give the same sha256 (E21)", async () => {
    const bytes = randomBytes(17 * 1024 * 1024);
    const parts: Uint8Array[] = [];
    for (let i = 0; i < bytes.byteLength; i += 1024 * 1024) parts.push(bytes.subarray(i, i + 1024 * 1024));
    await writeSessionFile(root, "blob/r.bin", {
      transferId: "t10",
      sizeBytes: bytes.byteLength,
      sha256: sha(bytes),
      overwrite: false,
      body: bodyOf(parts),
    });
    const { handle, size } = await openSessionFileForRead(root, "blob/r.bin", 32 * 1024 * 1024);
    try {
      expect(size).toBe(bytes.byteLength);
      const h = createHash("sha256");
      for await (const chunk of handle.createReadStream({ start: 0, end: size - 1, autoClose: false })) {
        h.update(chunk as Buffer);
      }
      expect(h.digest("hex")).toBe(sha(bytes));
    } finally {
      await handle.close();
    }
  }, 30_000);

  it.skipIf(process.platform === "win32")(
    "a FIFO is not_a_file both ways, and reading never blocks on it",
    async () => {
      execFileSync("mkfifo", [join(root, "docs", "pipe")]);
      expect(await codeOf(openSessionFileForRead(root, "docs/pipe", 10))).toBe("not_a_file");
      const w = writeSessionFile(root, "docs/pipe", {
        transferId: "t11",
        ...HELLO,
        overwrite: true,
        body: bodyOf(["hello"]),
      });
      expect(await codeOf(w)).toBe("not_a_file");
    },
  );
});
