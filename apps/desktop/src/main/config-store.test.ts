import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigStore, type TokenCipher } from "./config-store";

// Reversible stand-in for safeStorage; the point is that the plaintext never hits the disk.
const cipher: TokenCipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(`enc:${Buffer.from(s).toString("hex")}`),
  decrypt: (b) => Buffer.from(b.toString().slice(4), "hex").toString(),
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocw-cfg-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ConfigStore", () => {
  it("stores the token encrypted only, mode 0600, and round-trips it", async () => {
    const store = new ConfigStore(dir, cipher);
    await store.load();
    expect(store.paired).toBe(false);
    await store.setDevice({
      deviceId: "d1",
      organizationId: "o1",
      deviceName: "Mac",
      token: "ocwdt_supersecret",
    });
    const raw = readFileSync(store.file, "utf8");
    expect(raw).not.toContain("ocwdt_supersecret");
    expect(statSync(store.file).mode & 0o777).toBe(0o600);

    const again = new ConfigStore(dir, cipher);
    await again.load();
    expect(again.paired).toBe(true);
    expect(again.token()).toBe("ocwdt_supersecret");
  });

  it("refuses to store a token without secure storage", async () => {
    const store = new ConfigStore(dir, { ...cipher, isAvailable: () => false });
    await expect(
      store.setDevice({ deviceId: "d", organizationId: null, deviceName: "m", token: "t".repeat(20) }),
    ).rejects.toThrow(/Secure storage/);
  });

  it("unpair forgets the token but keeps the server URL", async () => {
    const store = new ConfigStore(dir, cipher);
    await store.update({ webUrl: "http://localhost:3000" });
    await store.setDevice({ deviceId: "d", organizationId: null, deviceName: "m", token: "t".repeat(20) });
    await store.unpair();
    expect(store.paired).toBe(false);
    expect(store.token()).toBeNull();
    expect(store.config.webUrl).toBe("http://localhost:3000");
  });

  it("keeps the AppImage's last file name (a plain name only) across a reload (07.13.1, Pitfall 6)", async () => {
    const store = new ConfigStore(dir, cipher);
    await store.load();
    expect(store.config.lastAppImageName).toBeUndefined();
    await store.update({ webUrl: "http://localhost:3000" });
    await store.update({ lastAppImageName: "OCW-v0.5.2-linux-x86_64.AppImage" });
    const again = new ConfigStore(dir, cipher);
    await again.load();
    expect(again.config.lastAppImageName).toBe("OCW-v0.5.2-linux-x86_64.AppImage");

    // A path, or a name over 255 characters, is refused: the previous value stays.
    for (const bad of ["/home/me/OCW.AppImage", "..\\OCW.AppImage", "a/b", "x".repeat(256), ""]) {
      await again.update({ lastAppImageName: bad });
      expect(again.config.lastAppImageName, bad).toBe("OCW-v0.5.2-linux-x86_64.AppImage");
    }
    const third = new ConfigStore(dir, cipher);
    await third.load();
    expect(third.config.lastAppImageName).toBe("OCW-v0.5.2-linux-x86_64.AppImage");
  });

  it("a stored AppImage name with a path is dropped on load, never the rest of the settings", async () => {
    const store = new ConfigStore(dir, cipher);
    await store.update({ webUrl: "http://localhost:3000" });
    const { writeFileSync } = await import("node:fs");
    const raw = JSON.parse(readFileSync(store.file, "utf8")) as Record<string, unknown>;
    writeFileSync(store.file, JSON.stringify({ ...raw, lastAppImageName: "/opt/OCW.AppImage" }));
    await store.load();
    expect(store.config.lastAppImageName).toBeUndefined();
    expect(store.config.webUrl).toBe("http://localhost:3000");
  });

  it("survives a corrupt file", async () => {
    const store = new ConfigStore(dir, cipher);
    await store.update({ webUrl: "x" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(store.file, "{nope");
    await store.load();
    expect(store.config.webUrl).toBeNull();
  });
});
