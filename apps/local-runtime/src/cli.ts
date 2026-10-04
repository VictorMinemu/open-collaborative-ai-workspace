// ocw-runtime CLI.
//   ocw-runtime enroll --server <url> --code <code> [--name <name>]   pair this machine (writes ~/.ocw)
//   ocw-runtime [run]              start the daemon (default)
//   ocw-runtime detect             print Claude Code detection
//   ocw-runtime status             query a running daemon over the control socket
//   ocw-runtime add-project <dir>  register a project (via the running daemon, or directly when stopped)
//   ocw-runtime projects           list registered projects (local only)

import { detectClaudeCode } from "./claude/detect.js";
import { ensureOcwHome, ocwHome, ProjectRegistry } from "./config.js";
import { type ControlRequest, controlRequest, controlSocketPath } from "./control-socket.js";
import { Daemon } from "./daemon.js";
import { enroll } from "./enroll.js";
import { errorMessage } from "./logger.js";

async function viaSocket(req: ControlRequest): Promise<void> {
  const res = await controlRequest(controlSocketPath(ocwHome()), req);
  if (!res.ok) throw new Error(res.error ?? "request failed");
  process.stdout.write(`${JSON.stringify(res.result, null, 2)}\n`);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}

function daemonDown(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

async function run(): Promise<void> {
  const daemon = await Daemon.create();
  await daemon.start();
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`received ${signal}, stopping\n`);
    daemon
      .stop()
      .catch(() => undefined)
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function main(argv: string[]): Promise<void> {
  const [cmd = "run", ...rest] = argv;
  switch (cmd) {
    case "run":
      return run();
    case "detect":
      process.stdout.write(`${JSON.stringify(await detectClaudeCode(), null, 2)}\n`);
      return;
    case "status":
      return viaSocket({ cmd: "status" });
    case "projects":
      return viaSocket({ cmd: "listProjects" });
    case "add-project": {
      const path = rest[0];
      if (!path) throw new Error("usage: ocw-runtime add-project <dir> [--name <name>]");
      const name = flag(rest, "name");
      try {
        return await viaSocket({ cmd: "addProject", path, ...(name ? { name } : {}) });
      } catch (err) {
        if (!daemonDown(err)) throw err;
        // Daemon not running: register directly; it is announced on the next connect.
        const home = ocwHome();
        await ensureOcwHome(home);
        const registry = new ProjectRegistry(home);
        await registry.load();
        const project = await registry.add(path, name);
        process.stdout.write(`${JSON.stringify(project, null, 2)}\n`);
        return;
      }
    }
    case "enroll": {
      const server = flag(rest, "server") ?? process.env.OCW_SERVER_URL;
      const code = flag(rest, "code");
      if (!server || !code)
        throw new Error("usage: ocw-runtime enroll --server <url> --code <XXXX-XXXX> [--name <name>]");
      const name = flag(rest, "name");
      const out = await enroll({ home: ocwHome(), serverUrl: server, code, ...(name ? { name } : {}) });
      process.stdout.write(
        `Paired "${out.name}" with ${out.serverUrl}.\nToken saved to ${out.tokenPath} (0600).\nStart the runtime with: ocw-runtime run\n`,
      );
      return;
    }
    case "remove-project": {
      const localId = rest[0];
      if (!localId) throw new Error("usage: ocw-runtime remove-project <localId>");
      return viaSocket({ cmd: "removeProject", localId });
    }
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`ocw-runtime: ${errorMessage(err)}\n`);
  process.exit(1);
});
