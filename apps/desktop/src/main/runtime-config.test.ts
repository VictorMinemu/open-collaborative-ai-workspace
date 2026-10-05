import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDaemonFullAccess, writeDaemonFullAccess } from "./runtime-config";

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
