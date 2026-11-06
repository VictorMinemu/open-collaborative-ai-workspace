import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fullAccessOptIn,
  loadConfig,
  ProjectRegistry,
  resolveFullAccess,
  resolveRuntimeUpdates,
  setFullAccessOptIn,
  setRuntimeUpdatesLevel,
} from "./config.js";

const dirs: string[] = [];
function home(): string {
  const d = mkdtempSync(join(tmpdir(), "ocw-cfg-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Full access opt-in (ADR-0012, D-02, P-12)", () => {
  it("is off when runtime.json has no fullAccess key (or no file at all)", async () => {
    const h = home();
    expect((await loadConfig(h, {})).fullAccess).toEqual({ optIn: false });
    writeFileSync(join(h, "runtime.json"), JSON.stringify({ serverUrl: "https://ocw.example.com" }));
    const config = await loadConfig(h, {});
    expect(config.fullAccess.optIn).toBe(false);
    expect(fullAccessOptIn(config, {})).toBe(false);
  });

  it("OCW_ALLOW_FULL_ACCESS wins over the file in both directions", async () => {
    const h = home();
    writeFileSync(join(h, "runtime.json"), JSON.stringify({ fullAccess: { optIn: true } }));
    const on = await loadConfig(h, {});
    expect(resolveFullAccess(on, {})).toEqual({ optIn: true, source: "config" });
    expect(resolveFullAccess(on, { OCW_ALLOW_FULL_ACCESS: "0" })).toEqual({ optIn: false, source: "env" });
    expect(fullAccessOptIn(on, { OCW_ALLOW_FULL_ACCESS: "false" })).toBe(false);
    const off = await loadConfig(home(), {});
    expect(resolveFullAccess(off, { OCW_ALLOW_FULL_ACCESS: "1" })).toEqual({ optIn: true, source: "env" });
    expect(fullAccessOptIn(off, { OCW_ALLOW_FULL_ACCESS: "true" })).toBe(true);
    // Anything else is not a decision: the file decides.
    expect(resolveFullAccess(off, { OCW_ALLOW_FULL_ACCESS: "yes" })).toEqual({
      optIn: false,
      source: "config",
    });
  });

  it("setFullAccessOptIn writes fullAccess.optIn atomically with mode 0600 and keeps the other keys", async () => {
    const h = home();
    writeFileSync(
      join(h, "runtime.json"),
      JSON.stringify({
        serverUrl: "https://ocw.example.com",
        logLevel: "debug",
        fullAccess: { optIn: false },
      }),
    );
    await setFullAccessOptIn(h, true);
    const file = join(h, "runtime.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      serverUrl: "https://ocw.example.com",
      logLevel: "debug",
      fullAccess: { optIn: true },
    });
    expect((await loadConfig(h, {})).fullAccess.optIn).toBe(true);
    await setFullAccessOptIn(h, false);
    expect((await loadConfig(h, {})).fullAccess.optIn).toBe(false);
  });

  it("creates runtime.json when missing and refuses to overwrite a malformed one", async () => {
    const h = home();
    await setFullAccessOptIn(h, true);
    expect(JSON.parse(readFileSync(join(h, "runtime.json"), "utf8"))).toEqual({
      fullAccess: { optIn: true },
    });
    const broken = home();
    writeFileSync(join(broken, "runtime.json"), "{ not json");
    await expect(setFullAccessOptIn(broken, true)).rejects.toThrow(/runtime\.json/);
    expect(readFileSync(join(broken, "runtime.json"), "utf8")).toBe("{ not json");
  });
});

describe("Runtime updates level on this device (07.11, D-02)", () => {
  it("defaults to automatic from runtime.json (no file, or no key)", async () => {
    const h = home();
    const config = await loadConfig(h, {});
    expect(config.runtimeUpdates).toEqual({ level: "automatic" });
    expect(resolveRuntimeUpdates(config, {})).toEqual({ level: "automatic", source: "config" });
  });

  it("reads runtimeUpdates.level from the file", async () => {
    const h = home();
    writeFileSync(join(h, "runtime.json"), JSON.stringify({ runtimeUpdates: { level: "notify" } }));
    expect(resolveRuntimeUpdates(await loadConfig(h, {}), {})).toEqual({ level: "notify", source: "config" });
  });

  it("OCW_RUNTIME_UPDATES wins over the file; an invalid value is ignored", async () => {
    const h = home();
    writeFileSync(join(h, "runtime.json"), JSON.stringify({ runtimeUpdates: { level: "automatic" } }));
    const config = await loadConfig(h, {});
    expect(resolveRuntimeUpdates(config, { OCW_RUNTIME_UPDATES: "off" })).toEqual({
      level: "off",
      source: "env",
    });
    expect(resolveRuntimeUpdates(config, { OCW_RUNTIME_UPDATES: " Notify " })).toEqual({
      level: "notify",
      source: "env",
    });
    expect(resolveRuntimeUpdates(config, { OCW_RUNTIME_UPDATES: "sometimes" })).toEqual({
      level: "automatic",
      source: "config",
    });
  });

  it("an unknown level in the file is refused like any other invalid key", async () => {
    const h = home();
    writeFileSync(join(h, "runtime.json"), JSON.stringify({ runtimeUpdates: { level: "always" } }));
    await expect(loadConfig(h, {})).rejects.toThrow();
  });

  it("setRuntimeUpdatesLevel writes runtimeUpdates.level atomically with mode 0600 and keeps every other key", async () => {
    const h = home();
    writeFileSync(
      join(h, "runtime.json"),
      JSON.stringify({
        serverUrl: "https://ocw.example.com",
        fullAccess: { optIn: true },
        runtimeUpdates: { level: "automatic" },
      }),
    );
    await setRuntimeUpdatesLevel(h, "notify");
    const file = join(h, "runtime.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      serverUrl: "https://ocw.example.com",
      fullAccess: { optIn: true },
      runtimeUpdates: { level: "notify" },
    });
    const config = await loadConfig(h, {});
    expect(resolveRuntimeUpdates(config, {})).toEqual({ level: "notify", source: "config" });
    expect(config.fullAccess.optIn).toBe(true);
    await setRuntimeUpdatesLevel(h, "off");
    expect(resolveRuntimeUpdates(await loadConfig(h, {}), {})).toEqual({ level: "off", source: "config" });
    // Full access written afterwards keeps the level too (one shared writer).
    await setFullAccessOptIn(h, false);
    expect(JSON.parse(readFileSync(file, "utf8")).runtimeUpdates).toEqual({ level: "off" });
  });

  it("setRuntimeUpdatesLevel creates runtime.json when missing, refuses a malformed one and an unknown level", async () => {
    const h = home();
    await setRuntimeUpdatesLevel(h, "off");
    expect(JSON.parse(readFileSync(join(h, "runtime.json"), "utf8"))).toEqual({
      runtimeUpdates: { level: "off" },
    });
    const broken = home();
    writeFileSync(join(broken, "runtime.json"), "{ not json");
    await expect(setRuntimeUpdatesLevel(broken, "notify")).rejects.toThrow(/runtime\.json/);
    expect(readFileSync(join(broken, "runtime.json"), "utf8")).toBe("{ not json");
    const list = home();
    writeFileSync(join(list, "runtime.json"), "[]");
    await expect(setRuntimeUpdatesLevel(list, "notify")).rejects.toThrow(
      "cannot update runtime.json: it is not a JSON object",
    );
    await expect(setRuntimeUpdatesLevel(h, "sometimes" as never)).rejects.toThrow();
    expect(JSON.parse(readFileSync(join(h, "runtime.json"), "utf8"))).toEqual({
      runtimeUpdates: { level: "off" },
    });
  });
});

describe("pairing records in runtime.json (07.12, D-06, PD-09)", () => {
  it("loads a runtime.json written before 07.12 unchanged (no deviceId, webUrl or pairedWith)", async () => {
    const h = home();
    writeFileSync(
      join(h, "runtime.json"),
      JSON.stringify({ serverUrl: "https://ocw.example.com", deviceName: "build-01" }),
    );
    const config = await loadConfig(h, {});
    expect(config.serverUrl).toBe("https://ocw.example.com");
    expect(config.deviceName).toBe("build-01");
    expect(config.deviceId).toBeUndefined();
    expect(config.webUrl).toBeUndefined();
    expect(config.pairedWith).toBeUndefined();
  });

  it("keeps deviceId, webUrl and pairedWith when pairing wrote them", async () => {
    const h = home();
    const pairing = {
      deviceId: "0199f0a0-0000-7000-8000-000000000001",
      webUrl: "https://ocw.example.com",
      pairedWith: { organization: "Acme", owner: "Ada Lovelace", at: "2026-10-29T10:00:00.000Z" },
    };
    writeFileSync(
      join(h, "runtime.json"),
      JSON.stringify({ serverUrl: "https://api.ocw.example.com", ...pairing }),
    );
    expect(await loadConfig(h, {})).toMatchObject(pairing);
  });

  it("refuses a webUrl that is not a URL, like any other invalid key", async () => {
    const h = home();
    writeFileSync(join(h, "runtime.json"), JSON.stringify({ webUrl: "settings/devices" }));
    await expect(loadConfig(h, {})).rejects.toThrow();
    writeFileSync(join(h, "runtime.json"), JSON.stringify({ deviceId: "build-01" }));
    await expect(loadConfig(h, {})).rejects.toThrow();
    writeFileSync(join(h, "runtime.json"), JSON.stringify({ pairedWith: { organization: "Acme" } }));
    await expect(loadConfig(h, {})).rejects.toThrow();
  });
});

describe("ProjectRegistry.resolveRef (07.12, D-07)", () => {
  /** A registry in a temp OCW home with `web` and two directories both named `api`. */
  async function registry() {
    const root = realpathSync(home());
    const ocw = join(root, "ocw");
    mkdirSync(ocw);
    for (const d of ["one/api", "two/api", "web"]) mkdirSync(join(root, d), { recursive: true });
    const reg = new ProjectRegistry(ocw);
    await reg.load();
    const api1 = await reg.add(join(root, "one", "api"));
    const api2 = await reg.add(join(root, "two", "api"));
    const web = await reg.add(join(root, "web"));
    return { root, ocw, reg, api1, api2, web };
  }

  it("finds a project by its exact localId, its directory (also through a symlink, ./ and ~/) or a unique name", async () => {
    const { root, reg, api1, api2, web } = await registry();
    expect(await reg.resolveRef(api2.localId)).toEqual(api2);
    expect(await reg.resolveRef(join(root, "one", "api"))).toEqual(api1);
    expect(await reg.resolveRef(`${join(root, "web")}/`)).toEqual(web);
    symlinkSync(join(root, "web"), join(root, "web-link"));
    expect(await reg.resolveRef(join(root, "web-link"))).toEqual(web);
    expect(await reg.resolveRef("./two/api", { cwd: root })).toEqual(api2);
    expect(await reg.resolveRef("~/one/api", { userHome: root })).toEqual(api1);
    expect(await reg.resolveRef("web")).toEqual(web);
  });

  it("still finds a project by its directory after the directory was deleted", async () => {
    const { root, reg, web } = await registry();
    rmSync(join(root, "web"), { recursive: true });
    expect(await reg.resolveRef(join(root, "web"))).toEqual(web);
  });

  it("refuses an ambiguous name listing the candidates by name and id", async () => {
    const { reg, api1, api2 } = await registry();
    await expect(reg.resolveRef("api")).rejects.toThrow(
      `ambiguous: api (${api1.localId}), api (${api2.localId}); use the id or the directory`,
    );
  });

  it("refuses a name or a directory that matches nothing, listing what is registered", async () => {
    const { root, reg, api1, web } = await registry();
    const err = (await reg.resolveRef("nope").catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('no registered project matches "nope"');
    expect(err.message).toContain(`api (${api1.localId})`);
    expect(err.message).toContain(`web (${web.localId})`);
    await expect(reg.resolveRef(join(root, "elsewhere"))).rejects.toThrow("no registered project matches");
    const empty = new ProjectRegistry(home());
    await empty.load();
    await expect(empty.resolveRef("api")).rejects.toThrow(
      'no registered project matches "api"; none are registered',
    );
  });
});

describe("ProjectRegistry: projects without git", () => {
  it("registers a folder in no repository as it is, announced with git false and no branch or path", async () => {
    const root = realpathSync(home());
    const notes = join(root, "notes");
    mkdirSync(notes);
    writeFileSync(join(notes, "todo.md"), "- one\n");
    mkdirSync(join(root, "ocw"));
    const reg = new ProjectRegistry(join(root, "ocw"));
    await reg.load();
    const p = await reg.add(notes);
    expect(p).toMatchObject({ path: notes, name: "notes", gitRemote: null, defaultBranch: null, git: false });
    expect(readdirSync(notes)).toEqual(["todo.md"]);
    expect(reg.toSynced()).toEqual([
      { localId: p.localId, name: "notes", gitRemote: null, defaultBranch: null, git: false },
    ]);
    expect(JSON.stringify(reg.toSynced())).not.toContain(root);
  });

  it("a repository is announced with git true; an entry written before the flag loads and is announced without it", async () => {
    const root = realpathSync(home());
    const repo = join(root, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    const ocw = join(root, "ocw");
    mkdirSync(ocw);
    const old = {
      localId: "lp_old",
      path: join(root, "old"),
      name: "old",
      gitRemote: null,
      defaultBranch: "main",
    };
    writeFileSync(
      join(ocw, "projects.json"),
      JSON.stringify({ projects: [{ ...old, addedAt: "2026-01-01T00:00:00.000Z" }] }),
    );
    const reg = new ProjectRegistry(ocw);
    await reg.load();
    const p = await reg.add(repo);
    expect(p).toMatchObject({ defaultBranch: "main", git: true });
    expect(reg.toSynced()).toEqual([
      { localId: "lp_old", name: "old", gitRemote: null, defaultBranch: "main" },
      { localId: p.localId, name: "repo", gitRemote: null, defaultBranch: "main", git: true },
    ]);
  });
});
