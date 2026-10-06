// Records a REAL Codex session through CodexRuntime (codex app-server) and stores every JSON-RPC
// message as a fixture for mapper / runtime tests. Manual tool, never run in CI.
//
// Billing guard: refuses to run when OPENAI_API_KEY / CODEX_API_KEY is set and requires the local
// Codex login to be ChatGPT (subscription). At most ONE trivial turn per fixture, in a throwaway temp
// git repo, never in a full-access sandbox.
//
//   npx tsx scripts/record-codex-fixture.ts [--scenario plan-read|supervised-write|model-list|title] [--codex /path/to/codex]
//
// Scenarios:
//   plan-read         plan mode (read-only sandbox), "cat hello.txt", reply OK            (default)
//   supervised-write  Supervised (read-only + untrusted), effort low via configure(), asks to create a
//                     file; every approval request is declined (03.2-03, D-12)
//   model-list        `initialize` + `model/list` only: no thread, no turn, no cost (03.2-03, D-08)
//   title             the session-title call (03.2-12): an ephemeral read-only gpt-6-luna thread on its own
//                     app-server, effort low, one turn; pinned to codex-cli 0.160.0

import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeSessionTitle,
  type PermissionMode,
  type SessionEvent,
  type SessionSettingsPatch,
} from "@ocw/contracts";
import { listCodexModels } from "../src/codex/catalog.js";
import { type AppServerProcess, CodexRuntime, codexChildEnv } from "../src/codex/codex-runtime.js";
import { detectCodex } from "../src/codex/detect.js";
import { generateCodexTitle } from "../src/codex/title.js";
import { sanitizeEvent } from "../src/sanitize.js";

const FIXTURE_ROOT = "/tmp/ocw-fixture-repo";
const FIXTURE_HOME = "/Users/fixture-user";

interface Scenario {
  mode: Exclude<PermissionMode, "fullAccess">;
  configure?: SessionSettingsPatch;
  prompt: string;
}

const SCENARIOS: Record<string, Scenario | "no-turn" | "title"> = {
  "model-list": "no-turn",
  title: "title",
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
const scenario = picked;
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

function fixtureDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "src", "codex", "__fixtures__");
}

/** `model/list` pages merged into one `ModelListResponse`-shaped file. */
async function recordModelList(version: string | null): Promise<void> {
  const bin = codexPath ?? "codex";
  const models = await listCodexModels(
    ({ cwd, env }) =>
      spawn(bin, ["app-server"], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      }) as unknown as AppServerProcess,
    { env: codexChildEnv(process.env) },
  );
  await mkdir(fixtureDir(), { recursive: true });
  const file = join(fixtureDir(), `codex-${version ?? "unknown"}.model-list.json`);
  await writeFile(file, `${JSON.stringify(scrub({ data: models, nextCursor: null }, []), null, 2)}\n`);
  console.log(`wrote ${models.length} models -> ${file.replace(homedir(), "~")}`);
  for (const m of models)
    console.log(
      `${m.id}${m.isDefault ? " (default)" : ""}${m.hidden ? " hidden" : ""} efforts=${m.supportedReasoningEfforts
        .map((e) => e.reasoningEffort)
        .join(",")} tiers=${m.serviceTiers.map((t) => t.id).join(",")}`,
    );
}

/** The codex-cli version the title fixture is pinned to. */
const PINNED_TITLE_CODEX = "0.160.0";
const TITLE_PROMPT = "Please fix the login redirect bug on the settings page when the session expires";

/** Notifications that only describe the owner's personal Codex config; never fit for an open-source fixture. */
const PERSONAL =
  /^(mcpServer\/startupStatus\/updated|hook\/.*|warning|configWarning|account\/.*|remoteControl\/.*)$/;

/**
 * The session-title call through the adapter's own `generateCodexTitle` (ONE turn). `hookPrompt` items (the owner's
 * local hooks) are dropped. The recording is kept even when the adapter refuses the answer.
 */
async function recordTitle(version: string | null): Promise<void> {
  if (version !== PINNED_TITLE_CODEX) {
    console.error(`codex ${version} is not the pinned ${PINNED_TITLE_CODEX}; pass --codex <pinned binary>.`);
    process.exit(1);
  }
  const bin = codexPath ?? "codex";
  const parent = await mkdtemp(join(tmpdir(), "ocw-fixture-"));
  const real = await realpath(parent);
  const roots = [...new Set([real, parent])].sort((a, b) => b.length - a.length);
  const rpc: Array<{ dir: "in" | "out"; msg: unknown }> = [];
  let answer: string | null = null;
  try {
    answer = await generateCodexTitle(
      ({ cwd, env }) =>
        spawn(bin, ["app-server"], {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        }) as unknown as AppServerProcess,
      {
        env: codexChildEnv(process.env),
        prompt: TITLE_PROMPT,
        model: "gpt-6-luna",
        effort: "low",
        signal: AbortSignal.timeout(90_000),
        tmpRoot: real,
        onRpcMessage: (dir, msg) => rpc.push({ dir, msg }),
      },
    );
  } catch (err) {
    console.error("title call refused (recorded as observed):", err);
  }
  await rm(real, { recursive: true, force: true });
  const isHookItem = (m: unknown) => {
    const p = (m as { params?: { item?: { type?: unknown } } }).params;
    return p?.item?.type === "hookPrompt";
  };
  const kept = rpc.filter(
    (r) => !PERSONAL.test(String((r.msg as { method?: unknown }).method ?? "")) && !isHookItem(r.msg),
  );
  await mkdir(fixtureDir(), { recursive: true });
  const file = join(fixtureDir(), `codex-${version}.title.rpc.jsonl`);
  await writeFile(file, `${kept.map((r) => JSON.stringify(scrub(r, roots))).join("\n")}\n`);
  console.log(`wrote ${kept.length} of ${rpc.length} JSON-RPC messages -> ${file.replace(homedir(), "~")}`);
  console.log("raw answer:", JSON.stringify(answer));
  console.log("normalized:", JSON.stringify(answer === null ? null : normalizeSessionTitle(answer)));
}

async function main(): Promise<void> {
  const info = await detectCodex(codexPath ? { codexPath } : {});
  if (!info.installed || !info.loggedIn) {
    console.error("codex is not installed or not logged in with ChatGPT; aborting.");
    process.exit(1);
  }
  if (scenario === "no-turn") return recordModelList(info.version);
  if (scenario === "title") return recordTitle(info.version);
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

  const outDir = fixtureDir();
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, `codex-${info.version ?? "unknown"}.${scenarioName}.rpc.jsonl`);
  // Drop notifications that only describe the owner's personal Codex config (MCP servers, hooks,
  // plugins, account): ignored by the mapper anyway and not fit for an open-source fixture.
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
