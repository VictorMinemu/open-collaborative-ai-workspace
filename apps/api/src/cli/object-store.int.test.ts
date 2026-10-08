import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStorage, type TestStorage } from "../testing-storage";
import { exportObjects, importObjects, objectStoreFromEnv, readIndex } from "./object-store";

/**
 * `ocw backup` / `ocw restore` object half (SELF-04, D-03): every object in the bucket goes out through the S3 API with
 * its content type and comes back byte-identical; a tampered backup is refused before the first PUT. Real Garage.
 */
let storage: TestStorage;
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "ocw-objstore-"));
  dirs.push(d);
  return d;
};

const OBJECTS = [
  {
    key: "org/a/conv/b/att/c/original",
    body: Buffer.from("%PDF-1.7 fake pdf bytes"),
    type: "application/pdf",
  },
  {
    key: "org/a/conv/b/att/c/thumb.webp",
    body: Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3]),
    type: "image/webp",
  },
  {
    key: "org/x/conv/y/att/z/original",
    body: Buffer.from("plain text\n"),
    type: "text/plain; charset=utf-8",
  },
];

beforeAll(async () => {
  storage = await startTestStorage();
});

afterAll(async () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  await storage?.stop();
});

async function emptyBucket() {
  const { s3, bucket } = objectStoreFromEnv(storage.env);
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
  for (const o of listed.Contents ?? [])
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: o.Key }));
}

async function seed() {
  const { s3, bucket } = objectStoreFromEnv(storage.env);
  for (const o of OBJECTS) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: o.key,
        Body: o.body,
        ContentType: o.type,
        ContentLength: o.body.length,
      }),
    );
  }
}

async function bucketState() {
  const { s3, bucket } = objectStoreFromEnv(storage.env);
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
  const out: Record<string, { type: string | undefined; body: string }> = {};
  for (const o of listed.Contents ?? []) {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: o.Key }));
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: o.Key }));
    out[o.Key as string] = {
      type: head.ContentType,
      body: Buffer.from(await got.Body!.transformToByteArray()).toString("base64"),
    };
  }
  return out;
}

describe("object-store export / import (SELF-04)", () => {
  it("export writes every object (0600, dir 0700) and a matching index", async () => {
    await emptyBucket();
    await seed();
    const dir = tmp();
    const entries = await exportObjects(objectStoreFromEnv(storage.env), dir);
    expect(entries.map((e) => e.key).sort()).toEqual(OBJECTS.map((o) => o.key).sort());
    const index = readIndex(dir);
    expect(index).toEqual(entries);
    for (const o of OBJECTS) {
      const e = index.find((x) => x.key === o.key)!;
      expect(e.contentType).toBe(o.type);
      expect(e.size).toBe(o.body.length);
      expect(e.etag).toBeTruthy();
      const file = path.join(dir, e.file);
      expect(readFileSync(file).equals(o.body)).toBe(true);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(statSync(path.join(dir, "objects")).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, "objects.json")).mode & 0o777).toBe(0o600);
    // File names never come from the key (a key is untrusted input on restore).
    for (const f of readdirSync(path.join(dir, "objects"))) expect(f).toMatch(/^[0-9a-f]{64}$/);
  });

  it("import into an empty bucket recreates identical bytes and content types, and drops extras on request", async () => {
    await emptyBucket();
    await seed();
    const dir = tmp();
    await exportObjects(objectStoreFromEnv(storage.env), dir);
    const before = await bucketState();
    await emptyBucket();
    const { s3, bucket } = objectStoreFromEnv(storage.env);
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: "org/new/extra",
        Body: Buffer.from("x"),
        ContentLength: 1,
      }),
    );
    const res = await importObjects(objectStoreFromEnv(storage.env), dir, { deleteExtra: true });
    expect(res).toEqual({ imported: 3, deleted: 1 });
    expect(await bucketState()).toEqual(before);
  });

  it("a corrupted file is refused before any PUT", async () => {
    await emptyBucket();
    await seed();
    const dir = tmp();
    const entries = await exportObjects(objectStoreFromEnv(storage.env), dir);
    await emptyBucket();
    const victim = entries.find((e) => e.key.endsWith("thumb.webp"))!;
    const file = path.join(dir, victim.file);
    const bytes = readFileSync(file);
    bytes[0] = bytes[0]! ^ 0xff;
    writeFileSync(file, bytes);
    await expect(importObjects(objectStoreFromEnv(storage.env), dir)).rejects.toThrow(
      /checksum mismatch.*thumb\.webp/,
    );
    expect(await bucketState()).toEqual({});
  });

  it("an index entry whose file escapes objects/ is refused", async () => {
    await emptyBucket();
    const dir = tmp();
    await exportObjects(objectStoreFromEnv(storage.env), dir);
    writeFileSync(
      path.join(dir, "objects.json"),
      JSON.stringify([
        {
          key: "k",
          file: "../db.dump",
          size: 1,
          etag: "x",
          contentType: "text/plain",
          sha256: "0".repeat(64),
        },
      ]),
    );
    await expect(importObjects(objectStoreFromEnv(storage.env), dir)).rejects.toThrow(/invalid index entry/);
  });

  it("the CLI reads only OCW_S3_* (no DATABASE_URL, no API secrets) and prints counts, never keys", () => {
    const dir = tmp();
    const cli = fileURLToPath(new URL("./object-store.ts", import.meta.url));
    const env = { PATH: process.env.PATH ?? "", ...storage.env };
    const res = spawnSync(process.execPath, ["--import", "tsx", cli, "export", dir], {
      env,
      encoding: "utf8",
    });
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/exported \d+ objects/);
    expect(res.stdout).not.toContain(storage.env.OCW_S3_SECRET_ACCESS_KEY);
    expect(res.stdout).not.toContain("org/");
    const bad = spawnSync(process.execPath, ["--import", "tsx", cli, "frobnicate"], {
      env,
      encoding: "utf8",
    });
    expect(bad.status).toBe(2);
  });
});
