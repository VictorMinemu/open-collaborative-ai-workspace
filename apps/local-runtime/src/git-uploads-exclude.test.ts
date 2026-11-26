import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORK_PROMPT_UPLOADS_DIR } from "@ocw/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { excludePromptUploads } from "./git.js";

/**
 * ADR-0045: a prompt's uploads (`.ocw/uploads/`) stay out of every commit the runtime makes. The device writes the
 * repository's own `info/exclude` (resolved by git, so a linked worktree's goes to the common git dir), once, and never
 * the tracked `.gitignore`. A project without git is left alone.
 */

let dir: string;
let repo: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const exclude = () => readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
const lines = (text: string, line: string) => text.split("\n").filter((l) => l === line).length;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "ocw-excl-")));
  repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("excludePromptUploads", () => {
  it("adds /.ocw/uploads/ to .git/info/exclude once; the tracked .gitignore is untouched", async () => {
    expect(await excludePromptUploads(repo, WORK_PROMPT_UPLOADS_DIR)).toBe(true);
    expect(await excludePromptUploads(repo, WORK_PROMPT_UPLOADS_DIR)).toBe(true);
    expect(lines(exclude(), "/.ocw/uploads/")).toBe(1);
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe("node_modules/\n");
    mkdirSync(join(repo, ".ocw", "uploads"), { recursive: true });
    writeFileSync(join(repo, ".ocw", "uploads", "spec.pdf"), "%PDF");
    // `git add -A` (what a runtime commit does) leaves the upload out.
    git(repo, "add", "-A");
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("keeps an existing exclude file's lines and adds a newline before its own", async () => {
    writeFileSync(join(repo, ".git", "info", "exclude"), "# local\n*.log");
    await excludePromptUploads(repo, WORK_PROMPT_UPLOADS_DIR);
    expect(exclude()).toBe("# local\n*.log\n/.ocw/uploads/\n");
  });

  it("a linked worktree writes the common git dir's exclude, and its uploads stay out of its commits", async () => {
    const wt = join(dir, "wt");
    git(repo, "worktree", "add", "-q", "-b", "session", wt);
    expect(await excludePromptUploads(wt, WORK_PROMPT_UPLOADS_DIR)).toBe(true);
    expect(lines(exclude(), "/.ocw/uploads/")).toBe(1);
    expect(existsSync(join(wt, ".gitignore"))).toBe(true);
    expect(readFileSync(join(wt, ".gitignore"), "utf8")).toBe("node_modules/\n");
    mkdirSync(join(wt, ".ocw", "uploads"), { recursive: true });
    writeFileSync(join(wt, ".ocw", "uploads", "notes.md"), "# notes\n");
    expect(git(wt, "status", "--porcelain")).toBe("");
    // Again from the main tree: still one line.
    await excludePromptUploads(repo, WORK_PROMPT_UPLOADS_DIR);
    expect(lines(exclude(), "/.ocw/uploads/")).toBe(1);
  });

  it("a project in a subfolder of the repository excludes its own uploads folder", async () => {
    const sub = join(repo, "apps", "web");
    mkdirSync(sub, { recursive: true });
    await excludePromptUploads(sub, WORK_PROMPT_UPLOADS_DIR);
    expect(lines(exclude(), "/apps/web/.ocw/uploads/")).toBe(1);
    mkdirSync(join(sub, ".ocw", "uploads"), { recursive: true });
    writeFileSync(join(sub, ".ocw", "uploads", "a.csv"), "1,2\n");
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("a project without git: nothing is written", async () => {
    const plain = join(dir, "plain");
    mkdirSync(plain);
    expect(await excludePromptUploads(plain, WORK_PROMPT_UPLOADS_DIR)).toBe(false);
    expect(existsSync(join(plain, ".git"))).toBe(false);
  });
});
