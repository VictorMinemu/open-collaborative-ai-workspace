import { readFileSync } from "node:fs";
import { createEgressProxy, type DecisionLine, EMPTY_POLICY, parseEgressPolicy } from "./proxy.ts";

/**
 * `sandbox-egress` entrypoint (07.8-12, D-11): the second entrypoint of @ocw/sandboxd, run by plain Node (native type
 * stripping) in its own image with no npm package. It is attached only to per-bot internal networks, never to the
 * control network, and receives its policy as a file the broker writes into its tmpfs with `docker exec` as root;
 * SIGHUP reloads it. The file carries one entry per bot network (keyed by the proxy's address there), `botNetworks`
 * (every bot network's subnet) and `ownAddresses` (the proxy's address on each network); both must be non-empty. A
 * missing or invalid file means no policy: every connection is refused (fail closed).
 *
 *   OCW_EGRESS_POLICY   policy file (default /run/ocw-egress/policy.json)
 *   OCW_EGRESS_HOST     listen address (default 0.0.0.0: every attached network)
 *   OCW_EGRESS_PORT     listen port (default 3128)
 *
 * stdout carries decision lines only, one JSON object per new (network, host, port, decision):
 * `{ network, host, port, allowed, reason }`; never a path, a query or a header. Operational lines go to stderr.
 */
const POLICY_PATH = process.env.OCW_EGRESS_POLICY || "/run/ocw-egress/policy.json";
const HOST = process.env.OCW_EGRESS_HOST || "0.0.0.0";
const PORT = Number(process.env.OCW_EGRESS_PORT || 3128);

const ops = (line: Record<string, unknown>) =>
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), ...line })}\n`);

const decision = (line: DecisionLine) =>
  process.stdout.write(
    `${JSON.stringify({
      network: line.network,
      host: line.host,
      port: line.port,
      allowed: line.allowed,
      reason: line.reason,
    })}\n`,
  );

let current = EMPTY_POLICY;

function reload() {
  let text: string;
  try {
    text = readFileSync(POLICY_PATH, "utf8");
  } catch {
    current = EMPTY_POLICY;
    ops({ level: "warn", msg: "policy missing" });
    return;
  }
  try {
    current = parseEgressPolicy(JSON.parse(text));
    ops({ level: "info", msg: "policy loaded", networks: current.networks.size });
  } catch {
    current = EMPTY_POLICY;
    ops({ level: "error", msg: "policy invalid" });
  }
}

if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65_535) {
  ops({ level: "error", msg: "invalid environment", variables: "OCW_EGRESS_PORT" });
  process.exit(1);
}

reload();
const server = createEgressProxy({ policies: () => current, log: decision });
server.listen(PORT, HOST, () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : PORT;
  ops({ level: "info", msg: "listening", host: HOST, port });
});
process.on("SIGHUP", reload);
const shutdown = () => {
  server.close(() => process.exit(0));
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 2_000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
