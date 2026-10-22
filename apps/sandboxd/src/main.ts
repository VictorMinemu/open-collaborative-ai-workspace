import { readFileSync } from "node:fs";
import type { SandboxdInfo } from "@ocw/contracts";
import { z } from "zod";
import { createBrowsers } from "./browser";
import { createDocker } from "./docker";
import { createEgress } from "./egress-attach";
import { createEvents } from "./events";
import { createFiles } from "./files";
import { createPackages, dockerPackageRunner, type RegistryConfig, registryConfig, runEnv } from "./packages";
import { createQuota } from "./quota";
import { createSandboxes, ownContainerId, ownLabelRefusal, startupRefusal } from "./sandboxes";
import { createServer, type LogLine } from "./server";
import { NAMESPACE_RE } from "./spec";
import { createSweeper, SWEEP_INTERVAL_MS } from "./sweeper";

/**
 * The sandbox broker (07.8-04, D-11 option b). The only process with the Docker socket: it never calls the API and
 * listens on the internal `sandbox-control` network only (0.0.0.0 inside compose, never a published port; 127.0.0.1
 * for host-process smokes). Fails fast on a missing token or namespace.
 *
 *   OCW_SANDBOX_TOKEN       bearer token shared with the API (required, at least 32 characters)
 *   OCW_SANDBOX_NAMESPACE   label namespace of every object (required; the compose project or a smoke namespace)
 *   OCW_SANDBOXD_HOST       listen address (default 127.0.0.1)
 *   OCW_SANDBOXD_PORT       listen port (default 8090; 0 picks a free port, logged as `listening`)
 *   OCW_SANDBOX_RUNTIME     auto | runsc | runc (default auto: runsc when the daemon has it)
 *   OCW_SANDBOX_SBX_IMAGE   the `sbx` image reference (digest or tag)
 *   OCW_SANDBOX_BRW_IMAGE   the `brw` image (07.8-07); unset: every browser op answers 503 (nothing is guessed)
 *   OCW_SANDBOX_EGRESS_IMAGE the `sandbox-egress` image (07.8-12); unset: no bot network gets a way out and every
 *                           browser op answers 503
 *   OCW_SANDBOX_BRW_SECCOMP the seccomp profile file for `brw` (infra/sandbox/browser/seccomp.json); unset: Docker's
 *                           default, so on runc Chromium falls back to `container-only` and says so (D-14)
 *   DOCKER_SOCKET           the daemon socket (default /var/run/docker.sock)
 *   OCW_SANDBOXD_SWEEP_MS   the sweep interval: quota, idle stop, usage, files helpers (default 60000; smokes
 *                           use a few seconds)
 *   OCW_SANDBOX_NPM_REGISTRY  npm registry of package reviews and installs (default https://registry.npmjs.org/)
 *   OCW_SANDBOX_PYPI_INDEX    PyPI simple index (default https://pypi.org/simple/)
 *   OCW_CLAWHUB_URL           ClawHub, the same value the API uses (default https://clawhub.ai)
 *   OCW_SANDBOX_REGISTRIES    comma list of hosts a review or installer run may reach (default: the npm, PyPI, Debian
 *                             and ClawHub hosts); fake registries in tests. Package runs need the egress image.
 */
const Env = z.object({
  OCW_SANDBOX_TOKEN: z.string().min(32, "OCW_SANDBOX_TOKEN must be at least 32 characters"),
  OCW_SANDBOX_NAMESPACE: z
    .string()
    .regex(NAMESPACE_RE, "OCW_SANDBOX_NAMESPACE: lower-case letters, digits, dashes"),
  OCW_SANDBOXD_HOST: z.string().min(1).default("127.0.0.1"),
  OCW_SANDBOXD_PORT: z.coerce.number().int().min(0).max(65_535).default(8090),
  OCW_SANDBOX_RUNTIME: z.enum(["auto", "runsc", "runc"]).default("auto"),
  OCW_SANDBOX_SBX_IMAGE: z.string().min(1).max(300).default("ocw-sandbox-sbx:local"),
  OCW_SANDBOX_BRW_IMAGE: z.string().min(1).max(300).optional(),
  OCW_SANDBOX_EGRESS_IMAGE: z.string().min(1).max(300).optional(),
  OCW_SANDBOX_BRW_SECCOMP: z.string().min(1).max(4096).optional(),
  DOCKER_SOCKET: z.string().min(1).default("/var/run/docker.sock"),
  OCW_SANDBOXD_SWEEP_MS: z.coerce.number().int().min(1000).max(3_600_000).default(SWEEP_INTERVAL_MS),
});

function writeLog(line: LogLine) {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...line })}\n`);
}

async function main() {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    // Names of the failing variables only, never their values.
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(", ");
    writeLog({ level: "error", msg: "invalid environment", variables: names });
    process.exit(1);
  }
  const env = parsed.data;

  let seccompProfile: string | null = null;
  if (env.OCW_SANDBOX_BRW_SECCOMP) {
    try {
      // Sent inline to the Engine (the API takes the profile's JSON, not a path); validated and minified here.
      seccompProfile = JSON.stringify(JSON.parse(readFileSync(env.OCW_SANDBOX_BRW_SECCOMP, "utf8")));
    } catch {
      writeLog({ level: "error", msg: "invalid environment", variables: "OCW_SANDBOX_BRW_SECCOMP" });
      process.exit(1);
    }
  }

  let registries: RegistryConfig;
  try {
    registries = registryConfig(process.env);
  } catch {
    writeLog({
      level: "error",
      msg: "invalid environment",
      variables: "OCW_SANDBOX_NPM_REGISTRY, OCW_SANDBOX_PYPI_INDEX, OCW_CLAWHUB_URL, OCW_SANDBOX_REGISTRIES",
    });
    process.exit(1);
  }

  const docker = createDocker({ socketPath: env.DOCKER_SOCKET });

  // D-14: the container sandboxd runs in (if any) must not carry the label sandboxd kills and purges by.
  try {
    const id = ownContainerId(
      readFileSync("/proc/self/mountinfo", "utf8"),
      readFileSync("/proc/self/cgroup", "utf8"),
    );
    if (id) {
      const self = await docker.request("GET", `/containers/${id}/json`);
      const labels = (self.body as { Config?: { Labels?: Record<string, string> } } | null)?.Config?.Labels;
      const refusal = self.status === 200 ? ownLabelRefusal(labels) : null;
      if (refusal) {
        writeLog({ level: "error", msg: "refusing to start", reason: refusal });
        process.exit(1);
      }
    }
  } catch {
    // Not Linux, or not in a container this daemon knows: a host process carries no label.
  }

  // Lifecycle and usage events for the API's long poll (ids, kinds, states and sizes only).
  const events = createEvents();
  const egress = env.OCW_SANDBOX_EGRESS_IMAGE
    ? createEgress({
        docker,
        ns: env.OCW_SANDBOX_NAMESPACE,
        image: env.OCW_SANDBOX_EGRESS_IMAGE,
        onEvent: (event) => events.emit(event),
        registries: registries.registries,
      })
    : null;
  const sandboxes = createSandboxes({
    docker,
    ns: env.OCW_SANDBOX_NAMESPACE,
    runtime: env.OCW_SANDBOX_RUNTIME,
    image: env.OCW_SANDBOX_SBX_IMAGE,
    onEvent: (event) => events.emit(event),
    egress,
  });
  const browsers = createBrowsers({
    docker,
    sandboxes,
    egress,
    ns: env.OCW_SANDBOX_NAMESPACE,
    image: env.OCW_SANDBOX_BRW_IMAGE ?? null,
    seccompProfile,
    onEvent: (event) => events.emit(event),
  });

  let info: SandboxdInfo | null = null;
  try {
    info = await sandboxes.info();
  } catch {
    // Docker down at start: keep serving; every ensure probes again and fails closed.
    writeLog({ level: "warn", msg: "docker unavailable at start" });
  }
  if (info) {
    writeLog({
      level: info.dockerOk ? "info" : "warn",
      msg: "docker",
      dockerVersion: info.dockerVersion,
      dockerOk: info.dockerOk,
      runtime: info.runtime,
      runtimes: info.runtimes,
    });
    // D-14: a required gVisor that is missing stops sandboxd here instead of running sandboxes on runc.
    const refusal = startupRefusal(env.OCW_SANDBOX_RUNTIME, info);
    if (refusal) {
      writeLog({ level: "error", msg: "refusing to start", reason: refusal });
      process.exit(1);
    }
    try {
      const adopted = await sandboxes.reconcile();
      writeLog({ level: "info", msg: "reconciled", namespace: env.OCW_SANDBOX_NAMESPACE, ...adopted });
    } catch {
      writeLog({ level: "warn", msg: "reconcile failed" });
    }
  }

  // Sandbox packages (07.8-17): review and installer containers from the `sbx` image, through the egress proxy.
  const runner = dockerPackageRunner({
    docker,
    sandboxes,
    egress,
    ns: env.OCW_SANDBOX_NAMESPACE,
    image: env.OCW_SANDBOX_SBX_IMAGE,
    env: runEnv(registries),
  });
  if (info) {
    // 07.8-28 (WINDOWS #260): a run lives within one process; what a crashed process left of its runs goes now.
    try {
      const swept = await runner.sweepOrphans?.();
      writeLog({ level: "info", msg: "package runs swept", namespace: env.OCW_SANDBOX_NAMESPACE, ...swept });
    } catch {
      writeLog({ level: "warn", msg: "package run sweep failed" });
    }
  }
  const packages = createPackages({ runner });

  const quota = createQuota({ sandboxes });
  const files = createFiles({ sandboxes, quota });
  const sweeper = createSweeper({
    sandboxes,
    quota,
    intervalMs: env.OCW_SANDBOXD_SWEEP_MS,
    // The step and the error's name only: never a path, an argv or content.
    onError: (step, err) =>
      writeLog({
        level: "warn",
        msg: "sweep failed",
        step,
        error: err instanceof Error ? err.name : "unknown",
      }),
  });
  const server = createServer({
    token: env.OCW_SANDBOX_TOKEN,
    sandboxes,
    files,
    events,
    browsers,
    egress,
    packages,
    log: writeLog,
  });
  let stopWatching = () => {};
  server.listen(env.OCW_SANDBOXD_PORT, env.OCW_SANDBOXD_HOST, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : env.OCW_SANDBOXD_PORT;
    writeLog({ level: "info", msg: "listening", host: env.OCW_SANDBOXD_HOST, port, bootId: events.bootId });
    sweeper.start();
    browsers.start();
    stopWatching = sandboxes.watch();
  });

  const shutdown = () => {
    sweeper.stop();
    browsers.stop();
    egress?.close();
    stopWatching();
    events.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main();
