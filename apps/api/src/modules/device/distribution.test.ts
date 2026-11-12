import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeRuntimeDist } from "../../testing-runtime-dist";
import { RuntimeDistStore } from "./distribution";
import { DeviceHub, type DeviceHubOptions } from "./hub";

/**
 * 07.17.1-03 (PD-05, PD-15): the build the workspace serves, read from the device module's one dist store. A temp
 * directory per case; no database, no network.
 */

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ocw-runtime-served-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("RuntimeDistStore.served() (07.17.1-03, PD-05, PD-15)", () => {
  it("is null for a missing dist", async () => {
    expect(await new RuntimeDistStore(join(await tempDir(), "nothing-here")).served()).toBeNull();
  });

  it("is null for a corrupt dist (a bundle that is not the manifest's)", async () => {
    const dir = await tempDir();
    await writeRuntimeDist(dir);
    await writeFile(join(dir, "ocw-runtime.mjs"), "tampered\n");
    expect(await new RuntimeDistStore(dir).served()).toBeNull();
  });

  it("is the version and the first 12 hex of the bundle's sha256 for a verified dist, cached once verified", async () => {
    const dir = await tempDir();
    const { bundle } = await writeRuntimeDist(dir);
    const store = new RuntimeDistStore(dir);
    const build = createHash("sha256").update(bundle).digest("hex").slice(0, 12);
    expect(await store.served()).toEqual({ version: "0.3.1", build });
    // The verified dist is cached: nothing on disk is read again.
    await rm(dir, { recursive: true, force: true });
    expect(await store.served()).toEqual({ version: "0.3.1", build });
  });
});

/** The hub's other dependencies are never touched by `servedRuntime()`; the constructor only stores them. */
const hubOptions = (extra: Partial<DeviceHubOptions> = {}): DeviceHubOptions =>
  ({ db: {}, bus: {}, realtime: {}, audit: {}, log: {}, ...extra }) as unknown as DeviceHubOptions;

describe("DeviceHub.servedRuntime() (07.17.1-03, PD-15)", () => {
  it("is null without a dist source", async () => {
    expect(await new DeviceHub(hubOptions()).servedRuntime()).toBeNull();
  });

  it("is the dist source's answer", async () => {
    const served = { version: "0.3.1", build: "0123456789ab" };
    const hub = new DeviceHub(hubOptions({ runtimeDist: { served: async () => served } }));
    expect(await hub.servedRuntime()).toEqual(served);
    const none = new DeviceHub(hubOptions({ runtimeDist: { served: async () => null } }));
    expect(await none.servedRuntime()).toBeNull();
  });
});
