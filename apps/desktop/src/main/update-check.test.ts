import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CachedUpdateCheck,
  checkForUpdate,
  compareVersions,
  fileUpdateStore,
  isReleasePageUrl,
  RELEASES_LATEST_URL,
  UPDATE_CHECK_INTERVAL_MS,
} from "./update-check";

/**
 * 07.13 (D-18, PD-21): the desktop app asks GitHub's public releases/latest at most once a day and announces a newer
 * release with a link to its page. It never downloads or installs anything (unsigned builds until Phase 9). The fake
 * fetch stands in for GitHub: no test reaches the network.
 */

const PAGE = "https://github.com/VictorMinemu/open-collaborative-ai-workspace/releases/tag/v0.5.0";
const T0 = Date.parse("2026-11-25T09:00:00.000Z");

function memoryStore(initial: CachedUpdateCheck | null = null) {
  let value = initial;
  return {
    read: vi.fn(async () => value),
    write: vi.fn(async (next: CachedUpdateCheck) => {
      value = next;
    }),
    get value() {
      return value;
    },
  };
}

function github(body: unknown, status = 200) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

const release = (over: Record<string, unknown> = {}) => ({
  tag_name: "v0.5.0",
  html_url: PAGE,
  draft: false,
  prerelease: false,
  ...over,
});

describe("checkForUpdate (D-18, PD-21)", () => {
  it("announces a newer release with its page", async () => {
    const fetchImpl = github(release());
    const store = memoryStore();
    const result = await checkForUpdate({ current: "0.4.0", fetchImpl, now: () => T0, store });
    expect(result).toEqual({ available: true, version: "0.5.0", url: PAGE });
    // One unauthenticated GET to the public API, JSON accepted, bounded by a timeout.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe(RELEASES_LATEST_URL);
    expect(RELEASES_LATEST_URL).toBe(
      "https://api.github.com/repos/VictorMinemu/open-collaborative-ai-workspace/releases/latest",
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(headers.get("authorization")).toBeNull();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.method ?? "GET").toBe("GET");
    expect(store.value).toEqual({ checkedAt: new Date(T0).toISOString(), version: "0.5.0", url: PAGE });
  });

  it("says nothing when the latest release is this version or older", async () => {
    for (const current of ["0.5.0", "0.6.0", "1.0.0"]) {
      const result = await checkForUpdate({
        current,
        fetchImpl: github(release()),
        now: () => T0,
        store: memoryStore(),
      });
      expect(result, current).toEqual({ available: false });
    }
  });

  it.each([
    [{ prerelease: true }],
    [{ draft: true }],
    [{ tag_name: "v0.5.0-rc.1" }],
    [{ tag_name: "nightly" }],
    [{ html_url: "https://evil.example/VictorMinemu/open-collaborative-ai-workspace/releases/tag/v0.5.0" }],
    [{ html_url: "https://github.com/someone-else/open-collaborative-ai-workspace/releases/tag/v0.5.0" }],
    [{ html_url: "http://github.com/VictorMinemu/open-collaborative-ai-workspace/releases/tag/v0.5.0" }],
    [
      {
        html_url:
          "https://user:pw@github.com/VictorMinemu/open-collaborative-ai-workspace/releases/tag/v0.5.0",
      },
    ],
    [{ html_url: 42 }],
  ])("ignores a release it must not announce: %j", async (over) => {
    const result = await checkForUpdate({
      current: "0.4.0",
      fetchImpl: github(release(over)),
      now: () => T0,
      store: memoryStore(),
    });
    expect(result).toEqual({ available: false });
  });

  it("asks at most once a day: a second call within 24 h uses the stored result", async () => {
    const store = memoryStore();
    const first = github(release());
    await checkForUpdate({ current: "0.4.0", fetchImpl: first, now: () => T0, store });
    const second = github(release({ tag_name: "v0.6.0" }));
    const later = T0 + UPDATE_CHECK_INTERVAL_MS - 1;
    expect(await checkForUpdate({ current: "0.4.0", fetchImpl: second, now: () => later, store })).toEqual({
      available: true,
      version: "0.5.0",
      url: PAGE,
    });
    expect(second).not.toHaveBeenCalled();
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
    // After a day it asks again.
    const day = T0 + UPDATE_CHECK_INTERVAL_MS;
    const page6 = PAGE.replace("v0.5.0", "v0.6.0");
    const third = github(release({ tag_name: "v0.6.0", html_url: page6 }));
    expect(await checkForUpdate({ current: "0.4.0", fetchImpl: third, now: () => day, store })).toEqual({
      available: true,
      version: "0.6.0",
      url: page6,
    });
    expect(third).toHaveBeenCalledTimes(1);
  });

  it("a forced check (a click on Check for updates…) asks even within the day, and still never throws", async () => {
    const store = memoryStore({ checkedAt: new Date(T0).toISOString(), version: "0.5.0", url: PAGE });
    const page6 = PAGE.replace("v0.5.0", "v0.6.0");
    const fresh = github(release({ tag_name: "v0.6.0", html_url: page6 }));
    expect(
      await checkForUpdate({ current: "0.4.0", fetchImpl: fresh, now: () => T0 + 1000, store, force: true }),
    ).toEqual({ available: true, version: "0.6.0", url: page6 });
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(store.value?.version).toBe("0.6.0");
    // Offline on a forced check: the stored answer stays, nothing is thrown.
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(
      await checkForUpdate({
        current: "0.4.0",
        fetchImpl: offline,
        now: () => T0 + 2000,
        store,
        force: true,
      }),
    ).toEqual({ available: true, version: "0.6.0", url: page6 });
    // Without force the same-day answer is used again.
    const unused = github(release());
    await checkForUpdate({ current: "0.4.0", fetchImpl: unused, now: () => T0 + 3000, store });
    expect(unused).not.toHaveBeenCalled();
  });

  it("the stored result is compared with the running version (an app already updated says nothing)", async () => {
    const store = memoryStore({ checkedAt: new Date(T0).toISOString(), version: "0.5.0", url: PAGE });
    const fetchImpl = github(release());
    expect(await checkForUpdate({ current: "0.5.0", fetchImpl, now: () => T0 + 1000, store })).toEqual({
      available: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a network error, a refusal or a malformed answer keeps the previous result and never throws", async () => {
    const stale = T0 - 2 * UPDATE_CHECK_INTERVAL_MS;
    const previous = { checkedAt: new Date(stale).toISOString(), version: "0.5.0", url: PAGE };
    const failures = [
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
      github({ message: "API rate limit exceeded" }, 403),
      vi.fn(async () => new Response("<html>", { status: 200 })),
      github({ tag_name: 5 }),
    ];
    for (const fetchImpl of failures) {
      const store = memoryStore(previous);
      expect(await checkForUpdate({ current: "0.4.0", fetchImpl, now: () => T0, store })).toEqual({
        available: true,
        version: "0.5.0",
        url: PAGE,
      });
      expect(store.write).not.toHaveBeenCalled();
    }
    // With nothing stored: nothing to announce.
    const store = memoryStore();
    expect(
      await checkForUpdate({ current: "0.4.0", fetchImpl: failures[0] as never, now: () => T0, store }),
    ).toEqual({ available: false });
  });

  it("a store that cannot be read or written never breaks the check", async () => {
    const store = {
      read: vi.fn(async () => {
        throw new Error("EACCES");
      }),
      write: vi.fn(async () => {
        throw new Error("EROFS");
      }),
    };
    expect(
      await checkForUpdate({ current: "0.4.0", fetchImpl: github(release()), now: () => T0, store }),
    ).toEqual({ available: true, version: "0.5.0", url: PAGE });
  });

  it("a stored entry with a URL outside the releases page is ignored", async () => {
    const store = memoryStore({
      checkedAt: new Date(T0).toISOString(),
      version: "9.0.0",
      url: "https://evil.example/download",
    });
    expect(
      await checkForUpdate({ current: "0.4.0", fetchImpl: github(release()), now: () => T0 + 1, store }),
    ).toEqual({ available: false });
  });
});

describe("compareVersions", () => {
  it.each([
    ["0.5.0", "0.4.0", 1],
    ["0.4.10", "0.4.9", 1],
    ["1.0.0", "0.99.99", 1],
    ["0.4.0", "0.4.0", 0],
    ["0.4.0", "0.5.0", -1],
    ["0.5.0", "0.5.0-rc.1", 1],
    ["0.5.0-rc.1", "0.5.0", -1],
  ])("%s vs %s → %d", (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });

  it("an unreadable version is never older than anything (no announcement)", () => {
    expect(compareVersions("0.5.0", "dev")).toBe(0);
    expect(compareVersions("x", "0.4.0")).toBe(0);
  });
});

describe("isReleasePageUrl", () => {
  it("accepts only https pages under the repository's releases", () => {
    expect(isReleasePageUrl(PAGE)).toBe(true);
    expect(
      isReleasePageUrl("https://github.com/VictorMinemu/open-collaborative-ai-workspace/releases/latest"),
    ).toBe(true);
    expect(isReleasePageUrl("https://github.com/VictorMinemu/open-collaborative-ai-workspace/issues/1")).toBe(
      false,
    );
    expect(
      isReleasePageUrl(
        "https://github.com.evil.example/VictorMinemu/open-collaborative-ai-workspace/releases/",
      ),
    ).toBe(false);
    expect(
      isReleasePageUrl("https://github.com/VictorMinemu/open-collaborative-ai-workspace/releases/../../evil"),
    ).toBe(false);
    expect(isReleasePageUrl("javascript:alert(1)")).toBe(false);
  });
});

describe("fileUpdateStore", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("keeps the last result in the app's data folder (0600) and reads it back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocw-desktop-update-"));
    dirs.push(dir);
    const store = fileUpdateStore(dir);
    expect(await store.read()).toBeNull();
    const entry = { checkedAt: new Date(T0).toISOString(), version: "0.5.0", url: PAGE };
    await store.write(entry);
    const file = join(dir, "update-check.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(entry);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await store.read()).toEqual(entry);
    // A malformed file reads as nothing stored (the next check rewrites it).
    writeFileSync(file, "{ broken");
    expect(await store.read()).toBeNull();
  });
});
