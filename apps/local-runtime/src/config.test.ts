import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fullAccessOptIn,
  loadConfig,
  resolveFullAccess,
  resolveRuntimeUpdates,
  setFullAccessOptIn,
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
});
