// extractZip (07.13 D-04, research "Don't Hand-Roll"): the brw image's Chromium archive extraction, shared with the
// Work Zone runtime's browser install (06). Archives are assembled by hand here (stored entries, no compression) so a
// test can write the names and modes a zip-slip archive carries, which a zip writer refuses to produce.
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { extractZip } from "./unzip.mjs";

interface Entry {
  name: string;
  data?: string;
  /** Unix mode (type and permission bits); 0o100644 by default, a directory when the name ends with "/". */
  mode?: number;
}

/** A zip archive (PKWARE APPNOTE 4.3: local headers, central directory, end record) with stored entries. */
function buildZip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.from(e.data ?? "", "utf8");
    const mode = e.mode ?? (e.name.endsWith("/") ? 0o040755 : 0o100644);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A scratch root with the archive at `root/a.zip` and an empty `root/out` destination. */
function scratch(entries: Entry[]): { root: string; archive: string; dest: string } {
  const root = mkdtempSync(join(tmpdir(), "ocw-unzip-"));
  dirs.push(root);
  const archive = join(root, "a.zip");
  writeFileSync(archive, buildZip(entries));
  const dest = join(root, "out");
  mkdirSync(dest);
  return { root, archive, dest };
}

describe("extractZip", () => {
  it("extracts regular files and strips the single top-level directory, keeping the executable bit", async () => {
    const s = scratch([
      { name: "chrome-headless-shell-linux64/" },
      { name: "chrome-headless-shell-linux64/chrome-headless-shell", data: "#!/bin/sh\n", mode: 0o100755 },
      { name: "chrome-headless-shell-linux64/locales/" },
      { name: "chrome-headless-shell-linux64/locales/en-US.pak", data: "pak" },
    ]);
    await expect(extractZip(s.archive, s.dest)).resolves.toEqual({ files: 2 });
    expect(readFileSync(join(s.dest, "chrome-headless-shell"), "utf8")).toBe("#!/bin/sh\n");
    expect(statSync(join(s.dest, "chrome-headless-shell")).mode & 0o777).toBe(0o755);
    expect(statSync(join(s.dest, "locales", "en-US.pak")).mode & 0o777).toBe(0o644);
    expect(readdirSync(s.dest).sort()).toEqual(["chrome-headless-shell", "locales"]);
  });

  const refusals: [string, Entry[], RegExp][] = [
    [
      "a .. segment",
      [
        { name: "top/ok", data: "1" },
        { name: "top/../escaped", data: "x" },
      ],
      // yauzl refuses the name before emitting the entry; extractZip names the entry and passes the reason on.
      /refused zip entry #2: invalid relative path/,
    ],
    ["an absolute path", [{ name: "/abs", data: "x" }], /refused zip entry #1: absolute path/],
    [
      "a symlink entry",
      [{ name: "top/link", data: "/etc/passwd", mode: 0o120777 }],
      /refused zip entry #1: not a regular file/,
    ],
    [
      "a duplicate name",
      [
        { name: "top/same", data: "1" },
        { name: "top/same", data: "2" },
      ],
      /refused zip entry #2: a duplicate name/,
    ],
    [
      "a file outside any top-level directory",
      [{ name: "loose", data: "x" }],
      /refused zip entry #1: not inside/,
    ],
  ];
  for (const [what, entries, message] of refusals) {
    it(`refuses ${what}, naming the reason, and writes nothing outside the destination`, async () => {
      const s = scratch(entries);
      await expect(extractZip(s.archive, s.dest)).rejects.toThrow(message);
      expect(readdirSync(s.root).sort()).toEqual(["a.zip", "out"]);
      expect(existsSync(join(s.dest, "link"))).toBe(false);
      expect(existsSync(join(s.root, "escaped"))).toBe(false);
    });
  }

  it("keeps the brw build's CLI: `node unzip.mjs <zip> <dest>` extracts a Chromium archive and says how many files", async () => {
    const s = scratch([{ name: "chrome-linux/chrome-headless-shell", data: "bin", mode: 0o100755 }]);
    const cli = fileURLToPath(new URL("./unzip.mjs", import.meta.url));
    const run = (args: string[]) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
        execFile(process.execPath, [cli, ...args], { encoding: "utf8" }, (err, stdout, stderr) =>
          resolve({ code: err ? Number(err.code ?? 1) : 0, stdout, stderr }),
        ),
      );
    const ok = await run([s.archive, s.dest]);
    expect(ok.code, ok.stderr).toBe(0);
    expect(ok.stdout).toBe("extracted 1 files\n");
    expect(existsSync(join(s.dest, "chrome-headless-shell"))).toBe(true);

    const usage = await run([]);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain("usage: node unzip.mjs <archive.zip> <dest-dir>");

    const other = scratch([{ name: "top/readme", data: "x" }]);
    const missing = await run([other.archive, other.dest]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("no chrome-headless-shell in the archive");
  });
});
