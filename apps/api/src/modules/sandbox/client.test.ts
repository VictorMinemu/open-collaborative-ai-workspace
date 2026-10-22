import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSandboxdClient, SandboxdUnavailableError } from "./client";

/**
 * The client's transport (07.8-24, WINDOWS #259). A package install may take up to 600 s at sandboxd; Node's global
 * fetch (undici) gives up on any answer whose headers take longer than 300 s, whatever the call's own deadline. The
 * client therefore uses its own dispatcher: each call's deadline (`timeoutMs`, AbortSignal) is the only limit. The
 * transport timeout is a test knob here, so the mechanism is proven in milliseconds instead of minutes.
 */
const TOKEN = "t".repeat(40);
const INFO = {
  version: "0.1.0",
  namespace: "ocw-test",
  dockerVersion: "29.8.2",
  dockerOk: true,
  runtimes: ["runc"],
  runtime: "hardened-runc",
  browserSandbox: null,
};

let server: Server;
let url = "";
let delayMs = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(req.headers.authorization === `Bearer ${TOKEN}` ? 200 : 401, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify(INFO));
    }, delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("sandboxd client transport (#259)", () => {
  it("a transport header timeout shorter than the answer fails the call even within its own deadline", async () => {
    // undici's transport timers tick about every 500 ms: the answer comes well after the knob's 200 ms.
    delayMs = 2_500;
    const client = createSandboxdClient({ url, token: TOKEN, transportTimeoutMs: 200 });
    await expect(client.call("info", {}, { timeoutMs: 10_000 })).rejects.toBeInstanceOf(
      SandboxdUnavailableError,
    );
  });

  it("by default only the call's deadline limits it: a slow answer inside the deadline arrives", async () => {
    delayMs = 2_500;
    const client = createSandboxdClient({ url, token: TOKEN });
    const info = await client.call("info", {}, { timeoutMs: 10_000 });
    expect(info.dockerVersion).toBe("29.8.2");
  });

  it("and the call's deadline still ends a call that takes longer", async () => {
    delayMs = 600;
    const client = createSandboxdClient({ url, token: TOKEN });
    await expect(client.call("info", {}, { timeoutMs: 150 })).rejects.toBeInstanceOf(
      SandboxdUnavailableError,
    );
  });
});
