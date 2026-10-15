import type { SandboxdInfo } from "@ocw/contracts";
import { z } from "zod";
import { createDocker } from "./docker";
import { createFiles } from "./files";
import { createQuota } from "./quota";
import { createSandboxes, startupRefusal } from "./sandboxes";
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
 *   DOCKER_SOCKET           the daemon socket (default /var/run/docker.sock)
 *   OCW_SANDBOXD_SWEEP_MS   the sweep interval: quota, idle stop, usage, files helpers (default 60000; smokes
 *                           use a few seconds)
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

  const docker = createDocker({ socketPath: env.DOCKER_SOCKET });
  const sandboxes = createSandboxes({
    docker,
    ns: env.OCW_SANDBOX_NAMESPACE,
    runtime: env.OCW_SANDBOX_RUNTIME,
    image: env.OCW_SANDBOX_SBX_IMAGE,
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
  const server = createServer({ token: env.OCW_SANDBOX_TOKEN, sandboxes, files, log: writeLog });
  server.listen(env.OCW_SANDBOXD_PORT, env.OCW_SANDBOXD_HOST, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : env.OCW_SANDBOXD_PORT;
    writeLog({ level: "info", msg: "listening", host: env.OCW_SANDBOXD_HOST, port });
    sweeper.start();
  });

  const shutdown = () => {
    sweeper.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main();
