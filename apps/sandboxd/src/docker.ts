import http from "node:http";
import type { Duplex } from "node:stream";

/**
 * A minimal Docker Engine API client over the daemon's Unix socket (07.8-04, spike iii). Node built-ins only: JSON
 * requests, the hijacked stream exec start and attach need, and the 8-byte multiplexed-stream demuxer. No TCP: the
 * socket is the only transport.
 *
 * Versioned calls are pinned to API v1.45 (Docker Engine 26.0, the CVE-2024-29018 floor). `/version` and `/info` are
 * read unversioned so an older daemon can still say how old it is.
 */
export const DOCKER_API_VERSION = "v1.45";

export type DockerMethod = "GET" | "POST" | "DELETE";

export interface DockerResponse {
  status: number;
  /** Parsed JSON body, the raw text when it is not JSON, or null when empty. */
  body: unknown;
}

export interface DockerRequestOptions {
  /** Skip the API version prefix (only `/version` and `/info`). */
  unversioned?: boolean;
  timeoutMs?: number;
}

export interface Docker {
  request(
    method: DockerMethod,
    path: string,
    body?: unknown,
    options?: DockerRequestOptions,
  ): Promise<DockerResponse>;
  /** A hijacked connection (`Connection: Upgrade`, `Upgrade: tcp`): exec start and attach. */
  hijack(path: string, body: unknown): Promise<Duplex>;
}

/** The daemon could not be reached or answered something unusable. Never carries a request body. */
export class DockerUnavailableError extends Error {
  override readonly name = "DockerUnavailableError";
}

export function createDocker(options: { socketPath: string }): Docker {
  const { socketPath } = options;
  const fullPath = (path: string, unversioned?: boolean) =>
    unversioned ? path : `/${DOCKER_API_VERSION}${path}`;

  function request(
    method: DockerMethod,
    path: string,
    body?: unknown,
    opts: DockerRequestOptions = {},
  ): Promise<DockerResponse> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = http.request(
        {
          socketPath,
          method,
          path: fullPath(path, opts.unversioned),
          headers: {
            Host: "docker",
            ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
          },
          timeout: opts.timeoutMs ?? 60_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown = null;
            if (text.length > 0) {
              try {
                parsed = JSON.parse(text);
              } catch {
                parsed = text;
              }
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
          res.on("error", (err) => reject(new DockerUnavailableError(err.message)));
        },
      );
      req.on("timeout", () => req.destroy(new Error("docker request timed out")));
      req.on("error", (err) => reject(new DockerUnavailableError(err.message)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  function hijack(path: string, body: unknown): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body ?? {}));
      const req = http.request({
        socketPath,
        method: "POST",
        path: fullPath(path),
        headers: {
          Host: "docker",
          "Content-Type": "application/json",
          "Content-Length": payload.length,
          Connection: "Upgrade",
          Upgrade: "tcp",
        },
      });
      req.on("upgrade", (_res, socket, head) => {
        if (head.length > 0) socket.unshift(head);
        resolve(socket);
      });
      req.on("response", (res) => {
        res.resume();
        reject(new DockerUnavailableError(`hijack refused with ${res.statusCode ?? 0}`));
      });
      req.on("error", (err) => reject(new DockerUnavailableError(err.message)));
      req.write(payload);
      req.end();
    });
  }

  return { request, hijack };
}

export interface DemuxedFrame {
  /** 1 stdout, 2 stderr (0 stdin is folded into stdout). */
  stream: 1 | 2;
  data: Buffer;
}

/**
 * Docker's multiplexed stream (no TTY): each frame is an 8-byte header `[stream, 0, 0, 0, size (BE32)]` and `size`
 * payload bytes. Frames may be split across chunks in any place; `push` returns the frames completed so far.
 */
export class Demuxer {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): DemuxedFrame[] {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const frames: DemuxedFrame[] = [];
    let offset = 0;
    while (this.pending.length - offset >= 8) {
      const type = this.pending[offset] as number;
      const size = this.pending.readUInt32BE(offset + 4);
      if (this.pending.length - offset - 8 < size) break;
      const data = this.pending.subarray(offset + 8, offset + 8 + size);
      frames.push({ stream: type === 2 ? 2 : 1, data: Buffer.from(data) });
      offset += 8 + size;
    }
    this.pending = offset === 0 ? this.pending : Buffer.from(this.pending.subarray(offset));
    return frames;
  }

  /** Bytes of an incomplete frame still waiting for the rest. */
  get buffered(): number {
    return this.pending.length;
  }
}

/** Feeds a hijacked stream through a `Demuxer`; resolves when the stream ends or closes. */
export function demux(stream: Duplex, onFrame: (frame: DemuxedFrame) => void): Promise<void> {
  const demuxer = new Demuxer();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    stream.on("data", (chunk: Buffer) => {
      for (const frame of demuxer.push(chunk)) onFrame(frame);
    });
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", finish);
  });
}
