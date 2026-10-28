// Phase 07.11 (D-07, D-12, PD-10): the registry client against a local HTTP stub. No test reaches the real npm
// registry (PD-19): every client is pointed at the stub through `OCW_RUNTIME_REGISTRY_URL`.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RegistryClient } from "./registry.js";

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
});
