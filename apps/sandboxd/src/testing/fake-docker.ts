import { Duplex, PassThrough, type Readable } from "node:stream";
import type { Docker, DockerMethod, DockerRequestOptions, DockerResponse } from "../docker";

/**
 * An in-memory Docker Engine double for sandboxd's unit tests (07.8-09). It answers only the Engine API calls sandboxd
 * makes, logs every call, runs execs through a scripted handler (stdin captured, stdout framed like the real daemon)
 * and lets a test push Docker events. Test code only: nothing in `src/` outside tests imports it.
 */

export interface FakeObject {
  Id: string;
  Name: string;
  Labels: Record<string, string>;
  Running: boolean;
  Internal?: boolean;
  Spec?: Record<string, unknown>;
  /** Cumulative CPU nanoseconds reported by stats. */
  cpuNs?: number;
}

export interface ExecCall {
  id: string;
  containerId: string;
  cmd: string[];
  user: string;
  attachStdin: boolean;
  stdin: Buffer;
}

export interface ExecReply {
  exitCode: number;
  stdout?: Buffer | string;
  stderr?: Buffer | string;
}

export type ExecHandler = (call: ExecCall) => ExecReply | Promise<ExecReply>;

function frame(stream: 1 | 2, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

export class FakeDocker implements Docker {
  calls: { method: DockerMethod | "STREAM" | "HIJACK"; path: string; body?: unknown }[] = [];
  containers = new Map<string, FakeObject>();
  networks = new Map<string, FakeObject>();
  volumes = new Map<string, FakeObject>();
  execs = new Map<string, ExecCall & { exitCode: number | null }>();
  onExec: ExecHandler = () => ({ exitCode: 0 });
  /** The Docker events stream the broker follows (push JSON lines with `emitEvent`). */
  eventStreams: PassThrough[] = [];
  private seq = 0;

  constructor(
    public version = "29.6.2",
    public runtimes: string[] = ["io.containerd.runc.v2", "runc"],
  ) {}

  private id(prefix = "id") {
    this.seq += 1;
    return `${prefix}${this.seq}`.padEnd(12, "0");
  }

  find(map: Map<string, FakeObject>, ref: string) {
    return map.get(ref) ?? [...map.values()].find((o) => o.Id === ref) ?? null;
  }

  container(ref: string) {
    return this.find(this.containers, ref);
  }

  async request(
    method: DockerMethod,
    rawPath: string,
    body?: unknown,
    _options?: DockerRequestOptions,
  ): Promise<DockerResponse> {
    this.calls.push({ method, path: rawPath, body });
    const url = new URL(rawPath, "http://docker");
    const path = decodeURIComponent(url.pathname);
    const json = (status: number, b: unknown = null) => ({ status, body: b });
    if (method === "GET" && path === "/version") return json(200, { Version: this.version });
    if (method === "GET" && path === "/info") {
      return json(200, { Runtimes: Object.fromEntries(this.runtimes.map((r) => [r, { path: r }])) });
    }
    let m = /^\/containers\/([^/]+)\/json$/.exec(path);
    if (method === "GET" && m) {
      const c = this.container(m[1] as string);
      if (!c) return json(404, { message: "No such container" });
      const spec = (c.Spec ?? {}) as { HostConfig?: Record<string, unknown> };
      return json(200, {
        Id: c.Id,
        Name: `/${c.Name}`,
        Config: { Labels: c.Labels },
        State: {
          Running: c.Running,
          Status: c.Running ? "running" : "exited",
          StartedAt: "2026-10-15T10:00:00Z",
        },
        HostConfig: spec.HostConfig ?? { Runtime: "runc" },
      });
    }
    m = /^\/containers\/([^/]+)\/stats$/.exec(path);
    if (method === "GET" && m) {
      const c = this.container(m[1] as string);
      if (!c) return json(404);
      return json(200, { cpu_stats: { cpu_usage: { total_usage: c.Running ? (c.cpuNs ?? 0) : 0 } } });
    }
    m = /^\/networks\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      const n = this.find(this.networks, m[1] as string);
      return n ? json(200, { Id: n.Id, Name: n.Name, Labels: n.Labels, Internal: n.Internal }) : json(404);
    }
    m = /^\/volumes\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      const v = this.find(this.volumes, m[1] as string);
      return v ? json(200, { Name: v.Name, Labels: v.Labels }) : json(404);
    }
    if (method === "POST" && path === "/networks/create") {
      const b = body as { Name: string; Labels: Record<string, string>; Internal: boolean };
      this.networks.set(b.Name, {
        Id: this.id(),
        Name: b.Name,
        Labels: b.Labels,
        Running: false,
        Internal: b.Internal,
      });
      return json(201, {});
    }
    if (method === "POST" && path === "/volumes/create") {
      const b = body as { Name: string; Labels: Record<string, string> };
      this.volumes.set(b.Name, { Id: b.Name, Name: b.Name, Labels: b.Labels, Running: false });
      return json(201, {});
    }
    if (method === "POST" && path === "/containers/create") {
      const name = url.searchParams.get("name") as string;
      if (this.containers.has(name)) return json(409);
      const b = body as { Labels: Record<string, string> } & Record<string, unknown>;
      this.containers.set(name, { Id: this.id(), Name: name, Labels: b.Labels, Running: false, Spec: b });
      return json(201, {});
    }
    m = /^\/containers\/([^/]+)$/.exec(path);
    if (method === "DELETE" && m) {
      const c = this.container(m[1] as string);
      if (!c) return json(404);
      this.containers.delete(c.Name);
      return json(204);
    }
    m = /^\/containers\/([^/]+)\/(start|stop|kill|restart|exec)$/.exec(path);
    if (method === "POST" && m) {
      const c = this.container(m[1] as string);
      if (!c) return json(404);
      if (m[2] === "exec") {
        const b = body as { Cmd: string[]; User: string; AttachStdin?: boolean };
        const id = this.id("exec");
        this.execs.set(id, {
          id,
          containerId: c.Id,
          cmd: b.Cmd,
          user: b.User,
          attachStdin: b.AttachStdin === true,
          stdin: Buffer.alloc(0),
          exitCode: null,
        });
        return json(201, { Id: id });
      }
      c.Running = m[2] === "start" || m[2] === "restart";
      return json(204);
    }
    m = /^\/exec\/([^/]+)\/json$/.exec(path);
    if (method === "GET" && m) {
      const e = this.execs.get(m[1] as string);
      if (!e) return json(404);
      return json(200, { Running: e.exitCode === null, ExitCode: e.exitCode ?? 0 });
    }
    if (method === "GET" && path === "/containers/json") {
      const want = (JSON.parse(url.searchParams.get("filters") ?? "{}").label ?? []) as string[];
      const all = url.searchParams.get("all") === "1";
      return json(
        200,
        [...this.containers.values()]
          .filter((c) => all || c.Running)
          .filter((c) =>
            want.every((kv) => c.Labels[kv.split("=")[0] as string] === kv.split("=").slice(1).join("=")),
          )
          .map((c) => ({
            Id: c.Id,
            Names: [`/${c.Name}`],
            State: c.Running ? "running" : "exited",
            Labels: c.Labels,
          })),
      );
    }
    if (method === "GET" && path === "/networks") {
      const want = (JSON.parse(url.searchParams.get("filters") ?? "{}").label ?? []) as string[];
      // Without a label filter, the default networks only (as a fresh Docker would list them).
      if (want.length === 0) return json(200, []);
      return json(
        200,
        [...this.networks.values()]
          .filter((n) =>
            want.every((kv) => n.Labels[kv.split("=")[0] as string] === kv.split("=").slice(1).join("=")),
          )
          .map((n) => ({ Id: n.Id, Name: n.Name, Labels: n.Labels })),
      );
    }
    m = /^\/networks\/([^/]+)$/.exec(path);
    if (method === "DELETE" && m) {
      const n = this.find(this.networks, m[1] as string);
      if (!n) return json(404);
      this.networks.delete(n.Name);
      return json(204);
    }
    if (method === "GET" && path === "/volumes") {
      const want = (JSON.parse(url.searchParams.get("filters") ?? "{}").label ?? []) as string[];
      return json(200, {
        Volumes: [...this.volumes.values()]
          .filter((v) =>
            want.every((kv) => v.Labels[kv.split("=")[0] as string] === kv.split("=").slice(1).join("=")),
          )
          .map((v) => ({ Name: v.Name, Labels: v.Labels })),
      });
    }
    return json(404);
  }

  async hijack(path: string, body: unknown): Promise<Duplex> {
    this.calls.push({ method: "HIJACK", path, body });
    const m = /^\/exec\/([^/]+)\/start$/.exec(path);
    const exec = m ? this.execs.get(m[1] as string) : undefined;
    if (!exec) {
      const s = new PassThrough();
      s.end();
      return s;
    }
    const chunks: Buffer[] = [];
    let produced = false;
    const run = async (stream: Duplex) => {
      if (produced) return;
      produced = true;
      exec.stdin = Buffer.concat(chunks);
      const reply = await this.onExec(exec);
      const out = reply.stdout === undefined ? Buffer.alloc(0) : Buffer.from(reply.stdout);
      const err = reply.stderr === undefined ? Buffer.alloc(0) : Buffer.from(reply.stderr);
      exec.exitCode = reply.exitCode;
      if (out.length > 0) stream.push(frame(1, out));
      if (err.length > 0) stream.push(frame(2, err));
      stream.push(null);
    };
    const duplex: Duplex = new Duplex({
      read() {},
      write(chunk: Buffer, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
      final(cb) {
        void run(duplex).then(() => cb(), cb);
      },
    });
    if (!exec.attachStdin) setImmediate(() => void run(duplex));
    return duplex;
  }

  async stream(path: string): Promise<Readable> {
    this.calls.push({ method: "STREAM", path });
    const s = new PassThrough();
    this.eventStreams.push(s);
    return s;
  }

  /** Pushes one Docker event (a JSON line) to every open events stream. */
  emitEvent(event: Record<string, unknown>) {
    for (const s of this.eventStreams) s.write(`${JSON.stringify(event)}\n`);
  }

  get execCreates() {
    return this.calls.filter((c) => c.method === "POST" && /\/exec$/.test(c.path));
  }

  get containerCreates() {
    return this.calls.filter((c) => c.method === "POST" && c.path.startsWith("/containers/create"));
  }
}
