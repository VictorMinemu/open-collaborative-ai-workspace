import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CliHome,
  deviceEnv,
  type FakeRegistry,
  installRoot,
  makeCliHome,
  registryPath,
  startFakeRegistry,
} from "./runtime-updates";

const CLAUDE = "@anthropic-ai/claude-code";
const CODEX = "@openai/codex";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function registry(): Promise<FakeRegistry> {
  const r = await startFakeRegistry();
  cleanups.push(() => r.stop());
  return r;
}

function home(): CliHome {
  const h = makeCliHome({ claude: "2.1.290", codex: "0.164.0" });
  cleanups.push(() => h.remove());
  return h;
}

const portOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

describe("startFakeRegistry (07.11-09)", () => {
  it("answers a package's dist-tag with the version set by setLatest, as the daemon asks for it", async () => {
    const r = await registry();
    expect(r.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    r.setLatest(CLAUDE, "latest", "2.1.290");
    expect(registryPath(CLAUDE, "latest")).toBe("/@anthropic-ai%2Fclaude-code/latest");

    const first = await fetch(`${r.url}/@anthropic-ai%2Fclaude-code/latest`);
    expect(first.status).toBe(200);
    expect(((await first.json()) as { version: string }).version).toBe("2.1.290");

    r.setLatest(CLAUDE, "latest", "2.1.300");
    const second = await fetch(`${r.url}/@anthropic-ai%2Fclaude-code/latest`);
    expect(((await second.json()) as { version: string }).version).toBe("2.1.300");

    expect((await fetch(`${r.url}/@anthropic-ai%2Fclaude-code/stable`)).status).toBe(404);
    expect((await fetch(`${r.url}/@openai%2Fcodex/latest`)).status).toBe(404);
  });

  it("records every request by path and filters them by prefix", async () => {
    const r = await registry();
    r.setLatest(CODEX, "latest", "0.165.0");
    await fetch(`${r.url}/@anthropic-ai%2Fclaude-code/latest`);
    await fetch(`${r.url}/@openai%2Fcodex/latest`);
    await fetch(`${r.url}/@openai%2Fcodex/latest`);
    expect(r.requests().map((q) => q.path)).toEqual([
      "/@anthropic-ai%2Fclaude-code/latest",
      "/@openai%2Fcodex/latest",
      "/@openai%2Fcodex/latest",
    ]);
    expect(r.requests("/@openai")).toHaveLength(2);
    expect(r.requests("/nothing")).toEqual([]);
  });

  it("frees its port on stop()", async () => {
    const r = await startFakeRegistry();
    const port = Number(new URL(r.url).port);
    expect(await portOpen(port)).toBe(true);
    await r.stop();
    expect(await portOpen(port)).toBe(false);
  });
});

describe("makeCliHome (07.11-09, PD-19)", () => {
  it("builds a native Claude Code and a standalone Codex from the fake, both inside the scratch home", () => {
    const h = home();
    expect(h.version("claude-code")).toBe("2.1.290 (Claude Code)");
    expect(h.version("codex")).toBe("codex-cli 0.164.0");
    expect(existsSync(join(h.home, ".local", "share", "claude", "versions", "2.1.290"))).toBe(true);
    expect(existsSync(join(h.home, ".codex", "packages", "standalone", "releases", "0.164.0-fake"))).toBe(
      true,
    );
    expect(installRoot(h.home, "claude-code").startsWith(h.home)).toBe(true);
    expect(installRoot(h.home, "codex").startsWith(h.home)).toBe(true);
  });

  it("writes fake-update.json in the runtime's install root and remove() deletes the home", () => {
    const h = makeCliHome({ claude: "2.1.290", codex: "0.164.0" });
    h.setNextUpdate("claude-code", { next: "2.1.300", delayMs: 10 });
    h.setNextUpdate("codex", { next: "0.165.0" });
    expect(existsSync(join(installRoot(h.home, "claude-code"), "fake-update.json"))).toBe(true);
    expect(existsSync(join(installRoot(h.home, "codex"), "fake-update.json"))).toBe(true);
    h.remove();
    expect(existsSync(h.home)).toBe(false);
  });
});

describe("deviceEnv (07.11-09, PD-19)", () => {
  it("points the daemon at the scratch home, the scratch bin first, the fake registry and fake-CLI mode", () => {
    const h = home();
    const env = deviceEnv(h.home, { url: "http://127.0.0.1:9" });
    expect(env.HOME).toBe(h.home);
    expect(env.CODEX_HOME).toBe(join(h.home, ".codex"));
    const path = env.PATH.split(":");
    expect(path[0]).toBe(join(h.home, ".local", "bin"));
    expect(path).toContain(dirname(process.execPath));
    expect(env.PATH.endsWith("/usr/bin:/bin")).toBe(true);
    expect(env.OCW_RUNTIME_REGISTRY_URL).toBe("http://127.0.0.1:9");
    expect(env.OCW_RUNTIME_FAKE_CLI).toBe("1");
    expect(env.OCW_RUNTIME_UPDATES).toBe("automatic");
    expect(JSON.stringify(env)).not.toContain("registry.npmjs.org");
  });
});
