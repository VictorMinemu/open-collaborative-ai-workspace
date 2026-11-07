import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
    mkdirSync(join(plain, "sub"), { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(plain, "a.txt"), "x");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("returns the repo root, also when a subfolder is picked", async () => {
    expect(await validateProjectDir(repo, { home: fakeHome })).toEqual({ root: repo, git: true });
    expect(await validateProjectDir(join(repo, "src"), { home: fakeHome })).toEqual({
      root: repo,
      git: true,
    });
  });

  it("a folder without git is accepted as it is: the picked folder is the root, nothing is created", async () => {
    expect(await validateProjectDir(plain, { home: fakeHome })).toEqual({ root: plain, git: false });
    expect(await validateProjectDir(join(plain, "sub"), { home: fakeHome })).toEqual({
      root: join(plain, "sub"),
      git: false,
    });
    expect(readdirSync(plain).sort()).toEqual(["a.txt", "sub"]);
    expect(existsSync(join(plain, ".git"))).toBe(false);
  });

  it("git missing: the folder is accepted without git", async () => {
    const git = async () => {
      throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    };
    expect(await validateProjectDir(plain, { home: fakeHome, git })).toEqual({ root: plain, git: false });
  });

  it("a repository git refuses to read (dubious ownership) is an error, never a folder without git", async () => {
    const git = async () => {
      throw Object.assign(new Error("Command failed"), {
        stderr: `fatal: detected dubious ownership in repository at '${repo}'`,
      });
    };
    const err = await validateProjectDir(repo, { home: fakeHome, git }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ProjectPathError);
    expect((err as Error).message).toMatch(/^Could not read the git repository of repo: git refuses/);
    expect((err as Error).message).not.toContain(fakeHome);
  });

  it("refuses files, missing paths, the home folder and OCW state, with or without git", async () => {
    await expect(validateProjectDir(join(plain, "a.txt"), { home: fakeHome })).rejects.toThrow(/not a file/);
    await expect(validateProjectDir(join(root, "missing"), { home: fakeHome })).rejects.toThrow(
      ProjectPathError,
    );
    await expect(validateProjectDir(fakeHome, { home: fakeHome })).rejects.toThrow(/home folder/);
    const state = join(fakeHome, ".ocw");
    mkdirSync(state, { recursive: true });
    await expect(validateProjectDir(state, { home: fakeHome, forbidden: [state] })).rejects.toThrow(
      /cannot be added/,
    );
  });

  it("refuses a repo whose root is the home folder (dotfiles repo)", async () => {
    const git = async () => fakeHome;
    await expect(validateProjectDir(plain, { home: fakeHome, git })).rejects.toThrow(/home folder/);
  });
});
