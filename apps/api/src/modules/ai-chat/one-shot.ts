import { streamText } from "ai";
import type { ResolvedModel } from "../model-gateway";
import { type BuildInput, buildModelMessages } from "./build-model-messages";
import type { ReportedUsage } from "./usage";

/**
 * One model call that is not a chat answer (Phase 07.6, ADR-0018): a Work Zone session's memory summary, or a person's
 * digest summary (07.6-13, opt-in, metered by the digest module). Like the title
 * call (titles.ts), it is one of the three doors to the AI SDK (guard.test.ts): the prompt comes only from
 * `buildModelMessages` (a non-chat purpose), the model only from the gateway (`ResolvedModel`, never a string id), no
 * tools, no retries, under a deadline. A session summary calls it outside any transaction; a digest summary inside its
 * run's fire transaction (the runner's, which holds only that run's and that digest's rows, on a serial worker), under a
 * shorter deadline. The caller meters it (`recordStandaloneUsage`).
 * Errors carry no prompt text out of here: the SDK's default error handler is silenced (P-10).
 */
export async function runOneShot(
  resolved: ResolvedModel,
  build: BuildInput & { purpose: "session_summary" | "digest_summary" },
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<{ text: string; usage: ReportedUsage | null; promptText: string }> {
  // A string id would route through the metered Vercel AI Gateway (P-04): never.
  if (typeof resolved.model === "string") throw new Error("model gateway returned a string model id");
  const prompt = buildModelMessages(build);
  if (prompt.messages.length === 0) throw new Error("nothing to send");
  const deadline = AbortSignal.timeout(opts.timeoutMs);
  const abort = opts.signal ? AbortSignal.any([deadline, opts.signal]) : deadline;
  const result = streamText({
    model: resolved.model,
    instructions: prompt.instructions,
    messages: prompt.messages,
    abortSignal: abort,
    maxRetries: 0,
    providerOptions: resolved.providerOptions,
    // The default handler console.error()s the error object, which carries the prompt (P-10).
    onError: () => {},
  });
  let text = "";
  let usage: ReportedUsage | null = null;
  let error: unknown = null;
  for await (const part of result.stream) {
    if (part.type === "text-delta") text += part.text;
    else if (part.type === "finish") {
      usage = {
        inputTokens: part.totalUsage.inputTokens,
        outputTokens: part.totalUsage.outputTokens,
        cachedInputTokens: part.totalUsage.inputTokenDetails?.cacheReadTokens,
        reasoningTokens: part.totalUsage.outputTokenDetails?.reasoningTokens,
      };
    } else if (part.type === "error") error ??= part.error;
    else if (part.type === "abort") error ??= new DOMException("aborted", "AbortError");
  }
  if (abort.aborted) throw new DOMException("one-shot deadline", "TimeoutError");
  if (error !== null) throw error;
  const promptText = [prompt.instructions, ...prompt.messages.map((m) => String(m.content))].join("\n");
  return { text, usage, promptText };
}
