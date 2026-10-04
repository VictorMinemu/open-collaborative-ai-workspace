import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlError, controlRequest } from "./control-client";

let dir: string;
let sock: string;
let server: Server | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocw-ctl-"));
  sock = join(dir, "runtime.sock");
});
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

function serve(handler: (req: Record<string, unknown>) => string | null): Promise<void> {
  server = createServer((s) => {
    s.setEncoding("utf8");
    let buf = "";
    s.on("data", (c: string) => {
      buf += c;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      const reply = handler(JSON.parse(buf.slice(0, i)) as Record<string, unknown>);
      if (reply !== null) s.write(reply);
    });
  });
  return new Promise((r) => server!.listen(sock, () => r()));
}

describe("controlRequest", () => {
  it("sends a JSON line with an id and resolves the result", async () => {
    let seen: Record<string, unknown> = {};
    await serve((req) => {
      seen = req;
      return `${JSON.stringify({ id: req.id, ok: true, result: { paired: true, connected: false } })}\n`;
    });
    await expect(controlRequest(sock, { cmd: "status" })).resolves.toEqual({
      paired: true,
      connected: false,
    });
    expect(seen.cmd).toBe("status");
    expect(typeof seen.id).toBe("number");
  });

  it("rejects with the daemon's error message", async () => {
    await serve((req) => `${JSON.stringify({ id: req.id, ok: false, error: "path does not exist" })}\n`);
    await expect(controlRequest(sock, { cmd: "addProject", path: "/nope" })).rejects.toThrow(
      "path does not exist",
    );
  });

  it("reports a missing daemon clearly", async () => {
    await expect(controlRequest(sock, { cmd: "status" })).rejects.toThrow("runtime is not running");
  });

  it("times out on a silent daemon", async () => {
    await serve(() => null);
    await expect(controlRequest(sock, { cmd: "status" }, 100)).rejects.toBeInstanceOf(ControlError);
  });

  it("rejects malformed responses", async () => {
    await serve(() => "not json\n");
    await expect(controlRequest(sock, { cmd: "listProjects" })).rejects.toThrow("malformed");
  });
});
