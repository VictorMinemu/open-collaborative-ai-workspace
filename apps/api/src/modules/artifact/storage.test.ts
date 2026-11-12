import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { BOT_FILE_LIMITS } from "@ocw/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEnvFileSecretStore } from "../../lib/secret-store";
import { streamServerAttachment } from "./index";
import { attachmentKey, createObjectStorage, type ObjectStorage, ObjectTooLargeError } from "./storage";

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

/**
 * 07.17.1.1-08 (D-08, PD-05, E21): `putStream` writes a body of one part or less with one `PutObject` and anything
 * larger as S3 multipart in `BOT_FILE_LIMITS.partBytes` parts, one part in memory; past `maxBytes` or on any error the
 * multipart upload is aborted. The S3 side is a stub server that speaks the four multipart calls and records them.
 */
describe("ObjectStorage.putStream (multipart, bounded)", () => {
  const MiB = 1024 * 1024;
  const PART = BOT_FILE_LIMITS.partBytes;
  type S3Call = { op: string; partNumber?: number; bytes: number; body?: string; contentType?: string };
  let calls: S3Call[] = [];
  /** A part number the stub refuses (403, which the SDK never retries), or null. */
  let failPart: number | null = null;
  let s3: Server;
  let store: ObjectStorage;

  function s3Handler(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://stub");
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const xml = (status: number, payload: string, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/xml", ...headers });
        res.end(payload);
      };
      if (req.method === "POST" && url.searchParams.has("uploads")) {
        calls.push({ op: "CreateMultipartUpload", bytes: 0, contentType: req.headers["content-type"] });
        return xml(
          200,
          "<InitiateMultipartUploadResult><Bucket>ocw-attachments</Bucket><Key>k</Key><UploadId>up-1</UploadId></InitiateMultipartUploadResult>",
        );
      }
      if (req.method === "PUT" && url.searchParams.has("partNumber")) {
        const partNumber = Number(url.searchParams.get("partNumber"));
        calls.push({ op: "UploadPart", partNumber, bytes: body.length });
        if (failPart === partNumber)
          return xml(403, "<Error><Code>AccessDenied</Code><Message>no</Message></Error>");
        return xml(200, "", { etag: `"etag-${partNumber}"` });
      }
      if (req.method === "POST" && url.searchParams.has("uploadId")) {
        calls.push({ op: "CompleteMultipartUpload", bytes: body.length, body: body.toString("utf8") });
        return xml(
          200,
          '<CompleteMultipartUploadResult><Bucket>ocw-attachments</Bucket><Key>k</Key><ETag>"done"</ETag></CompleteMultipartUploadResult>',
        );
      }
      if (req.method === "DELETE" && url.searchParams.has("uploadId")) {
        calls.push({ op: "AbortMultipartUpload", bytes: 0 });
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "PUT") {
        calls.push({ op: "PutObject", bytes: body.length, contentType: req.headers["content-type"] });
        return xml(200, "", { etag: '"one"' });
      }
      xml(400, "<Error><Code>InvalidRequest</Code><Message>unexpected</Message></Error>");
    });
  }

  /** The bytes in pieces of `chunk` bytes (an HTTP body arrives in pieces of no fixed size). */
  async function* chunked(bytes: Uint8Array, chunk = 64 * 1024): AsyncGenerator<Uint8Array> {
    for (let at = 0; at < bytes.length; at += chunk) yield bytes.subarray(at, at + chunk);
  }

  beforeAll(async () => {
    s3 = createServer(s3Handler);
    await new Promise<void>((resolve) => s3.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(s3.address() as AddressInfo).port}`;
    const built = createObjectStorage(
      {
        OCW_S3_ENDPOINT: endpoint,
        OCW_S3_PUBLIC_URL: endpoint,
        OCW_S3_BUCKET: "ocw-attachments",
        OCW_S3_REGION: "garage",
        OCW_S3_ACCESS_KEY_ID: "GKtest",
      },
      createEnvFileSecretStore({ OCW_S3_SECRET_ACCESS_KEY: "test-secret" }),
    );
    if (!built) throw new Error("storage not configured");
    store = built;
  });

  afterAll(async () => {
    s3.closeAllConnections();
    await new Promise<void>((resolve) => s3.close(() => resolve()));
  });

  const reset = () => {
    calls = [];
    failPart = null;
  };
  const octets = "application/octet-stream";

  it("a body of one part or less is one PutObject", async () => {
    reset();
    const seen: number[] = [];
    const out = await store.putStream("org/o/conv/c/att/a/original", chunked(new Uint8Array([1, 2, 3])), {
      contentType: octets,
      maxBytes: 3,
      onChunk: (c) => seen.push(c.length),
    });
    expect(out).toEqual({ bytes: 3 });
    expect(calls).toEqual([{ op: "PutObject", bytes: 3, contentType: octets }]);
    expect(seen).toEqual([3]);
  });

  it("exactly one part, and an empty body, are still one PutObject each", async () => {
    reset();
    expect((await store.putStream("k", chunked(new Uint8Array(PART)), { contentType: octets, maxBytes: PART })).bytes).toBe(PART);
    expect((await store.putStream("k", chunked(new Uint8Array(0)), { contentType: octets, maxBytes: 1 })).bytes).toBe(0);
    expect(calls.map((c) => [c.op, c.bytes])).toEqual([
      ["PutObject", PART],
      ["PutObject", 0],
    ]);
  });

  it("17 MiB is a multipart upload of 8, 8 and 1 MiB, completed with the three ETags (E21)", async () => {
    reset();
    const body = randomBytes(17 * MiB);
    let seen = 0;
    const out = await store.putStream("k", chunked(body), {
      contentType: octets,
      maxBytes: 17 * MiB,
      onChunk: (c) => {
        seen += c.length;
      },
    });
    expect(out.bytes).toBe(17 * MiB);
    expect(seen).toBe(17 * MiB);
    expect(calls.map((c) => [c.op, c.partNumber, c.bytes])).toEqual([
      ["CreateMultipartUpload", undefined, 0],
      ["UploadPart", 1, 8 * MiB],
      ["UploadPart", 2, 8 * MiB],
      ["UploadPart", 3, 1 * MiB],
      ["CompleteMultipartUpload", undefined, expect.any(Number)],
    ]);
    const complete = calls.at(-1)?.body ?? "";
    for (const n of [1, 2, 3]) {
      expect(complete).toContain(`<PartNumber>${n}</PartNumber>`);
      expect(complete).toContain(`etag-${n}`);
    }
  });

  it("past maxBytes the multipart upload is aborted and ObjectTooLargeError is thrown", async () => {
    reset();
    await expect(
      store.putStream("k", chunked(new Uint8Array(17 * MiB)), { contentType: octets, maxBytes: 9 * MiB }),
    ).rejects.toBeInstanceOf(ObjectTooLargeError);
    expect(calls.map((c) => c.op)).toEqual(["CreateMultipartUpload", "UploadPart", "AbortMultipartUpload"]);
  });

  it("past maxBytes within one part: nothing is written at all", async () => {
    reset();
    await expect(
      store.putStream("k", chunked(new Uint8Array(1024)), { contentType: octets, maxBytes: 1000 }),
    ).rejects.toBeInstanceOf(ObjectTooLargeError);
    expect(calls).toEqual([]);
  });

  it("a failing part aborts the upload and rethrows the store's error", async () => {
    reset();
    failPart = 2;
    await expect(
      store.putStream("k", chunked(new Uint8Array(17 * MiB)), { contentType: octets, maxBytes: 17 * MiB }),
    ).rejects.toMatchObject({ name: "AccessDenied" });
    expect(calls.map((c) => c.op)).toEqual([
      "CreateMultipartUpload",
      "UploadPart",
      "UploadPart",
      "AbortMultipartUpload",
    ]);
  });

  it("a body that breaks mid-way aborts the upload and rethrows", async () => {
    reset();
    async function* broken(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(PART);
      yield new Uint8Array(1024);
      throw new Error("client went away");
    }
    await expect(store.putStream("k", broken(), { contentType: octets, maxBytes: 17 * MiB })).rejects.toThrow(
      "client went away",
    );
    expect(calls.map((c) => c.op)).toEqual(["CreateMultipartUpload", "UploadPart", "AbortMultipartUpload"]);
  });
});

describe("streamServerAttachment (07.17.1.1-08, PD-17)", () => {
  /** A storage whose `putStream` drains the body through `onChunk`, as the real one does. */
  function draining(record: { key?: string; contentType?: string; maxBytes?: number; seen: Buffer[] }) {
    const unused = (name: string) => () => {
      throw new Error(`ObjectStorage.${name} is not used by streamServerAttachment`);
    };
    const storage: ObjectStorage = {
      bucket: "test",
      presignPut: unused("presignPut"),
      presignGet: unused("presignGet"),
      head: unused("head"),
      rangeGet: unused("rangeGet"),
      stream: unused("stream"),
      put: unused("put"),
      remove: unused("remove"),
      ensureBucketCors: unused("ensureBucketCors"),
      async putStream(key, body, opts) {
        record.key = key;
        record.contentType = opts.contentType;
        record.maxBytes = opts.maxBytes;
        let bytes = 0;
        for await (const chunk of body) {
          opts.onChunk?.(chunk);
          record.seen.push(Buffer.from(chunk));
          bytes += chunk.length;
        }
        return { bytes };
      },
    };
    return storage;
  }

  it("hashes and sniffs every byte it streams to the attachment's original key, and counts them", async () => {
    // A PDF's magic bytes, then filler: `sniff` reads only the first bytes.
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n%âãÏÓ\n", "latin1"), randomBytes(300_000)]);
    const record: { key?: string; contentType?: string; maxBytes?: number; seen: Buffer[] } = { seen: [] };
    async function* body(): AsyncGenerator<Uint8Array> {
      // Pieces smaller than the sniff window, so the head is assembled across chunks.
      for (let at = 0; at < pdf.length; at += 1000) yield pdf.subarray(at, at + 1000);
    }
    const out = await streamServerAttachment(draining(record), {
      organizationId: "o1",
      conversationId: "c1",
      attachmentId: "a1",
      body: body(),
      maxBytes: pdf.length,
    });
    expect(out).toEqual({
      sizeBytes: pdf.length,
      sha256: createHash("sha256").update(pdf).digest("hex"),
      contentType: "application/pdf",
    });
    expect(record.key).toBe(attachmentKey("o1", "c1", "a1", "original"));
    expect(record.contentType).toBe("application/octet-stream");
    expect(record.maxBytes).toBe(pdf.length);
    expect(Buffer.concat(record.seen).equals(pdf)).toBe(true);
  });

  it("an active type (HTML) is never kept: the stored type is application/octet-stream", async () => {
    const html = Buffer.from("<!doctype html><html><script>alert(1)</script></html>");
    async function* body(): AsyncGenerator<Uint8Array> {
      yield html;
    }
    const out = await streamServerAttachment(draining({ seen: [] }), {
      organizationId: "o1",
      conversationId: "c1",
      attachmentId: "a2",
      body: body(),
      maxBytes: 1024,
    });
    expect(out.contentType).toBe("application/octet-stream");
    expect(out.sizeBytes).toBe(html.length);
  });
});
