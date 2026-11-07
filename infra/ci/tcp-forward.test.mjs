// node --test infra/ci/tcp-forward.test.mjs
//
// infra/ci/tcp-forward.mjs gives the e2e step (its own network namespace, .woodpecker/e2e.yaml) the slot's loopback
// ports again: each `listenHost:port=targetHost:port` pair accepts on the step's loopback and pipes every connection,
// both ways, to the stack container on the compose network. Against local servers, never a real stack.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { forward, parseSpec } from "./tcp-forward.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "tcp-forward.mjs");
const closers = [];
after(async () => {
  for (const close of closers.reverse()) await close();
});

/** An upstream on 127.0.0.1 that answers every chunk with "<tag>:" + the chunk; resolves to its port. */
async function upstream(tag) {
  const server = net.createServer((socket) => socket.on("data", (d) => socket.write(`${tag}:${d}`)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

/** A port nothing listens on (bound once, then released). */
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Starts the forwarder for `specs` and returns its servers (closed after the suite). */
async function start(specs) {
  const servers = await forward(specs.map(parseSpec), { log: () => {} });
  closers.push(() => Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))));
  return servers;
}

/** Sends `text` through 127.0.0.1:`port` and resolves to the first answer (or "" when the peer closes first). */
function roundTrip(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(text));
    let got = "";
    socket.on("data", (d) => {
      got += d;
      socket.end();
    });
    socket.on("close", () => resolve(got));
    socket.on("error", reject);
  });
}

describe("tcp-forward: the e2e step's loopback ports reach the stack on the compose network", () => {
  it("parses listen=target pairs and refuses anything else", () => {
    assert.deepEqual(parseSpec("127.0.0.1:2102=postgres:5432"), {
      listen: { host: "127.0.0.1", port: 2102 },
      target: { host: "postgres", port: 5432 },
    });
    // Listen port 0 (any free port) is allowed, for these tests; a target always names its port.
    for (const bad of [
      "postgres:5432",
      "127.0.0.1:2102=postgres",
      "127.0.0.1:2102=postgres:0",
      ":2102=a:1",
      "a:1=b:70000",
    ]) {
      assert.throws(() => parseSpec(bad), /listenHost:port=targetHost:port/u, bad);
    }
  });

  it("pipes each listen port to its own target, both ways, for several connections", async () => {
    const [pg, redis] = [await upstream("pg"), await upstream("redis")];
    const [a, b] = await start([`127.0.0.1:0=127.0.0.1:${pg}`, `127.0.0.1:0=127.0.0.1:${redis}`]);
    assert.equal(await roundTrip(a.address().port, "one"), "pg:one");
    assert.equal(await roundTrip(b.address().port, "two"), "redis:two");
    assert.equal(await roundTrip(a.address().port, "three"), "pg:three");
  });

  it("adds no Nagle delay: a request sent in two writes and answered after the second stays fast", async () => {
    // The Postgres extended protocol (Parse/Bind/Execute, then Sync) and Redis pipelines write small pieces and wait.
    // With Nagle on the forwarder's sockets, the second piece waits for the peer's delayed ACK (40 ms on Linux) on
    // every round trip; pipeline 150's e2e specs ran up to 2x slower that way. Direct, a round trip is ~1 ms.
    const server = net.createServer((socket) => {
      socket.setNoDelay(true);
      let seen = "";
      socket.on("data", (d) => {
        seen += d;
        if (seen.includes("S")) {
          seen = "";
          socket.write("Z");
        }
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise((resolve) => server.close(resolve)));
    const [s] = await start([`127.0.0.1:0=127.0.0.1:${server.address().port}`]);
    const client = net.connect(s.address().port, "127.0.0.1");
    client.setNoDelay(true);
    await new Promise((resolve) => client.once("connect", resolve));
    const rounds = 30;
    const t0 = performance.now();
    for (let i = 0; i < rounds; i++) {
      await new Promise((resolve) => {
        client.once("data", resolve);
        client.write("Q".repeat(40));
        setTimeout(() => client.write("S"), 0);
      });
    }
    const perRound = (performance.now() - t0) / rounds;
    client.destroy();
    assert.ok(perRound < 15, `${perRound.toFixed(1)} ms per round trip through the forwarder`);
  });

  it("closes the client when its target refuses, instead of leaving it hanging, and keeps listening", async () => {
    const dead = await freePort();
    const [s] = await start([`127.0.0.1:0=127.0.0.1:${dead}`]);
    assert.equal(await roundTrip(s.address().port, "hello"), "");
    assert.equal(await roundTrip(s.address().port, "again"), "");
  });

  it("the CLI exits 2 with the usage when a pair is malformed or missing", () => {
    for (const args of [[], ["nope"]]) {
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
      assert.equal(r.status, 2, args.join(" "));
      assert.match(r.stderr, /usage: node infra\/ci\/tcp-forward\.mjs/u);
    }
  });
});
