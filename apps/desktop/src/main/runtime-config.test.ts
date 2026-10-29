import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readDaemonFullAccess,
  readDaemonRuntimeUpdates,
  writeDaemonFullAccess,
  writeDaemonRuntimeUpdates,
} from "./runtime-config";

const dirs: string[] = [];
function home(): string {
  const d = mkdtempSync(join(tmpdir(), "ocw-desktop-rc-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("daemon runtime.json Full access opt-in (ADR-0012, P-12)", () => {
  it("is off when the file or the key is missing", async () => {
    const h = home();
    expect(await readDaemonFullAccess(h)).toBe(false);
    writeFileSync(join(h, "runtime.json"), JSON.stringify({ serverUrl: "https://ocw.example.com" }));
    expect(await readDaemonFullAccess(h)).toBe(false);
  });

  it("creates the file (0600) when missing and reads it back", async () => {
    const h = join(home(), "nested-ocw-home");
    await writeDaemonFullAccess(h, true);
    const file = join(h, "runtime.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ fullAccess: { optIn: true } });
    expect(await readDaemonFullAccess(h)).toBe(true);
  });

  it("updates fullAccess.optIn atomically and keeps every other key", async () => {
    const h = home();
    writeFileSync(
      join(h, "runtime.json"),
      JSON.stringify({
        serverUrl: "https://ocw.example.com",
        deviceName: "Mac",
        fullAccess: { optIn: true },
      }),
      { mode: 0o644 },
    );
    await writeDaemonFullAccess(h, false);
    const file = join(h, "runtime.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      serverUrl: "https://ocw.example.com",
      deviceName: "Mac",
      fullAccess: { optIn: false },
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await readDaemonFullAccess(h)).toBe(false);
  });

  it("never overwrites a malformed file; the error is surfaced", async () => {
    const h = home();
    writeFileSync(join(h, "runtime.json"), "{ broken");
    await expect(writeDaemonFullAccess(h, true)).rejects.toThrow(/runtime\.json/);
    await expect(readDaemonFullAccess(h)).rejects.toThrow(/runtime\.json/);
    expect(readFileSync(join(h, "runtime.json"), "utf8")).toBe("{ broken");
  });
});

describe("daemon runtime.json runtime updates level (07.11, D-02)", () => {
  it("is automatic when the file or the key is missing (and for a value this app does not know)", async () => {
    const h = home();
    expect(await readDaemonRuntimeUpdates(h)).toBe("automatic");
    writeFileSync(join(h, "runtime.json"), JSON.stringify({ fullAccess: { optIn: true } }));
    expect(await readDaemonRuntimeUpdates(h)).toBe("automatic");
    writeFileSync(join(h, "runtime.json"), JSON.stringify({ runtimeUpdates: { level: "sometimes" } }));
    expect(await readDaemonRuntimeUpdates(h)).toBe("automatic");
  });

  it("writes runtimeUpdates.level atomically (0600), keeping fullAccess and every other key", async () => {
    const h = home();
    writeFileSync(
      join(h, "runtime.json"),
      JSON.stringify({ serverUrl: "https://ocw.example.com", fullAccess: { optIn: true } }),
      { mode: 0o644 },
    );
    await writeDaemonRuntimeUpdates(h, "off");
    const file = join(h, "runtime.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      serverUrl: "https://ocw.example.com",
      fullAccess: { optIn: true },
      runtimeUpdates: { level: "off" },
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await readDaemonRuntimeUpdates(h)).toBe("off");
    // And the Full access writer keeps the level.
    await writeDaemonFullAccess(h, false);
    expect(await readDaemonRuntimeUpdates(h)).toBe("off");
    expect(await readDaemonFullAccess(h)).toBe(false);
  });

  it("creates the file when missing; never overwrites a malformed one; refuses an unknown level", async () => {
    const h = join(home(), "nested-ocw-home");
    await writeDaemonRuntimeUpdates(h, "notify");
    expect(JSON.parse(readFileSync(join(h, "runtime.json"), "utf8"))).toEqual({
      runtimeUpdates: { level: "notify" },
    });
    await expect(writeDaemonRuntimeUpdates(h, "always" as never)).rejects.toThrow();
    expect(await readDaemonRuntimeUpdates(h)).toBe("notify");
    const broken = home();
    writeFileSync(join(broken, "runtime.json"), "{ broken");
    await expect(writeDaemonRuntimeUpdates(broken, "off")).rejects.toThrow(/runtime\.json/);
    expect(readFileSync(join(broken, "runtime.json"), "utf8")).toBe("{ broken");
  });
});
