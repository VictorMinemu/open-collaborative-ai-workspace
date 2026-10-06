// Records a REAL Claude Code session through ClaudeCodeRuntime and stores the raw SDK messages as a
// fixture for mapper / adapter tests. Manual tool, never run in CI.
//
// Cost guard: refuses to run when ANTHROPIC_API_KEY is set (metered API) and aborts if the CLI
// reports any API-key source other than 'none' (i.e. it must use the local claude.ai login), or if
// any init reports bypassPermissions. At most ONE trivial turn per fixture, in a throw-away temp repo.
//
//   npx tsx scripts/record-fixture.ts                      # plan-read: plan mode, haiku, one Read
//   npx tsx scripts/record-fixture.ts --scenario settings  # setModel + applyFlagSettings + setPermissionMode, one turn
//   npx tsx scripts/record-fixture.ts --scenario catalog   # initializationResult + context probe, NO turn
//   npx tsx scripts/record-fixture.ts --scenario title     # one-shot haiku title query (03.2-12), ONE turn

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type SDKMessage, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { normalizeSessionTitle, type SessionEvent } from "@ocw/contracts";
import { probeClaudeModels } from "../src/claude/catalog.js";
import { ClaudeCodeRuntime, childEnv, type QueryFn, type QueryHandle } from "../src/claude/claude-runtime.js";
import { generateClaudeTitle } from "../src/claude/title.js";
import { findExecutable } from "../src/exec-path.js";
import { sanitizeEvent } from "../src/sanitize.js";

const FIXTURE_ROOT = "/tmp/ocw-fixture-repo";
const FIXTURE_HOME = "/Users/fixture-user";
/** The CLI version the 03.2 fixtures are pinned to (packages/contracts PINNED_RUNTIME_VERSIONS). */
const PINNED_CLI = "2.1.289";
const INIT_KEEP = new Set([
  "type",
  "subtype",
  "session_id",
  "uuid",
  "model",
  "permissionMode",
  "cwd",
  "claude_code_version",
  "apiKeySource",
  "output_style",
]);
/** Settings scenario: the init fields that carry the effective settings (D-11, D-15). */
const SETTINGS_INIT_KEEP = new Set([...INIT_KEEP, "fast_mode_state", "fast_mode_disabled_reason", "effort"]);

type Scenario = "plan-read" | "settings" | "catalog" | "title";

/** Title scenario (03.2-12): a Spanish prompt, so the fixture also proves the title keeps the prompt's language. */
const TITLE_PROMPT =
  "Arregla el error de redirección del login cuando caduca la sesión en la página de ajustes";

function scenarioArg(argv: string[]): Scenario {
  const i = argv.indexOf("--scenario");
  const v = i >= 0 ? argv[i + 1] : "plan-read";
  if (v === "plan-read" || v === "settings" || v === "catalog" || v === "title") return v;
  console.error(`unknown scenario ${String(v)} (plan-read | settings | catalog | title)`);
  process.exit(1);
}

if (process.env.ANTHROPIC_API_KEY) {
  console.error(
    "ANTHROPIC_API_KEY is set; refusing to record (would be metered). Unset it to use the local login.",
  );
  process.exit(1);
}

function scrubString(s: string, roots: string[]): string {
  let out = s;
  for (const r of roots) out = out.split(r).join(FIXTURE_ROOT);
  out = out.split(homedir()).join(FIXTURE_HOME);
  return out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "fixture@example.com");
}

function scrub(v: unknown, roots: string[]): unknown {
  if (typeof v === "string") return scrubString(v, roots);
  if (Array.isArray(v)) return v.map((x) => scrub(x, roots));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = scrub(x, roots);
    return out;
  }
  return v;
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "src", "claude", "__fixtures__");

/** The CLI the adapter runs (PATH `claude`) must be the pinned version, else nothing is recorded. */
function requirePinnedCli(): string {
  const claude = findExecutable("claude");
  if (!claude) {
    console.error("claude CLI not found on PATH");
    process.exit(1);
  }
  const out = execFileSync(claude, ["--version"], { encoding: "utf8" });
  if (!out.includes(PINNED_CLI)) {
    console.error(
      `claude --version printed ${out.trim()}; the fixtures are pinned to ${PINNED_CLI}. Not recording.`,
    );
    process.exit(1);
  }
  return claude;
}

async function tempRepo(gitInit: boolean): Promise<{ real: string; roots: string[] }> {
  const tmp = await mkdtemp(join(tmpdir(), "ocw-fixture-"));
  const real = await realpath(tmp);
  const roots = [...new Set([real, tmp])].sort((a, b) => b.length - a.length);
  await writeFile(join(real, "hello.txt"), "Hello from the fixture repo.\n");
  if (gitInit) execFileSync("git", ["init", "-q"], { cwd: real });
  return { real, roots };
}

/** Tees the raw SDK messages; aborts on an API-key source or a bypass mode. */
function teeRuntime(raw: SDKMessage[], state: { aborted: boolean }, calls: string[]): ClaudeCodeRuntime {
  return new ClaudeCodeRuntime({
    queryFn: (params) => {
      const q = sdkQuery(params);
      const tee: QueryHandle = {
        interrupt: () => q.interrupt(),
        close: () => q.close(),
        setModel: (model) => {
          calls.push(`setModel(${JSON.stringify(model)})`);
          return q.setModel(model);
        },
        setPermissionMode: (mode) => {
          calls.push(`setPermissionMode(${JSON.stringify(mode)})`);
          return q.setPermissionMode(mode);
        },
        applyFlagSettings: (settings) => {
          calls.push(`applyFlagSettings(${JSON.stringify(settings)})`);
          return q.applyFlagSettings(settings);
        },
        initializationResult: () => q.initializationResult(),
        getContextUsage: (opts) => q.getContextUsage(opts),
        async *[Symbol.asyncIterator]() {
          for await (const m of q) {
            if (m.type === "system" && m.subtype === "init") {
              if (m.apiKeySource !== "none") {
                state.aborted = true;
                console.error(`apiKeySource=${m.apiKeySource}: not the local login; aborting.`);
                q.close();
                return;
              }
              if (m.permissionMode === "bypassPermissions") {
                state.aborted = true;
                console.error("init reported bypassPermissions; aborting.");
                q.close();
                return;
              }
            }
            raw.push(m);
            yield m;
          }
        },
      };
      return tee;
    },
  });
}

async function recordTurn(scenario: "plan-read" | "settings"): Promise<void> {
  if (scenario === "settings") requirePinnedCli();
  const { real, roots } = await tempRepo(scenario === "settings");
  const raw: SDKMessage[] = [];
  const events: SessionEvent[] = [];
  const calls: string[] = [];
  const state = { aborted: false };
  const runtime = teeRuntime(raw, state, calls);

  const done = new Promise<void>((resolve) => {
    void runtime.start(
      { sessionId: "fixture-session", cwd: real, permissionMode: "plan", model: "haiku" },
      (ev) => {
        events.push(ev);
        if (ev.type === "approval.requested")
          runtime.resolveApproval("fixture-session", ev.approvalId, "deny");
        if (ev.type === "prompt.completed" || (ev.type === "session.state" && ev.status === "failed"))
          resolve();
      },
    );
  });
  if (scenario === "settings") {
    // Before the first prompt: a model, effort and permission-mode change through the adapter's own path.
    try {
      await runtime.configure("fixture-session", { model: "sonnet", effort: "low", permissionMode: "auto" });
    } catch (err) {
      console.error("configure failed (recorded as observed):", err);
    }
  }
  await runtime.prompt("fixture-session", {
    promptId: "prompt-1",
    text:
      scenario === "settings"
        ? "Reply with exactly the word OK. Do not use any tools."
        : "Use the Read tool to read hello.txt, then reply with exactly: OK",
  });
  await done;
  await runtime.stop("fixture-session");
  await rm(real, { recursive: true, force: true });

  if (state.aborted) process.exit(1);

  const keep = scenario === "settings" ? SETTINGS_INIT_KEEP : INIT_KEEP;
  const fixtureMessages = raw.map((m) => {
    const scrubbed = scrub(m, roots) as Record<string, unknown>;
    if (scrubbed.type === "system" && scrubbed.subtype === "init") {
      for (const k of Object.keys(scrubbed)) if (!keep.has(k)) delete scrubbed[k];
    }
    return scrubbed;
  });
  await mkdir(outDir, { recursive: true });
  const version =
    (fixtureMessages.find((m) => m.subtype === "init")?.claude_code_version as string) ?? "unknown";
  const file = join(outDir, `claude-code-${version}.${scenario}.sdk.jsonl`);
  await writeFile(file, `${fixtureMessages.map((m) => JSON.stringify(m)).join("\n")}\n`);

  console.log(`wrote ${fixtureMessages.length} SDK messages -> ${file.replace(homedir(), "~")}`);
  console.log("control requests:", calls.join(", ") || "(none)");
  console.log("normalised events (sanitised):");
  for (const ev of events) console.log(JSON.stringify(sanitizeEvent(ev, roots)).slice(0, 300));
}

/** `initializationResult().models` + the context-window probe, through the adapter's own code. NO turn. */
async function recordCatalog(): Promise<void> {
  const claude = requirePinnedCli();
  const { real, roots } = await tempRepo(false);
  const calls: string[] = [];
  const queryFn: QueryFn = (params) => {
    const q = sdkQuery(params);
    return {
      interrupt: () => q.interrupt(),
      close: () => q.close(),
      setModel: (model) => {
        calls.push(`setModel(${JSON.stringify(model)})`);
        return q.setModel(model);
      },
      setPermissionMode: () => Promise.reject(new Error("not used by the catalog probe")),
      applyFlagSettings: () => Promise.reject(new Error("not used by the catalog probe")),
      initializationResult: () => q.initializationResult(),
      getContextUsage: (opts) => q.getContextUsage(opts),
      [Symbol.asyncIterator]: () => q[Symbol.asyncIterator](),
    };
  };
  const { models, contextWindows } = await probeClaudeModels(queryFn, {
    claudePath: claude,
    env: childEnv(process.env, false),
    cwd: real,
  });
  await rm(real, { recursive: true, force: true });
  const fixture = scrub({ cliVersion: PINNED_CLI, models, contextWindows }, roots);
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, `claude-code-${PINNED_CLI}.catalog.json`);
  await writeFile(file, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${models.length} models -> ${file.replace(homedir(), "~")}`);
  console.log(`control requests: ${calls.length} setModel probes (no user message)`);
  console.log(JSON.stringify(contextWindows));
}

/**
 * The session-title call (03.2-12) through the adapter's own `generateClaudeTitle`: a separate one-shot haiku query
 * with no tools, nothing persisted, in an empty temp directory. ONE turn. The recording is kept even when the
 * adapter refuses the answer (a model substitution, a tool), so the behaviour is visible in the fixture.
 */
async function recordTitle(): Promise<void> {
  const claude = requirePinnedCli();
  const parent = await mkdtemp(join(tmpdir(), "ocw-fixture-"));
  const real = await realpath(parent);
  const roots = [...new Set([real, parent])].sort((a, b) => b.length - a.length);
  const catalog = JSON.parse(
    await readFile(join(outDir, `claude-code-${PINNED_CLI}.catalog.json`), "utf8"),
  ) as { models: Array<{ value: string; resolvedModel?: string }> };
  const resolvedModel = catalog.models.find((m) => m.value === "haiku")?.resolvedModel ?? null;
  const raw: SDKMessage[] = [];
  const state = { aborted: false };
  const queryFn: QueryFn = (params) => {
    const q = sdkQuery(params);
    return {
      interrupt: () => q.interrupt(),
      close: () => q.close(),
      setModel: () => Promise.reject(new Error("not used by the title query")),
      setPermissionMode: () => Promise.reject(new Error("not used by the title query")),
      applyFlagSettings: () => Promise.reject(new Error("not used by the title query")),
      initializationResult: () => q.initializationResult(),
      getContextUsage: (opts) => q.getContextUsage(opts),
      async *[Symbol.asyncIterator]() {
        for await (const m of q) {
          if (m.type === "system" && m.subtype === "init") {
            if (m.apiKeySource !== "none") {
              state.aborted = true;
              console.error(`apiKeySource=${m.apiKeySource}: not the local login; aborting.`);
              q.close();
              return;
            }
            if (m.permissionMode === "bypassPermissions") {
              state.aborted = true;
              console.error("init reported bypassPermissions; aborting.");
              q.close();
              return;
            }
          }
          raw.push(m);
          yield m;
        }
      },
    };
  };
  let answer: string | null = null;
  try {
    answer = await generateClaudeTitle(queryFn, {
      claudePath: claude,
      env: childEnv(process.env, false),
      prompt: TITLE_PROMPT,
      model: "haiku",
      resolvedModel,
      signal: AbortSignal.timeout(60_000),
      tmpRoot: real,
    });
  } catch (err) {
    console.error("title call refused (recorded as observed):", err);
  }
  await rm(real, { recursive: true, force: true });
  if (state.aborted) process.exit(1);

  const fixtureMessages = raw.map((m) => {
    const scrubbed = scrub(m, roots) as Record<string, unknown>;
    if (scrubbed.type === "system" && scrubbed.subtype === "init") {
      for (const k of Object.keys(scrubbed)) if (!INIT_KEEP.has(k)) delete scrubbed[k];
    }
    return scrubbed;
  });
  await mkdir(outDir, { recursive: true });
  const version =
    (fixtureMessages.find((m) => m.subtype === "init")?.claude_code_version as string) ?? "unknown";
  const file = join(outDir, `claude-code-${version}.title.sdk.jsonl`);
  await writeFile(file, `${fixtureMessages.map((m) => JSON.stringify(m)).join("\n")}\n`);
  console.log(`wrote ${fixtureMessages.length} SDK messages -> ${file.replace(homedir(), "~")}`);
  console.log("raw answer:", JSON.stringify(answer));
  console.log("normalized:", JSON.stringify(answer === null ? null : normalizeSessionTitle(answer)));
}

async function main(): Promise<void> {
  const scenario = scenarioArg(process.argv.slice(2));
  if (scenario === "catalog") await recordCatalog();
  else if (scenario === "title") await recordTitle();
  else await recordTurn(scenario);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
