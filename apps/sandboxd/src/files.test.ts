import { SANDBOX_LIMITS, SandboxFileList } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { createFiles, OCW_FILES } from "./files";
import { createSandboxes, type RunOptions, type RunResult, type WorkspaceHandle } from "./sandboxes";
import { nameFor } from "./spec";
import { type ExecCall, FakeDocker } from "./testing/fake-docker";

const ORG = "0199f0a0-0000-7000-8000-00000000000a";
const AGENT = "0199f0a0-1111-7000-8000-00000000000b";
const NS = "ocw-unit";
const target = { orgId: ORG, agentId: AGENT };

/**
 * A tiny in-memory stand-in for `ocw-files` (infra/sandbox/sbx/ocw-files): same subcommands, outputs and exit codes,
 * so these tests prove sandboxd's parsing, caps and error mapping. The real helper is proven on real Docker by
 * `run-sandbox-smoke.sh --only files`.
 */
class MiniWorkspace {
  files = new Map<string, Buffer>();
  dirs = new Set<string>();
  /** Paths whose `realpath` resolves outside /workspace (a symlink to /etc/passwd, say). */
  escapes = new Set<string>();
  calls: { cmd: string[]; stdin?: Buffer }[] = [];

  run = async (_h: WorkspaceHandle, cmd: string[], opts: RunOptions = {}): Promise<RunResult> => {
    this.calls.push({ cmd, stdin: opts.stdin });
    const reply = this.exec(cmd, opts.stdin ?? Buffer.alloc(0));
    return { exitCode: reply.code, stdout: reply.out ?? Buffer.alloc(0), overflow: false };
  };

  private exec(cmd: string[], stdin: Buffer): { code: number; out?: Buffer } {
    expect(cmd[0]).toBe(OCW_FILES);
    const [, sub, path = "", a, b] = cmd;
    if (this.escapes.has(path)) return { code: 3 };
    const out = (s: string | Buffer) => ({ code: 0, out: Buffer.from(s) });
    switch (sub) {
      case "list": {
        if (path !== "" && !this.dirs.has(path)) return { code: this.files.has(path) ? 6 : 4 };
        const prefix = path === "" ? "" : `${path}/`;
        const recs: string[] = [];
        for (const d of this.dirs) {
          const rest = d.slice(prefix.length);
          if (d.startsWith(prefix) && rest && !rest.includes("/")) recs.push(`${rest}/d/0/1760500000.5`);
        }
        for (const [f, data] of this.files) {
          const rest = f.slice(prefix.length);
          if (f.startsWith(prefix) && !rest.includes("/")) recs.push(`${rest}/f/${data.length}/1760500000.5`);
        }
        const visible = recs.filter((r) => a === "1" || !r.startsWith("."));
        return out(`${visible.length}\0${visible.join("\0")}${visible.length ? "\0" : ""}`);
      }
      case "stat": {
        if (this.dirs.has(path)) return out("d/0/1760500000.5");
        const f = this.files.get(path);
        return f ? out(`f/${f.length}/1760500000.5`) : { code: 4 };
      }
      case "read": {
        const f = this.files.get(path);
        if (!f) return { code: this.dirs.has(path) ? 6 : 4 };
        const offset = Number(a);
        const limit = Number(b);
        return out(Buffer.concat([Buffer.from(`${f.length}\n`), f.subarray(offset, offset + limit)]));
      }
      case "cat": {
        const f = this.files.get(path);
        return f ? out(f) : { code: 4 };
      }
      case "write": {
        if (this.dirs.has(path)) return { code: 6 };
        if (a === "create" && this.files.has(path)) return { code: 5 };
        const prev = a === "append" ? (this.files.get(path) ?? Buffer.alloc(0)) : Buffer.alloc(0);
        const next = Buffer.concat([prev, stdin]);
        this.files.set(path, next);
        return out(String(next.length));
      }
      case "rm": {
        if (this.files.delete(path)) return out("1");
        if (!this.dirs.has(path)) return { code: 4 };
        const inside = [...this.files.keys()].filter((p) => p.startsWith(`${path}/`));
        if (a !== "1" && inside.length > 0) return { code: 7 };
        for (const p of inside) this.files.delete(p);
        this.dirs.delete(path);
        return out(String(inside.length + 1));
      }
      default:
        return { code: 2 };
    }
  }
}

function setup(ws = new MiniWorkspace()) {
  const room: { incoming: number[]; full: boolean } = { incoming: [], full: false };
  const changed: string[] = [];
  const files = createFiles({
    sandboxes: {
      workspace: async () => ({ containerId: "c1", kind: "sbx" }),
      run: ws.run,
    },
    quota: {
      async assertRoom(_t, incoming) {
        room.incoming.push(incoming);
        if (room.full) {
          const { SandboxdFailure } = await import("./sandboxes");
          throw new SandboxdFailure("disk_full", 409, "the workspace is over its quota");
        }
      },
      async afterChange(t) {
        changed.push(t.agentId);
      },
    },
  });
  return { ws, files, room, changed };
}

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return err as { code: string; status: number };
  }
  throw new Error("expected a refusal");
}

describe("files: confinement to /workspace (D-04, Pitfalls 4-5, T-07.8-09-01)", () => {
  it("a path that realpath resolves outside /workspace → 422 invalid_path for every op", async () => {
    const { ws, files } = setup();
    ws.escapes.add("leak");
    const ops = [
      files.list({ target, path: "leak", hidden: true }),
      files.stat({ target, path: "leak" }),
      files.read({ target, path: "leak", offset: 0, limit: 10 }),
      files.write({ target, path: "leak", content: "x", encoding: "utf8", mode: "overwrite" }),
      files.remove({ target, path: "leak", recursive: false }),
      files.upload({ target, path: "leak", data: "eA==", overwrite: true }),
      files.download({ target, path: "leak" }),
    ];
    for (const op of ops) expect(await refusal(op)).toMatchObject({ code: "invalid_path", status: 422 });
  });

  it("passes the workspace-relative path as one argv item to ocw-files, never through a shell", async () => {
    const { ws, files } = setup();
    ws.files.set("a b;$(id).txt", Buffer.from("x"));
    await files.read({ target, path: "a b;$(id).txt", offset: 0, limit: 10 });
    expect(ws.calls[0]?.cmd).toEqual([OCW_FILES, "read", "a b;$(id).txt", "0", "10"]);
  });
});

describe("files: list", () => {
  it("caps at 500 entries, reports the rest in more, folders first then files by name", async () => {
    const { ws, files } = setup();
    for (let i = 0; i < 520; i++) ws.files.set(`f${String(i).padStart(3, "0")}.txt`, Buffer.from("x"));
    ws.dirs.add("zeta");
    ws.dirs.add("alpha");
    const list = await files.list({ target, path: "", hidden: true });
    expect(SandboxFileList.safeParse(list).success).toBe(true);
    expect(list.entries).toHaveLength(SANDBOX_LIMITS.listMaxEntries);
    expect(list.more).toBe(522 - 500);
    expect(list.entries.slice(0, 3).map((e) => [e.name, e.kind])).toEqual([
      ["alpha", "dir"],
      ["zeta", "dir"],
      ["f000.txt", "file"],
    ]);
    expect(list.entries[0]).toMatchObject({ path: "alpha", size: null, hidden: false });
    expect(list.entries[2]).toMatchObject({ path: "f000.txt", size: 1 });
    expect(list.entries[2]?.modifiedAt).toBe(new Date(1_760_500_000_500).toISOString());
  });

  it("lists a subfolder with full relative paths and marks dot files hidden", async () => {
    const { ws, files } = setup();
    ws.dirs.add("reports");
    ws.files.set("reports/q3.csv", Buffer.from("a,b\n"));
    ws.files.set("reports/.cache", Buffer.from(""));
    const list = await files.list({ target, path: "reports", hidden: true });
    expect(list.entries.map((e) => [e.path, e.hidden])).toEqual([
      ["reports/.cache", true],
      ["reports/q3.csv", false],
    ]);
    expect(ws.calls[0]?.cmd).toEqual([
      OCW_FILES,
      "list",
      "reports",
      "1",
      String(SANDBOX_LIMITS.listMaxEntries),
    ]);
  });

  it("a missing folder → 404 not_found; a file → 422 invalid_path", async () => {
    const { ws, files } = setup();
    ws.files.set("x.txt", Buffer.from("x"));
    expect(await refusal(files.list({ target, path: "nope", hidden: true }))).toMatchObject({
      code: "not_found",
      status: 404,
    });
    expect(await refusal(files.list({ target, path: "x.txt", hidden: true }))).toMatchObject({
      code: "invalid_path",
    });
  });
});

describe("files: read", () => {
  it("over readMaxBytes returns the first bytes with truncated and the whole size", async () => {
    const { ws, files } = setup();
    const big = Buffer.alloc(SANDBOX_LIMITS.readMaxBytes + 1000, "a");
    ws.files.set("big.txt", big);
    const res = await files.read({ target, path: "big.txt", offset: 0, limit: SANDBOX_LIMITS.readMaxBytes });
    expect(res).toMatchObject({ path: "big.txt", encoding: "utf8", size: big.length, truncated: true });
    expect(res.content.length).toBe(SANDBOX_LIMITS.readMaxBytes);
  });

  it("text is utf8; a range at the end is not truncated", async () => {
    const { ws, files } = setup();
    ws.files.set("t.txt", Buffer.from("héllo wörld"));
    const res = await files.read({ target, path: "t.txt", offset: 7, limit: 100 });
    expect(res).toMatchObject({ content: "wörld", encoding: "utf8", truncated: false, size: 13 });
  });

  it("a folder → 422 invalid_path; a missing file → 404 not_found", async () => {
    const { ws, files } = setup();
    ws.dirs.add("d");
    expect(await refusal(files.read({ target, path: "d", offset: 0, limit: 5 }))).toMatchObject({
      code: "invalid_path",
    });
    expect(await refusal(files.read({ target, path: "nope", offset: 0, limit: 5 }))).toMatchObject({
      code: "not_found",
    });
  });
});

describe("files: write, upload, download, delete", () => {
  it("write in create mode on an existing file → 409 exists", async () => {
    const { ws, files } = setup();
    ws.files.set("a.txt", Buffer.from("old"));
    expect(
      await refusal(files.write({ target, path: "a.txt", content: "new", encoding: "utf8", mode: "create" })),
    ).toMatchObject({ code: "exists", status: 409 });
    expect(ws.files.get("a.txt")?.toString()).toBe("old");
  });

  it("binary content round-trips as base64 (write → read → download)", async () => {
    const { files } = setup();
    const bytes = Buffer.from([0, 1, 2, 0xff, 0xfe, 0x80, 0x00, 0x7f]);
    const written = await files.write({
      target,
      path: "bin/x.dat",
      content: bytes.toString("base64"),
      encoding: "base64",
      mode: "overwrite",
    });
    expect(written).toEqual({ path: "bin/x.dat", size: bytes.length });
    const read = await files.read({ target, path: "bin/x.dat", offset: 0, limit: 100 });
    expect(read.encoding).toBe("base64");
    expect(Buffer.from(read.content, "base64").equals(bytes)).toBe(true);
    const down = await files.download({ target, path: "bin/x.dat" });
    expect(down).toMatchObject({ path: "bin/x.dat", name: "x.dat", size: bytes.length });
    expect(Buffer.from(down.data, "base64").equals(bytes)).toBe(true);
  });

  it("append mode adds to the file; the bytes travel on stdin, never in argv", async () => {
    const { ws, files } = setup();
    await files.write({ target, path: "log.txt", content: "one\n", encoding: "utf8", mode: "append" });
    const res = await files.write({
      target,
      path: "log.txt",
      content: "two\n",
      encoding: "utf8",
      mode: "append",
    });
    expect(res.size).toBe(8);
    expect(ws.files.get("log.txt")?.toString()).toBe("one\ntwo\n");
    for (const c of ws.calls) expect(c.cmd.join(" ")).not.toContain("two");
  });

  it("upload without overwrite on an existing file → 409 exists; with overwrite → replaced", async () => {
    const { ws, files } = setup();
    ws.files.set("up.bin", Buffer.from("old"));
    const data = Buffer.from("new bytes").toString("base64");
    expect(await refusal(files.upload({ target, path: "up.bin", data, overwrite: false }))).toMatchObject({
      code: "exists",
    });
    expect(await files.upload({ target, path: "up.bin", data, overwrite: true })).toEqual({
      path: "up.bin",
      size: 9,
    });
  });

  it("checks room for the decoded size before any byte is written; disk_full writes nothing", async () => {
    const { ws, files, room } = setup();
    const data = Buffer.alloc(3000, 7).toString("base64");
    await files.upload({ target, path: "a.bin", data, overwrite: false });
    expect(room.incoming).toEqual([3000]);
    room.full = true;
    const before = ws.calls.length;
    expect(await refusal(files.upload({ target, path: "b.bin", data, overwrite: false }))).toMatchObject({
      code: "disk_full",
      status: 409,
    });
    expect(
      await refusal(files.write({ target, path: "c.txt", content: "x", encoding: "utf8", mode: "create" })),
    ).toMatchObject({ code: "disk_full" });
    expect(ws.calls.slice(before).filter((c) => c.cmd[1] === "write")).toHaveLength(0);
    expect(ws.files.has("b.bin")).toBe(false);
  });

  it("refuses a write over writeMaxBytes with 413 too_large before the helper runs", async () => {
    const { ws, files } = setup();
    const content = Buffer.alloc(SANDBOX_LIMITS.writeMaxBytes + 1, 1).toString("base64");
    expect(
      await refusal(files.write({ target, path: "x", content, encoding: "base64", mode: "overwrite" })),
    ).toMatchObject({ code: "too_large", status: 413 });
    expect(ws.calls).toHaveLength(0);
  });

  it("download of a folder → invalid_path; of a file over uploadMaxBytes → 413 too_large", async () => {
    const { ws, files } = setup();
    ws.dirs.add("d");
    expect(await refusal(files.download({ target, path: "d" }))).toMatchObject({ code: "invalid_path" });
    ws.files.set("huge", Buffer.alloc(0));
    const real = ws.run;
    ws.run = async (h, cmd, opts) =>
      cmd[1] === "stat"
        ? {
            exitCode: 0,
            stdout: Buffer.from(`f/${SANDBOX_LIMITS.uploadMaxBytes + 1}/1760500000`),
            overflow: false,
          }
        : real(h, cmd, opts);
    const { files: files2 } = setup(ws);
    expect(await refusal(files2.download({ target, path: "huge" }))).toMatchObject({
      code: "too_large",
      status: 413,
    });
    expect(ws.calls.filter((c) => c.cmd[1] === "cat")).toHaveLength(0);
  });

  it("delete: a non-empty folder needs recursive (409 busy); recursive counts entries and re-measures", async () => {
    const { ws, files, changed } = setup();
    ws.dirs.add("reports");
    ws.files.set("reports/a", Buffer.from("1"));
    ws.files.set("reports/b", Buffer.from("2"));
    expect(await refusal(files.remove({ target, path: "reports", recursive: false }))).toMatchObject({
      code: "busy",
      status: 409,
    });
    expect(await files.remove({ target, path: "reports", recursive: true })).toEqual({
      path: "reports",
      deleted: 3,
    });
    expect(changed).toEqual([AGENT]);
    expect(await refusal(files.remove({ target, path: "reports", recursive: true }))).toMatchObject({
      code: "not_found",
    });
  });
});

describe("files through sandboxd's containers (D-01, D-04, D-09, T-07.8-09-02)", () => {
  function helperDocker() {
    const docker = new FakeDocker();
    const seen: ExecCall[] = [];
    docker.onExec = (call) => {
      seen.push(call);
      if (call.cmd[1] === "list") return { exitCode: 0, stdout: "1\0a.txt/f/3/1760500000\0" };
      if (call.cmd[1] === "write") return { exitCode: 0, stdout: String(call.stdin.length) };
      return { exitCode: 0 };
    };
    return { docker, seen };
  }

  it("runs ocw-files as 10001 in the running sbx, with bytes on stdin and no archive API call", async () => {
    const { docker, seen } = helperDocker();
    const sandboxes = createSandboxes({ docker, ns: NS, runtime: "auto", image: "sbx:test" });
    await sandboxes.ensure(target);
    const files = createFiles({
      sandboxes,
      quota: { assertRoom: async () => {}, afterChange: async () => {} },
    });
    await files.list({ target, path: "", hidden: true });
    await files.upload({
      target,
      path: "u.bin",
      data: Buffer.from("hello").toString("base64"),
      overwrite: false,
    });
    const sbx = docker.container(nameFor("sbx", NS, AGENT));
    expect(seen.map((c) => [c.containerId, c.user, c.cmd[0], c.cmd[1]])).toEqual([
      [sbx?.Id, "10001:10001", OCW_FILES, "list"],
      [sbx?.Id, "10001:10001", OCW_FILES, "write"],
    ]);
    expect(seen[1]?.attachStdin).toBe(true);
    expect(seen[1]?.stdin.toString()).toBe("hello");
    expect(docker.calls.some((c) => c.path.includes("/archive"))).toBe(false);
  });

  it("on a stopped sandbox, uses a files helper on the same volume with no network, and leaves the sbx stopped", async () => {
    const { docker, seen } = helperDocker();
    const sandboxes = createSandboxes({ docker, ns: NS, runtime: "auto", image: "sbx:test" });
    await sandboxes.ensure(target);
    await sandboxes.stop({ target, reason: "user" });
    const files = createFiles({
      sandboxes,
      quota: { assertRoom: async () => {}, afterChange: async () => {} },
    });
    await files.list({ target, path: "", hidden: true });

    const sbx = docker.container(nameFor("sbx", NS, AGENT));
    expect(sbx?.Running).toBe(false);
    const helper = docker.container(nameFor("files", NS, AGENT));
    expect(helper?.Running).toBe(true);
    const spec = helper?.Spec as {
      User: string;
      Cmd: string[];
      Labels: Record<string, string>;
      HostConfig: { NetworkMode: string; Mounts: unknown[]; ReadonlyRootfs: boolean; CapDrop: string[] };
    };
    expect(spec.User).toBe("10001:10001");
    expect(spec.Cmd).toEqual(["sleep", "300"]);
    expect(spec.Labels).toMatchObject({
      "ocw.kind": "files",
      "ocw.org": ORG,
      "ocw.agent": AGENT,
      "ocw.namespace": NS,
    });
    expect(spec.HostConfig.NetworkMode).toBe("none");
    expect(spec.HostConfig.ReadonlyRootfs).toBe(true);
    expect(spec.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(spec.HostConfig.Mounts).toEqual([
      { Type: "volume", Source: nameFor("ws", NS, AGENT), Target: "/workspace", ReadOnly: false },
    ]);
    expect(seen[0]?.containerId).toBe(helper?.Id);

    // A second op reuses the helper.
    await files.list({ target, path: "", hidden: true });
    expect(docker.containerCreates.filter((c) => c.path.includes("ocw-files-"))).toHaveLength(1);
  });

  it("a bot with no workspace volume → 404 not_found and no helper is created", async () => {
    const { docker } = helperDocker();
    const sandboxes = createSandboxes({ docker, ns: NS, runtime: "auto", image: "sbx:test" });
    const files = createFiles({
      sandboxes,
      quota: { assertRoom: async () => {}, afterChange: async () => {} },
    });
    expect(await refusal(files.list({ target, path: "", hidden: true }))).toMatchObject({
      code: "not_found",
      status: 404,
    });
    expect(docker.containerCreates).toHaveLength(0);
  });

  it("refuses a files helper whose labels name another bot (409 label_mismatch, no exec)", async () => {
    const { docker, seen } = helperDocker();
    const sandboxes = createSandboxes({ docker, ns: NS, runtime: "auto", image: "sbx:test" });
    await sandboxes.ensure(target);
    await sandboxes.stop({ target, reason: "user" });
    docker.containers.set(nameFor("files", NS, AGENT), {
      Id: "squat0000000",
      Name: nameFor("files", NS, AGENT),
      Labels: {
        "ocw.sandbox": "1",
        "ocw.namespace": NS,
        "ocw.org": ORG,
        "ocw.agent": "x",
        "ocw.kind": "files",
      },
      Running: true,
    });
    const files = createFiles({
      sandboxes,
      quota: { assertRoom: async () => {}, afterChange: async () => {} },
    });
    expect(await refusal(files.list({ target, path: "", hidden: true }))).toMatchObject({
      code: "label_mismatch",
    });
    expect(seen).toHaveLength(0);
  });
});

describe("files routes on the sandboxd server", () => {
  const TOKEN = "t".repeat(40);

  async function serve() {
    const { createServer } = await import("./server");
    const docker = new FakeDocker();
    const stored = new Map<string, Buffer>();
    docker.onExec = (call) => {
      const [, sub, path = ""] = call.cmd;
      if (sub === "write") {
        stored.set(path, call.stdin);
        return { exitCode: 0, stdout: String(call.stdin.length) };
      }
      if (sub === "read") {
        const f = stored.get(path);
        return f
          ? { exitCode: 0, stdout: Buffer.concat([Buffer.from(`${f.length}\n`), f]) }
          : { exitCode: 4 };
      }
      return { exitCode: 0 };
    };
    const sandboxes = createSandboxes({ docker, ns: NS, runtime: "auto", image: "sbx:test" });
    await sandboxes.ensure(target);
    const files = createFiles({
      sandboxes,
      quota: { assertRoom: async () => {}, afterChange: async () => {} },
    });
    const server = createServer({ token: TOKEN, sandboxes, files });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as import("node:net").AddressInfo;
    const call = async (path: string, body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, text, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
    };
    return { server, call, stored, docker };
  }

  it("accepts a 2 MiB upload (base64 over 1 MiB) while other routes keep the 1 MiB body limit", async () => {
    const { server, call, stored } = await serve();
    try {
      const bytes = Buffer.alloc(2 * 1024 * 1024, 9);
      const up = await call("/v1/files/upload", {
        target,
        path: "reports/q3.csv",
        data: bytes.toString("base64"),
        overwrite: false,
      });
      expect(up.status).toBe(200);
      expect(up.json).toEqual({ path: "reports/q3.csv", size: bytes.length });
      expect(stored.get("reports/q3.csv")?.equals(bytes)).toBe(true);

      const exec = await call("/v1/sandboxes/exec", {
        target,
        argv: ["echo", "x".repeat(1500 * 1024)],
        cwd: "",
        timeoutMs: 5000,
        yieldMs: 0,
      });
      expect(exec.status).toBe(413);
    } finally {
      server.close();
    }
  });

  it("refuses a path that fails the contract with 400 and never echoes it; a read returns utf8", async () => {
    const { server, call, docker } = await serve();
    try {
      const SENTINEL = "SENTINEL-path-81c2";
      for (const path of [`../${SENTINEL}`, `/etc/${SENTINEL}`, ""]) {
        const res = await call("/v1/files/read", { target, path });
        expect(res.status).toBe(400);
        expect(res.text).not.toContain(SENTINEL);
      }
      expect(docker.execCreates).toHaveLength(0);
      await call("/v1/files/write", {
        target,
        path: "n.txt",
        content: "hello",
        encoding: "utf8",
        mode: "create",
      });
      const read = await call("/v1/files/read", { target, path: "n.txt" });
      expect(read.json).toMatchObject({ content: "hello", encoding: "utf8", size: 5, truncated: false });
      const missing = await call("/v1/files/read", { target, path: "nope.txt" });
      expect(missing.status).toBe(404);
      expect(missing.json).toEqual({ error: { code: "not_found", message: expect.any(String) } });
    } finally {
      server.close();
    }
  });
});
