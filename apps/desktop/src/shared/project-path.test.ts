import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProjectPathError, refusalReason, validateProjectDir } from "./project-path";

describe("refusalReason", () => {
  const home = "/Users/victor";
  it("refuses home, its ancestors and system roots", () => {
    expect(refusalReason("/Users/victor", home)).toMatch(/home folder/);
    expect(refusalReason("/Users/victor/", home)).toMatch(/home folder/);
    expect(refusalReason("/Users", home)).toMatch(/contains your home/);
    expect(refusalReason("/", home)).toMatch(/contains your home/);
    for (const p of ["/System", "/usr", "/etc", "/Applications", "/private/var", "/Volumes"]) {
      expect(refusalReason(p, home)).not.toBeNull();
    }
    expect(refusalReason("/Users/victor/Library/Keychains", home)).toMatch(/Library/);
    expect(refusalReason("/Users/victor/.ocw/x", home, ["/Users/victor/.ocw"])).not.toBeNull();
  });

  it("accepts normal project folders", () => {
    expect(refusalReason("/Users/victor/code/repo", home)).toBeNull();
    expect(refusalReason("/Users/victorious/repo", home)).toBeNull();
    expect(refusalReason("/Volumes/Work/repo", home)).toBeNull();
  });
});

describe("validateProjectDir (real git)", () => {
  let root: string;
  let fakeHome: string;
  let repo: string;
  let plain: string;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ocw-desk-")));
    fakeHome = join(root, "home");
    repo = join(fakeHome, "code", "repo");
    plain = join(fakeHome, "notes");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(plain, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(plain, "a.txt"), "x");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("returns the repo root, also when a subfolder is picked", async () => {
    expect(await validateProjectDir(repo, { home: fakeHome })).toBe(repo);
    expect(await validateProjectDir(join(repo, "src"), { home: fakeHome })).toBe(repo);
  });

  it("refuses non-git folders, files, missing paths and home", async () => {
    await expect(validateProjectDir(plain, { home: fakeHome })).rejects.toThrow(/not a git repository/);
    await expect(validateProjectDir(join(plain, "a.txt"), { home: fakeHome })).rejects.toThrow(/not a file/);
    await expect(validateProjectDir(join(root, "missing"), { home: fakeHome })).rejects.toThrow(
      ProjectPathError,
    );
    await expect(validateProjectDir(fakeHome, { home: fakeHome })).rejects.toThrow(/home folder/);
  });

  it("refuses a repo whose root is the home folder (dotfiles repo)", async () => {
    const git = async () => fakeHome;
    await expect(validateProjectDir(plain, { home: fakeHome, git })).rejects.toThrow(/home folder/);
  });
});
