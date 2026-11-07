import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { AttachmentRow } from "../model";
import { type AttachmentPart, attachmentKey, type ObjectStorage } from "../storage";
import { EXTRACT_LIMITS } from "./limits";
import { readAttachmentForAgent } from "./read";

/**
 * 07.15-04 (BRA-02, D-05, PD-07): what a bot gets when it reads a stored file. Text from at most the first
 * `EXTRACT_LIMITS.textReadBytes` bytes of the object (a range read, never the whole object), capped in UTF-16 code
 * units; images as the stored rendition or a bounded original; anything else a fixed refusal, never an exception.
 */

const ORG = "00000000-0000-7000-8000-00000000000a";
const CONV = "00000000-0000-7000-8000-00000000000b";
const CAPS = { charsPerFile: 64_000, maxBytes: 25 * 1024 * 1024 };

let n = 0;
function row(over: Partial<AttachmentRow>): AttachmentRow {
  n++;
  return {
    id: `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`,
    organizationId: ORG,
    conversationId: CONV,
    messageId: "00000000-0000-7000-8000-00000000000d",
    workPromptId: null,
    workPromptPosition: null,
    uploaderId: "00000000-0000-7000-8000-00000000000c",
    filename: "file.bin",
    declaredType: "application/octet-stream",
    contentType: "application/octet-stream",
    sizeBytes: 10,
    sha256: null,
    status: "ready",
    scanStatus: "not_scanned",
    hasRenditions: false,
    largeBytes: null,
    width: null,
    height: null,
    eventId: null,
    createdAt: "2026-10-06T12:00:00.000Z",
    completedAt: "2026-10-06T12:00:01.000Z",
    purgedAt: null,
    ...over,
  } as AttachmentRow;
}

type Call = { method: "rangeGet" | "stream"; key: string; bytes?: number };

/** A typed in-memory store: objects per part of one row, every call recorded, methods the read never uses throw. */
function memoryStorage(
  target: AttachmentRow,
  parts: Partial<Record<AttachmentPart, Uint8Array>>,
  fail?: { rangeGet?: Error; stream?: Error },
) {
  const calls: Call[] = [];
  const objects = new Map<string, Uint8Array>();
  for (const [part, bytes] of Object.entries(parts) as Array<[AttachmentPart, Uint8Array]>)
    objects.set(attachmentKey(target.organizationId, target.conversationId, target.id, part), bytes);
  const unused = (name: string) => () => {
    throw new Error(`ObjectStorage.${name} is not used by the bot read layer`);
  };
  const storage: ObjectStorage = {
    bucket: "test",
    presignPut: unused("presignPut"),
    presignGet: unused("presignGet"),
    head: unused("head"),
    put: unused("put"),
    remove: unused("remove"),
    ensureBucketCors: unused("ensureBucketCors"),
    async rangeGet(key, bytes) {
      calls.push({ method: "rangeGet", key, bytes });
      if (fail?.rangeGet) throw fail.rangeGet;
      const body = objects.get(key);
      if (!body) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
      return body.slice(0, bytes);
    },
    async stream(key) {
      calls.push({ method: "stream", key });
      if (fail?.stream) throw fail.stream;
      const body = objects.get(key);
      if (!body) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
      return Readable.from([Buffer.from(body)]);
    },
  };
  return { storage, calls };
}

const enc = (s: string) => new TextEncoder().encode(s);
const keyOf = (r: AttachmentRow, part: AttachmentPart) =>
  attachmentKey(r.organizationId, r.conversationId, r.id, part);

describe("readAttachmentForAgent: text", () => {
  it("returns a Markdown file's text from one range read of the original, never streaming the object", async () => {
    const body = "# Hello\nworld\n";
    const md = row({
      filename: "notes.md",
      declaredType: "text/markdown",
      contentType: "application/octet-stream",
      sizeBytes: enc(body).length,
    });
    const { storage, calls } = memoryStorage(md, { original: enc(body) });
    expect(await readAttachmentForAgent(storage, md, CAPS)).toEqual({
      kind: "text",
      text: body,
      chars: 14,
      truncated: false,
    });
    expect(calls).toEqual([
      { method: "rangeGet", key: keyOf(md, "original"), bytes: EXTRACT_LIMITS.textReadBytes },
    ]);
    expect(EXTRACT_LIMITS.textReadBytes).toBe(262_144);
  });

  it("caps a large file at charsPerFile code units and marks it truncated", async () => {
    const big = row({ filename: "big.txt", declaredType: "text/plain", sizeBytes: 300_000 });
    const { storage, calls } = memoryStorage(big, { original: enc("a".repeat(300_000)) });
    const read = await readAttachmentForAgent(storage, big, CAPS);
    expect(read).toMatchObject({ kind: "text", chars: 64_000, truncated: true });
    expect(read.kind === "text" && read.text.length).toBe(64_000);
    expect(calls.map((c) => c.method)).toEqual(["rangeGet"]);
  });

  it("refuses a .docx as unsupported_type without touching the store", async () => {
    const docx = row({
      filename: "report.docx",
      declaredType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      contentType: "application/zip",
    });
    const { storage, calls } = memoryStorage(docx, { original: enc("PK") });
    expect(await readAttachmentForAgent(storage, docx, CAPS)).toEqual({
      kind: "refused",
      code: "unsupported_type",
    });
    expect(calls).toEqual([]);
  });

  it("answers unavailable when the store fails", async () => {
    const txt = row({ filename: "a.txt", declaredType: "text/plain" });
    const { storage } = memoryStorage(txt, {}, { rangeGet: new Error("connect ECONNREFUSED secret-text") });
    expect(await readAttachmentForAgent(storage, txt, CAPS)).toEqual({
      kind: "refused",
      code: "unavailable",
    });
  });

  it("refuses bytes with a NUL in the first 8 KiB as unsupported_type", async () => {
    const bin = row({ filename: "data.txt", declaredType: "text/plain", sizeBytes: 6 });
    const { storage } = memoryStorage(bin, {
      original: new Uint8Array([0x61, 0x00, 0x00, 0x62, 0x63, 0x64]),
    });
    expect(await readAttachmentForAgent(storage, bin, CAPS)).toEqual({
      kind: "refused",
      code: "unsupported_type",
    });
  });
});
