// `add-project` / `setup --project`: which folders may become projects, the same rule as the desktop's
// "Add project…" (apps/desktop/src/shared/project-path.ts). A folder needs no git repository (the Work Zone works
// without one); it must not be the home folder, contain it, be a system folder, hold OCW state or sit in ~/Library.
// Messages name no path.

import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";

/** POSIX roots never registered as projects (the desktop list plus Linux server roots). */
const SYSTEM_ROOTS = new Set([
  "/",
  "/Applications",
  "/Library",
  "/System",
  "/Users",
  "/Volumes",
  "/bin",
  "/boot",
  "/cores",
  "/dev",
  "/etc",
  "/home",
  "/lib",
  "/media",
  "/mnt",
  "/opt",
  "/private",
  "/private/etc",
  "/private/tmp",
  "/private/var",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/srv",
  "/sys",
  "/tmp",
  "/usr",
  "/usr/local",
  "/var",
]);

function stripTrailingSep(p: string): string {
  return p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p;
}

function isSameOrAncestor(ancestor: string, p: string): boolean {
  const a = stripTrailingSep(ancestor);
  const b = stripTrailingSep(p);
  return b === a || b.startsWith(a === sep ? a : a + sep);
}

/** Why `path` (absolute, resolved) must not be a project, or null when it may. */
export function projectDirRefusal(path: string, home: string, forbidden: string[] = []): string | null {
  const p = stripTrailingSep(path);
  const h = stripTrailingSep(home);
  if (p === h) return "pick a project folder, not your whole home folder";
  if (isSameOrAncestor(p, h)) return "that folder contains your home folder; pick a project folder";
  if (SYSTEM_ROOTS.has(p) || dirname(p) === p) return "system folders cannot be projects";
  for (const f of forbidden) {
    if (isSameOrAncestor(f, p)) return "that folder holds OCW state and cannot be a project";
  }
  if (isSameOrAncestor(`${h}${sep}Library`, p)) return "folders inside ~/Library cannot be projects";
  return null;
}

export interface ProjectDirOptions {
  /** The user's home folder (default: os.homedir()). */
  userHome?: string;
  /** e.g. the OCW home (~/.ocw). */
  forbidden?: string[];
}

/** Resolve `dir` and refuse it when it may not be a project; returns the real path. Creates nothing. */
export async function assertProjectDirAllowed(dir: string, opts: ProjectDirOptions = {}): Promise<string> {
  const abs = await realpath(resolve(dir)).catch(() => {
    throw new Error("path does not exist");
  });
  if (!(await stat(abs)).isDirectory()) throw new Error("path is not a directory");
  const userHome = opts.userHome ?? homedir();
  const home = await realpath(userHome).catch(() => userHome);
  const forbidden = await Promise.all((opts.forbidden ?? []).map((f) => realpath(f).catch(() => f)));
  const refused = projectDirRefusal(abs, home, forbidden);
  if (refused) throw new Error(refused);
  return abs;
}

/** The one line shown when a project has no git repository (folder name only). */
export function noGitNotice(name: string): string {
  return `${name} has no git repository: sessions work; changes and worktrees are off.`;
}
