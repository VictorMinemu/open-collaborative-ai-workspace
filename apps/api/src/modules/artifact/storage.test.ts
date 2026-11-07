import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEnvFileSecretStore } from "../../lib/secret-store";
import { createObjectStorage, type ObjectStorage } from "./storage";

/**
 * WR-05 (07.15 review): `rangeGet` asks for `bytes=0-<n-1>` but never trusts the store to honour it. ADR-0015 allows
 * any S3-compatible store, and one (or a proxy in front of it) that ignores `Range` answers 200 with the whole object;
 * the API must still read at most `n` bytes and stop the transfer, never buffer the object.
 */

const OBJECT_BYTES = 64 * 1024 * 1024;
const CHUNK = Buffer.alloc(64 * 1024, 0x61);

type Mode = "ignore-range" | "honour-range";
let mode: Mode = "ignore-range";
/** What the fake store saw and sent for the last request. */
let last: { range: string | undefined; sent: number; finished: boolean; closed: Promise<void> } | undefined;

/** Streams `total` bytes with backpressure and records how many were written before the client hung up. */
function sendBody(res: ServerResponse, total: number, record: NonNullable<typeof last>): void {
  let left = total;
  const pump = () => {
    while (left > 0) {
      const piece = left >= CHUNK.length ? CHUNK : CHUNK.subarray(0, left);
      left -= piece.length;
      record.sent += piece.length;
      if (!res.write(piece)) {
        res.once("drain", pump);
        return;
      }
    }
    res.end(() => {
      record.finished = true;
    });
  };
  pump();
}

function handler(req: IncomingMessage, res: ServerResponse): void {
  let close: () => void = () => undefined;
  const record = {
    range: req.headers.range,
    sent: 0,
    finished: false,
    closed: new Promise<void>((resolve) => {
      close = resolve;
    }),
  };
  last = record;
  res.once("close", () => close());
  if (mode === "honour-range") {
    const end = Number(/^bytes=0-(\d+)$/u.exec(req.headers.range ?? "")?.[1] ?? OBJECT_BYTES - 1);
    const size = Math.min(end + 1, OBJECT_BYTES);
    res.writeHead(206, {
      "content-type": "application/octet-stream",
      "content-length": String(size),
      "content-range": `bytes 0-${size - 1}/${OBJECT_BYTES}`,
    });
    sendBody(res, size, record);
    return;
  }
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(OBJECT_BYTES) });
  sendBody(res, OBJECT_BYTES, record);
}

let server: Server;
let storage: ObjectStorage;

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const store = createObjectStorage(
    {
      OCW_S3_ENDPOINT: endpoint,
      OCW_S3_PUBLIC_URL: endpoint,
      OCW_S3_BUCKET: "ocw-attachments",
      OCW_S3_REGION: "garage",
      OCW_S3_ACCESS_KEY_ID: "GKtest",
    },
    createEnvFileSecretStore({ OCW_S3_SECRET_ACCESS_KEY: "test-secret" }),
  );
  if (!store) throw new Error("storage not configured");
  storage = store;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("ObjectStorage.rangeGet (WR-05)", () => {
  it("against a store that ignores Range: at most the bytes asked for, and the transfer is cut", async () => {
    mode = "ignore-range";
    const rss = process.memoryUsage.rss();
    const bytes = await storage.rangeGet("org/o/conv/c/att/a/original", 262_144);
    expect(bytes.length).toBe(262_144);
    expect(bytes.every((b) => b === 0x61)).toBe(true);
    expect(last?.range).toBe("bytes=0-262143");
    await last?.closed;
    expect(last?.finished).toBe(false);
    expect(last?.sent ?? 0).toBeLessThan(OBJECT_BYTES);
    // Never the 64 MiB object in this process.
    expect((process.memoryUsage.rss() - rss) / 1024 / 1024).toBeLessThan(48);
  });

  it("against a store that honours Range: exactly the range", async () => {
    mode = "honour-range";
    const bytes = await storage.rangeGet("org/o/conv/c/att/a/original", 1000);
    expect(bytes.length).toBe(1000);
    expect(last?.range).toBe("bytes=0-999");
  });
});
