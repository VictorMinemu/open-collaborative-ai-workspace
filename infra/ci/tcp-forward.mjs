#!/usr/bin/env node
// Plain TCP forwarder for the e2e step (.woodpecker/e2e.yaml):
//   node infra/ci/tcp-forward.mjs 127.0.0.1:2102=postgres:5432 127.0.0.1:2103=redis:6379 ...
// The e2e step runs in its own network namespace instead of the dind's (host networking let Chromium see every veth and
// bridge other workflows add, and abort requests with net::ERR_NETWORK_CHANGED). Compose still publishes the stack on
// the dind's loopback, which this namespace cannot reach, so the step joins the compose network and this forwarder
// listens on the slot's loopback ports, piping each connection to its service. Every URL in .env stays as it is. TCP
// only, no TLS, no rewriting: Garage still sees the Host its presigned URLs were signed for.
import net from "node:net";
import { pathToFileURL } from "node:url";

const USAGE = "usage: node infra/ci/tcp-forward.mjs listenHost:port=targetHost:port [...]";
const PAIR = /^([^\s:=]+):(\d{1,5})=([^\s:=]+):(\d{1,5})$/u;

/** "127.0.0.1:2102=postgres:5432" → { listen, target }. Listen port 0 means any free port; a target names its port. */
export function parseSpec(spec) {
  const m = PAIR.exec(spec);
  const [listenPort, targetPort] = m ? [Number(m[2]), Number(m[4])] : [];
  if (!m || listenPort > 65535 || targetPort < 1 || targetPort > 65535) {
    throw new Error(`${JSON.stringify(spec)}: expected listenHost:port=targetHost:port`);
  }
  return { listen: { host: m[1], port: listenPort }, target: { host: m[3], port: targetPort } };
}

// Both legs of every connection: no Nagle (Node's default is on; docker-proxy, which host networking used, is Go and
// sets TCP_NODELAY). With Nagle, a request written in pieces (Postgres Parse/Bind/Execute then Sync, Redis pipelines)
// waits for the peer's delayed ACK, 40 ms per round trip on Linux. Keepalive for the long-lived pub/sub sockets.
const SOCKET_OPTIONS = { noDelay: true, keepAlive: true };

/** Pipes one accepted connection to `target`; either side closing or failing closes both. */
function relay(client, target, log) {
  const upstream = net.connect({ host: target.host, port: target.port, ...SOCKET_OPTIONS });
  const close = (err) => {
    if (err && !client.destroyed)
      log(`tcp-forward: ${target.host}:${target.port}: ${err.code ?? err.message}`);
    client.destroy();
    upstream.destroy();
  };
  client.on("error", close).on("close", () => close());
  upstream.on("error", close).on("close", () => close());
  client.pipe(upstream).pipe(client);
}

/** Listens on every pair's address and resolves to the servers once all of them listen (rejects if one cannot). */
export async function forward(pairs, { log = console.error } = {}) {
  return Promise.all(
    pairs.map(
      ({ listen, target }) =>
        new Promise((resolve, reject) => {
          const server = net.createServer(SOCKET_OPTIONS, (client) => relay(client, target, log));
          server.once("error", reject);
          server.listen(listen.port, listen.host, () => {
            const { port } = server.address();
            log(`tcp-forward: ${listen.host}:${port} -> ${target.host}:${target.port}`);
            resolve(server);
          });
        }),
    ),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let pairs;
  try {
    pairs = process.argv.slice(2).map(parseSpec);
    if (pairs.length === 0) throw new Error("no pair given");
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    process.exit(2);
  }
  await forward(pairs);
  // The e2e step waits for this line before it migrates.
  console.error("tcp-forward: ready");
}
