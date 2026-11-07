// Validation for "Add project…": neither the picked folder nor its repository root may be the home
// folder, a system root or an ancestor of home. A folder in a git repository registers the
// repository root; a folder in none registers as it is (the Work Zone works without git; nothing is
// created in it). The absolute path never leaves the main process; it goes to the daemon over the
// local Unix socket only.

import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, sep } from "node:path";

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

/**
 * The repository root containing `dir`, or null when `dir` is in no repository (or git is not
 * installed). Any other git failure (a repository git refuses to read) rejects.
 */
export type GitToplevel = (dir: string) => Promise<string | null>;

export const gitToplevel: GitToplevel = (dir) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", dir, "rev-parse", "--show-toplevel"],
      { timeout: 5000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } },
      (err, stdout, stderr) => {
        if (err) {
          if ((err as { code?: unknown }).code === "ENOENT") return resolve(null);
          if (/not a git repository/i.test(String(stderr))) return resolve(null);
          return reject(Object.assign(err, { stderr: String(stderr) }));
        }
        const top = String(stdout).trim();
        resolve(top || null);
      },
    );
  });

/** A short cause for a failed git call, with no path in it (stderr may carry absolute paths). */
function gitCause(err: unknown): string {
  const e = err as { code?: unknown; stderr?: unknown; message?: unknown; killed?: unknown } | null;
  const text = `${typeof e?.stderr === "string" ? e.stderr : ""} ${typeof e?.message === "string" ? e.message : ""}`;
  if (/dubious ownership/i.test(text))
    return "git refuses a repository owned by another user (safe.directory)";
  if (e?.code === "EACCES" || /permission denied/i.test(text)) return "permission denied";
  if (e?.killed === true) return "git did not answer in time";
  return "git failed";
}

export interface ValidateOptions {
  home?: string;
  git?: GitToplevel;
  /** e.g. the OCW state directory (~/.ocw) and the app bundle. */
  forbidden?: string[];
}

export interface ValidatedProject {
  /** The folder to register: the repository root, or the picked folder itself when it is in no repository. */
  root: string;
  /** False when the folder is in no git repository (registered as it is; nothing is created). */
  git: boolean;
}

/**
 * Resolve and validate a picked folder. The refusal checks run first; then a folder in a repository
 * returns the repository root (which may be an ancestor of the picked folder), and a folder in none
 * returns itself. Errors are ProjectPathError with folder names only, never a path.
 */
export async function validateProjectDir(
  picked: string,
  opts: ValidateOptions = {},
): Promise<ValidatedProject> {
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
  let top: string | null;
  try {
    top = await (opts.git ?? gitToplevel)(abs);
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === "ENOENT") return { root: abs, git: false };
    throw new ProjectPathError(`Could not read the git repository of ${basename(abs)}: ${gitCause(err)}.`);
  }
  if (!top) return { root: abs, git: false };
  const root = await realpath(top).catch(() => top);
  const late = refusalReason(root, home, forbidden);
  if (late) throw new ProjectPathError(late);
  return { root, git: true };
}
