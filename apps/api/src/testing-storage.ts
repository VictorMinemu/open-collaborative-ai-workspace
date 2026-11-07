import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import type { TestClient } from "./testing";

/** Same image as compose.yaml (ADR-0015). */
export const GARAGE_IMAGE = "dxflrs/garage:v2.4.1";
export const TEST_BUCKET = "ocw-attachments";

/** The same single-node config compose.yaml mounts (no secrets; they come from GARAGE_* env). */
const GARAGE_TOML = readFileSync(new URL("../../../infra/garage/garage.toml", import.meta.url), "utf8");

export interface TestStorage {
  /** `OCW_S3_*` for `startTestStack({ env })` (the secret is resolved through the SecretStore from it). */
  env: Record<string, string>;
  /** http://127.0.0.1:<port> (endpoint and public URL are the same in tests). */
  endpoint: string;
  container: StartedTestContainer;
  stop(): Promise<void>;
}

/** A throwaway Garage (`--single-node --default-bucket`) with random keys, for integration tests. */
export async function startTestStorage(): Promise<TestStorage> {
  const accessKeyId = `GK${randomBytes(12).toString("hex")}`;
  const secretAccessKey = randomBytes(32).toString("hex");
  const container = await new GenericContainer(GARAGE_IMAGE)
    .withCopyContentToContainer([{ content: GARAGE_TOML, target: "/etc/garage.toml" }])
    .withEnvironment({
      GARAGE_RPC_SECRET: randomBytes(32).toString("hex"),
      GARAGE_DEFAULT_ACCESS_KEY: accessKeyId,
      GARAGE_DEFAULT_SECRET_KEY: secretAccessKey,
      GARAGE_DEFAULT_BUCKET: TEST_BUCKET,
    })
    .withCommand(["/garage", "server", "--single-node", "--default-bucket"])
    .withExposedPorts(3900)
    .withWaitStrategy(Wait.forLogMessage(/S3 API server listening/))
    .start();
  const endpoint = `http://127.0.0.1:${container.getMappedPort(3900)}`;
  return {
    env: {
      OCW_S3_ENDPOINT: endpoint,
      OCW_S3_PUBLIC_URL: endpoint,
      OCW_S3_BUCKET: TEST_BUCKET,
      OCW_S3_REGION: "garage",
      OCW_S3_ACCESS_KEY_ID: accessKeyId,
      OCW_S3_SECRET_ACCESS_KEY: secretAccessKey,
    },
    endpoint,
    container,
    async stop() {
      await container.stop();
    },
  };
}

/** A file a test uploads as a person (`type` is the declared content type). */
export interface UploadFile {
  name: string;
  type: string;
  bytes: Uint8Array;
}

/**
 * A person's upload into `conversationId` through the public routes (07.15-03): presign (`POST
 * /api/v1/conversations/:id/attachments`), PUT to the signed URL with its headers, then `POST
 * /api/v1/attachments/:id/complete` unless `opts.complete` is false (the row stays `pending`). The file is not sent
 * with any message; post one with `attachmentIds` for that. Returns the attachment id; throws with the status and
 * body on any non-2xx answer.
 */
export async function uploadAttachment(
  client: TestClient,
  conversationId: string,
  file: UploadFile,
  opts: { complete?: boolean } = {},
): Promise<string> {
  const fail = (step: string, status: number, body: unknown): never => {
    throw new Error(`uploadAttachment ${step}: ${status} ${JSON.stringify(body)}`);
  };
  const presign = await client.request("POST", `/api/v1/conversations/${conversationId}/attachments`, {
    filename: file.name,
    contentType: file.type,
    size: file.bytes.length,
  });
  if (presign.status < 200 || presign.status > 299) fail("presign", presign.status, presign.body);
  const p = presign.body as {
    attachment: { id: string };
    upload: { url: string; headers: Record<string, string> };
  };
  const put = await fetch(p.upload.url, { method: "PUT", headers: p.upload.headers, body: file.bytes });
  if (!put.ok) fail("put", put.status, await put.text());
  if (opts.complete !== false) {
    const done = await client.request("POST", `/api/v1/attachments/${p.attachment.id}/complete`);
    if (done.status < 200 || done.status > 299) fail("complete", done.status, done.body);
  }
  return p.attachment.id;
}
