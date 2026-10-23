// Build-time helper of the brw image (07.8-07): extract the checksum-verified Chromium headless shell archive into a
// fixed directory with playwright-core's bundled zip reader, so the image needs no extra system package for unzip.
//   node unzip.mjs <archive.zip> <dest-dir>
// The archive's single top-level directory is stripped. Only regular files are accepted; absolute paths, `..`
// segments, symlinks and duplicate names fail the build.
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, normalize, sep } from "node:path";
import { pipeline } from "node:stream/promises";

const require = createRequire(import.meta.url);
const { yauzl } = require("playwright-core/lib/utilsBundle");

const [archive, dest] = process.argv.slice(2);
if (!archive || !dest) {
  process.stderr.write("usage: node unzip.mjs <archive.zip> <dest-dir>\n");
  process.exit(2);
}

const open = (file) =>
  new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zip) =>
      err ? reject(err) : resolve(zip),
    ),
  );

const zip = await open(archive);
const seen = new Set();
let files = 0;
await new Promise((resolve, reject) => {
  zip.on("error", reject);
  zip.on("end", resolve);
  zip.on("entry", (entry) => {
    const parts = entry.fileName.split("/");
    const rel = parts.slice(1).join("/");
    const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
    if (entry.fileName.endsWith("/")) {
      zip.readEntry();
      return;
    }
    const target = normalize(join(dest, rel));
    if (
      parts.length < 2 ||
      rel === "" ||
      entry.fileName.startsWith("/") ||
      parts.includes("..") ||
      !target.startsWith(normalize(dest) + sep) ||
      (mode !== 0 && mode !== 0o100000) ||
      seen.has(target)
    ) {
      reject(new Error(`refused zip entry #${files + 1}`));
      return;
    }
    seen.add(target);
    const perms = (entry.externalFileAttributes >>> 16) & 0o111 ? 0o755 : 0o644;
    zip.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      mkdirSync(dirname(target), { recursive: true });
      pipeline(stream, createWriteStream(target, { mode: perms, flags: "wx" }))
        .then(() => {
          files += 1;
          zip.readEntry();
        })
        .catch(reject);
    });
  });
  zip.readEntry();
});
if (!existsSync(join(dest, "chrome-headless-shell")))
  throw new Error("no chrome-headless-shell in the archive");
process.stdout.write(`extracted ${files} files\n`);
