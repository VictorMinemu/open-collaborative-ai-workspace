// Spike (iii), 07.8-03: can a sandboxd-like process drive the Woodpecker dind daemon the way `sandboxd` will?
// Throwaway code. Dependency-free: Node built-ins only, Engine API over the Unix socket (as CI steps reach the dind).
// Run from a node container with the dind socket mounted (see run.sh). Prints one JSON report on stdout.
//
// For two fake bots A and B it creates: an `internal: true` network and a named volume each, and one container each
// with the research's hardened spec (07.8-RESEARCH.md §3 "Hardened runc fallback", Code Examples "sandboxd container
// spec"). Then: exec as 10001 (write/read in A, absent in B), cross-bot reachability, external route and DNS, the
// hardening as seen from inside, a stdio round-trip on the main process, kill by label and removal by label.
import http from "node:http";

const SOCKET = process.env.DOCKER_SOCK ?? "/var/run/docker.sock";
const IMAGE = process.env.SPIKE_IMAGE ?? "ocw-spike-078-bot:spike";
const LABEL = "ocw.spike=07.8";
const LABELS = { "ocw.spike": "07.8", "ocw.namespace": "spike-078" };
const PREFIX = "ocw-spike-078";

const report = { steps: [], checks: {}, errors: [] };
const step = (name, data) => report.steps.push({ name, ...data });

function request(method, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        socketPath: SOCKET,
        method,
        path,
        headers: {
          Host: "docker",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function api(method, path, body) {
  const res = await request(method, path, body);
  const text = res.body.toString("utf8");
  if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status} ${text.trim()}`);
  return text ? JSON.parse(text) : null;
}

// Docker's multiplexed stream (no TTY): 8-byte header [stream, 0, 0, 0, size BE32] then payload.
function demux(buf) {
  const out = { stdout: "", stderr: "" };
  let i = 0;
  while (i + 8 <= buf.length) {
    const type = buf[i];
    const size = buf.readUInt32BE(i + 4);
    const chunk = buf.subarray(i + 8, i + 8 + size).toString("utf8");
    if (type === 2) out.stderr += chunk;
    else out.stdout += chunk;
    i += 8 + size;
  }
  return out;
}

// Hijacked connection (exec start, attach): ask for the upgrade explicitly and read the raw socket.
function hijack(path, body, onSocket) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body ?? {}));
    const req = http.request({
      socketPath: SOCKET,
      method: "POST",
      path,
      headers: {
        Host: "docker",
        "Content-Type": "application/json",
        "Content-Length": payload.length,
        Connection: "Upgrade",
        Upgrade: "tcp",
      },
    });
    req.on("upgrade", (_res, socket, head) => onSocket(socket, head, resolve, reject));
    req.on("response", (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => reject(new Error(`${path} -> ${res.statusCode} ${Buffer.concat(chunks).toString()}`)));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function exec(id, cmd, user = "10001:10001") {
  const created = await api("POST", `/containers/${id}/exec`, {
    User: user,
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  });
  const raw = await hijack(`/exec/${created.Id}/start`, { Detach: false, Tty: false }, (socket, head, resolve) => {
    const chunks = [head];
    socket.on("data", (c) => chunks.push(c));
    socket.on("end", () => resolve(Buffer.concat(chunks)));
    socket.on("close", () => resolve(Buffer.concat(chunks)));
  });
  const info = await api("GET", `/exec/${created.Id}/json`);
  return { exitCode: info.ExitCode, ...demux(raw) };
}

// One node one-liner per check; output is a JSON line so the report stays structured.
const nodeEval = (src) => ["node", "-e", src];
const tcpProbe = (host, port) =>
  nodeEval(
    `const s=require("net").connect({host:${JSON.stringify(host)},port:${port},timeout:3000});` +
      `s.on("connect",()=>{console.log(JSON.stringify({ok:true}));s.destroy()});` +
      `s.on("timeout",()=>{console.log(JSON.stringify({ok:false,error:"timeout"}));s.destroy()});` +
      `s.on("error",e=>console.log(JSON.stringify({ok:false,error:e.code})))`,
  );
const dnsProbe = (name) =>
  nodeEval(
    `require("dns").lookup(${JSON.stringify(name)},(e,a)=>console.log(JSON.stringify(e?{ok:false,error:e.code}:{ok:true,address:a})))`,
  );
const parseLine = (r) => {
  try {
    return { ...JSON.parse(r.stdout.trim().split("\n").pop()), exitCode: r.exitCode };
  } catch {
    return { ok: false, exitCode: r.exitCode, stdout: r.stdout.trim(), stderr: r.stderr.trim().slice(0, 400) };
  }
};

// The bot's main process: echoes stdin lines (the stdio JSON protocol stand-in) and listens on 8080 so that a peer
// probe has something to reach if the network allowed it.
const MAIN =
  'process.stdin.setEncoding("utf8");process.stdin.on("data",d=>process.stdout.write(d));' +
  'require("http").createServer((q,r)=>r.end("bot")).listen(8080)';

function botSpec(bot) {
  return {
    Image: IMAGE,
    User: "10001:10001",
    Cmd: ["node", "-e", MAIN],
    WorkingDir: "/workspace",
    Env: ["HOME=/workspace"],
    OpenStdin: true,
    StdinOnce: false,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    Labels: { ...LABELS, "ocw.agent": bot, "ocw.kind": "sbx" },
    HostConfig: {
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Init: true,
      PidsLimit: 256,
      Memory: 1024 * 1024 * 1024,
      MemorySwap: 1024 * 1024 * 1024,
      NanoCpus: 1_000_000_000,
      Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=256m" },
      Mounts: [{ Type: "volume", Source: `${PREFIX}-vol-${bot}`, Target: "/workspace" }],
      NetworkMode: `${PREFIX}-net-${bot}`,
    },
  };
}

async function cleanupByLabel() {
  const filters = encodeURIComponent(JSON.stringify({ label: [LABEL] }));
  const containers = await api("GET", `/containers/json?all=1&filters=${filters}`);
  const killed = [];
  for (const c of containers) {
    if (c.State === "running") {
      await api("POST", `/containers/${c.Id}/kill`);
      killed.push(c.Names[0]);
    }
    await api("DELETE", `/containers/${c.Id}?force=1&v=1`);
  }
  const networks = await api("GET", `/networks?filters=${filters}`);
  for (const n of networks) await api("DELETE", `/networks/${n.Id}`);
  const vols = (await api("GET", `/volumes?filters=${filters}`)).Volumes ?? [];
  for (const v of vols) await api("DELETE", `/volumes/${v.Name}`);
  return {
    killed,
    removedContainers: containers.map((c) => c.Names[0]),
    removedNetworks: networks.map((n) => n.Name),
    removedVolumes: vols.map((v) => v.Name),
  };
}

async function main() {
  const version = await api("GET", "/version");
  const info = await api("GET", "/info");
  report.daemon = {
    ServerVersion: version.Version,
    ApiVersion: version.ApiVersion,
    MinAPIVersion: version.MinAPIVersion,
    Runtimes: Object.keys(info.Runtimes ?? {}),
    DefaultRuntime: info.DefaultRuntime,
    KernelVersion: info.KernelVersion,
    OperatingSystem: info.OperatingSystem,
    CgroupVersion: info.CgroupVersion,
    CgroupDriver: info.CgroupDriver,
    SecurityOptions: info.SecurityOptions,
    Driver: info.Driver,
  };
  const major = Number.parseInt(String(version.Version).split(".")[0], 10);
  report.checks.dockerAtLeast26 = major >= 26;
  report.checks.runscRegistered = Object.keys(info.Runtimes ?? {}).includes("runsc");

  step("pre-clean", await cleanupByLabel());

  const ids = {};
  for (const bot of ["a", "b"]) {
    await api("POST", "/networks/create", {
      Name: `${PREFIX}-net-${bot}`,
      Driver: "bridge",
      Internal: true,
      Labels: { ...LABELS, "ocw.agent": bot },
    });
    await api("POST", "/volumes/create", { Name: `${PREFIX}-vol-${bot}`, Labels: { ...LABELS, "ocw.agent": bot } });
    const c = await api("POST", `/containers/create?name=${PREFIX}-bot-${bot}`, botSpec(bot));
    await api("POST", `/containers/${c.Id}/start`);
    ids[bot] = c.Id;
  }
  // Let the main processes bind 8080.
  await new Promise((r) => setTimeout(r, 1500));

  const inspectA = await api("GET", `/containers/${ids.a}/json`);
  const inspectB = await api("GET", `/containers/${ids.b}/json`);
  const ipA = inspectA.NetworkSettings.Networks[`${PREFIX}-net-a`]?.IPAddress;
  const ipB = inspectB.NetworkSettings.Networks[`${PREFIX}-net-b`]?.IPAddress;
  const netA = await api("GET", `/networks/${PREFIX}-net-a`);
  step("created", {
    ipA,
    ipB,
    networkInternal: netA.Internal,
    hostConfigA: {
      ReadonlyRootfs: inspectA.HostConfig.ReadonlyRootfs,
      CapDrop: inspectA.HostConfig.CapDrop,
      SecurityOpt: inspectA.HostConfig.SecurityOpt,
      Init: inspectA.HostConfig.Init,
      PidsLimit: inspectA.HostConfig.PidsLimit,
      Memory: inspectA.HostConfig.Memory,
      NanoCpus: inspectA.HostConfig.NanoCpus,
      Tmpfs: inspectA.HostConfig.Tmpfs,
      Binds: inspectA.HostConfig.Binds,
      Runtime: inspectA.HostConfig.Runtime,
      User: inspectA.Config.User,
    },
  });

  // Exec as 10001.
  const uid = await exec(ids.a, nodeEval("console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid()}))"));
  report.checks.execUid = parseLine(uid);
  const write = await exec(
    ids.a,
    nodeEval(
      'const f=require("fs");f.writeFileSync("/workspace/a.txt","bot-a");' +
        'const s=f.statSync("/workspace/a.txt");' +
        'console.log(JSON.stringify({ok:true,read:f.readFileSync("/workspace/a.txt","utf8"),uid:s.uid}))',
    ),
  );
  report.checks.writeReadInA = parseLine(write);
  const absent = await exec(
    ids.b,
    nodeEval('console.log(JSON.stringify({ok:true,exists:require("fs").existsSync("/workspace/a.txt")}))'),
  );
  report.checks.fileAbsentInB = parseLine(absent);

  // Hardening as seen from inside.
  const inside = await exec(
    ids.a,
    nodeEval(
      'const f=require("fs");const st=f.readFileSync("/proc/self/status","utf8");' +
        "const g=k=>(st.match(new RegExp(k+\":\\\\s*(\\\\S+)\"))||[])[1];" +
        'let rootWrite;try{f.writeFileSync("/etc/x","1");rootWrite="written"}catch(e){rootWrite=e.code}' +
        'let tmpExec;try{f.writeFileSync("/tmp/x.sh","#!/bin/sh\\necho hi\\n",{mode:0o755});' +
        'require("child_process").execFileSync("/tmp/x.sh");tmpExec="ran"}catch(e){tmpExec=e.code||String(e.status)}' +
        'console.log(JSON.stringify({ok:true,CapEff:g("CapEff"),NoNewPrivs:g("NoNewPrivs"),Seccomp:g("Seccomp"),' +
        'rootWrite,tmpExec,pidOne:f.readFileSync("/proc/1/cmdline","utf8").split("\\0")[0]}))',
    ),
  );
  report.checks.hardeningInside = parseLine(inside);

  // Network: the peer listener works for A itself (control), B cannot reach A, no route out, no external DNS.
  report.checks.aReachesItself = parseLine(await exec(ids.a, tcpProbe(ipA, 8080)));
  report.checks.bReachesA = parseLine(await exec(ids.b, tcpProbe(ipA, 8080)));
  report.checks.bExternalRoute = parseLine(await exec(ids.b, tcpProbe("1.1.1.1", 443)));
  report.checks.bExternalDns = parseLine(await exec(ids.b, dnsProbe("example.com")));
  report.checks.bResolvesA = parseLine(await exec(ids.b, dnsProbe(`${PREFIX}-bot-a`)));
  report.checks.aResolvesItselfByName = parseLine(await exec(ids.a, dnsProbe(`${PREFIX}-bot-a`)));

  // Stdio: attach to A's main process, send one JSON line, read it back.
  const line = `${JSON.stringify({ id: 1, method: "ping", params: { from: "sandboxd" } })}\n`;
  const echoed = await hijack(
    `/containers/${ids.a}/attach?stream=1&stdin=1&stdout=1&stderr=1`,
    {},
    (socket, head, resolve, reject) => {
      let buf = head;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("attach: no echo within 5 s"));
      }, 5000);
      socket.on("data", (c) => {
        buf = Buffer.concat([buf, c]);
        const out = demux(buf).stdout;
        if (out.includes("\n")) {
          clearTimeout(timer);
          socket.destroy();
          resolve(out);
        }
      });
      socket.write(line);
    },
  );
  report.checks.stdioRoundTrip = { ok: echoed.trim() === line.trim(), sent: line.trim(), received: echoed.trim() };

  // Kill by label and remove everything by label.
  step("cleanup", await cleanupByLabel());
  const filters = encodeURIComponent(JSON.stringify({ label: [LABEL] }));
  report.checks.leftovers = {
    containers: (await api("GET", `/containers/json?all=1&filters=${filters}`)).length,
    networks: (await api("GET", `/networks?filters=${filters}`)).length,
    volumes: ((await api("GET", `/volumes?filters=${filters}`)).Volumes ?? []).length,
  };
}

try {
  await main();
} catch (err) {
  report.errors.push(String(err?.stack ?? err));
  try {
    step("cleanup-after-error", await cleanupByLabel());
  } catch (e) {
    report.errors.push(`cleanup: ${e}`);
  }
}
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.errors.length ? 1 : 0;
