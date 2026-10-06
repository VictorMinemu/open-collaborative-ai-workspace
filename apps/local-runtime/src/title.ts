// Automatic session titles on the device (Phase 03.2 Plan 12, D-18 … D-20, P-17, P-19, ADR-0014).
// The session runtime's adapter asks its own small model (Claude Code `haiku`, Codex `gpt-6-luna`) on the device
// owner's login; this module wraps that call with the daemon's own checks: same runtime, model in the catalog,
// a hard timeout, the shared shape rule, and a title that contain()/redact() would change is refused outright.

import {
  normalizeSessionTitle,
  type RuntimeId,
  SessionTitle,
  type SessionTitlePayload,
  type TitleFailureCode,
} from "@ocw/contracts";
import { errorMessage } from "./logger.js";
import type { AgentRuntime } from "./runtime.js";
import { sanitizeString } from "./sanitize.js";

/** System instructions of every title call (both runtimes). */
export const TITLE_INSTRUCTIONS =
  "You name coding sessions. Reply with a short title for the user's request and nothing else: 3 to 6 words " +
  "in the same language as the request, sentence case, no quotes, no markdown, no emoji and no trailing " +
  "punctuation, at most 48 characters. Describe what is being asked. Do not answer or carry out the request, " +
  "do not ask questions and do not use tools.";

/** The single user message of a title call: the prompt between clear delimiters. */
export function titleUserMessage(prompt: string): string {
  return `Write the title for this request.\n<request>\n${prompt}\n</request>`;
}

/** A title call that produced nothing usable; its message is `"<code>: <detail>"` (the failed ack's error). */
export class TitleError extends Error {
  constructor(
    readonly code: TitleFailureCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "TitleError";
  }
}

export interface RunTitleOptions {
  /** The adapter of `payload.runtime` on this device (undefined when it is not available here). */
  runtime: AgentRuntime | undefined;
  payload: SessionTitlePayload;
  /** contain() roots: the session's roots, or the OCW home and the registered projects. */
  roots: readonly string[];
  /** The daemon's own deadline (TITLE_TIMEOUT_MS; lowered in tests). */
  timeoutMs: number;
  /** The runtime of the session when it is active on this device. */
  sessionRuntime?: RuntimeId;
  /** Home directory for contain() (tests). */
  home?: string;
}

/** Run one title call and return a normalized, sanitized, valid title, or throw a `TitleError`. */
export async function runTitle(o: RunTitleOptions): Promise<string> {
  const { payload } = o;
  if (o.sessionRuntime && o.sessionRuntime !== payload.runtime) {
    throw new TitleError("title_runtime_mismatch", `the session runs ${o.sessionRuntime}`);
  }
  const runtime = o.runtime;
  if (!runtime?.generateTitle || runtime.id !== payload.runtime) {
    throw new TitleError("title_unsupported", `${payload.runtime} cannot generate titles on this device`);
  }
  const catalog = runtime.catalog ? await runtime.catalog().catch(() => null) : null;
  if (!catalog?.models.some((m) => m.id === payload.model)) {
    throw new TitleError(
      "title_model_not_in_catalog",
      `${payload.model} is not offered by ${payload.runtime}`,
    );
  }

  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new TitleError("title_timeout", `no answer in ${Math.round(o.timeoutMs / 1000)}s`));
    }, o.timeoutMs);
  });
  let raw: string;
  try {
    raw = await Promise.race([
      runtime.generateTitle({ prompt: payload.prompt, model: payload.model, signal: abort.signal }),
      deadline,
    ]);
  } catch (err) {
    if (err instanceof TitleError) throw err;
    throw new TitleError("title_failed", errorMessage(err).slice(0, 300));
  } finally {
    clearTimeout(timer);
  }

  const title = normalizeSessionTitle(raw);
  if (!title) throw new TitleError("title_invalid_shape", "the answer is not a 3 to 6 word title");
  // D-20: no absolute host path and no secret ever leaves the device inside a title; never "fixed", refused.
  if (sanitizeString(title, o.roots, o.home) !== title) {
    throw new TitleError("title_sanitized", "the title contained a host path or a credential");
  }
  if (!SessionTitle.safeParse(title).success) {
    throw new TitleError("title_invalid_shape", "the title is not a valid session title");
  }
  return title;
}
