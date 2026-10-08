// Object half of `ocw backup` / `ocw restore` (SELF-04, D-03): every object in the attachments bucket out to a
// directory and back, through the S3 API only (any S3-compatible backend). Runs inside the api image:
//   docker compose run --rm --no-deps -v <backup dir>:/backup api node --import tsx src/cli/object-store.ts export /backup
//   … import /backup [--delete-extra]
// Reads only OCW_S3_* (the secret key as OCW_S3_SECRET_ACCESS_KEY or _FILE), never the API's full config, so it works
// whatever provider holds the API-only secrets. Prints counts, never keys, URLs or credentials.
import { createHash } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { z } from "zod";
import { createEnvFileSecretStore } from "../lib/secret-store";
import { s3Client } from "../modules/artifact";

export const INDEX_FILE = "objects.json";
export const OBJECTS_DIR = "objects";

/** One object in a backup. `file` is `objects/<sha256 of the key>`: never derived from the (untrusted) key text. */
export const IndexEntry = z.object({
  key: z.string().min(1).max(1024),
  file: z.string().regex(/^objects\/[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
  etag: z.string().nullable(),
  contentType: z.string().nullable(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type IndexEntry = z.infer<typeof IndexEntry>;

/** The only settings this CLI reads (same names and defaults as the API's config). */
const ObjectStoreSettings = z.object({
  OCW_S3_ENDPOINT: z.url(),
  OCW_S3_BUCKET: z
    .string()
    .default("")
    .transform((v) => v.trim() || "ocw-attachments"),
  OCW_S3_REGION: z
    .string()
    .default("")
    .transform((v) => v.trim() || "garage"),
  OCW_S3_ACCESS_KEY_ID: z.string().trim().min(1),
});

export interface ObjectStore {
  s3: S3Client;
  bucket: string;
}

/** Throws naming the missing setting (never its value). */
export function objectStoreFromEnv(env: NodeJS.ProcessEnv = process.env): ObjectStore {
  const parsed = ObjectStoreSettings.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(", ");
    throw new Error(`object storage is not configured: set ${names}`);
  }
  const s = parsed.data;
  const secretAccessKey = createEnvFileSecretStore(env).resolveSync({
    provider: "env",
    key: "OCW_S3_SECRET_ACCESS_KEY",
  });
  return {
    s3: s3Client(s.OCW_S3_ENDPOINT, s.OCW_S3_REGION, {
      accessKeyId: s.OCW_S3_ACCESS_KEY_ID,
      secretAccessKey,
    }),
    bucket: s.OCW_S3_BUCKET,
  };
}

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** Garage creates the default bucket shortly after it starts: wait for it instead of failing a fresh stack. */
async function waitForBucket(store: ObjectStore, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await store.s3.send(new HeadBucketCommand({ Bucket: store.bucket }));
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function* listKeys(store: ObjectStore) {
  let token: string | undefined;
  do {
    const page = await store.s3.send(
      new ListObjectsV2Command({ Bucket: store.bucket, ContinuationToken: token }),
    );
    for (const o of page.Contents ?? []) if (o.Key) yield o.Key;
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}

/** Writes every object to `<dir>/objects/<sha256(key)>` (0600, dir 0700) and `<dir>/objects.json`; returns the index. */
export async function exportObjects(store: ObjectStore, dir: string): Promise<IndexEntry[]> {
  await waitForBucket(store);
  const objectsDir = path.join(dir, OBJECTS_DIR);
  mkdirSync(objectsDir, { recursive: true, mode: 0o700 });
  chmodSync(objectsDir, 0o700);
  const entries: IndexEntry[] = [];
  for await (const key of listKeys(store)) {
    const res = await store.s3.send(new GetObjectCommand({ Bucket: store.bucket, Key: key }));
    if (!res.Body) throw new Error("an object has no body");
    const file = `${OBJECTS_DIR}/${sha256Hex(key)}`;
    const target = path.join(dir, file);
    const hash = createHash("sha256");
    let size = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });
    await pipeline(res.Body as Readable, tap, createWriteStream(target, { mode: 0o600 }));
    chmodSync(target, 0o600);
    entries.push({
      key,
      file,
      size,
      etag: res.ETag ?? null,
      contentType: res.ContentType ?? null,
      sha256: hash.digest("hex"),
    });
  }
  const index = path.join(dir, INDEX_FILE);
  writeFileSync(index, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  chmodSync(index, 0o600);
  return entries;
}

/** The index of a backup directory, schema-checked (a tampered or foreign file is refused). */
export function readIndex(dir: string): IndexEntry[] {
  const raw = JSON.parse(readFileSync(path.join(dir, INDEX_FILE), "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${INDEX_FILE}: invalid index (not a list)`);
  return raw.map((e, i) => {
    const parsed = IndexEntry.safeParse(e);
    if (!parsed.success || parsed.data.file !== `${OBJECTS_DIR}/${sha256Hex(parsed.data.key)}`) {
      throw new Error(`${INDEX_FILE}: invalid index entry #${i}`);
    }
    return parsed.data;
  });
}

async function fileSha256(file: string) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/** Checks every object file against the index (size and sha256). Throws naming the first bad one; changes nothing. */
export async function verifyObjects(dir: string): Promise<IndexEntry[]> {
  const entries = readIndex(dir);
  for (const e of entries) {
    const file = path.join(dir, e.file);
    if (!existsSync(file)) throw new Error(`missing object file ${e.file} (${e.key})`);
    if (statSync(file).size !== e.size || (await fileSha256(file)) !== e.sha256) {
      throw new Error(`checksum mismatch: ${e.file} (${e.key})`);
    }
  }
  return entries;
}

/**
 * Verifies every file first, then PUTs each object with its stored content type. With `deleteExtra`, objects in the
 * bucket that the backup does not hold are removed afterwards (the bucket then equals the backup).
 */
export async function importObjects(
  store: ObjectStore,
  dir: string,
  { deleteExtra = false }: { deleteExtra?: boolean } = {},
): Promise<{ imported: number; deleted: number }> {
  const entries = await verifyObjects(dir);
  await waitForBucket(store);
  for (const e of entries) {
    await store.s3.send(
      new PutObjectCommand({
        Bucket: store.bucket,
        Key: e.key,
        Body: createReadStream(path.join(dir, e.file)),
        ContentLength: e.size,
        ...(e.contentType ? { ContentType: e.contentType } : {}),
      }),
    );
  }
  let deleted = 0;
  if (deleteExtra) {
    const keep = new Set(entries.map((e) => e.key));
    const extra: string[] = [];
    for await (const key of listKeys(store)) if (!keep.has(key)) extra.push(key);
    for (const key of extra) {
      await store.s3.send(new DeleteObjectCommand({ Bucket: store.bucket, Key: key }));
      deleted++;
    }
  }
  return { imported: entries.length, deleted };
}

const USAGE = "usage: object-store.ts export <dir> | import <dir> [--delete-extra]";

export async function main(argv: string[]): Promise<number> {
  const [cmd, dir, ...rest] = argv;
  const flags = new Set(rest);
  const known = cmd === "export" ? [] : ["--delete-extra"];
  if ((cmd !== "export" && cmd !== "import") || !dir || [...flags].some((f) => !known.includes(f))) {
    console.error(USAGE);
    return 2;
  }
  try {
    const store = objectStoreFromEnv();
    if (cmd === "export") {
      const entries = await exportObjects(store, dir);
      const bytes = entries.reduce((n, e) => n + e.size, 0);
      console.log(`exported ${entries.length} objects (${bytes} bytes)`);
    } else {
      const res = await importObjects(store, dir, { deleteExtra: flags.has("--delete-extra") });
      console.log(`imported ${res.imported} objects; removed ${res.deleted} not in the backup`);
    }
    return 0;
  } catch (err) {
    console.error(`object-store ${cmd} failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
