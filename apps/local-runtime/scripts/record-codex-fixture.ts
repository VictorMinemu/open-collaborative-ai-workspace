// Records a REAL Codex session through CodexRuntime (codex app-server) and stores every JSON-RPC
// message as a fixture for mapper / runtime tests. Manual tool, never run in CI.
//
// Billing guard: refuses to run when OPENAI_API_KEY / CODEX_API_KEY is set and requires the local
// Codex login to be ChatGPT (subscription). At most ONE trivial turn per fixture, in a throwaway temp
// git repo, never in a full-access sandbox.
//
//   npx tsx scripts/record-codex-fixture.ts [--scenario plan-read|supervised-write] [--codex /path/to/codex]
//
// Scenarios:
//   plan-read         plan mode (read-only sandbox), "cat hello.txt", reply OK            (default)
//   supervised-write  Supervised (read-only + untrusted), effort low via configure(), asks to create a
//                     file; every approval request is declined (03.2-03, D-12)

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PermissionMode, SessionEvent, SessionSettingsPatch } from "@ocw/contracts";
import { CodexRuntime } from "../src/codex/codex-runtime.js";
import { detectCodex } from "../src/codex/detect.js";
import { sanitizeEvent } from "../src/sanitize.js";

const FIXTURE_ROOT = "/tmp/ocw-fixture-repo";
const FIXTURE_HOME = "/Users/fixture-user";

interface Scenario {
  mode: Exclude<PermissionMode, "fullAccess">;
  configure?: SessionSettingsPatch;
  prompt: string;
}

const SCENARIOS: Record<string, Scenario> = {
  "plan-read": { mode: "plan", prompt: "Run `cat hello.txt`, then reply with exactly: OK" },
  "supervised-write": {
    mode: "default",
    configure: { effort: "low" },
    prompt: "Create a file named note.txt containing the word hi.",
  },
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const scenarioName = arg("scenario") ?? "plan-read";
const picked = SCENARIOS[scenarioName];
if (!picked) {
  console.error(`unknown scenario ${scenarioName}; one of ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(1);
}
const scenario: Scenario = picked;
const codexPath = arg("codex");

if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) {
  console.error("OPENAI_API_KEY / CODEX_API_KEY is set; refusing to record (would be metered).");
  process.exit(1);
}

function scrub(v: unknown, roots: string[]): unknown {
  if (typeof v === "string") {
    let out = v;
    for (const r of roots) out = out.split(r).join(FIXTURE_ROOT);
    out = out.split(homedir()).join(FIXTURE_HOME);
    return out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "fixture@example.com");
  }
  if (Array.isArray(v)) return v.map((x) => scrub(x, roots));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = scrub(x, roots);
    return out;
  }
  return v;
}

async function main(): Promise<void> {
  const info = await detectCodex(codexPath ? { codexPath } : {});
  if (!info.installed || !info.loggedIn) {
    console.error("codex is not installed or not logged in with ChatGPT; aborting.");
    process.exit(1);
  }
  const tmp = await mkdtemp(join(tmpdir(), "ocw-fixture-"));
  const real = await realpath(tmp);
  const roots = [...new Set([real, tmp])].sort((a, b) => b.length - a.length);
  await writeFile(join(real, "hello.txt"), "Hello from the fixture repo.\n");
  execFileSync("git", ["init", "-q"], { cwd: real });

  const rpc: Array<{ dir: "in" | "out"; msg: unknown }> = [];
  const events: SessionEvent[] = [];
  const runtime = new CodexRuntime({
    ...(codexPath ? { codexPath } : {}),
    onRpcMessage: (dir, msg) => rpc.push({ dir, msg }),
  });

  const done = new Promise<void>((resolve) => {
    void runtime
      .start({ sessionId: "fixture-session", cwd: real, permissionMode: scenario.mode }, (ev) => {
        events.push(ev);
        if (ev.type === "approval.requested")
          runtime.resolveApproval("fixture-session", ev.approvalId, "deny");
        if (ev.type === "prompt.completed" || (ev.type === "session.state" && ev.status === "failed"))
          resolve();
      })
      .then(() => (scenario.configure ? runtime.configure("fixture-session", scenario.configure) : undefined))
      .then(() => runtime.prompt("fixture-session", { promptId: "prompt-1", text: scenario.prompt }))
      .catch((err: unknown) => {
        console.error(err);
        resolve();
      });
  });
  await done;
  await runtime.stop("fixture-session");

  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, "..", "src", "codex", "__fixtures__");
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, `codex-${info.version ?? "unknown"}.${scenarioName}.rpc.jsonl`);
  // Drop notifications that only describe the owner's personal Codex config (MCP servers, hooks,
  // plugins, account): ignored by the mapper anyway and not fit for an open-source fixture.
  const PERSONAL =
    /^(mcpServer\/startupStatus\/updated|hook\/.*|warning|configWarning|account\/.*|remoteControl\/.*)$/;
  const kept = rpc.filter((r) => !PERSONAL.test(String((r.msg as { method?: unknown }).method ?? "")));
  await writeFile(file, `${kept.map((r) => JSON.stringify(scrub(r, roots))).join("\n")}\n`);
  await rm(real, { recursive: true, force: true });

  console.log(`wrote ${rpc.length} JSON-RPC messages -> ${file.replace(homedir(), "~")}`);
  for (const ev of events) console.log(JSON.stringify(sanitizeEvent(ev, roots)).slice(0, 300));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
