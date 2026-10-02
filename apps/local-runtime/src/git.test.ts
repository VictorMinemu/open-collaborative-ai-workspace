import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changedFiles, ensureSessionWorktree, repoInfo, sanitizeRemoteUrl, unifiedPatch } from "./git.js";

let repo: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

beforeAll(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "ocw-git-")));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  writeFileSync(join(repo, "gone.txt"), "bye\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  // Fake credential, assembled at runtime so secret scanners do not flag the fixture.
  const fakeToken = ["ghp", "x".repeat(36)].join("_");
  git("remote", "add", "origin", `https://bob:${fakeToken}@github.com/acme/app.git`);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("git adapter", () => {
  it("reports repo info without credentials", async () => {
    const info = await repoInfo(repo);
    expect(info).toMatchObject({
      isRepo: true,
      branch: "main",
      remote: "https://github.com/acme/app.git",
      dirty: false,
    });
    expect(info.headSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("lists changed files repo-relative with line counts", async () => {
    writeFileSync(join(repo, "a.txt"), "one\nTWO\nthree\n");
    unlinkSync(join(repo, "gone.txt"));
    writeFileSync(join(repo, "new.ts"), "export const x = 1;\nexport const y = 2;\n");
    const files = await changedFiles(repo);
    expect(files).toEqual([
      { path: "a.txt", status: "modified", additions: 2, deletions: 1 },
      { path: "gone.txt", status: "deleted", additions: 0, deletions: 1 },
      { path: "new.ts", status: "untracked", additions: 2, deletions: 0 },
    ]);
    expect((await repoInfo(repo)).dirty).toBe(true);
  });

  it("produces a unified patch including untracked files, without absolute paths", async () => {
    const { patch, truncated } = await unifiedPatch(repo);
    expect(truncated).toBe(false);
    expect(patch).toContain("diff --git a/a.txt b/a.txt");
    expect(patch).toContain("+TWO");
    expect(patch).toContain("b/new.ts");
    expect(patch).not.toContain(repo);
  });

  it("caps the patch size", async () => {
    writeFileSync(join(repo, "big.txt"), `${"x".repeat(100)}\n`.repeat(2000));
    const { patch, truncated } = await unifiedPatch(repo, 10 * 1024);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(patch)).toBeLessThan(11 * 1024);
  });

  it("creates an idempotent per-session worktree on its own branch, excluded locally", async () => {
    const wt = await ensureSessionWorktree(repo, "0190f3c2-aaaa-bbbb-cccc-123456789abc");
    expect(wt).toMatchObject({ branch: "ocw/0190f3c2aaaa", created: true });
    expect(wt.path).toBe(join(repo, ".ocw-worktrees", "0190f3c2-aaaa-bbbb-cccc-123456789abc"));
    expect(existsSync(join(wt.path, "a.txt"))).toBe(true);
    expect(git("-C", wt.path, "branch", "--show-current").trim()).toBe("ocw/0190f3c2aaaa");
    expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).toContain("/.ocw-worktrees/");
    expect((await changedFiles(repo)).some((f) => f.path.startsWith(".ocw-worktrees"))).toBe(false);
    expect((await ensureSessionWorktree(repo, "0190f3c2-aaaa-bbbb-cccc-123456789abc")).created).toBe(false);
    await expect(ensureSessionWorktree(repo, "../escape")).rejects.toThrow();
  });

  it("strips credentials from remote URLs", () => {
    expect(sanitizeRemoteUrl("https://x-access-token:abc123@github.com/a/b")).toBe("https://github.com/a/b");
    expect(sanitizeRemoteUrl("git@github.com:a/b.git")).toBe("git@github.com:a/b.git");
  });
});
