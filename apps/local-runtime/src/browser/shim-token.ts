// The Codex shim's per-session token (07.13 PD-08, Pitfall 5): 32 random bytes as hex in `<runDir>/shim-token`, 0600
// inside the session's 0700 run dir. The shim reads it from the file its env names (never argv) and sends it with each
// `browserCall`; the daemon compares it in constant time with the file. It binds a shim to its own session; it is not a
// boundary against other processes of the same OS user (who can read the file), which ADR-0035 records.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const SHIM_TOKEN_FILE = "shim-token";
const TOKEN = /^[0-9a-f]{64}$/;

/** Reads the token file: a regular file holding exactly a token, else null. */
async function readToken(path: string): Promise<string | null> {
  try {
    const st = await lstat(path);
    if (!st.isFile()) return null;
    const token = (await readFile(path, "utf8")).trim();
    return TOKEN.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** The session's token file, created once (`wx`, 0600) in its 0700 run dir; answers its path. */
export async function ensureShimToken(runDir: string): Promise<string> {
  await mkdir(dirname(runDir), { recursive: true, mode: 0o700 });
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by the umask, and an existing dir keeps its mode.
  await chmod(runDir, 0o700);
  const path = join(runDir, SHIM_TOKEN_FILE);
  if (await readToken(path)) return path;
  try {
    await writeFile(path, `${randomBytes(32).toString("hex")}\n`, { flag: "wx", mode: 0o600 });
  } catch (err) {
    // Another call created it first; anything else (a directory or a link in its place) is an error.
    if ((err as NodeJS.ErrnoException).code !== "EEXIST" || !(await readToken(path))) {
      throw new Error("the shim token could not be created");
    }
  }
  return path;
}

/** True when `token` is the one in the session's token file (constant-time; a missing or odd file is false). */
export async function verifyShimToken(runDir: string, token: string): Promise<boolean> {
  if (!TOKEN.test(token)) return false;
  const expected = await readToken(join(runDir, SHIM_TOKEN_FILE));
  if (!expected) return false;
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(token, "utf8"));
}
