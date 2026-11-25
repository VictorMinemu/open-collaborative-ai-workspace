// Records a REAL Codex session through CodexRuntime (codex app-server) and stores every JSON-RPC
// message as a fixture for mapper / runtime tests. Manual tool, never run in CI.
//
// Billing guard: refuses to run when OPENAI_API_KEY / CODEX_API_KEY is set and requires the local
// Codex login to be ChatGPT (subscription). At most ONE trivial turn per fixture, in a throwaway temp
// git repo, never in a full-access sandbox.
//
//   npx tsx scripts/record-codex-fixture.ts [--scenario plan-read|supervised-write|model-list|title] [--codex /path/to/codex]
//   npx tsx scripts/record-codex-fixture.ts --offline [--scenario …] [--fake-url http://127.0.0.1:<port>] [--print-env]
//
// `--offline` (07.13-25, PD-29) is valid for every scenario and is how the pinned fixtures are recorded: no login, no
// subscription, no key. The real codex-cli 0.172.0 app-server runs with HOME / CODEX_HOME / CLAUDE_CONFIG_DIR / XDG
// dirs in a fresh temp dir (offlineRecorderEnv) and the repo's fake model (infra/fake-model, Responses API, loopback)
// as its only provider (`model_provider = "ocw_fake"`, `model = "fake-model"`, plugins / remote plugins / apps off).
// The turn prompts carry the fake's `[[call <tool> <json>]]` directive so the model calls the offered shell tool; the
// title prompt forces the fake's title with `[[title:…]]`. The login check and the key guard are skipped (the child
// env drops every caller key) and the caller's home is never read. Without `--offline` the scenarios use the local
// ChatGPT login (a manual refresh only).
//
// Scenarios:
//   plan-read         plan mode (read-only sandbox), "cat hello.txt", reply OK            (default)
//   supervised-write  Supervised (read-only + untrusted), effort low via configure(), asks to create a
//                     file; every approval request is declined (03.2-03, D-12)
//   model-list        `initialize` + `model/list` only: no thread, no turn, no cost (03.2-03, D-08)
//   title             the session-title call (03.2-12): an ephemeral read-only gpt-6-luna thread on its own
//                     app-server, effort low, one turn; pinned to codex-cli 0.160.0
//   browser-mcp       07.13-04, OFFLINE (PD-29): no login, no subscription, no key. The real codex-cli 0.172.0
//                     app-server runs with HOME / CODEX_HOME / CLAUDE_CONFIG_DIR / XDG dirs in a fresh temp dir
//                     (offlineRecorderEnv), its only model provider the repo's fake model server on loopback
//                     (`ocw_fake`, Responses API; started in-process on a random port unless --fake-url is given),
//                     and the stand-in `ocw_browser` stdio MCP server (scripts/spike-browser-mcp.mjs) configured by
//                     `-c mcp_servers.ocw_browser.*` (PD-08). One turn calls its `open` and `screenshot` tools; every
//                     server request is recorded and answered as PD-08 plans. `--print-env` prints the child env
//                     (PATH omitted) and exits; a non-loopback `--fake-url` exits non-zero before anything starts.
//                     `--approval-mode prompt` (control run) writes `…browser-mcp.prompt-mode.rpc.jsonl` instead: the
//                     same turn with `default_tools_approval_mode = "prompt"`, so Codex asks through elicitations.

import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeSessionTitle,
  type PermissionMode,
  type SessionEvent,
  type SessionSettingsPatch,
} from "@ocw/contracts";
import { createFakeModelServer, type FakeModelRequest } from "../../../infra/fake-model/server.mjs";
import { listCodexModels } from "../src/codex/catalog.js";
import {
  type AppServerProcess,
  CODEX_APP_SERVER_ARGS,
  CodexRuntime,
  type CodexRuntimeOptions,
  codexChildEnv,
  type SpawnAppServer,
} from "../src/codex/codex-runtime.js";
import { detectCodex, parseCodexVersion } from "../src/codex/detect.js";
import {
  JsonRpcError,
  type JsonRpcNotification,
  JsonRpcPeer,
  type JsonRpcRequest,
} from "../src/codex/jsonrpc.js";
import { generateCodexTitle } from "../src/codex/title.js";
import {
  isLoopbackUrl,
  makeOfflineDirs,
  type OfflineEnv,
  offlineRecorderEnv,
  printableOfflineEnv,
} from "../src/fixtures/offline-env.js";
import { sanitizeEvent } from "../src/sanitize.js";

const FIXTURE_ROOT = "/tmp/ocw-fixture-repo";
const FIXTURE_HOME = "/Users/fixture-user";

interface Scenario {
  mode: Exclude<PermissionMode, "fullAccess">;
  configure?: SessionSettingsPatch;
  prompt: string;
}

const SCENARIOS: Record<string, Scenario | "no-turn" | "title" | "browser-mcp"> = {
  "model-list": "no-turn",
  title: "title",
  "browser-mcp": "browser-mcp",
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
/** browser-mcp is always offline; every other scenario with `--offline` (07.13-25). */
const offline = scenario === "browser-mcp" || process.argv.includes("--offline");

// An offline child env drops every caller key (offlineRecorderEnv) and never reaches a real provider.
if (!offline && (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY)) {
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

/**
 * The codex-cli version every offline fixture is recorded at (browser-mcp in 07.13-04; the pinned fixtures in 07.13-25,
 * `PINNED_RUNTIME_VERSIONS.codex.cli`).
 */
const OFFLINE_CODEX = "0.172.0";
/** The browser-mcp turn: the fake model calls `open`, then `screenshot`, then reports what each tool said. */
const BROWSER_MCP_PROMPT = '[[call open {"url":"http://localhost:1/"}]] [[call screenshot {}]]';
const BROWSER_MCP_TURN_TIMEOUT_MS = 180_000;

/** A TOML basic string (`-c` values are parsed as TOML; JSON string escapes are valid TOML ones). */
const toml = (s: string): string => JSON.stringify(s);

/** The `-c` overrides of every offline app-server: the fake provider and model, and nothing that leaves the device. */
function offlineCodexOverrides(fakeOrigin: string): string[] {
  return [
    `model_provider=${toml("ocw_fake")}`,
    `model_providers.ocw_fake.name=${toml("OCW fake")}`,
    `model_providers.ocw_fake.base_url=${toml(`${fakeOrigin}/v1`)}`,
    `model_providers.ocw_fake.wire_api=${toml("responses")}`,
    `model_providers.ocw_fake.env_key=${toml("OCW_FAKE_MODEL_KEY")}`,
    `model=${toml("fake-model")}`,
    // Offline: no curated-plugin clone from GitHub, no remote plugins, no ChatGPT apps connectors (a first run
    // without these cloned the plugin catalogue into the temp CODEX_HOME). The MCP tool path is unaffected.
    "features.plugins=false",
    "features.remote_plugin=false",
    "features.apps=false",
  ];
}

const asArgs = (overrides: string[]): string[] => overrides.flatMap((o) => ["-c", o]);

/** The `-c` overrides of the browser-mcp app-server: the fake provider and the `ocw_browser` server (PD-08). */
function browserMcpArgs(fakeOrigin: string, node: string, spike: string, approvalMode: string): string[] {
  const overrides = [
    ...offlineCodexOverrides(fakeOrigin),
    `mcp_servers.ocw_browser.command=${toml(node)}`,
    `mcp_servers.ocw_browser.args=[${toml(spike)}]`,
    `mcp_servers.ocw_browser.default_tools_approval_mode=${toml(approvalMode)}`,
    "mcp_servers.ocw_browser.tool_timeout_sec=960",
  ];
  return [...CODEX_APP_SERVER_ARGS, ...asArgs(overrides)];
}

/** An offline recording's fake model, temp dir and child env (PD-29). */
interface OfflineRun {
  env: OfflineEnv;
  tmp: string;
  realTmp: string;
  fakeOrigin: string;
  /** The fake's view of each model request (console notes only, never written into a fixture). */
  requests: FakeModelRequest[];
  bin: string;
  version: string;
  /** Removes the temp dir and stops the in-process fake. */
  close(): Promise<void>;
}

/**
 * Starts the fake model (in-process on a random loopback port unless `--fake-url` names one), builds the offline env
 * and checks the binary is the pinned `OFFLINE_CODEX`. `--print-env` prints the env and returns null; a non-loopback
 * `--fake-url` throws before anything starts.
 */
async function openOffline(): Promise<OfflineRun | null> {
  const fakeArg = arg("fake-url");
  if (fakeArg !== undefined && !isLoopbackUrl(fakeArg)) {
    throw new Error("--fake-url must be http(s) on a loopback host (the fake model server)");
  }
  const requests: FakeModelRequest[] = [];
  const fake = fakeArg ? null : createFakeModelServer({ onRequest: (r) => requests.push(r) });
  if (fake) await new Promise<void>((ok) => fake.listen(0, "127.0.0.1", ok));
  const fakeOrigin = fake
    ? `http://127.0.0.1:${(fake.address() as AddressInfo).port}`
    : new URL(fakeArg ?? "").origin;
  const closeFake = () => new Promise<void>((ok) => (fake ? fake.close(() => ok()) : ok()));
  const tmp = await mkdtemp(join(tmpdir(), "ocw-offline-codex-"));
  const close = async () => {
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await closeFake();
  };
  let env: OfflineEnv;
  try {
    env = offlineRecorderEnv({ env: process.env, tmp, fakeUrl: fakeOrigin });
  } catch (err) {
    await close();
    throw err;
  }
  if (process.argv.includes("--print-env")) {
    process.stdout.write(`${JSON.stringify(printableOfflineEnv(env), null, 2)}\n`);
    await close();
    return null;
  }
  const bin = codexPath ?? "codex";
  makeOfflineDirs(env);
  const version = parseCodexVersion(execFileSync(bin, ["--version"], { env, encoding: "utf8" }));
  if (version !== OFFLINE_CODEX) {
    await close();
    throw new Error(`codex ${version} is not the pinned ${OFFLINE_CODEX}; pass --codex <pinned binary>.`);
  }
  return { env, tmp, realTmp: await realpath(tmp), fakeOrigin, requests, bin, version, close };
}

/**
 * The adapter's `SpawnAppServer` for an offline run: the adapter's arguments (or the default) plus the offline
 * overrides, and the offline env instead of the one the adapter filtered from the caller's.
 */
function offlineSpawn(run: OfflineRun): SpawnAppServer {
  return ({ cwd, args }) =>
    spawn(run.bin, [...(args ?? CODEX_APP_SERVER_ARGS), ...asArgs(offlineCodexOverrides(run.fakeOrigin))], {
      cwd,
      env: run.env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as unknown as AppServerProcess;
}

/** The placeholder pairs of an offline fixture: the repo is FIXTURE_ROOT, the rest of the temp dir `<tmp>`. */
function offlineRoots(run: OfflineRun, repo: string, realRepo: string): Array<[string, string]> {
  const roots: Array<[string, string]> = [
    [realRepo, FIXTURE_ROOT],
    [repo, FIXTURE_ROOT],
    [run.realTmp, "<tmp>"],
    [run.tmp, "<tmp>"],
    [process.execPath, "<node>"],
  ];
  if (process.env.HOME) roots.push([process.env.HOME, FIXTURE_HOME]);
  return roots.sort((a, b) => b[0].length - a[0].length);
}

/** The shell tool codex-cli 0.172.0 offers the model (unified exec: `{ cmd, workdir?, … }`), recorded in the console. */
const OFFLINE_SHELL_TOOL = "exec_command";
/** The offline turn prompts: the fake model calls the offered shell tool through `[[call]]` (07.13-25). */
const OFFLINE_PROMPTS: Record<string, string> = {
  "plan-read": `Run \`cat hello.txt\`. [[call ${OFFLINE_SHELL_TOOL} {"cmd":"cat hello.txt"}]]`,
  "supervised-write":
    "Create a file named note.txt containing the word hi. " +
    `[[call ${OFFLINE_SHELL_TOOL} {"cmd":"printf hi > note.txt"}]]`,
};
/** The offline title: the fake answers a title request with the forced text (its `[[title:…]]` rule). */
const OFFLINE_TITLE_PROMPT = `${TITLE_PROMPT} [[title:Fix settings page login redirect]]`;

/** Replaces every absolute root with its placeholder (longest first) and masks e-mail addresses. */
function placeholders(v: unknown, roots: Array<[string, string]>): unknown {
  if (typeof v === "string") {
    let out = v;
    for (const [root, mark] of roots) out = out.split(root).join(mark);
    return out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "fixture@example.com");
  }
  if (Array.isArray(v)) return v.map((x) => placeholders(x, roots));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = placeholders(x, roots);
    return out;
  }
  return v;
}

/**
 * PD-08's answers to the app-server's requests: an elicitation of `ocw_browser` is accepted, a user-input question on
 * an `ocw_browser` tool call gets each question's first option; every other server's elicitation and every approval
 * is declined; anything else is unsupported.
 */
function browserMcpAnswer(r: JsonRpcRequest, browserItems: Set<string>): unknown {
  const p = (r.params ?? {}) as Record<string, unknown>;
  switch (r.method) {
    case "mcpServer/elicitation/request":
      return p.serverName === "ocw_browser"
        ? { action: "accept", content: {}, _meta: null }
        : { action: "decline", content: null, _meta: null };
    case "item/tool/requestUserInput": {
      const mine = typeof p.itemId === "string" && browserItems.has(p.itemId);
      const questions = Array.isArray(p.questions) ? (p.questions as Array<Record<string, unknown>>) : [];
      const answers: Record<string, { answers: string[] }> = {};
      if (mine) {
        for (const q of questions) {
          const first = Array.isArray(q.options)
            ? (q.options[0] as { label?: unknown } | undefined)
            : undefined;
          if (typeof q.id === "string" && typeof first?.label === "string")
            answers[q.id] = { answers: [first.label] };
        }
      }
      return { answers };
    }
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "item/permissions/requestApproval":
      return { permissions: {}, scope: "turn" };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: { denied: { rejection: "declined by the browser-mcp recorder" } } };
    default:
      throw new JsonRpcError(`${r.method} is not supported by this client`, -32601);
  }
}

/** The browser-mcp scenario (07.13-04): offline, the real codex binary, the fake model, the spike MCP server. */
async function recordBrowserMcp(): Promise<void> {
  const approvalMode = arg("approval-mode") ?? "approve";
  if (approvalMode !== "approve" && approvalMode !== "prompt")
    throw new Error("--approval-mode is approve or prompt");
  const run = await openOffline();
  if (!run) return;
  const { env, tmp, realTmp, fakeOrigin, requests, bin, version } = run;
  const repo = join(tmp, "repo");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "hello.txt"), "Hello from the fixture repo.\n");
  execFileSync("git", ["init", "-q"], { cwd: repo, env });
  const here = dirname(fileURLToPath(import.meta.url));
  const spike = resolve(here, "spike-browser-mcp.mjs");
  const repoRoot = resolve(here, "..", "..", "..");
  // Placeholders for every absolute path that could appear (the caller's HOME is only a scrub string here).
  const roots: Array<[string, string]> = [
    [realTmp, "<tmp>"],
    [tmp, "<tmp>"],
    [spike, "<spike>"],
    [process.execPath, "<node>"],
    [repoRoot, "<repo>"],
  ];
  if (process.env.HOME) roots.push([process.env.HOME, "<home>"]);
  roots.sort((a, b) => b[0].length - a[0].length);

  const rpc: Array<{ dir: "in" | "out"; msg: unknown }> = [];
  const serverRequests: string[] = [];
  const browserItems = new Set<string>();
  let finalText = "";
  const proc = spawn(bin, browserMcpArgs(fakeOrigin, process.execPath, spike, approvalMode), {
    cwd: repo,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (d: string) => {
    stderr += d;
  });
  const exited = new Promise<void>((ok) => proc.once("exit", () => ok()));
  let turnDone: () => void = () => undefined;
  const turnCompleted = new Promise<void>((ok) => {
    turnDone = ok;
  });
  const peer = new JsonRpcPeer(proc.stdout, proc.stdin, {
    onNotification: (n: JsonRpcNotification) => {
      const p = (n.params ?? {}) as { item?: { type?: string; id?: string; server?: string; text?: string } };
      if (n.method === "item/started" && p.item?.type === "mcpToolCall" && p.item.server === "ocw_browser") {
        if (p.item.id) browserItems.add(p.item.id);
      }
      if (n.method === "item/completed" && p.item?.type === "agentMessage") finalText = p.item.text ?? "";
      if (n.method === "turn/completed") turnDone();
    },
    onRequest: async (r: JsonRpcRequest) => {
      serverRequests.push(r.method);
      return browserMcpAnswer(r, browserItems);
    },
    onClose: () => turnDone(),
    onLine: (dir, msg) => rpc.push({ dir, msg }),
  });
  let failure: unknown = null;
  let timer: NodeJS.Timeout | undefined;
  try {
    await peer.request(
      "initialize",
      {
        clientInfo: { name: "ocw_local_runtime", title: "Open Collaborative AI Workspace", version: "0.0.0" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      },
      30_000,
    );
    peer.notify("initialized");
    const started = await peer.request<{ thread: { id: string } }>(
      "thread/start",
      { cwd: repo, approvalPolicy: "on-request", sandbox: "read-only" },
      60_000,
    );
    await peer.request(
      "turn/start",
      { threadId: started.thread.id, input: [{ type: "text", text: BROWSER_MCP_PROMPT, text_elements: [] }] },
      60_000,
    );
    await Promise.race([
      turnCompleted,
      new Promise<void>((_, no) => {
        timer = setTimeout(
          () => no(new Error("the browser-mcp turn did not complete in time")),
          BROWSER_MCP_TURN_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    failure = err;
  } finally {
    clearTimeout(timer);
  }
  proc.stdin.end();
  proc.kill("SIGTERM");
  const gone = await Promise.race([
    exited.then(() => true),
    new Promise((ok) => setTimeout(() => ok(false), 3_000)),
  ]);
  if (!gone) {
    proc.kill("SIGKILL");
    await exited;
  }
  peer.close();

  const suffix = approvalMode === "prompt" ? "browser-mcp.prompt-mode" : "browser-mcp";
  const file = join(fixtureDir(), `codex-${version}.${suffix}.rpc.jsonl`);
  if (!failure) {
    await mkdir(fixtureDir(), { recursive: true });
    await writeFile(file, `${rpc.map((r) => JSON.stringify(placeholders(r, roots))).join("\n")}\n`);
  }
  await run.close();

  // What the SPIKES notes need, never written into the fixture: the fake's view of each model request.
  const responses = requests.filter((r) => r.kind === "responses");
  const offered = (responses[0]?.body?.tools ?? []) as Array<{ type?: string; name?: string }>;
  console.log(`model requests: ${requests.map((r) => `${r.kind} ${r.path}`).join(", ") || "none"}`);
  console.log(`tools offered: ${JSON.stringify(offered.map((t) => `${t.type}:${t.name ?? ""}`))}`);
  for (const [i, r] of responses.entries()) {
    const outputs = ((r.body?.input ?? []) as Array<{ type?: string; output?: unknown }>)
      .filter((x) => x.type === "function_call_output")
      .map((x) => JSON.stringify(placeholders(x.output, roots)).slice(0, 300));
    console.log(`responses #${i + 1}: function_call_output=${JSON.stringify(outputs)}`);
  }
  console.log(`server requests: ${JSON.stringify(serverRequests)}`);
  console.log(`final agent message: ${JSON.stringify(finalText)}`);
  if (failure) {
    console.error(String(placeholders(stderr.slice(-4000), roots)));
    throw failure;
  }
  console.log(`wrote ${rpc.length} JSON-RPC messages -> ${String(placeholders(file, roots))}`);
}

/** Drops the notifications that only describe a personal Codex config (see PERSONAL). */
const notPersonal = (r: { msg: unknown }) =>
  !PERSONAL.test(String((r.msg as { method?: unknown }).method ?? ""));

/**
 * One turn through CodexRuntime: start in the scenario's mode, configure, prompt, decline every approval, stop.
 * Writes `codex-<version>.<scenario>.rpc.jsonl` with `clean` applied to every line; returns the adapter's events.
 */
async function recordTurn(o: {
  scenario: Scenario;
  version: string | null;
  cwd: string;
  prompt: string;
  runtime: CodexRuntimeOptions;
  clean: (v: unknown) => unknown;
}): Promise<SessionEvent[]> {
  const rpc: Array<{ dir: "in" | "out"; msg: unknown }> = [];
  const events: SessionEvent[] = [];
  const runtime = new CodexRuntime({ ...o.runtime, onRpcMessage: (dir, msg) => rpc.push({ dir, msg }) });
  const { mode, configure } = o.scenario;
  const done = new Promise<void>((resolve) => {
    void runtime
      .start({ sessionId: "fixture-session", cwd: o.cwd, permissionMode: mode }, (ev) => {
        events.push(ev);
        if (ev.type === "approval.requested")
          runtime.resolveApproval("fixture-session", ev.approvalId, "deny");
        if (ev.type === "prompt.completed" || (ev.type === "session.state" && ev.status === "failed"))
          resolve();
      })
      .then(() => (configure ? runtime.configure("fixture-session", configure) : undefined))
      .then(() => runtime.prompt("fixture-session", { promptId: "prompt-1", text: o.prompt }))
      .catch((err: unknown) => {
        console.error(err);
        resolve();
      });
  });
  await done;
  await runtime.stop("fixture-session");

  const outDir = fixtureDir();
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, `codex-${o.version ?? "unknown"}.${scenarioName}.rpc.jsonl`);
  // Drop notifications that only describe the owner's personal Codex config (MCP servers, hooks,
  // plugins, account): ignored by the mapper anyway and not fit for an open-source fixture.
  const kept = rpc.filter(notPersonal);
  await writeFile(file, `${kept.map((r) => JSON.stringify(o.clean(r))).join("\n")}\n`);
  console.log(`wrote ${kept.length} of ${rpc.length} JSON-RPC messages -> ${String(o.clean(file))}`);
  return events;
}

/** The offline recordings (07.13-25, PD-29): the same scenarios against the fake model, under temp homes only. */
async function recordOffline(): Promise<void> {
  const run = await openOffline();
  if (!run) return;
  const repo = join(run.tmp, "repo");
  await mkdir(repo, { recursive: true });
  const realRepo = await realpath(repo);
  const roots = offlineRoots(run, repo, realRepo);
  const clean = (v: unknown) => placeholders(v, roots);
  const spawnFn = offlineSpawn(run);
  try {
    if (scenario === "no-turn") {
      const models = await listCodexModels(spawnFn, { cwd: realRepo, env: run.env });
      await mkdir(fixtureDir(), { recursive: true });
      const file = join(fixtureDir(), `codex-${run.version}.model-list.json`);
      await writeFile(file, `${JSON.stringify(clean({ data: models, nextCursor: null }), null, 2)}\n`);
      console.log(`wrote ${models.length} models -> ${String(clean(file))}`);
      for (const m of models)
        console.log(`${m.id}${m.isDefault ? " (default)" : ""}${m.hidden ? " hidden" : ""}`);
      return;
    }
    if (scenario === "title") {
      const rpc: Array<{ dir: "in" | "out"; msg: unknown }> = [];
      let answer: string | null = null;
      try {
        answer = await generateCodexTitle(spawnFn, {
          env: run.env,
          prompt: OFFLINE_TITLE_PROMPT,
          model: "gpt-6-luna",
          effort: "low",
          signal: AbortSignal.timeout(90_000),
          tmpRoot: realRepo,
          onRpcMessage: (dir, msg) => rpc.push({ dir, msg }),
        });
      } catch (err) {
        console.error("title call refused (recorded as observed):", err);
      }
      const kept = rpc.filter(notPersonal);
      await mkdir(fixtureDir(), { recursive: true });
      const file = join(fixtureDir(), `codex-${run.version}.title.rpc.jsonl`);
      await writeFile(file, `${kept.map((r) => JSON.stringify(clean(r))).join("\n")}\n`);
      console.log(`wrote ${kept.length} of ${rpc.length} JSON-RPC messages -> ${String(clean(file))}`);
      console.log("raw answer:", JSON.stringify(answer));
      console.log("normalized:", JSON.stringify(answer === null ? null : normalizeSessionTitle(answer)));
      return;
    }
    if (scenario === "browser-mcp") throw new Error("browser-mcp is recorded by recordBrowserMcp");
    const prompt = OFFLINE_PROMPTS[scenarioName];
    if (!prompt) throw new Error(`no offline prompt for ${scenarioName}`);
    await writeFile(join(realRepo, "hello.txt"), "Hello from the fixture repo.\n");
    execFileSync("git", ["init", "-q"], { cwd: realRepo, env: run.env });
    const events = await recordTurn({
      scenario,
      version: run.version,
      cwd: realRepo,
      prompt,
      runtime: { codexPath: run.bin, spawnAppServer: spawnFn },
      clean,
    });
    for (const ev of events) console.log(JSON.stringify(clean(ev)).slice(0, 300));
    // The fake's view (console only): the tools Codex offered and each tool output it got back.
    const responses = run.requests.filter((r) => r.kind === "responses");
    const offered = (responses[0]?.body?.tools ?? []) as Array<{
      type?: string;
      name?: string;
      parameters?: { properties?: Record<string, unknown> };
    }>;
    console.log(`tools offered: ${JSON.stringify(offered.map((t) => `${t.type}:${t.name ?? ""}`))}`);
    const shell = offered.find((t) => t.name === OFFLINE_SHELL_TOOL);
    console.log(
      `${OFFLINE_SHELL_TOOL} parameters: ${JSON.stringify(Object.keys(shell?.parameters?.properties ?? {}))}`,
    );
    for (const [i, r] of responses.entries()) {
      const outputs = ((r.body?.input ?? []) as Array<{ type?: string; output?: unknown }>)
        .filter((x) => x.type === "function_call_output")
        .map((x) => JSON.stringify(clean(x.output)).slice(0, 300));
      console.log(`responses #${i + 1}: function_call_output=${JSON.stringify(outputs)}`);
    }
  } finally {
    await run.close();
  }
}

async function main(): Promise<void> {
  if (scenario === "browser-mcp") return recordBrowserMcp();
  if (offline) return recordOffline();
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
  const events = await recordTurn({
    scenario,
    version: info.version,
    cwd: real,
    prompt: scenario.prompt,
    runtime: codexPath ? { codexPath } : {},
    clean: (v) => scrub(v, roots),
  });
  await rm(real, { recursive: true, force: true });
  for (const ev of events) console.log(JSON.stringify(sanitizeEvent(ev, roots)).slice(0, 300));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
