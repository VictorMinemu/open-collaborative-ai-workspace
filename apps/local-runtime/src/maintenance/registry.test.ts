// Phase 07.11 (D-07, D-12, PD-10): the registry client against a local HTTP stub. No test reaches the real npm
// registry (PD-19): every client is pointed at the stub through `OCW_RUNTIME_REGISTRY_URL`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { channelFor, DEFAULT_REGISTRY_URL, RegistryClient } from "./registry.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let base: string;
let requests: string[];
let handler: Handler;

beforeEach(async () => {
  requests = [];
  handler = (_req, res) => {
    res.writeHead(404).end();
  };
  server = createServer((req, res) => {
    requests.push(req.url ?? "");
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function json(body: unknown, status = 200): Handler {
  return (_req, res) => {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  };
}

describe("RegistryClient (Phase 07.11, PD-10)", () => {
  it("asks the stub for the package's dist-tag and returns its version", async () => {
    handler = json({ name: "@anthropic-ai/claude-code", version: "2.1.300" });
    const client = new RegistryClient({ env: { OCW_RUNTIME_REGISTRY_URL: base } });
    await expect(client.latest("claude-code", "latest")).resolves.toBe("2.1.300");
    expect(requests).toEqual(["/@anthropic-ai%2Fclaude-code/latest"]);
  });

  it("asks the stable dist-tag for an install on the stable channel, and Codex's own package", async () => {
    handler = (req, res) => {
      const version = req.url?.endsWith("/stable") ? "2.1.308" : "0.165.0";
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ version }));
    };
    const client = new RegistryClient({ env: { OCW_RUNTIME_REGISTRY_URL: `${base}/` } });
    await expect(client.latest("claude-code", "stable")).resolves.toBe("2.1.308");
    await expect(client.latest("codex", "latest")).resolves.toBe("0.165.0");
    expect(requests).toEqual(["/@anthropic-ai%2Fclaude-code/stable", "/@openai%2Fcodex/latest"]);
  });

  it("caches an answer for an hour per package and tag, then asks again", async () => {
    handler = json({ version: "2.1.300" });
    let now = 1_000_000;
    const client = new RegistryClient({ env: { OCW_RUNTIME_REGISTRY_URL: base }, now: () => now });
    await client.latest("claude-code", "latest");
    now += 59 * 60 * 1000;
    await expect(client.latest("claude-code", "latest")).resolves.toBe("2.1.300");
    expect(requests).toHaveLength(1);
    await client.latest("claude-code", "stable");
    expect(requests).toHaveLength(2);
    now += 2 * 60 * 1000;
    await client.latest("claude-code", "latest");
    expect(requests).toHaveLength(3);
  });

  it("returns null after the timeout when the registry never answers", async () => {
    handler = () => {
      // never answers
    };
    const client = new RegistryClient({ env: { OCW_RUNTIME_REGISTRY_URL: base }, timeoutMs: 200 });
    const started = Date.now();
    await expect(client.latest("claude-code", "latest")).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it.each([
    ["a 500", json({ error: "boom" }, 500)],
    ["a non-JSON body", ((_req, res) => res.writeHead(200).end("<html>")) as Handler],
    ["a version that is not a version", json({ version: "latest" })],
    ["a version with an argument in it", json({ version: "2.1.300 --force" })],
    ["a 100 KB body", json({ version: "2.1.300", pad: "x".repeat(100 * 1024) })],
    [
      "a 100 KB body without a length",
      ((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write(`{"version":"2.1.300","pad":"`);
        res.end(`${"x".repeat(100 * 1024)}"}`);
      }) as Handler,
    ],
  ])("returns null for %s and does not cache it", async (_name, bad) => {
    handler = bad;
    const client = new RegistryClient({ env: { OCW_RUNTIME_REGISTRY_URL: base } });
    await expect(client.latest("claude-code", "latest")).resolves.toBeNull();
    handler = json({ version: "2.1.300" });
    await expect(client.latest("claude-code", "latest")).resolves.toBe("2.1.300");
    expect(requests).toHaveLength(2);
  });

  it("uses the public registry when OCW_RUNTIME_REGISTRY_URL is not an http(s) URL (injected fetch, no network)", async () => {
    const urls: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ version: "2.1.300" }), { status: 200 });
    }) as typeof fetch;
    const client = new RegistryClient({ env: { OCW_RUNTIME_REGISTRY_URL: "file:///etc/passwd" }, fetchFn });
    await expect(client.latest("claude-code", "latest")).resolves.toBe("2.1.300");
    expect(urls).toEqual([`${DEFAULT_REGISTRY_URL}/@anthropic-ai%2Fclaude-code/latest`]);
  });
});

describe("channelFor (Phase 07.11, PD-10, Pitfall 6)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocw-channel-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function settings(content: string): void {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), content);
  }

  it("Homebrew `claude-code` follows stable, `claude-code@latest` follows latest", () => {
    expect(
      channelFor({ runtime: "claude-code", method: "homebrew_cask", brewName: "claude-code" }, home),
    ).toBe("stable");
    expect(
      channelFor({ runtime: "claude-code", method: "homebrew_cask", brewName: "claude-code@latest" }, home),
    ).toBe("latest");
  });

  it("native Claude follows `autoUpdatesChannel` from ~/.claude/settings.json, else latest", () => {
    expect(channelFor({ runtime: "claude-code", method: "native" }, home)).toBe("latest");
    settings(JSON.stringify({ autoUpdatesChannel: "stable" }));
    expect(channelFor({ runtime: "claude-code", method: "native" }, home)).toBe("stable");
    settings(JSON.stringify({ autoUpdatesChannel: "latest" }));
    expect(channelFor({ runtime: "claude-code", method: "native" }, home)).toBe("latest");
    settings("{ not json");
    expect(channelFor({ runtime: "claude-code", method: "native" }, home)).toBe("latest");
  });

  it("npm installs and Codex always follow latest", () => {
    settings(JSON.stringify({ autoUpdatesChannel: "stable" }));
    expect(channelFor({ runtime: "claude-code", method: "npm" }, home)).toBe("latest");
    expect(channelFor({ runtime: "codex", method: "codex_standalone" }, home)).toBe("latest");
    expect(channelFor({ runtime: "codex", method: "homebrew_cask", brewName: "codex" }, home)).toBe("latest");
  });
});
