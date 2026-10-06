import type { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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
  /** The first `bytes` bytes (fewer when the object is smaller). */
  rangeGet(key: string, bytes: number): Promise<Uint8Array>;
  stream(key: string): Promise<Readable>;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Deletes the keys; missing keys are not an error. */
  remove(keys: string[]): Promise<void>;
  /** Browser uploads and downloads from these origins only (PUT/GET, signed content-type, ETag exposed). */
  ensureBucketCors(origins: string[]): Promise<void>;
}

function client(
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

/** Null when storage is not configured (endpoint, key id and secret all required); attachments are then disabled. */
/** Whether `createObjectStorage` would return a store (endpoint, key id and secret all set), without building one. */
export function objectStorageConfigured(env: Env, secrets: SecretStore): boolean {
  if (!env.OCW_S3_ENDPOINT || !env.OCW_S3_ACCESS_KEY_ID) return false;
  try {
    secrets.resolveSync({ provider: "env", key: "OCW_S3_SECRET_ACCESS_KEY" });
    return true;
  } catch (err) {
    if (err instanceof MissingSecretError) return false;
    throw err;
  }
}

export function createObjectStorage(env: Env, secrets: SecretStore): ObjectStorage | null {
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
  const s3 = client(endpoint, env.OCW_S3_REGION, credentials);
  const presigner = client(publicUrl, env.OCW_S3_REGION, credentials);
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
      return res.Body.transformToByteArray();
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
