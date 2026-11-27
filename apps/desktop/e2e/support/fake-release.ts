// A fake desktop release on loopback for the update e2e (07.13.1, D-12): the platform's update manifest
// (latest-mac.yml, latest.yml or latest-linux.yml, in electron-builder's shape) and one payload under its release name,
// served by the test process itself on 127.0.0.1 and an ephemeral port. GET only; query strings (electron-updater's
// cache-busting `noCache`) are ignored. `corrupt` serves bytes whose sha512 differs from the manifest's (same size), so
// the download must be refused. Every request path is recorded for the spec's assertions. Nothing here reaches the
// network beyond loopback.

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRelease {
  /** Base URL of the feed (`http://127.0.0.1:<port>/`): the generic provider's `url`. */
  url: string;
  /** The manifest electron-updater asks for on this platform. */
  channelFile: string;
  /** The payload's release name, e.g. `OCW-v9.9.9-macos-arm64.zip`. */
  payloadName: string;
  /** Every request's path, in order (no query string). */
  requests: string[];
  /** How many times the payload was requested. */
  payloadRequests(): number;
  close(): Promise<void>;
}

/** The channel file electron-updater's generic provider requests (x64 Linux has no arch suffix). */
export function channelFileFor(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "latest-mac.yml";
  if (platform === "win32") return "latest.yml";
  if (platform === "linux") return "latest-linux.yml";
  throw new Error(`no desktop release for ${platform}`);
}

/** The release name of the file the platform's updater downloads (the names release.yml publishes). */
export function payloadNameFor(version: string, platform: NodeJS.Platform): string {
  if (platform === "darwin") return `OCW-v${version}-macos-arm64.zip`;
  if (platform === "win32") return `OCW-v${version}-windows-x64-setup.exe`;
  if (platform === "linux") return `OCW-v${version}-linux-x86_64.AppImage`;
  throw new Error(`no desktop release for ${platform}`);
}

function sha512Base64(data: Buffer): string {
  return createHash("sha512").update(data).digest("base64");
}

function manifest(version: string, name: string, sha512: string, size: number): string {
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${name}`,
    `    sha512: '${sha512}'`,
    `    size: ${size}`,
    `path: ${name}`,
    `sha512: '${sha512}'`,
    `releaseDate: '${new Date().toISOString()}'`,
    "",
  ].join("\n");
}

export function startFakeRelease(opts: {
  version: string;
  platform: NodeJS.Platform;
  payload: Buffer;
  corrupt?: boolean;
}): Promise<FakeRelease> {
  if (opts.payload.length === 0) throw new Error("the payload must not be empty");
  const channelFile = channelFileFor(opts.platform);
  const payloadName = payloadNameFor(opts.version, opts.platform);
  const yml = Buffer.from(
    manifest(opts.version, payloadName, sha512Base64(opts.payload), opts.payload.length),
    "utf8",
  );
  // Same size, one byte flipped: only the checksum can tell.
  const served = Buffer.from(opts.payload);
  if (opts.corrupt) served[0] = (served[0] ?? 0) ^ 0xff;
  const requests: string[] = [];

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    requests.push(path);
    if (req.method !== "GET") {
      res.writeHead(405, { allow: "GET" }).end();
      return;
    }
    if (path === `/${channelFile}`) {
      res.writeHead(200, { "content-type": "text/yaml; charset=utf-8", "content-length": yml.length });
      res.end(yml);
      return;
    }
    if (path === `/${payloadName}`) {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": served.length });
      res.end(served);
      return;
    }
    res.writeHead(404).end();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        channelFile,
        payloadName,
        requests,
        payloadRequests: () => requests.filter((p) => p === `/${payloadName}`).length,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
