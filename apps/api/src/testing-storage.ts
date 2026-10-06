import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";

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
