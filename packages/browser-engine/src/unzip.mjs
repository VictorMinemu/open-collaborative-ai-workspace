// Safe zip extraction with playwright-core's bundled zip reader (07.8-07; shared in 07.13 D-04): the brw image's
// build extracts the checksum-verified Chromium headless shell archive with it, and the Work Zone runtime's browser
// install (07.13-06) extracts the same archive on the device. No extra system package for unzip.
//
// The archive's single top-level directory is stripped. Only regular files are accepted: absolute paths, `..`
// segments, symlinks (and any other non-regular entry), duplicate names and files outside a top-level directory are
// refused with an Error naming the entry and the reason. A refusal can leave the files extracted before it in `dest`:
// callers extract into a staging directory they delete on failure.
//
// As a script (the brw Dockerfile's build step): node unzip.mjs <archive.zip> <dest-dir>
// extracts, fails unless the archive held `chrome-headless-shell`, and prints how many files it wrote.
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
// Loaded on first extraction, not on import (07.13-20): the runtime imports this module for `browser install`, and
// every other command of the runtime must start without playwright-core (only the browser loads it).
let yauzl;
const reader = () => {
  yauzl ??= require("playwright-core/lib/utilsBundle").yauzl;
  return yauzl;
};

const open = (file) =>
  new Promise((resolve, reject) =>
    reader().open(file, { lazyEntries: true, autoClose: true }, (err, zip) =>
      err ? reject(new Error(`refused zip archive: ${err.message}`)) : resolve(zip),
    ),
  );

/** Extracts `archive` into the existing or new directory `dest`; resolves with `{ files }` written. */
export async function extractZip(archive, dest) {
  const zip = await open(archive);
  const root = normalize(dest);
  const seen = new Set();
  let files = 0;
  let index = 0;
  await new Promise((resolve, reject) => {
    let done = false;
    const refuse = (err) => {
      if (done) return;
      done = true;
      zip.close();
      reject(err);
    };
    // yauzl itself refuses absolute names and `..` segments before an entry is emitted ("invalid relative path").
    zip.on("error", (err) => refuse(new Error(`refused zip entry #${index + 1}: ${err.message}`)));
    zip.on("end", () => {
      done = true;
      resolve();
    });
    zip.on("entry", (entry) => {
      index += 1;
      const parts = entry.fileName.split("/");
      const rel = parts.slice(1).join("/");
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (entry.fileName.endsWith("/")) {
        zip.readEntry();
        return;
      }
      const target = normalize(join(root, rel));
      let reason = null;
      if (entry.fileName.startsWith("/")) reason = "an absolute path";
      else if (parts.includes("..")) reason = "a .. segment";
      else if (parts.length < 2 || rel === "") reason = "not inside the archive's top-level directory";
      else if (!target.startsWith(root.endsWith(sep) ? root : root + sep)) reason = "outside the destination";
      else if (mode !== 0 && mode !== 0o100000) reason = "not a regular file";
      else if (seen.has(target)) reason = "a duplicate name";
      if (reason) {
        refuse(new Error(`refused zip entry #${index}: ${reason}`));
        return;
      }
      seen.add(target);
      const perms = (entry.externalFileAttributes >>> 16) & 0o111 ? 0o755 : 0o644;
      zip.openReadStream(entry, (err, stream) => {
        if (err) return refuse(err);
        mkdirSync(dirname(target), { recursive: true });
        pipeline(stream, createWriteStream(target, { mode: perms, flags: "wx" }))
          .then(() => {
            files += 1;
            zip.readEntry();
          })
          .catch(refuse);
      });
    });
    zip.readEntry();
  });
  return { files };
}

// Script mode only when this very file is the main script. A bundle that inlines this module (the Local Runtime's
// ocw-runtime.mjs, 07.13-06) shares the bundle's import.meta.url, which IS argv[1] there: without the file name check
// every runtime command would run this script instead (07.13-20).
const SELF = import.meta.url.endsWith("/unzip.mjs");
if (SELF && process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [archive, dest] = process.argv.slice(2);
  if (!archive || !dest) {
    process.stderr.write("usage: node unzip.mjs <archive.zip> <dest-dir>\n");
    process.exit(2);
  }
  const { files } = await extractZip(archive, dest);
  if (!existsSync(join(dest, "chrome-headless-shell")))
    throw new Error("no chrome-headless-shell in the archive");
  process.stdout.write(`extracted ${files} files\n`);
}
