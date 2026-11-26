// "Update available" (07.13, D-18, PD-21): the desktop app asks GitHub's public latest-release API at most once a day
// and, when the latest stable release is newer than its own version, the tray and the onboarding window link to that
// release's page. It never downloads or installs anything: the builds are unsigned until Phase 9, so the person
// updates by hand. One unauthenticated GET, no token, no identity beyond a generic User-Agent. The answer is untrusted
// JSON: only a stable `vX.Y.Z` tag and a page under the repository's releases are ever shown. No Electron imports
// (unit-tested).

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const REPO = "VictorMinemu/open-collaborative-ai-workspace";
export const RELEASES_LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASE_PAGE_PATH = `/${REPO}/releases/`;
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;
const FILE = "update-check.json";

/** The last answer, kept in the app's data folder so a restart does not ask again within the day. */
export const CachedUpdateCheck = z.object({
  checkedAt: z.string().datetime(),
  /** The latest stable release's version (`0.5.0`), or null when there is none to announce. */
  version: z.string().max(64).nullable(),
  url: z.string().max(2048).nullable(),
});
export type CachedUpdateCheck = z.infer<typeof CachedUpdateCheck>;

export interface UpdateStore {
  read(): Promise<CachedUpdateCheck | null>;
  write(entry: CachedUpdateCheck): Promise<void>;
}

export type UpdateCheckResult = { available: false } | { available: true; version: string; url: string };

/** The part of GitHub's release object this app reads. */
const LatestRelease = z.object({
  tag_name: z.string().max(64),
  html_url: z.string().max(2048),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
});

const VERSION = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const STABLE_TAG = /^v?(\d{1,9}\.\d{1,9}\.\d{1,9})$/;

/**
 * Numeric semver order of the core (`0.4.10` > `0.4.9`); a pre-release sorts before its release. An unreadable version
 * compares equal, so it never produces an announcement.
 */
export function compareVersions(a: string, b: string): number {
  const x = VERSION.exec(a);
  const y = VERSION.exec(b);
  if (!x || !y) return 0;
  for (const i of [1, 2, 3]) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return Math.sign(d);
  }
  if (x[4] && !y[4]) return -1;
  if (!x[4] && y[4]) return 1;
  return 0;
}

/** Only an https page under the repository's releases, without credentials, is ever shown or opened. */
export function isReleasePageUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname === "github.com" &&
    url.port === "" &&
    !url.username &&
    !url.password &&
    url.pathname.startsWith(RELEASE_PAGE_PATH)
  );
}

function announce(entry: CachedUpdateCheck | null, current: string): UpdateCheckResult {
  if (!entry?.version || !entry.url || !isReleasePageUrl(entry.url)) return { available: false };
  if (!STABLE_TAG.test(entry.version) || compareVersions(entry.version, current) <= 0)
    return { available: false };
  return { available: true, version: entry.version, url: entry.url };
}

async function fetchLatest(
  fetchImpl: typeof fetch,
): Promise<{ version: string | null; url: string | null } | null> {
  try {
    const res = await fetchImpl(RELEASES_LATEST_URL, {
      method: "GET",
      headers: { Accept: "application/vnd.github+json", "User-Agent": "OCW-Desktop" },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const parsed = LatestRelease.safeParse(await res.json());
    if (!parsed.success) return null;
    const { tag_name, html_url, draft, prerelease } = parsed.data;
    const tag = STABLE_TAG.exec(tag_name);
    if (draft === true || prerelease === true || !tag?.[1] || !isReleasePageUrl(html_url)) {
      return { version: null, url: null };
    }
    return { version: tag[1], url: html_url };
  } catch {
    return null; // offline, timed out, not JSON: keep what we knew
  }
}

/**
 * The update notice for `current` (`app.getVersion()`). Within a day of the last answer it uses the stored one; after
 * that it asks GitHub once. Any failure (network, refusal, rate limit, malformed answer, unreadable store) keeps the
 * previous result and never throws.
 */
export async function checkForUpdate(opts: {
  current: string;
  fetchImpl: typeof fetch;
  now: () => number;
  store: UpdateStore;
}): Promise<UpdateCheckResult> {
  const cached = await opts.store.read().catch(() => null);
  const at = cached ? Date.parse(cached.checkedAt) : Number.NaN;
  const now = opts.now();
  if (cached && Number.isFinite(at) && now >= at && now - at < UPDATE_CHECK_INTERVAL_MS) {
    return announce(cached, opts.current);
  }
  const latest = await fetchLatest(opts.fetchImpl);
  if (!latest) return announce(cached, opts.current);
  const entry: CachedUpdateCheck = { checkedAt: new Date(now).toISOString(), ...latest };
  await opts.store.write(entry).catch(() => undefined);
  return announce(entry, opts.current);
}

/** The store in the app's data folder (`userData/update-check.json`, 0600, temp file + rename). */
export function fileUpdateStore(dir: string): UpdateStore {
  const path = join(dir, FILE);
  return {
    async read() {
      try {
        const parsed = CachedUpdateCheck.safeParse(JSON.parse(await readFile(path, "utf8")));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
    async write(entry) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, `${JSON.stringify(CachedUpdateCheck.parse(entry), null, 2)}\n`, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, path);
    },
  };
}
