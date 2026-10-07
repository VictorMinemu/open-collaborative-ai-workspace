import type { AiGeneration, AiQueueState } from "@ocw/contracts";

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

/** Between the parts of a footer or a chip sentence. */
const PART_SEP = " · ";

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
 * "1.2k in · 340 out · ~$0.004 · Claude Sonnet 5.5 · METERED" (or "… · GPT-6 Astra · ChatGPT plan"). In a
 * multiplayer chat `payer` (`payerLabel`) replaces the backend label: "… · GPT-6 Astra · for Alex Kim · Alex's
 * ChatGPT plan" (06-11, D-01); null keeps the Phase 5 footer.
 */
export function footerParts(g: AiGeneration, payer: string | null = null): string[] {
  const u = g.usage;
  const tail = [g.modelLabel, ...(payer ? payer.split(PART_SEP) : [BACKEND_LABEL[g.backend]])];
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
  return footerParts(g).join(PART_SEP);
}

/** "Alex Kim" → "Alex's"; "James" → "James's". */
function possessive(name: string): string {
  const first = name.trim().split(/\s+/u)[0] || name;
  return `${first}'s`;
}

/**
 * Whose request a multiplayer answer answered and who pays for it (06-11, D-01: the triggering human, on their own
 * plan or a METERED organization model; never the owner's plan for someone else). From the generation's
 * `requesterUserId` and backend only (server data): "for Alex Kim · Alex's ChatGPT plan", "for Alex Kim · METERED",
 * or, to the requester, "for you · your ChatGPT plan". Null for Phase 5 rows (no requester) and in solo chats (the
 * caller passes no requester name there).
 */
export function payerLabel(
  g: AiGeneration,
  requesterName: string | null,
  viewerId: string | null,
): string | null {
  if (!g.requesterUserId || requesterName === null) return null;
  const you = viewerId !== null && g.requesterUserId === viewerId;
  const who = you ? "you" : requesterName;
  const pays =
    g.backend === "chatgpt_plan"
      ? `${you ? "your" : possessive(requesterName)} ChatGPT plan`
      : BACKEND_LABEL[g.backend];
  return `for ${who}${PART_SEP}${pays}`;
}

/** "A", "A and B", "A, B and C", "A, B and 2 others". */
function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}

/**
 * The queue chip's sentence (06-11, D-05): "AI is answering Víctor Ruiz · Alex Kim and Sam Lee are next". The running
 * turn names its requester first, then the other authors it answers (`respondingTo` holds user ids, 06-06: a coalesced
 * turn answers several people); "next" lists the waiting authors in order, each once. Null when nothing runs and
 * nothing waits.
 */
export function queueText(queue: AiQueueState, nameOf: (userId: string) => string): string | null {
  const running = queue.running;
  const answering: string[] = [];
  if (running) {
    for (const id of [running.requesterUserId, ...running.respondingTo]) {
      if (!answering.includes(id)) answering.push(id);
    }
  }
  const next: string[] = [];
  for (const p of queue.pending) if (!next.includes(p.authorId)) next.push(p.authorId);
  if (!running && next.length === 0) return null;
  const head = running ? `AI is answering ${listNames(answering.map(nameOf))}` : "Waiting for the AI";
  if (next.length === 0) return head;
  return `${head}${PART_SEP}${listNames(next.map(nameOf))} ${next.length === 1 ? "is" : "are"} next`;
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

/**
 * When a daily cap resets, in the member's local time: "2:00 AM", or "2:00 AM tomorrow" when that is not today
 * where they are (caps reset at 00:00 UTC).
 */
export function formatResetTime(resetsAt: string, now = new Date(), locale?: string): string {
  const at = new Date(resetsAt);
  const time = at.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  return at.toDateString() === now.toDateString() ? time : `${time} tomorrow`;
}

/** The composer notice at a daily cap (05-08). */
export function limitNoticeText(
  limit: {
    kind: "generations" | "cost";
    backendClass: "org_key" | "chatgpt_plan";
    max: number;
    resetsAt: string;
  },
  now = new Date(),
  locale?: string,
): string {
  const where = limit.backendClass === "org_key" ? "on organization models" : "on your ChatGPT plan here";
  const used =
    limit.kind === "cost"
      ? `You've reached today's ${formatCostMicros(limit.max, false)} limit ${where}.`
      : `You've used today's ${limit.max} ${limit.max === 1 ? "answer" : "answers"} ${where}.`;
  return `${used} Resets at ${formatResetTime(limit.resetsAt, now, locale)}.`;
}
