import type { Duplex } from "node:stream";
import { SANDBOXD_LABELS, type SandboxdOrgPolicy, type SandboxdTarget } from "@ocw/contracts";
import { type Docker, DockerUnavailableError, demux } from "./docker";
import type { SandboxdEventInput } from "./sandboxes";
import { SandboxdFailure } from "./sandboxes";
import {
  EGRESS_ALIAS,
  EGRESS_POLICY_DIR,
  EGRESS_POLICY_FILE,
  egressLabels,
  egressNames,
  egressNetworkSpec,
  egressSpec,
} from "./spec";

/**
 * The namespace's `sandbox-egress` container as sandboxd owns it (07.8-13, D-01, D-11, SBX-03): the proxy of 07.8-12
 * attached to an outbound network and to every bot network (alias `sandbox-egress`), never to the network the API and
 * sandboxd share. sandboxd compiles the proxy's policy file from the organization policies the API pushes, writes it
 * into the proxy's tmpfs with an exec as root and sends SIGHUP; it follows the proxy's output on the container's
 * attached stdio and turns each decision line into an `egress` event (host only). Every attachment is derived from
 * Docker (the networks the container is on and their labels), so a restarted sandboxd rebuilds the same view; the
 * organization policies are memory only and default to `off` (fail closed) until the API pushes them again.
 */

export type EgressKind = "sbx" | "brw";

/** One bot network the proxy is attached to: the proxy's address there names the policy entry. */
export interface EgressEntry {
  network: string;
  address: string;
  target: SandboxdTarget;
  kind: EgressKind;
}

/** The file 07.8-12's `parseEgressPolicy` reads: one entry per bot network, every bot subnet, the proxy's addresses. */
export interface EgressPolicyFile {
  networks: Array<{
    address: string;
    orgId: string;
    agentId: string;
    kind: EgressKind;
    mode: "off" | "allowlist" | "public";
    allowHosts: string[];
    privateHosts: string[];
  }>;
  botNetworks: string[];
  ownAddresses: string[];
}

/**
 * The proxy's policy, or null when there is nothing a valid file could say (no bot network attached, or no subnet or
 * own address known: the proxy then runs without a file and refuses everything). An organization without a pushed
 * policy, or a killed one, gets `off` for every network (fail closed); the browser network takes `browserEgress`, the
 * shell network `sandboxEgress`.
 */
export function compileEgressPolicy(input: {
  entries: readonly EgressEntry[];
  policies: ReadonlyMap<string, SandboxdOrgPolicy>;
  botSubnets: readonly string[];
  ownAddresses: readonly string[];
}): EgressPolicyFile | null {
  if (input.entries.length === 0 || input.botSubnets.length === 0 || input.ownAddresses.length === 0)
    return null;
  const seen = new Set<string>();
  const networks: EgressPolicyFile["networks"] = [];
  for (const e of input.entries) {
    if (seen.has(e.address)) continue;
    seen.add(e.address);
    const p = input.policies.get(e.target.orgId);
    const mode = !p || p.killed ? "off" : e.kind === "brw" ? p.browserEgress : p.sandboxEgress;
    networks.push({
      address: e.address,
      orgId: e.target.orgId,
      agentId: e.target.agentId,
      kind: e.kind,
      mode,
      allowHosts: mode === "off" || !p ? [] : [...p.allowHosts],
      privateHosts: mode === "off" || !p ? [] : [...p.privateHosts],
    });
  }
  return {
    networks,
    botNetworks: [...new Set(input.botSubnets)],
    ownAddresses: [...new Set(input.ownAddresses)],
  };
}

/** A decision line of the proxy (`{ network, host, port, allowed, reason }`), or null when it is not one. */
export function parseDecisionLine(line: string): { network: string; host: string; allowed: boolean } | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.network !== "string" || typeof o.host !== "string" || typeof o.allowed !== "boolean")
    return null;
  if (o.host.length === 0) return null;
  return { network: o.network, host: o.host.slice(0, 260), allowed: o.allowed };
}

export interface Egress {
  /** The outbound network and the proxy container exist and run; the proxy's output is followed. */
  ensure(): Promise<void>;
  /** Attaches the proxy to a bot network (alias `sandbox-egress`) and rewrites the policy. */
  attach(target: SandboxdTarget, kind: EgressKind, network: string): Promise<void>;
  /** Detaches the proxy from every network of the bot (before a purge removes them) and rewrites the policy. */
  detachTarget(target: SandboxdTarget): Promise<void>;
  /** A pushed organization policy (newest version only); the file is rewritten when the org has a network. */
  setOrgPolicy(policy: SandboxdOrgPolicy): Promise<void>;
  /** The attachments known now (tests, logs). */
  entries(): EgressEntry[];
  close(): void;
}

export interface EgressOptions {
  docker: Docker;
  ns: string;
  image: string;
  onEvent?: (event: SandboxdEventInput) => void;
  /** How long a policy write waits for the proxy's reload line. */
  reloadTimeoutMs?: number;
  /** Delay before re-following the proxy after its output ended. */
  retryMs?: number;
}

const MAX_LINE = 64 * 1024;

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const dockerDown = (what: string) => new SandboxdFailure("docker_unavailable", 503, what);

export function createEgress(options: EgressOptions): Egress {
  const { docker, ns, image } = options;
  const emit = options.onEvent ?? (() => {});
  const reloadTimeoutMs = options.reloadTimeoutMs ?? 5_000;
  const retryMs = options.retryMs ?? 2_000;
  const names = egressNames(ns);
  const policies = new Map<string, SandboxdOrgPolicy>();
  const entries = new Map<string, EgressEntry>(); // by network name
  let containerId: string | null = null;
  let follower: Duplex | null = null;
  let synced = false;
  let closed = false;
  /** Operational lines seen per message (`policy loaded`, `policy missing`, `policy invalid`), for reload acks. */
  const seen = new Map<string, number>();
  const seenWaiters: Array<() => void> = [];
  let queue: Promise<unknown> = Promise.resolve();

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  async function call(method: "GET" | "POST" | "DELETE", path: string, body?: unknown) {
    try {
      return await docker.request(method, path, body);
    } catch (err) {
      if (err instanceof DockerUnavailableError) throw dockerDown("the Docker daemon is unavailable");
      throw err;
    }
  }

  function ownedByNamespace(labels: unknown, kind: string): boolean {
    const l = asRecord(labels);
    const want = egressLabels(ns);
    return (
      l[SANDBOXD_LABELS.sandbox] === want[SANDBOXD_LABELS.sandbox] &&
      l[SANDBOXD_LABELS.namespace] === ns &&
      l[SANDBOXD_LABELS.kind] === kind
    );
  }

  // ------------------------------------------------------------ the proxy's output

  function onStdout(line: string) {
    const d = parseDecisionLine(line);
    if (!d) return;
    const entry = [...entries.values()].find((e) => e.address === d.network);
    if (!entry) return;
    emit({ type: "egress", target: entry.target, kind: entry.kind, host: d.host, allowed: d.allowed });
  }

  function onStderr(line: string) {
    let msg: string | null = null;
    try {
      const v = asRecord(JSON.parse(line));
      msg = typeof v.msg === "string" ? v.msg : null;
    } catch {
      return;
    }
    if (msg !== "policy loaded" && msg !== "policy missing" && msg !== "policy invalid") return;
    seen.set(msg, (seen.get(msg) ?? 0) + 1);
    for (const w of seenWaiters.splice(0)) w();
  }

  function lineSplitter(onLine: (line: string) => void) {
    let buf = "";
    return (data: Buffer) => {
      buf += data.toString("utf8");
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
      if (buf.length > MAX_LINE) buf = "";
    };
  }

  async function follow(id: string): Promise<void> {
    if (follower && !follower.destroyed) return;
    let stream: Duplex;
    try {
      stream = await docker.hijack(
        `/containers/${encodeURIComponent(id)}/attach?stream=1&stdout=1&stderr=1`,
        {},
      );
    } catch {
      throw dockerDown("cannot follow the egress proxy");
    }
    follower = stream;
    const out = lineSplitter(onStdout);
    const err = lineSplitter(onStderr);
    void demux(stream, (frame) => (frame.stream === 2 ? err(frame.data) : out(frame.data))).then(() => {
      if (follower === stream) follower = null;
      if (closed) return;
      // The proxy stopped or the daemon dropped the stream: follow again later (the next ensure restarts it).
      const timer = setTimeout(() => {
        if (!closed && containerId) void follow(containerId).catch(() => undefined);
      }, retryMs);
      timer.unref?.();
    });
  }

  function waitSeen(msg: string, before: number): Promise<boolean> {
    return new Promise((resolve) => {
      const check = () => {
        if ((seen.get(msg) ?? 0) > before) {
          clearTimeout(timer);
          resolve(true);
          return true;
        }
        return false;
      };
      const timer = setTimeout(() => {
        const i = seenWaiters.indexOf(waiter);
        if (i >= 0) seenWaiters.splice(i, 1);
        resolve(false);
      }, reloadTimeoutMs);
      timer.unref?.();
      const waiter = () => {
        if (!check()) seenWaiters.push(waiter);
      };
      if (!check()) seenWaiters.push(waiter);
    });
  }

  // ------------------------------------------------------------ the container and its networks

  async function inspectSelf(): Promise<Record<string, unknown> | null> {
    const res = await call("GET", `/containers/${encodeURIComponent(names.container)}/json`);
    if (res.status === 404) return null;
    if (res.status !== 200) throw dockerDown("cannot inspect the egress proxy");
    const c = asRecord(res.body);
    if (!ownedByNamespace(asRecord(c.Config).Labels, "egress")) {
      throw new SandboxdFailure("label_mismatch", 409, "the egress container is not this namespace's");
    }
    return c;
  }

  function attachedNetworks(
    c: Record<string, unknown>,
  ): Record<string, { IPAddress?: string; NetworkID?: string }> {
    return asRecord(asRecord(c.NetworkSettings).Networks) as Record<
      string,
      { IPAddress?: string; NetworkID?: string }
    >;
  }

  async function ensureOutbound() {
    const spec = egressNetworkSpec(ns);
    const res = await call("GET", `/networks/${encodeURIComponent(spec.Name)}`);
    if (res.status === 200) {
      if (!ownedByNamespace(asRecord(res.body).Labels, "egress")) {
        throw new SandboxdFailure("label_mismatch", 409, "the egress network is not this namespace's");
      }
      return;
    }
    if (res.status !== 404) throw dockerDown("cannot inspect the egress network");
    const created = await call("POST", "/networks/create", spec);
    if (created.status !== 201 && created.status !== 409)
      throw dockerDown("cannot create the egress network");
  }

  /** A bot network's labels as a target and kind, or null when it is not one of this namespace's bot networks. */
  async function botNetwork(
    name: string,
  ): Promise<{ target: SandboxdTarget; kind: EgressKind; subnets: string[] } | null> {
    const res = await call("GET", `/networks/${encodeURIComponent(name)}`);
    if (res.status !== 200) return null;
    const n = asRecord(res.body);
    const l = asRecord(n.Labels) as Record<string, string>;
    if (l[SANDBOXD_LABELS.sandbox] !== "1" || l[SANDBOXD_LABELS.namespace] !== ns || n.Internal !== true)
      return null;
    const kind = l[SANDBOXD_LABELS.kind];
    const orgId = l[SANDBOXD_LABELS.org];
    const agentId = l[SANDBOXD_LABELS.agent];
    if ((kind !== "sbx" && kind !== "brw") || !orgId || !agentId) return null;
    const config = asRecord(n.IPAM).Config;
    const subnets = (Array.isArray(config) ? config : [])
      .map((c) => asRecord(c).Subnet)
      .filter((s): s is string => typeof s === "string" && s.length > 0);
    return { target: { orgId, agentId }, kind, subnets };
  }

  /** Every bot network of the namespace (attached or not): their subnets are refused for every bot. */
  async function allBotSubnets(): Promise<string[]> {
    const filters = encodeURIComponent(
      JSON.stringify({ label: [`${SANDBOXD_LABELS.sandbox}=1`, `${SANDBOXD_LABELS.namespace}=${ns}`] }),
    );
    const res = await call("GET", `/networks?filters=${filters}`);
    if (res.status !== 200 || !Array.isArray(res.body)) throw dockerDown("cannot list bot networks");
    const out: string[] = [];
    for (const raw of res.body) {
      const n = asRecord(raw);
      const name = typeof n.Name === "string" ? n.Name : null;
      if (!name || name === names.network) continue;
      const bot = await botNetwork(name);
      if (bot) out.push(...bot.subnets);
    }
    return out;
  }

  /** Rebuilds the attachments from the proxy's networks and their labels (sandboxd keeps none of it on disk). */
  async function syncEntries(c: Record<string, unknown>) {
    entries.clear();
    for (const [name, ep] of Object.entries(attachedNetworks(c))) {
      if (name === names.network || !ep.IPAddress) continue;
      const bot = await botNetwork(name);
      if (bot)
        entries.set(name, { network: name, address: ep.IPAddress, target: bot.target, kind: bot.kind });
    }
  }

  async function writePolicyLocked(): Promise<void> {
    if (!containerId) return;
    const c = await inspectSelf();
    if (!c) return;
    const ownAddresses = Object.values(attachedNetworks(c))
      .map((ep) => ep.IPAddress)
      .filter((a): a is string => typeof a === "string" && a.length > 0);
    const file = compileEgressPolicy({
      entries: [...entries.values()],
      policies,
      botSubnets: entries.size > 0 ? await allBotSubnets() : [],
      ownAddresses,
    });
    const msg = file ? "policy loaded" : "policy missing";
    const before = seen.get(msg) ?? 0;
    const invalidBefore = seen.get("policy invalid") ?? 0;
    // Written as root (the tmpfs is root-owned 0755) through stdin, then renamed: the proxy never reads half a file.
    const script = file
      ? `cat > ${EGRESS_POLICY_DIR}/policy.json.tmp && mv -f ${EGRESS_POLICY_DIR}/policy.json.tmp ${EGRESS_POLICY_FILE}`
      : `rm -f ${EGRESS_POLICY_FILE}`;
    await execAsRoot(["sh", "-c", script], file ? Buffer.from(JSON.stringify(file)) : null);
    const hup = await call("POST", `/containers/${encodeURIComponent(containerId)}/kill?signal=HUP`);
    if (hup.status !== 204) throw dockerDown("cannot signal the egress proxy");
    const loaded = await waitSeen(msg, before);
    if ((seen.get("policy invalid") ?? 0) > invalidBefore) {
      throw dockerDown("the egress proxy refused its policy");
    }
    if (!loaded) throw dockerDown("the egress proxy did not reload its policy");
  }

  async function execAsRoot(cmd: string[], stdin: Buffer | null): Promise<void> {
    if (!containerId) throw dockerDown("no egress proxy");
    const created = await call("POST", `/containers/${encodeURIComponent(containerId)}/exec`, {
      User: "0",
      Cmd: cmd,
      AttachStdin: stdin !== null,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    const execId = String(asRecord(created.body).Id ?? "");
    if (created.status !== 201 || !execId) throw dockerDown("cannot write the egress policy");
    let stream: Duplex;
    try {
      stream = await docker.hijack(`/exec/${encodeURIComponent(execId)}/start`, {
        Detach: false,
        Tty: false,
      });
    } catch {
      throw dockerDown("cannot write the egress policy");
    }
    const ended = demux(stream, () => undefined);
    if (stdin) stream.end(stdin);
    await ended;
    for (let i = 0; i < 40; i++) {
      const res = await call("GET", `/exec/${encodeURIComponent(execId)}/json`);
      const body = asRecord(res.body);
      if (res.status === 200 && body.Running !== true) {
        if (body.ExitCode !== 0) throw dockerDown("cannot write the egress policy");
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw dockerDown("cannot write the egress policy");
  }

  async function ensureLocked(): Promise<void> {
    await ensureOutbound();
    let c = await inspectSelf();
    if (!c) {
      const created = await call(
        "POST",
        `/containers/create?name=${encodeURIComponent(names.container)}`,
        egressSpec({ ns, image }),
      );
      if (created.status !== 201 && created.status !== 409)
        throw dockerDown("cannot create the egress proxy");
      c = await inspectSelf();
      if (!c) throw dockerDown("cannot create the egress proxy");
    }
    containerId = String(c.Id);
    const running = asRecord(c.State).Running === true;
    if (!running) {
      // Follow before starting, so its first lines (and the first reload) are seen.
      follower?.destroy();
      follower = null;
      await follow(containerId);
      const before = seen.get("policy missing") ?? 0;
      const started = await call("POST", `/containers/${encodeURIComponent(containerId)}/start`);
      if (started.status !== 204 && started.status !== 304) throw dockerDown("cannot start the egress proxy");
      await waitSeen("policy missing", before); // the fresh tmpfs has no file yet: it starts refusing everything
      c = (await inspectSelf()) ?? c;
      synced = false;
    } else {
      await follow(containerId);
    }
    if (!synced) {
      await syncEntries(c);
      synced = true;
      // A new proxy (empty tmpfs) or a new sandboxd (policies forgotten): write what is known now (fail closed).
      await writePolicyLocked();
    }
  }

  return {
    ensure: () => serial(ensureLocked),

    attach(target, kind, network) {
      return serial(async () => {
        await ensureLocked();
        const bot = await botNetwork(network);
        if (
          !bot ||
          bot.kind !== kind ||
          bot.target.orgId !== target.orgId ||
          bot.target.agentId !== target.agentId
        ) {
          throw new SandboxdFailure("label_mismatch", 409, "the network is not this bot's");
        }
        let c = await inspectSelf();
        if (!c) throw dockerDown("no egress proxy");
        if (!attachedNetworks(c)[network]) {
          const res = await call("POST", `/networks/${encodeURIComponent(network)}/connect`, {
            Container: containerId,
            EndpointConfig: { Aliases: [EGRESS_ALIAS] },
          });
          if (res.status !== 200) throw dockerDown("cannot attach the egress proxy");
          c = await inspectSelf();
          if (!c) throw dockerDown("no egress proxy");
        }
        const address = attachedNetworks(c)[network]?.IPAddress;
        if (!address) throw dockerDown("the egress proxy has no address on the bot network");
        const known = entries.get(network);
        if (known?.address === address) return;
        entries.set(network, { network, address, target, kind });
        await writePolicyLocked();
      });
    },

    detachTarget(target) {
      return serial(async () => {
        const c = await inspectSelf();
        if (!c) {
          entries.clear();
          return;
        }
        containerId = String(c.Id);
        let changed = false;
        for (const [name, entry] of [...entries.entries()]) {
          if (entry.target.orgId !== target.orgId || entry.target.agentId !== target.agentId) continue;
          if (attachedNetworks(c)[name]) {
            const res = await call("POST", `/networks/${encodeURIComponent(name)}/disconnect`, {
              Container: containerId,
              Force: true,
            });
            if (res.status !== 200 && res.status !== 404) throw dockerDown("cannot detach the egress proxy");
          }
          entries.delete(name);
          changed = true;
        }
        if (changed && asRecord(c.State).Running === true) await writePolicyLocked();
      });
    },

    setOrgPolicy(policy) {
      return serial(async () => {
        const held = policies.get(policy.orgId);
        if (held && held.version > policy.version) return;
        policies.set(policy.orgId, policy);
        if (![...entries.values()].some((e) => e.target.orgId === policy.orgId)) return;
        await writePolicyLocked();
      });
    },

    entries: () => [...entries.values()],

    close() {
      closed = true;
      follower?.destroy();
      follower = null;
    },
  };
}
