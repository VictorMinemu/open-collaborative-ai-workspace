// Records a REAL Codex session through CodexRuntime (codex app-server) and stores every JSON-RPC
// message as a fixture for mapper tests. Manual tool, never run in CI.
//
// Billing guard: refuses to run when OPENAI_API_KEY / CODEX_API_KEY is set and requires the local
// Codex login to be ChatGPT (subscription). One trivial prompt, read-only sandbox (plan mode).
//
//   npx tsx scripts/record-codex-fixture.ts

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEvent } from "@ocw/contracts";
import { CodexRuntime } from "../src/codex/codex-runtime.js";
import { detectCodex } from "../src/codex/detect.js";
import { sanitizeEvent } from "../src/sanitize.js";

const FIXTURE_ROOT = "/tmp/ocw-fixture-repo";
const FIXTURE_HOME = "/Users/fixture-user";

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
  const info = await detectCodex();
  if (!info.installed || !info.loggedIn) {
    console.error("codex is not installed or not logged in with ChatGPT; aborting.");
    process.exit(1);
  }
  const tmp = await mkdtemp(join(tmpdir(), "ocw-fixture-"));
  const real = await realpath(tmp);
  const roots = [...new Set([real, tmp])].sort((a, b) => b.length - a.length);
  await writeFile(join(real, "hello.txt"), "Hello from the fixture repo.\n");

  const rpc: Array<{ dir: "in" | "out"; msg: unknown }> = [];
  const events: SessionEvent[] = [];
  const runtime = new CodexRuntime({ onRpcMessage: (dir, msg) => rpc.push({ dir, msg }) });

  const done = new Promise<void>((resolve) => {
    void runtime
      .start({ sessionId: "fixture-session", cwd: real, permissionMode: "plan" }, (ev) => {
        events.push(ev);
        if (ev.type === "approval.requested")
          runtime.resolveApproval("fixture-session", ev.approvalId, "deny");
        if (ev.type === "prompt.completed" || (ev.type === "session.state" && ev.status === "failed"))
          resolve();
      })
      .then(() =>
        runtime.prompt("fixture-session", {
          promptId: "prompt-1",
          text: "Run `cat hello.txt`, then reply with exactly: OK",
        }),
      )
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
  const file = join(outDir, `codex-${info.version ?? "unknown"}.plan-read.rpc.jsonl`);
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
