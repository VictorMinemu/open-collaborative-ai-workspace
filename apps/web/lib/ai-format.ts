import type { AiGeneration } from "@ocw/contracts";

/**
 * Usage formatting for AI chats (05-08, AICHAT-07, P-11): token counts, costs and the answer footer. Pure, so the
 * footer, the composer limit notice and the usage views (05-09) read the same numbers the same way.
 */

const trim = (s: string) => s.replace(/\.?0+$/u, "");

/** 950 → "950", 1234 → "1.2k", 1_250_000 → "1.25M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)));
  const k = Math.round(n / 100) / 10;
  if (k < 1000) return `${trim(k.toFixed(1))}k`;
  return `${trim((Math.round(n / 10_000) / 100).toFixed(2))}M`;
}

/** null → "—" (no price for this model); 4000 → "$0.004"; estimated → "~$0.004". */
export function formatCostMicros(micros: number | null, estimated: boolean): string {
  if (micros === null) return "—";
  // Integer rounding on micro-dollars: float rounding would turn 345_000 into "$0.34".
  let text: string;
  if (micros === 0) text = "0";
  else if (micros >= 995_000) text = (Math.round(micros / 10_000) / 100).toFixed(2);
  else {
    // Two significant digits below a dollar.
    const factor = 10 ** (Math.floor(Math.log10(micros)) - 1);
    text = String((Math.round(micros / factor) * factor) / 1_000_000);
  }
  return `${estimated ? "~" : ""}$${text}`;
}

const BACKEND_LABEL: Record<AiGeneration["backend"], string> = {
  chatgpt_plan: "ChatGPT plan",
  org_key: "METERED",
  mock: "not metered",
};

function counts(g: AiGeneration): string | null {
  const u = g.usage;
  if (!u) return null;
  const approx = u.estimated ? "~" : "";
  return `${approx}${formatTokens(u.inputTokens)} in · ${approx}${formatTokens(u.outputTokens)} out`;
}

/**
 * "1.2k in · 340 out · ~$0.004" on organization keys, "1.2k in · 340 out · ChatGPT plan" on the member's plan (no
 * cost: it costs the organization nothing), "… · not metered" on the mock; "" while nothing is recorded.
 */
export function formatUsage(g: AiGeneration): string {
  const c = counts(g);
  if (!c || !g.usage) return "";
  if (g.backend === "org_key") return `${c} · ${formatCostMicros(g.usage.costMicrosUsd, g.usage.estimated)}`;
  return `${c} · ${BACKEND_LABEL[g.backend]}`;
}

/**
 * The answer footer, in parts: usage, then the model, then who pays. Joined with " · " it reads
 * "1.2k in · 340 out · ~$0.004 · Claude Sonnet 5.5 · METERED" (or "… · GPT-6 Astra · ChatGPT plan").
 */
export function footerParts(g: AiGeneration): string[] {
  const u = g.usage;
  const tail = [g.modelLabel, BACKEND_LABEL[g.backend]];
  if (!u) return tail;
  const approx = u.estimated ? "~" : "";
  const parts = [
    `${approx}${formatTokens(u.inputTokens)} in`,
    `${approx}${formatTokens(u.outputTokens)} out`,
  ];
  if (g.backend === "org_key") parts.push(formatCostMicros(u.costMicrosUsd, u.estimated));
  return [...parts, ...tail];
}

export function footerLabel(g: AiGeneration): string {
  return footerParts(g).join(" · ");
}

const exact = (n: number) => n.toLocaleString("en-US");

/** The footer tooltip: exact counts, the cost and whether the counts are estimated. */
export function usageTitle(g: AiGeneration): string | undefined {
  const u = g.usage;
  if (!u) return undefined;
  const cached = u.cachedInputTokens ? ` (${exact(u.cachedInputTokens)} cached)` : "";
  const parts = [`${exact(u.inputTokens)} input tokens${cached}`, `${exact(u.outputTokens)} output tokens`];
  if (g.backend === "org_key") {
    parts.push(
      u.costMicrosUsd === null
        ? "no price for this model"
        : `estimated ${formatCostMicros(u.costMicrosUsd, false)}`,
    );
  } else if (g.backend === "chatgpt_plan") {
    parts.push("on your ChatGPT plan");
  } else {
    parts.push("not metered");
  }
  if (u.estimated) parts.push("estimated counts");
  return parts.join(" · ");
}
