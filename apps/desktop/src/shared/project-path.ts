// Validation for "Add project…": the picked folder must be a git work tree, and neither it nor
// its repository root may be the home folder, a system root or an ancestor of home. The absolute
// path never leaves the main process; it goes to the daemon over the local Unix socket only.

import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, sep } from "node:path";

export class ProjectPathError extends Error {}

const SYSTEM_ROOTS_POSIX = [
  "/",
  "/Applications",
  "/Library",
  "/System",
  "/Users",
  "/Volumes",
  "/bin",
  "/cores",
  "/dev",
  "/etc",
  "/home",
  "/opt",
  "/private",
  "/private/etc",
  "/private/tmp",
  "/private/var",
  "/root",
  "/sbin",
  "/tmp",
  "/usr",
  "/usr/local",
  "/var",
];

function stripTrailingSep(p: string): string {
  return p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p;
}

/** True if `ancestor` equals `p` or contains it. */
function isSameOrAncestor(ancestor: string, p: string): boolean {
  const a = stripTrailingSep(ancestor);
  const b = stripTrailingSep(p);
  return b === a || b.startsWith(a === sep ? a : a + sep);
}

/**
 * Pure policy check on an absolute, already-resolved path. Returns a reason string if the path
 * must be refused, or null if it is acceptable.
 */
export function refusalReason(path: string, home: string, extraForbidden: string[] = []): string | null {
  const p = stripTrailingSep(path);
  const h = stripTrailingSep(home);
  if (p === h) return "Pick a project folder, not your whole home folder.";
  if (isSameOrAncestor(p, h)) return "That folder contains your home folder. Pick a project folder instead.";
  if (SYSTEM_ROOTS_POSIX.includes(p) || dirname(p) === p)
    return "System folders cannot be added as projects.";
  for (const f of extraForbidden) {
    if (isSameOrAncestor(f, p)) return "That folder cannot be added as a project.";
  }
  const hLib = `${h}${sep}Library`;
  if (isSameOrAncestor(hLib, p)) return "Folders inside ~/Library cannot be added as projects.";
  return null;
}

export type GitToplevel = (dir: string) => Promise<string | null>;

export const gitToplevel: GitToplevel = (dir) =>
  new Promise((resolve) => {
    execFile(
      "git",
      ["-C", dir, "rev-parse", "--show-toplevel"],
      { timeout: 5000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout) => {
        if (err) return resolve(null);
        const top = String(stdout).trim();
        resolve(top || null);
      },
    );
  });

export interface ValidateOptions {
  home?: string;
  git?: GitToplevel;
  /** e.g. the OCW state directory (~/.ocw) and the app bundle. */
  forbidden?: string[];
}

/**
 * Resolve and validate a picked folder. Returns the repository root to register (which may be
 * an ancestor of the picked folder when a subfolder of a repo was chosen).
 */
export async function validateProjectDir(picked: string, opts: ValidateOptions = {}): Promise<string> {
  const home = await realpath(opts.home ?? homedir()).catch(() => opts.home ?? homedir());
  const forbidden = await Promise.all((opts.forbidden ?? []).map((f) => realpath(f).catch(() => f)));
  let abs: string;
  try {
    abs = await realpath(picked);
  } catch {
    throw new ProjectPathError("That folder does not exist.");
  }
  if (!(await stat(abs)).isDirectory()) throw new ProjectPathError("Pick a folder, not a file.");
  const early = refusalReason(abs, home, forbidden);
  if (early) throw new ProjectPathError(early);
  const top = await (opts.git ?? gitToplevel)(abs);
  if (!top)
    throw new ProjectPathError("That folder is not a git repository. Run `git init` first or pick a repo.");
  const root = await realpath(top).catch(() => top);
  const late = refusalReason(root, home, forbidden);
  if (late) throw new ProjectPathError(late);
  return root;
}
