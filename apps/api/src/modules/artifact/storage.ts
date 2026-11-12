import type { Readable } from "node:stream";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { BOT_FILE_LIMITS } from "@ocw/contracts";
import type { Env } from "../../config/env";
import { MissingSecretError, type SecretStore } from "../../lib/secret-store";

/**
 * S3-compatible object storage (Garage in compose, ADR-0015, P-10). The S3 API is the contract: nothing here is
 * Garage-specific. Two clients: server operations go to `OCW_S3_ENDPOINT` (e.g. http://garage:3900), presigned
 * URLs are signed for `OCW_S3_PUBLIC_URL` (SigV4 signs the Host, Pitfall 5). The bucket is private; the API is the
 * only ACL. Never log a URL produced here: a presigned query string is a bearer credential.
 */

export type AttachmentPart = "original" | "thumb.webp" | "large.webp";
export const ATTACHMENT_PARTS: readonly AttachmentPart[] = ["original", "thumb.webp", "large.webp"];

/** Tenant-scoped key from ids only (never a filename): `org/<orgId>/conv/<convId>/att/<attId>/<part>`. */
export function attachmentKey(orgId: string, convId: string, attId: string, part: AttachmentPart): string {
  return `org/${orgId}/conv/${convId}/att/${attId}/${part}`;
}

export interface ObjectStorage {
  readonly bucket: string;
  /** A PUT URL with the content type and length signed (a different type gets 403 from the store). */
  presignPut(
    key: string,
    contentType: string,
    size: number,
    ttlSeconds: number,
  ): Promise<{ url: string; headers: Record<string, string>; expiresAt: string }>;
  /** A GET URL that forces the response type and disposition. */
  presignGet(
    key: string,
    opts: { ttlSeconds: number; contentType: string; disposition: string },
  ): Promise<string>;
  /** Object size, or null when the object does not exist. */
  head(key: string): Promise<{ size: number } | null>;
  /** The first `bytes` bytes (fewer when the object is smaller), never more, even from a store that ignores Range. */
  rangeGet(key: string, bytes: number): Promise<Uint8Array>;
  stream(key: string): Promise<Readable>;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /**
   * 07.17.1.1 (D-08, PD-05): a body of unknown length, never held whole. Up to one part (`BOT_FILE_LIMITS.partBytes`)
   * is one `PutObject`; anything larger is an S3 multipart upload in parts of that size, one part in memory at a time.
   * Every byte is counted and handed to `onChunk` (hashing, sniffing); past `maxBytes` the write stops with
   * `ObjectTooLargeError`. On any error the multipart upload is aborted (no object, no orphaned parts) and the error
   * is rethrown.
   */
  putStream(
    key: string,
    body: AsyncIterable<Uint8Array>,
    opts: { contentType: string; maxBytes: number; onChunk?: (chunk: Uint8Array) => void },
  ): Promise<{ bytes: number }>;
  /** Deletes the keys; missing keys are not an error. */
  remove(keys: string[]): Promise<void>;
  /** Browser uploads and downloads from these origins only (PUT/GET, signed content-type, ETag exposed). */
  ensureBucketCors(origins: string[]): Promise<void>;
}

/** A streamed body grew past the `maxBytes` its writer allowed; nothing was stored. */
export class ObjectTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`object larger than ${maxBytes} bytes`);
    this.name = "ObjectTooLargeError";
  }
}

/** The `Env` fields object storage reads (the object-store CLI builds exactly these, never the full API config). */
export type ObjectStorageEnv = Pick<
  Env,
  "OCW_S3_ENDPOINT" | "OCW_S3_PUBLIC_URL" | "OCW_S3_BUCKET" | "OCW_S3_REGION" | "OCW_S3_ACCESS_KEY_ID"
>;

/** An S3 client with the settings every OCW caller needs against S3-compatible stores (Garage). */
export function s3Client(
  endpoint: string,
  region: string,
  credentials: { accessKeyId: string; secretAccessKey: string },
) {
  return new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials,
    // The SDK's default (WHEN_SUPPORTED) adds x-amz-checksum-crc32 of an empty body to presigned PUTs, which
    // Garage refuses with 400 InvalidDigest (Pitfall 3). Checksums only where the S3 API requires them.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

const isNotFound = (err: unknown) => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
};

/**
 * At most `max` bytes of `stream`, then the stream is destroyed (the transfer stops): what `rangeGet` returns, however
 * much the store sends (WR-05). Fewer when the stream ends first.
 */
async function readAtMost(stream: Readable, max: number): Promise<Uint8Array> {
  const out = new Uint8Array(max);
  let filled = 0;
  try {
    for await (const chunk of stream) {
      const buf = chunk as Uint8Array;
      const take = Math.min(buf.length, max - filled);
      out.set(take === buf.length ? buf : buf.subarray(0, take), filled);
      filled += take;
      if (filled >= max) break;
    }
  } finally {
    stream.destroy();
  }
  return filled === max ? out : out.slice(0, filled);
}

/** Whether `createObjectStorage` would return a store (endpoint, key id and secret all set), without building one. */
export function objectStorageConfigured(env: ObjectStorageEnv, secrets: SecretStore): boolean {
  if (!env.OCW_S3_ENDPOINT || !env.OCW_S3_ACCESS_KEY_ID) return false;
  try {
    secrets.resolveSync({ provider: "env", key: "OCW_S3_SECRET_ACCESS_KEY" });
    return true;
  } catch (err) {
    if (err instanceof MissingSecretError) return false;
    throw err;
  }
}

/** Null when storage is not configured (endpoint, key id and secret all required); attachments are then disabled. */
export function createObjectStorage(env: ObjectStorageEnv, secrets: SecretStore): ObjectStorage | null {
  const endpoint = env.OCW_S3_ENDPOINT;
  const publicUrl = env.OCW_S3_PUBLIC_URL ?? endpoint;
  const accessKeyId = env.OCW_S3_ACCESS_KEY_ID;
  if (!endpoint || !publicUrl || !accessKeyId) return null;
  let secretAccessKey: string;
  try {
    secretAccessKey = secrets.resolveSync({ provider: "env", key: "OCW_S3_SECRET_ACCESS_KEY" });
  } catch (err) {
    if (err instanceof MissingSecretError) return null;
    throw err;
  }
  const credentials = { accessKeyId, secretAccessKey };
  const s3 = s3Client(endpoint, env.OCW_S3_REGION, credentials);
  const presigner = s3Client(publicUrl, env.OCW_S3_REGION, credentials);
  const Bucket = env.OCW_S3_BUCKET;

  return {
    bucket: Bucket,

    async presignPut(key, contentType, size, ttlSeconds) {
      const url = await getSignedUrl(
        presigner,
        new PutObjectCommand({ Bucket, Key: key, ContentType: contentType, ContentLength: size }),
        // Without this the content type is not signed and any type can be uploaded (Pitfall 4).
        { expiresIn: ttlSeconds, signableHeaders: new Set(["content-type"]) },
      );
      return {
        url,
        headers: { "content-type": contentType },
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      };
    },

    presignGet(key, opts) {
      return getSignedUrl(
        presigner,
        new GetObjectCommand({
          Bucket,
          Key: key,
          ResponseContentType: opts.contentType,
          ResponseContentDisposition: opts.disposition,
        }),
        { expiresIn: opts.ttlSeconds },
      );
    },

    async head(key) {
      try {
        const res = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { size: Number(res.ContentLength ?? 0) };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async rangeGet(key, bytes) {
      const res = await s3.send(new GetObjectCommand({ Bucket, Key: key, Range: `bytes=0-${bytes - 1}` }));
      if (!res.Body) return new Uint8Array();
      // WR-05: never trust the store to honour Range (one that ignores it answers 200 with the whole object).
      return readAtMost(res.Body as Readable, bytes);
    },

    async stream(key) {
      const res = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
      if (!res.Body) throw new Error("object has no body");
      return res.Body as Readable;
    },

    async put(key, body, contentType) {
      await s3.send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ContentLength: body.length,
        }),
      );
    },

    async putStream(key, body, opts) {
      const partBytes = BOT_FILE_LIMITS.partBytes;
      // One part in memory, reused for every part (each send is awaited before the buffer is refilled). Never more
      // than the bound: a body allowed fewer bytes than a part never allocates a whole part.
      let buf: Buffer | null = null;
      let filled = 0;
      let total = 0;
      let uploadId: string | undefined;
      const parts: Array<{ ETag: string; PartNumber: number }> = [];

      const sendPart = async (bytes: Buffer) => {
        if (uploadId === undefined) {
          const created = await s3.send(
            new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: opts.contentType }),
          );
          if (!created.UploadId) throw new Error("the store returned no multipart upload id");
          uploadId = created.UploadId;
        }
        const PartNumber = parts.length + 1;
        const res = await s3.send(
          new UploadPartCommand({
            Bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber,
            Body: bytes,
            ContentLength: bytes.length,
          }),
        );
        if (!res.ETag) throw new Error("the store returned no part ETag");
        parts.push({ ETag: res.ETag, PartNumber });
      };

      try {
        for await (const chunk of body) {
          total += chunk.length;
          if (total > opts.maxBytes) throw new ObjectTooLargeError(opts.maxBytes);
          opts.onChunk?.(chunk);
          buf ??= Buffer.allocUnsafe(Math.min(partBytes, opts.maxBytes));
          let at = 0;
          while (at < chunk.length) {
            // A full part is sent only once more bytes arrive, so a body of exactly one part stays one PutObject.
            if (filled === buf.length) {
              await sendPart(buf);
              filled = 0;
            }
            const take = Math.min(buf.length - filled, chunk.length - at);
            buf.set(chunk.subarray(at, at + take), filled);
            filled += take;
            at += take;
          }
        }
        const rest = buf ? buf.subarray(0, filled) : Buffer.alloc(0);
        if (uploadId === undefined) {
          await s3.send(
            new PutObjectCommand({
              Bucket,
              Key: key,
              Body: rest,
              ContentType: opts.contentType,
              ContentLength: rest.length,
            }),
          );
          return { bytes: total };
        }
        if (rest.length > 0) await sendPart(rest);
        await s3.send(
          new CompleteMultipartUploadCommand({
            Bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts },
          }),
        );
        return { bytes: total };
      } catch (err) {
        if (uploadId !== undefined) {
          // Best effort: the caller gets the original error, not the abort's.
          await s3
            .send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }))
            .catch(() => undefined);
        }
        throw err;
      }
    },

    async remove(keys) {
      // One DeleteObject per key: DeleteObjects needs a Content-MD5/checksum that S3-compatible stores treat
      // differently, and an attachment has at most three keys.
      for (const Key of keys) {
        try {
          await s3.send(new DeleteObjectCommand({ Bucket, Key }));
        } catch (err) {
          if (!isNotFound(err)) throw err;
        }
      }
    },

    async ensureBucketCors(origins) {
      await s3.send(
        new PutBucketCorsCommand({
          Bucket,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: origins,
                AllowedMethods: ["PUT", "GET"],
                AllowedHeaders: ["content-type"],
                ExposeHeaders: ["ETag"],
                MaxAgeSeconds: 3600,
              },
            ],
          },
        }),
      );
    },
  };
}
