import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  RUNTIME_BUNDLE_FILE,
  RUNTIME_EXTERNAL_LOCK_FILE,
  RUNTIME_ROUTES,
  RuntimeDistManifest,
} from "@ocw/contracts";
import type { FastifyBaseLogger } from "fastify";
import type { App, Core } from "../../core";
import { HttpError } from "../../lib/errors";
import { renderInstallScript } from "./install-script";

/**
 * Phase 07.12-06 (HSR-01, D-01, D-13, PD-05): the workspace serves its own Local Runtime, so a server installs it from
 * the same origin as the web app (no npm publish, no third-party host, principle 10).
 *
 * Four public, read-only routes under `/api/v1/runtime/` (no session exists on a server yet; nothing tenant-scoped is
 * read), each limited to 30 requests per minute per client IP: `version` (the manifest), `bundle` (the file),
 * `bundle.sha256` (its checksum line) and `install.sh` (rendered from `OCW_PUBLIC_API_URL`, never from Host or
 * X-Forwarded-Host). The dist directory is `OCW_RUNTIME_DIST_DIR`, else this checkout's `apps/local-runtime/dist`.
 * It is read on first use and re-hashed against its manifest (the bundle's sha256 and bytes, and the sha256 of the npm
 * lockfile `install.sh` embeds, 07.12 review ME-03); only a verified load is cached (until
 * the API restarts). A missing dist answers 404 `runtime_unavailable` and a mismatching one 503 `runtime_corrupt`, both
 * re-checked on the next request.
 */

const MANIFEST_FILE = "manifest.json";

/** `apps/local-runtime/dist` of this checkout (this file is `apps/api/src/modules/device/distribution.ts`). */
export function defaultRuntimeDistDir(): string {
  return resolve(import.meta.dirname, "..", "..", "..", "..", "local-runtime", "dist");
}

export interface RuntimeDist {
  manifest: RuntimeDistManifest;
  bundle: Buffer;
  /** The npm lockfile embedded in install.sh (hashed in the manifest). */
  externalLock: string;
  /** `"<sha256>"`, the bundle's strong ETag. */
  etag: string;
}

export type RuntimeDistLoad = RuntimeDist | "missing" | "corrupt";

const isMissing = (err: unknown) =>
  typeof err === "object" &&
  err !== null &&
  "code" in err &&
  (err.code === "ENOENT" || err.code === "ENOTDIR");

/** Loads, verifies and caches one dist directory (see the module comment). */
export class RuntimeDistStore {
  private verified: RuntimeDist | null = null;
  private pending: Promise<RuntimeDistLoad> | null = null;
  /** The last unverified answer, so a broken dist is logged once per change, not on every request. */
  private lastBad: "missing" | "corrupt" | null = null;

  constructor(
    readonly dir: string,
    private readonly log?: FastifyBaseLogger,
  ) {}

  /** The verified dist, `"missing"` or `"corrupt"`. Concurrent first requests share one read. */
  load(): Promise<RuntimeDistLoad> {
    if (this.verified) return Promise.resolve(this.verified);
    if (!this.pending) {
      this.pending = this.read()
        .then((res) => {
          if (typeof res === "string" && res !== this.lastBad) {
            this.log?.warn(
              `runtime dist: ${res}; the runtime routes answer ${res === "missing" ? 404 : 503}`,
            );
          }
          this.lastBad = typeof res === "string" ? res : null;
          return res;
        })
        .finally(() => {
          this.pending = null;
        });
    }
    return this.pending;
  }

  private async read(): Promise<RuntimeDistLoad> {
    let manifestText: string;
    let bundle: Buffer;
    let lock: Buffer;
    try {
      manifestText = await readFile(join(this.dir, MANIFEST_FILE), "utf8");
      bundle = await readFile(join(this.dir, RUNTIME_BUNDLE_FILE));
      lock = await readFile(join(this.dir, RUNTIME_EXTERNAL_LOCK_FILE));
    } catch (err) {
      if (isMissing(err)) return "missing";
      throw err;
    }
    let manifest: RuntimeDistManifest;
    try {
      manifest = RuntimeDistManifest.parse(JSON.parse(manifestText));
    } catch {
      return "corrupt";
    }
    const sha256 = createHash("sha256").update(bundle).digest("hex");
    if (sha256 !== manifest.sha256 || bundle.length !== manifest.bytes) return "corrupt";
    // The lockfile install.sh embeds (ME-03): the bytes the build hashed into the manifest, or nothing is served.
    if (createHash("sha256").update(lock).digest("hex") !== manifest.externalLockSha256) return "corrupt";
    this.verified = { manifest, bundle, externalLock: lock.toString("utf8"), etag: `"${manifest.sha256}"` };
    return this.verified;
  }
}

const runtimeUnavailable = () =>
  new HttpError(
    404,
    "runtime_unavailable",
    "This workspace does not serve the Local Runtime (no bundle was built)",
  );
const runtimeCorrupt = () =>
  new HttpError(
    503,
    "runtime_corrupt",
    "The Local Runtime bundle on this workspace does not match its manifest",
  );

/** Strips `/api/v1` from a contract route: the routes register inside the device module's `/api/v1` scope. */
const scoped = (route: string) => route.replace(/^\/api\/v1/, "");

export function registerRuntimeDistRoutes(app: App, core: Core): void {
  const store = new RuntimeDistStore(core.env.OCW_RUNTIME_DIST_DIR ?? defaultRuntimeDistDir(), core.log);
  let script: { sha256: string; text: string } | null = null;

  const need = async (): Promise<RuntimeDist> => {
    const dist = await store.load();
    if (dist === "missing") throw runtimeUnavailable();
    if (dist === "corrupt") throw runtimeCorrupt();
    return dist;
  };

  const route = {
    // A server has no session before it is paired; these routes read no organization data.
    config: { authz: "public" as const, rateLimit: { max: 30, timeWindow: "1 minute" } },
  };
  const tags = ["runtime"];

  app.get(
    scoped(RUNTIME_ROUTES.version),
    { ...route, schema: { tags, response: { 200: RuntimeDistManifest } } },
    async (_req, reply) => {
      const { manifest } = await need();
      return reply.header("cache-control", "no-cache").type("application/json; charset=utf-8").send(manifest);
    },
  );

  app.get(scoped(RUNTIME_ROUTES.bundle), { ...route, schema: { tags } }, async (req, reply) => {
    const { manifest, bundle, etag } = await need();
    reply
      .header("cache-control", "no-cache")
      .header("etag", etag)
      .header("x-content-sha256", manifest.sha256);
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();
    return reply
      .header("content-disposition", `attachment; filename="${RUNTIME_BUNDLE_FILE}"`)
      .type("application/javascript; charset=utf-8")
      .send(bundle);
  });

  app.get(scoped(RUNTIME_ROUTES.bundleSha256), { ...route, schema: { tags } }, async (_req, reply) => {
    const { manifest } = await need();
    return reply
      .header("cache-control", "no-cache")
      .type("text/plain; charset=utf-8")
      .send(`${manifest.sha256}  ${RUNTIME_BUNDLE_FILE}\n`);
  });

  app.get(scoped(RUNTIME_ROUTES.installScript), { ...route, schema: { tags } }, async (_req, reply) => {
    const dist = await need();
    const { manifest } = dist;
    if (script?.sha256 !== manifest.sha256) {
      try {
        // The URL is the configured public API URL only: a Host or X-Forwarded-Host header never reaches the script.
        script = {
          sha256: manifest.sha256,
          text: renderInstallScript({
            serverUrl: core.env.OCW_PUBLIC_API_URL,
            manifest,
            externalLock: dist.externalLock,
          }),
        };
      } catch (err) {
        core.log.error({ err }, "runtime dist: OCW_PUBLIC_API_URL cannot be embedded in install.sh");
        throw new HttpError(
          503,
          "install_script_unavailable",
          "This workspace's public API URL cannot be embedded in the install script",
        );
      }
    }
    return reply
      .header("cache-control", "no-cache")
      .type("text/x-shellscript; charset=utf-8")
      .send(script.text);
  });
}
