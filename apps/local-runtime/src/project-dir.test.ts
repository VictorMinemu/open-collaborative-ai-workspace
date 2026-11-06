import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertProjectDirAllowed, projectDirRefusal } from "./project-dir.js";

describe("projectDirRefusal", () => {
  const h = "/home/ada";
  it("refuses the home folder, its ancestors, system roots, OCW state and ~/Library", () => {
    expect(projectDirRefusal("/home/ada", h)).toMatch(/home folder/);
    expect(projectDirRefusal("/home/ada/", h)).toMatch(/home folder/);
    expect(projectDirRefusal("/home", h)).toMatch(/contains your home folder/);
    expect(projectDirRefusal("/", h)).toMatch(/contains your home folder/);
    for (const p of ["/usr", "/etc", "/opt", "/var", "/tmp", "/srv", "/mnt", "/System"]) {
      expect(projectDirRefusal(p, h)).not.toBeNull();
    }
    expect(projectDirRefusal("/home/ada/.ocw", h, ["/home/ada/.ocw"])).toMatch(/OCW/);
    expect(projectDirRefusal("/home/ada/.ocw/x", h, ["/home/ada/.ocw"])).toMatch(/OCW/);
    expect(projectDirRefusal("/home/ada/Library/Caches", h)).toMatch(/Library/);
  });

  it("accepts ordinary project folders", () => {
    expect(projectDirRefusal("/home/ada/code/app", h)).toBeNull();
    expect(projectDirRefusal("/srv/projects/app", h)).toBeNull();
    expect(projectDirRefusal("/home/adam/app", h)).toBeNull();
  });
});

describe("assertProjectDirAllowed (real paths)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("resolves symlinks before deciding, so a link to the home folder is refused too", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ocw-pdir-")));
    dirs.push(root);
    const userHome = join(root, "home");
    mkdirSync(join(userHome, "code"), { recursive: true });
    symlinkSync(userHome, join(root, "link"));
    await expect(assertProjectDirAllowed(join(root, "link"), { userHome })).rejects.toThrow(/home folder/);
    await expect(assertProjectDirAllowed(join(userHome, "code"), { userHome })).resolves.toBe(
      join(userHome, "code"),
    );
    await expect(assertProjectDirAllowed(join(root, "missing"), { userHome })).rejects.toThrow(
      /does not exist/,
    );
  });
});
