// The device's browser install (07.13 D-05, PD-19, Pitfall 9): a pinned, verified headless shell or nothing. No test
// downloads a real browser: archives are built here (stored entries) and their hashes injected through `pins`, and
// downloads come from an injected fetch.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  APPARMOR_PROFILE_PATH,
  appArmorFixLine,
  aptInstallLine,
  BrowserInstallError,
  browsersRoot,
  installBrowser,
  installedBrowser,
  missingLinuxLibraries,
  parseOsRelease,
} from "./install.js";
import { CFT_PINS, CFT_VERSION, type CftPin, type CftPlatform, cftZipUrl } from "./pins.js";

interface Entry {
  name: string;
  data?: string;
  mode?: number;
}

/** A zip archive (PKWARE APPNOTE 4.3) with stored entries, made by Unix, so modes survive. */
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
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
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

const PLATFORM: CftPlatform = "linux64";
const SHELL_ZIP = buildZip([
  { name: "chrome-headless-shell-linux64/" },
  {
    name: "chrome-headless-shell-linux64/chrome-headless-shell",
    data: "#!/bin/sh\necho shell\n",
    mode: 0o100755,
  },
  { name: "chrome-headless-shell-linux64/libEGL.so", data: "lib" },
]);
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const pinsFor = (zip: Buffer): Readonly<Record<CftPlatform, CftPin>> => ({
  ...CFT_PINS,
  [PLATFORM]: { sha256: sha256(zip), bytes: zip.length },
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function scratch(): { root: string; zip: (b: Buffer) => string } {
  const base = mkdtempSync(join(tmpdir(), "ocw-browser-install-"));
  dirs.push(base);
  const root = join(base, "browsers");
  let n = 0;
  return {
    root,
    zip: (b) => {
      n += 1;
      const file = join(base, `shell-${n}.zip`);
      writeFileSync(file, b);
      return file;
    },
  };
}

/** Everything in the root but the finished version directory (staging dirs, locks). */
const leftovers = (root: string) =>
  existsSync(root) ? readdirSync(root).filter((name) => name !== CFT_VERSION) : [];

async function refusal(p: Promise<unknown>): Promise<BrowserInstallError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BrowserInstallError);
  return err as BrowserInstallError;
}

/** A fetch answering the zip in small chunks, counting calls. */
function fakeFetch(body: Buffer | number, delayMs = 0): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    urls.push(String(input));
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (typeof body === "number") return new Response("not found", { status: body });
    const chunks: Buffer[] = [];
    for (let i = 0; i < body.length; i += 64) chunks.push(body.subarray(i, i + 64));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next) controller.enqueue(new Uint8Array(next));
        else controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-length": String(body.length) } });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

describe("installBrowser --from-zip (07.13 D-05, PD-19)", () => {
  it("installs a zip with the pinned hash into <root>/<version>, writes the marker and finds the executable", async () => {
    const { root, zip } = scratch();
    const pins = pinsFor(SHELL_ZIP);
    const installed = await installBrowser({ root, platform: PLATFORM, fromZip: zip(SHELL_ZIP), pins });
    const dir = join(root, CFT_VERSION);
    expect(installed).toEqual({
      version: CFT_VERSION,
      platform: PLATFORM,
      dir,
      executable: join(dir, "chrome-headless-shell"),
    });
    expect(JSON.parse(readFileSync(join(dir, ".ocw-browser.json"), "utf8"))).toEqual({
      version: CFT_VERSION,
      platform: PLATFORM,
      zipSha256: pins[PLATFORM].sha256,
    });
    expect(statSync(installed.executable).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(dir, "libEGL.so"), "utf8")).toBe("lib");
    expect(await installedBrowser(root, { platform: PLATFORM, pins })).toEqual(installed);
    expect(leftovers(root)).toEqual([]);
    // Another build's pin does not count as installed.
    expect(await installedBrowser(root, { platform: PLATFORM })).toBeNull();
    expect(await installedBrowser(root, { platform: "mac-arm64", pins })).toBeNull();
  });

  it("refuses a zip with another hash (checksum_mismatch) and leaves no partial directory", async () => {
    const { root, zip } = scratch();
    const tampered = buildZip([
      { name: "chrome-headless-shell-linux64/" },
      { name: "chrome-headless-shell-linux64/chrome-headless-shell", data: "evil", mode: 0o100755 },
    ]);
    const err = await refusal(
      installBrowser({ root, platform: PLATFORM, fromZip: zip(tampered), pins: pinsFor(SHELL_ZIP) }),
    );
    expect(err.code).toBe("checksum_mismatch");
    expect(existsSync(join(root, CFT_VERSION))).toBe(false);
    expect(leftovers(root)).toEqual([]);
    // The real pins refuse it too: there is no way around the hash.
    const real = await refusal(installBrowser({ root, platform: PLATFORM, fromZip: zip(SHELL_ZIP) }));
    expect(real.code).toBe("checksum_mismatch");
    expect(leftovers(root)).toEqual([]);
  });

  it("an archive with the pinned hash but a zip-slip entry is refused and its staging is removed", async () => {
    const { root, zip } = scratch();
    const slip = buildZip([
      { name: "chrome-headless-shell-linux64/chrome-headless-shell", data: "x", mode: 0o100755 },
      { name: "chrome-headless-shell-linux64/link", data: "/etc/passwd", mode: 0o120777 },
    ]);
    const err = await refusal(
      installBrowser({ root, platform: PLATFORM, fromZip: zip(slip), pins: pinsFor(slip) }),
    );
    expect(err.code).toBe("download_failed");
    expect(existsSync(join(root, CFT_VERSION))).toBe(false);
    expect(leftovers(root)).toEqual([]);
  });

  it("an existing install short-circuits: nothing is read or extracted again", async () => {
    const { root, zip } = scratch();
    const pins = pinsFor(SHELL_ZIP);
    const first = await installBrowser({ root, platform: PLATFORM, fromZip: zip(SHELL_ZIP), pins });
    const again = await installBrowser({
      root,
      platform: PLATFORM,
      fromZip: join(root, "missing.zip"),
      pins,
    });
    expect(again).toEqual(first);
    const { fetchImpl, urls } = fakeFetch(404);
    expect(await installBrowser({ root, platform: PLATFORM, fetchImpl, pins })).toEqual(first);
    expect(urls).toEqual([]);
  });

  it("an unreadable zip is download_failed, and no message names an absolute path", async () => {
    const { root } = scratch();
    const err = await refusal(
      installBrowser({ root, platform: PLATFORM, fromZip: join(root, "nope.zip"), pins: pinsFor(SHELL_ZIP) }),
    );
    expect(err.code).toBe("download_failed");
    expect(err.message).not.toContain(root);
    expect(leftovers(root)).toEqual([]);
  });
});

describe("installBrowser download (07.13 D-05, Pitfall 9)", () => {
  it("streams from the fixed CfT URL to staging with progress, verifies and installs", async () => {
    const { root } = scratch();
    const { fetchImpl, urls } = fakeFetch(SHELL_ZIP);
    const progress: Array<{ receivedBytes: number; totalBytes: number }> = [];
    const installed = await installBrowser({
      root,
      platform: PLATFORM,
      fetchImpl,
      pins: pinsFor(SHELL_ZIP),
      onProgress: (p) => progress.push(p),
    });
    expect(urls).toEqual([cftZipUrl(PLATFORM)]);
    expect(installed.executable).toBe(join(root, CFT_VERSION, "chrome-headless-shell"));
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)).toEqual({ receivedBytes: SHELL_ZIP.length, totalBytes: SHELL_ZIP.length });
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]?.receivedBytes).toBeGreaterThanOrEqual(progress[i - 1]?.receivedBytes ?? 0);
    }
    expect(leftovers(root)).toEqual([]);
  });

  it("a 404 or a network error is download_failed; a body that does not hash to the pin is checksum_mismatch", async () => {
    const { root } = scratch();
    const pins = pinsFor(SHELL_ZIP);
    expect(
      (await refusal(installBrowser({ root, platform: PLATFORM, fetchImpl: fakeFetch(404).fetchImpl, pins })))
        .code,
    ).toBe("download_failed");
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect((await refusal(installBrowser({ root, platform: PLATFORM, fetchImpl: offline, pins }))).code).toBe(
      "download_failed",
    );
    const other = Buffer.from(SHELL_ZIP);
    other[other.length - 30] = (other[other.length - 30] ?? 0) ^ 0xff;
    expect(
      (
        await refusal(
          installBrowser({ root, platform: PLATFORM, fetchImpl: fakeFetch(other).fetchImpl, pins }),
        )
      ).code,
    ).toBe("checksum_mismatch");
    const longer = Buffer.concat([SHELL_ZIP, Buffer.from("trailing bytes")]);
    expect(
      (
        await refusal(
          installBrowser({ root, platform: PLATFORM, fetchImpl: fakeFetch(longer).fetchImpl, pins }),
        )
      ).code,
    ).toBe("checksum_mismatch");
    expect(existsSync(join(root, CFT_VERSION))).toBe(false);
    expect(leftovers(root)).toEqual([]);
  });

  it("two concurrent installs fetch once", async () => {
    const { root } = scratch();
    const { fetchImpl, urls } = fakeFetch(SHELL_ZIP, 50);
    const pins = pinsFor(SHELL_ZIP);
    const [a, b] = await Promise.all([
      installBrowser({ root, platform: PLATFORM, fetchImpl, pins }),
      installBrowser({ root, platform: PLATFORM, fetchImpl, pins }),
    ]);
    expect(a).toEqual(b);
    expect(urls).toHaveLength(1);
  });

  it("waits for another process's lock and uses its install; a lock older than 15 minutes is taken over", async () => {
    const { root, zip } = scratch();
    const pins = pinsFor(SHELL_ZIP);
    mkdirSync(root, { recursive: true });
    const lock = join(root, ".install.lock");
    writeFileSync(lock, "other process");
    const { fetchImpl, urls } = fakeFetch(SHELL_ZIP);
    const waiting = installBrowser({ root, platform: PLATFORM, fetchImpl, pins });
    // The other process finishes: its install appears and it drops the lock.
    await new Promise((r) => setTimeout(r, 100));
    await installBrowser({
      root: join(root, "..", "elsewhere"),
      platform: PLATFORM,
      fromZip: zip(SHELL_ZIP),
      pins,
    });
    const { renameSync } = await import("node:fs");
    renameSync(join(root, "..", "elsewhere", CFT_VERSION), join(root, CFT_VERSION));
    rmSync(lock);
    expect((await waiting).dir).toBe(join(root, CFT_VERSION));
    expect(urls).toEqual([]);

    rmSync(join(root, CFT_VERSION), { recursive: true });
    writeFileSync(lock, "crashed process");
    const old = new Date(Date.now() - 16 * 60_000);
    utimesSync(lock, old, old);
    mkdirSync(join(root, ".staging-crashed"));
    await installBrowser({ root, platform: PLATFORM, fetchImpl, pins });
    expect(urls).toHaveLength(1);
    expect(leftovers(root)).toEqual([]);
  });
});

describe("browsersRoot (07.13 PD-19)", () => {
  it("is OCW_BROWSERS_DIR when absolute, else <OCW_HOME>/browsers; a relative OCW_BROWSERS_DIR is refused", () => {
    expect(browsersRoot({ OCW_HOME: "/x/ocw" })).toBe(join("/x/ocw", "browsers"));
    expect(browsersRoot({ OCW_HOME: "/x/ocw", OCW_BROWSERS_DIR: "/cache/browsers" })).toBe("/cache/browsers");
    expect(() => browsersRoot({ OCW_BROWSERS_DIR: "relative/browsers" })).toThrow(/absolute/);
  });
});

// ---------------------------------------------------------------- doctor helpers (07.13 D-06, Pitfall 4, SPIKES A-6)

const LDD = [
  "\tlinux-vdso.so.1 (0x0000ffff9b4f1000)",
  "\tlibdl.so.2 => /lib/aarch64-linux-gnu/libdl.so.2 (0x0000ffff9b4a0000)",
  "\tlibnss3.so => not found",
  "\tlibnssutil3.so => not found",
  "\tlibasound.so.2 => not found",
  "\tlibglib-2.0.so.0 => not found",
  "\tlibgobject-2.0.so.0 => not found",
  "\tlibatk-bridge-2.0.so.0 => not found",
  "\tlibnss3.so => not found",
  "\tlibm.so.6 => /lib/aarch64-linux-gnu/libm.so.6 (0x0000ffff9b3f0000)",
].join("\n");

describe("missingLinuxLibraries (07.13 D-06)", () => {
  it("reads the `=> not found` sonames of ldd's output, once each, in order", async () => {
    const calls: string[] = [];
    const missing = await missingLinuxLibraries("/x/chrome-headless-shell", async (exe) => {
      calls.push(exe);
      return LDD;
    });
    expect(calls).toEqual(["/x/chrome-headless-shell"]);
    expect(missing).toEqual([
      "libasound.so.2",
      "libatk-bridge-2.0.so.0",
      "libglib-2.0.so.0",
      "libgobject-2.0.so.0",
      "libnss3.so",
      "libnssutil3.so",
    ]);
    expect(await missingLinuxLibraries("/x", async () => "\tlibc.so.6 => /lib/libc.so.6 (0x1)\n")).toEqual(
      [],
    );
    // ldd cannot run: nothing is known to be missing (the launch reports what it finds).
    expect(
      await missingLinuxLibraries("/x", async () => {
        throw new Error("spawn ldd ENOENT");
      }),
    ).toEqual([]);
  });
});

describe("aptInstallLine (07.13 D-06, SPIKES A-6)", () => {
  const ubuntu2404 = { id: "ubuntu", versionId: "24.04" };
  const debian12 = { id: "debian", versionId: "12" };

  it("maps sonames to packages, with the t64 names on Ubuntu 24.04 and later", () => {
    expect(aptInstallLine(["libasound.so.2", "libnss3.so"], ubuntu2404)).toBe(
      "sudo apt-get install -y libasound2t64 libnss3",
    );
    expect(aptInstallLine(["libasound.so.2", "libnss3.so"], debian12)).toBe(
      "sudo apt-get install -y libasound2 libnss3",
    );
    expect(aptInstallLine(["libasound.so.2"], { id: "ubuntu", versionId: "22.04" })).toBe(
      "sudo apt-get install -y libasound2",
    );
    expect(aptInstallLine(["libasound.so.2"], { id: "ubuntu", versionId: "25.10" })).toBe(
      "sudo apt-get install -y libasound2t64",
    );
  });

  it("prints SPIKES A-6's measured lines from the linux64 sonames", () => {
    const linux64 = [
      "libasound.so.2",
      "libatk-1.0.so.0",
      "libatk-bridge-2.0.so.0",
      "libatspi.so.0",
      "libdbus-1.so.3",
      "libexpat.so.1",
      "libgbm.so.1",
      "libgio-2.0.so.0",
      "libglib-2.0.so.0",
      "libgobject-2.0.so.0",
      "libnspr4.so",
      "libnss3.so",
      "libnssutil3.so",
      "libsmime3.so",
      "libX11.so.6",
      "libxcb.so.1",
      "libXcomposite.so.1",
      "libXdamage.so.1",
      "libXext.so.6",
      "libXfixes.so.3",
      "libxkbcommon.so.0",
      "libXrandr.so.2",
    ];
    expect(aptInstallLine(linux64, debian12)).toBe(
      "sudo apt-get install -y libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libdbus-1-3 libexpat1 libgbm1 libglib2.0-0 libnspr4 libnss3 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2",
    );
    expect(aptInstallLine(linux64, ubuntu2404)).toBe(
      "sudo apt-get install -y libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libdbus-1-3 libexpat1 libgbm1 libglib2.0-0t64 libnspr4 libnss3 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2",
    );
  });

  it("follows an Ubuntu derivative by its Ubuntu codename; no line off Debian/Ubuntu or without a known soname", () => {
    expect(
      aptInstallLine(["libasound.so.2"], {
        id: "linuxmint",
        versionId: "22",
        idLike: ["ubuntu", "debian"],
        ubuntuCodename: "noble",
      }),
    ).toBe("sudo apt-get install -y libasound2t64");
    expect(
      aptInstallLine(["libasound.so.2"], {
        id: "linuxmint",
        versionId: "21.3",
        idLike: ["ubuntu", "debian"],
        ubuntuCodename: "jammy",
      }),
    ).toBe("sudo apt-get install -y libasound2");
    expect(aptInstallLine(["libnss3.so"], { id: "fedora", versionId: "41" })).toBeNull();
    expect(aptInstallLine(["libnss3.so"], null)).toBeNull();
    expect(aptInstallLine(["libunknown.so.7"], debian12)).toBeNull();
    expect(aptInstallLine([], debian12)).toBeNull();
  });

  it("parses /etc/os-release", () => {
    expect(
      parseOsRelease(
        'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nID_LIKE=debian\nUBUNTU_CODENAME=noble\n# comment\n',
      ),
    ).toEqual({ id: "ubuntu", versionId: "24.04", idLike: ["debian"], ubuntuCodename: "noble" });
    expect(parseOsRelease("ID=debian\nVERSION_ID='12'\n")).toEqual({
      id: "debian",
      versionId: "12",
      idLike: [],
    });
    expect(parseOsRelease("NAME=nothing\n")).toBeNull();
  });
});

describe("appArmorFixLine (07.13 Pitfall 4)", () => {
  const HOME = "/home/dana";
  const EXE = `${HOME}/.ocw/browsers/${CFT_VERSION}/chrome-headless-shell`;
  const reader =
    (files: Record<string, string>) =>
    async (path: string): Promise<string | null> =>
      files[path] ?? null;
  const RESTRICT = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";

  it("is a line only when Ubuntu restricts unprivileged user namespaces, naming a profile for the home-relative executable", async () => {
    expect(await appArmorFixLine(EXE, reader({}), HOME)).toBeNull();
    expect(await appArmorFixLine(EXE, reader({ [RESTRICT]: "0\n" }), HOME)).toBeNull();
    const line = await appArmorFixLine(EXE, reader({ [RESTRICT]: "1\n" }), HOME);
    expect(line).toContain(`"@{HOME}/.ocw/browsers/${CFT_VERSION}/chrome-headless-shell"`);
    expect(line).toContain("userns,");
    expect(line).toContain(`sudo tee ${APPARMOR_PROFILE_PATH}`);
    expect(line).toContain(`sudo apparmor_parser -r ${APPARMOR_PROFILE_PATH}`);
    expect(line).not.toContain(HOME);
    expect(line?.split("\n")).toHaveLength(1);
  });

  it("is null once the profile for this executable is loaded from its file", async () => {
    const line = (await appArmorFixLine(EXE, reader({ [RESTRICT]: "1" }), HOME)) ?? "";
    const profile = /printf '([^']*)'/.exec(line)?.[1]?.replaceAll("\\n", "\n") ?? "";
    expect(profile).toContain("profile ocw-chrome-headless-shell");
    expect(
      await appArmorFixLine(EXE, reader({ [RESTRICT]: "1", [APPARMOR_PROFILE_PATH]: profile }), HOME),
    ).toBeNull();
    // A profile for an older build does not cover this one.
    const older = profile.replace(CFT_VERSION, "155.0.0.1");
    expect(
      await appArmorFixLine(EXE, reader({ [RESTRICT]: "1", [APPARMOR_PROFILE_PATH]: older }), HOME),
    ).not.toBeNull();
  });
});
