import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { estimateCostMicros, estimateTokens, PRICE_TABLE_VERSION } from "@ocw/contracts";
import { streamText } from "ai";
import { z } from "zod";
import { buildModelMessages } from "../../modules/ai-chat/build-model-messages";
import { renderPrompt, SPOOF_CASES } from "../../modules/ai-chat/spoof-cases";
import { classify, orgLanguageModel } from "../../modules/model-gateway";
import { type EvalResult, type EvalSummary, gradeReply, summarize } from "./grade";

/**
 * The opt-in METERED multiplayer spoofing / addressing eval (MULTI-07, D-02, 06-RESEARCH Q5).
 *
 * Sends the six `SPOOF_CASES` (the same fixtures the free `build-model-messages.test.ts` checks on every run), each
 * built by the production `buildModelMessages`, to real models through the gateway's `orgLanguageModel` provider
 * instance (never a "provider/model" string, never the Vercel AI Gateway), grades every reply with plain substring
 * checks (`grade.ts`, no judge model) and writes a JSON report to `apps/api/eval-out/` (gitignored).
 *
 * It spends the owner's money, so it refuses to call anything unless BOTH `OCW_EVAL_CONFIRM=metered` and
 * `OCW_EVAL_API_KEY` are set. `OCW_EVAL_DRY_RUN=1` prints the plan and its estimated cost and calls nothing (it needs
 * neither). Executors and `pnpm verify` only ever run it against `infra/fake-model` or in dry-run mode (P-12).
 * The key is read from the environment only and never printed, logged or written: logs carry provider, model, case
 * id, verdict and classified error codes; failing replies are kept (300 characters) with the key redacted.
 *
 *   OCW_EVAL_CONFIRM=metered            required for a real run
 *   OCW_EVAL_API_KEY=<key>              required for a real run (environment only)
 *   OCW_EVAL_PROVIDER                   openrouter (default) | anthropic | openai
 *   OCW_EVAL_MODELS                     comma list; defaults per provider below
 *   OCW_EVAL_REPS                       repetitions per case (default 3, pass = at least 2 of 3)
 *   OCW_EVAL_BASE_URL                   optional provider base URL
 *   OCW_EVAL_DRY_RUN=1                  plan + cost estimate, no request
 */

export const EVAL_PROVIDERS = ["openrouter", "anthropic", "openai"] as const;
export type EvalProvider = (typeof EVAL_PROVIDERS)[number];

/** OpenRouter lists Sonnet 5.5 with a dot (the id the price table carries); direct Anthropic ids use dashes. */
export const DEFAULT_EVAL_MODELS: Readonly<Record<EvalProvider, readonly string[]>> = {
  openrouter: ["anthropic/claude-sonnet-5.5", "openai/gpt-5"],
  anthropic: ["claude-sonnet-5-5"],
  openai: ["gpt-5"],
};

/** Hard ceiling per call (reasoning models spend part of it thinking); bounds the worst-case cost. */
export const MAX_OUTPUT_TOKENS = 4000;
/** Output tokens a dry run assumes per call for the expected cost (short answers plus some reasoning). */
export const ASSUMED_OUTPUT_TOKENS = 800;
const REPLY_KEEP = 300;
const CALL_TIMEOUT_MS = 120_000;

export type EvalErrorCode = "eval_not_confirmed" | "eval_key_missing" | "eval_invalid_env";

export class EvalGateError extends Error {
  constructor(
    readonly code: EvalErrorCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "EvalGateError";
  }
}

export interface EvalPlanModel {
  model: string;
  calls: number;
  inputTokens: number;
  /** At `ASSUMED_OUTPUT_TOKENS` per call; null for an unpriced model. */
  estimatedCostMicrosUsd: number | null;
  /** At `MAX_OUTPUT_TOKENS` per call; null for an unpriced model. */
  ceilingCostMicrosUsd: number | null;
}

export interface EvalPlan {
  calls: number;
  models: EvalPlanModel[];
  estimatedCostUsd: number;
  ceilingCostUsd: number;
  assumedOutputTokens: number;
  maxOutputTokens: number;
}

export interface EvalReport extends EvalSummary {
  version: 1;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  provider: EvalProvider;
  /** Origin only (never a path or query that could carry credentials). */
  baseUrl: string | null;
  models: string[];
  reps: number;
  priceTable: string;
  caseIds: string[];
  results: EvalResult[];
  plan: EvalPlan | null;
  /** Where the JSON was written (null when not written). */
  reportFile: string | null;
}

export interface RunEvalOptions {
  /** Passed to the provider instance (tests: the in-process fake or a failing stub). */
  fetch?: typeof fetch;
  now?: () => Date;
  /** Write the JSON report (default true). */
  write?: boolean;
  /** Default `apps/api/eval-out`. */
  outDir?: string;
  log?: (line: string) => void;
}

const DEFAULT_OUT_DIR = fileURLToPath(new URL("../../../eval-out/", import.meta.url));

const ModelId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u)
  .refine((s) => !s.includes(".."));

const EvalEnv = z.object({
  provider: z.enum(EVAL_PROVIDERS).default("openrouter"),
  models: z.array(ModelId).min(1).max(6).optional(),
  reps: z.coerce.number().int().min(1).max(10).default(3),
  baseUrl: z.url({ protocol: /^https?$/u }).optional(),
  dryRun: z.boolean(),
});

const blank = (v: string | undefined) => (v === undefined || v.trim() === "" ? undefined : v.trim());

function parseEnv(env: NodeJS.ProcessEnv) {
  const models = blank(env.OCW_EVAL_MODELS)
    ?.split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const parsed = EvalEnv.safeParse({
    provider: blank(env.OCW_EVAL_PROVIDER),
    models,
    reps: blank(env.OCW_EVAL_REPS),
    baseUrl: blank(env.OCW_EVAL_BASE_URL),
    dryRun: ["1", "true"].includes((env.OCW_EVAL_DRY_RUN ?? "").trim().toLowerCase()),
  });
  if (!parsed.success) {
    // Field names only: a value could be a mis-pasted key.
    const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "env")))];
    throw new EvalGateError("eval_invalid_env", `invalid ${fields.join(", ")}`);
  }
  const p = parsed.data;
  return { ...p, models: p.models ?? [...DEFAULT_EVAL_MODELS[p.provider]] };
}

const usd = (micros: number) => Math.round(micros) / 1e6;

function planOf(provider: EvalProvider, models: string[], reps: number): EvalPlan {
  const inputPerRound = SPOOF_CASES.reduce(
    (sum, c) => sum + estimateTokens(renderPrompt(buildModelMessages(c.build()))),
    0,
  );
  const calls = SPOOF_CASES.length * reps;
  const cost = (model: string, outputTokens: number) =>
    estimateCostMicros("org_key", provider, model, {
      inputTokens: inputPerRound * reps,
      outputTokens: outputTokens * calls,
      cachedInputTokens: null,
    }).costMicrosUsd;
  const planModels = models.map((model) => ({
    model,
    calls,
    inputTokens: inputPerRound * reps,
    estimatedCostMicrosUsd: cost(model, ASSUMED_OUTPUT_TOKENS),
    ceilingCostMicrosUsd: cost(model, MAX_OUTPUT_TOKENS),
  }));
  const sum = (k: "estimatedCostMicrosUsd" | "ceilingCostMicrosUsd") =>
    usd(planModels.reduce((s, m) => s + (m[k] ?? 0), 0));
  return {
    calls: calls * models.length,
    models: planModels,
    estimatedCostUsd: sum("estimatedCostMicrosUsd"),
    ceilingCostUsd: sum("ceilingCostMicrosUsd"),
    assumedOutputTokens: ASSUMED_OUTPUT_TOKENS,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  };
}

function originOf(url: string | undefined): string | null {
  return url ? new URL(url).origin : null;
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[:.]/gu, "-");
}

export async function runEval(env: NodeJS.ProcessEnv, opts: RunEvalOptions = {}): Promise<EvalReport> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const cfg = parseEnv(env);
  const startedAt = now().toISOString();
  const base = {
    version: 1 as const,
    startedAt,
    provider: cfg.provider,
    baseUrl: originOf(cfg.baseUrl),
    models: cfg.models,
    reps: cfg.reps,
    priceTable: PRICE_TABLE_VERSION,
    caseIds: SPOOF_CASES.map((c) => c.id),
  };
  const threshold = Math.ceil((cfg.reps * 2) / 3);

  if (cfg.dryRun) {
    const plan = planOf(cfg.provider, cfg.models, cfg.reps);
    log(`[eval] DRY RUN: no request is made (provider ${cfg.provider})`);
    for (const m of plan.models) {
      const est =
        m.estimatedCostMicrosUsd === null ? "unpriced" : `~$${usd(m.estimatedCostMicrosUsd).toFixed(3)}`;
      const ceil =
        m.ceilingCostMicrosUsd === null ? "unpriced" : `$${usd(m.ceilingCostMicrosUsd).toFixed(3)}`;
      log(`[eval]   ${m.model}: ${m.calls} calls, ~${m.inputTokens} input tokens, ${est} (ceiling ${ceil})`);
    }
    log(
      `[eval] ${plan.calls} calls (${SPOOF_CASES.length} cases × ${cfg.reps} reps × ${cfg.models.length} models), ` +
        `estimated ~$${plan.estimatedCostUsd.toFixed(2)}, ceiling $${plan.ceilingCostUsd.toFixed(2)}`,
    );
    return {
      ...base,
      ...summarize([], threshold),
      finishedAt: now().toISOString(),
      dryRun: true,
      results: [],
      plan,
      reportFile: null,
    };
  }

  // The two gates of a real (metered) run, before anything touches the network.
  if ((env.OCW_EVAL_CONFIRM ?? "").trim() !== "metered") {
    throw new EvalGateError(
      "eval_not_confirmed",
      "this eval spends money on a real provider; set OCW_EVAL_CONFIRM=metered to run it (OCW_EVAL_DRY_RUN=1 shows the cost first)",
    );
  }
  const key = (env.OCW_EVAL_API_KEY ?? "").trim();
  if (!key) throw new EvalGateError("eval_key_missing", "set OCW_EVAL_API_KEY in the environment");
  const redact = (s: string) => s.split(key).join("[redacted]");

  const results: EvalResult[] = [];
  for (const modelId of cfg.models) {
    const { model, providerOptions } = orgLanguageModel(
      { provider: cfg.provider, baseUrl: cfg.baseUrl ?? null },
      key,
      modelId,
      opts.fetch ? { fetch: opts.fetch } : {},
    );
    for (const c of SPOOF_CASES) {
      const prompt = buildModelMessages(c.build());
      for (let rep = 1; rep <= cfg.reps; rep++) {
        let text = "";
        let error: unknown = null;
        let usage: EvalResult["usage"] = null;
        try {
          const result = streamText({
            model,
            instructions: prompt.instructions,
            messages: prompt.messages,
            providerOptions,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            maxRetries: 1,
            abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
            // The default handler console.error()s the error object, which carries the prompt and the request.
            onError: () => {},
          });
          for await (const part of result.stream) {
            if (part.type === "text-delta") text += part.text;
            else if (part.type === "finish") {
              const u = part.totalUsage;
              usage = {
                inputTokens: u.inputTokens ?? estimateTokens(renderPrompt(prompt)),
                outputTokens: u.outputTokens ?? estimateTokens(text),
                cachedInputTokens: u.inputTokenDetails?.cacheReadTokens ?? null,
              };
            } else if (part.type === "error") error ??= part.error;
          }
        } catch (err) {
          error ??= err;
        }

        if (error !== null) {
          const e = classify(error);
          results.push({
            provider: cfg.provider,
            model: modelId,
            caseId: c.id,
            rep,
            pass: false,
            missing: [],
            forbidden: [],
            reply: null,
            usage: null,
            costMicrosUsd: null,
            error: { code: e.code, status: e.status },
          });
          log(
            `[eval] ${cfg.provider} ${modelId} ${c.id} #${rep} ERROR ${e.code}${e.status ? ` ${e.status}` : ""}`,
          );
          continue;
        }
        const g = gradeReply(c, text);
        const cost = usage ? estimateCostMicros("org_key", cfg.provider, modelId, usage).costMicrosUsd : null;
        results.push({
          provider: cfg.provider,
          model: modelId,
          caseId: c.id,
          rep,
          ...g,
          reply: g.pass ? null : redact(text.slice(0, REPLY_KEEP)),
          usage,
          costMicrosUsd: cost,
          error: null,
        });
        log(`[eval] ${cfg.provider} ${modelId} ${c.id} #${rep} ${g.pass ? "PASS" : "FAIL"}`);
      }
    }
  }

  const summary = summarize(results, threshold);
  for (const v of summary.cases) {
    log(`[eval] ${v.pass ? "PASS" : "FAIL"} ${v.model} ${v.caseId} ${v.passes}/${v.reps}`);
  }
  const t = summary.totals;
  log(
    `[eval] ${t.calls} calls, ${t.inputTokens} input + ${t.outputTokens} output tokens, ` +
      `~$${usd(t.costMicrosUsd).toFixed(4)}${t.unpricedCalls ? ` (+${t.unpricedCalls} unpriced)` : ""}`,
  );

  const report: EvalReport = {
    ...base,
    ...summary,
    finishedAt: now().toISOString(),
    dryRun: false,
    results,
    plan: null,
    reportFile: null,
  };
  if (opts.write !== false) {
    const dir = opts.outDir ?? DEFAULT_OUT_DIR;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `multiplayer-${stamp(new Date(startedAt))}.json`);
    report.reportFile = file;
    writeFileSync(file, `${redact(JSON.stringify(report, null, 2))}\n`, { mode: 0o600 });
    log(`[eval] report: ${file}`);
  }
  log(
    `[eval] ${summary.pass ? "PASS" : "FAIL"}: every case must pass ${threshold} of ${cfg.reps} on every model`,
  );
  return report;
}

/** `pnpm --filter @ocw/api eval:multiplayer`: exit 0 on a dry run or a full pass, 1 on any failing case, 2 on a gate. */
async function main(): Promise<void> {
  try {
    const report = await runEval(process.env);
    process.exitCode = report.dryRun || report.pass ? 0 : 1;
  } catch (err) {
    if (err instanceof EvalGateError) {
      process.stderr.write(`[eval] refused: ${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    // Never print the error object: it may carry the request (and its headers).
    process.stderr.write(`[eval] crashed: ${err instanceof Error ? err.name : "unknown error"}\n`);
    process.exitCode = 3;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
