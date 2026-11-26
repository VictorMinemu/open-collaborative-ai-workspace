// scripts/check-update-manifest.mjs (07.13.1, D-03, D-04): a fake release folder per platform, with the manifest
// electron-builder writes (`latest*.yml`, real base64 sha512 and size) and the packaged `app-update.yml`. The script
// passes on a faithful folder and fails, naming the file but never the folder's absolute path, on every way a release
// can point a device at the wrong bytes.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "check-update-manifest.mjs");
const VERSION = "1.2.3";
const APPIMAGE = `OCW-v${VERSION}-linux-x86_64.AppImage`;

type Platform = "darwin" | "win32" | "linux";

const LAYOUT: Record<Platform, { manifest: string; resources: string; files: string[]; extra: string[] }> = {
  darwin: {
    manifest: "latest-mac.yml",
    resources: "mac-arm64/OCW.app/Contents/Resources",
    files: [`OCW-v${VERSION}-macos-arm64.zip`, `OCW-v${VERSION}-macos-arm64.dmg`],
    extra: [`OCW-v${VERSION}-macos-arm64.zip.blockmap`],
  },
  win32: {
    manifest: "latest.yml",
    resources: "win-unpacked/resources",
    files: [`OCW-v${VERSION}-windows-x64-setup.exe`],
    extra: [`OCW-v${VERSION}-windows-x64-setup.exe.blockmap`],
  },
  linux: {
    manifest: "latest-linux.yml",
    resources: "linux-unpacked/resources",
    files: [APPIMAGE, `OCW-v${VERSION}-linux-amd64.deb`],
    extra: [],
  },
};

const APP_UPDATE = [
  "owner: VictorMinemu",
  "repo: open-collaborative-ai-workspace",
  "provider: github",
  "releaseType: release",
  "updaterCacheDirName: '@ocwdesktop-updater'",
  "",
].join("\n");

let release: string;
beforeEach(() => {
  release = mkdtempSync(join(tmpdir(), "ocw-update-manifest-"));
});
afterEach(() => rmSync(release, { recursive: true, force: true }));

function sha512(bytes: Buffer): string {
  return createHash("sha512").update(bytes).digest("base64");
}

/** Writes the folder electron-builder leaves behind on `platform`; returns the manifest's path. */
function fakeRelease(platform: Platform, opts: { version?: string; urls?: string[] } = {}): string {
  const layout = LAYOUT[platform];
  const entries = layout.files.map((name, i) => {
    const bytes = randomBytes(4096 + i);
    writeFileSync(join(release, name), bytes);
    return { url: opts.urls?.[i] ?? name, sha512: sha512(bytes), size: bytes.length };
  });
  for (const name of layout.extra) writeFileSync(join(release, name), randomBytes(64));
  const first = entries[0];
  if (!first) throw new Error("no files");
  const yml = [
    `version: ${opts.version ?? VERSION}`,
    "files:",
    ...entries.flatMap((e) => [`  - url: ${e.url}`, `    sha512: ${e.sha512}`, `    size: ${e.size}`]),
    `path: ${first.url}`,
    `sha512: ${first.sha512}`,
    "releaseDate: '2026-11-26T10:00:00.000Z'",
    "",
  ].join("\n");
  const manifest = join(release, layout.manifest);
  writeFileSync(manifest, yml);
  mkdirSync(join(release, layout.resources), { recursive: true });
  writeFileSync(join(release, layout.resources, "app-update.yml"), APP_UPDATE);
  return manifest;
}

function appUpdatePath(platform: Platform): string {
  return join(release, LAYOUT[platform].resources, "app-update.yml");
}

function check(platform: Platform) {
  const args = [SCRIPT, "--release", release, "--version", VERSION, "--platform", platform];
  if (platform === "darwin") args.push("--no-seal");
  const r = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 30_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, stderr: r.stderr };
}

function expectNoAbsolutePath(out: string) {
  expect(out).not.toContain(release);
  expect(out).not.toContain(realpathSync(release));
}

describe("check-update-manifest.mjs", () => {
  for (const platform of ["linux", "win32", "darwin"] as const) {
    it(`passes a faithful ${platform} release folder`, () => {
      fakeRelease(platform);
      const r = check(platform);
      expect(r.out).toContain(LAYOUT[platform].manifest);
      expect(r.status).toBe(0);
      expectNoAbsolutePath(r.out);
    });
  }

  it("fails when a payload byte changes (sha512)", () => {
    fakeRelease("linux");
    const file = join(release, APPIMAGE);
    const bytes = readFileSync(file);
    bytes[10] = (bytes[10] ?? 0) ^ 0xff;
    writeFileSync(file, bytes);
    const r = check("linux");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(APPIMAGE);
    expectNoAbsolutePath(r.out);
  });

  it("fails when a listed file is missing", () => {
    fakeRelease("linux");
    rmSync(join(release, APPIMAGE));
    const r = check("linux");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(APPIMAGE);
    expectNoAbsolutePath(r.out);
  });

  it("fails when the manifest's version is not the expected one", () => {
    fakeRelease("linux", { version: "1.2.4" });
    const r = check("linux");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("latest-linux.yml");
    expectNoAbsolutePath(r.out);
  });

  it("fails when app-update.yml names a publisherName", () => {
    fakeRelease("win32");
    writeFileSync(appUpdatePath("win32"), `${APP_UPDATE}publisherName:\n  - Someone\n`);
    const r = check("win32");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("app-update.yml");
    expect(r.stderr).toContain("publisherName");
    expectNoAbsolutePath(r.out);
  });

  it("fails when app-update.yml points at another repository", () => {
    fakeRelease("linux");
    writeFileSync(appUpdatePath("linux"), APP_UPDATE.replace("open-collaborative-ai-workspace", "a-fork"));
    const r = check("linux");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("app-update.yml");
    expectNoAbsolutePath(r.out);
  });

  for (const url of [`../${APPIMAGE}`, `sub/${APPIMAGE}`]) {
    it(`fails when a files[].url is not a plain file name (${url})`, () => {
      fakeRelease("linux", { urls: [url] });
      const r = check("linux");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("latest-linux.yml");
      expectNoAbsolutePath(r.out);
    });
  }

  it("fails when updaterCacheDirName contains a separator", () => {
    fakeRelease("linux");
    writeFileSync(appUpdatePath("linux"), APP_UPDATE.replace("'@ocwdesktop-updater'", "'../elsewhere'"));
    const r = check("linux");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("updaterCacheDirName");
    expectNoAbsolutePath(r.out);
  });

  it("fails when the Windows blockmap is missing", () => {
    fakeRelease("win32");
    rmSync(join(release, `OCW-v${VERSION}-windows-x64-setup.exe.blockmap`));
    const r = check("win32");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`OCW-v${VERSION}-windows-x64-setup.exe.blockmap`);
    expectNoAbsolutePath(r.out);
  });
});
