import {
  maskSample,
  type SensitiveFinding,
  type SensitiveFindingKind,
  type SensitiveSpan,
} from "@ocw/contracts";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";

/**
 * Detector layer 2 (MEM-05, D-06, D-08): the optional Presidio analyzer of the `pii` compose profile. Off without a
 * URL. One request per language under one overall deadline; any failure (status, network, timeout, a body that is
 * not the expected shape) returns the visible `extended_scan_unavailable` info finding and the caller proceeds: never
 * a block, never an approval. The scanned text, the URL's credentials and response bodies are never logged.
 */

/** The entities asked for; anything else Presidio returns is ignored. */
export const PRESIDIO_ENTITIES = [
  "PERSON",
  "LOCATION",
  "ES_NIF",
  "ES_NIE",
  "IBAN_CODE",
  "CREDIT_CARD",
  "EMAIL_ADDRESS",
  "PHONE_NUMBER",
  "IP_ADDRESS",
] as const;
type PresidioEntity = (typeof PRESIDIO_ENTITIES)[number];

const ENTITY_KIND: Record<PresidioEntity, SensitiveFindingKind> = {
  PERSON: "person",
  LOCATION: "location",
  ES_NIF: "es_nif",
  ES_NIE: "es_nie",
  IBAN_CODE: "iban",
  CREDIT_CARD: "payment_card",
  EMAIL_ADDRESS: "email",
  PHONE_NUMBER: "phone",
  IP_ADDRESS: "ip_address",
};

export type PresidioLanguage = "es" | "en";

export interface PresidioConfig {
  url: string | null | undefined;
  languages: readonly PresidioLanguage[];
  timeoutMs: number;
}

export interface PresidioScanResult {
  findings: SensitiveFinding[];
  spans: SensitiveSpan[];
}

export interface PresidioScanner {
  readonly enabled: boolean;
  scan(text: string): Promise<PresidioScanResult>;
}

/** Bytes of UTF-8 sent per request; a longer text is scanned up to here and flagged `extended_scan_partial`. */
export const PRESIDIO_MAX_BYTES = 100 * 1024;
/** Presidio's default threshold for its pattern recognizers (NIF/NIE score 0.5). */
const SCORE_THRESHOLD = 0.5;
const MAX_SAMPLES = 3;
const MAX_LINES = 20;

const PresidioResult = z
  .array(
    z.object({
      entity_type: z.string().max(100),
      start: z.number().int().nonnegative(),
      end: z.number().int().positive(),
      score: z.number().min(0).max(1),
    }),
  )
  .max(10_000);

class PresidioStatusError extends Error {
  override name = "PresidioStatusError";
  constructor(readonly status: number) {
    super(`presidio answered ${status}`);
  }
}

class PresidioOffsetError extends Error {
  override name = "PresidioOffsetError";
}

const info = (kind: "extended_scan_unavailable" | "extended_scan_partial"): SensitiveFinding => ({
  kind,
  severity: "info",
  source: "presidio",
  count: 0,
  samples: [],
  lines: [],
});

const EMPTY: PresidioScanResult = { findings: [], spans: [] };

/** `<base>/analyze`, keeping any path in the base; credentials move to a Basic header (fetch refuses them). */
function endpoint(raw: string): { url: string; headers: Record<string, string> } {
  const u = new URL(raw);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (u.username || u.password) {
    const user = decodeURIComponent(u.username);
    const pass = decodeURIComponent(u.password);
    headers.authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
    u.username = "";
    u.password = "";
  }
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/analyze`;
  u.search = "";
  u.hash = "";
  return { url: u.toString(), headers };
}

/** The longest prefix of at most `PRESIDIO_MAX_BYTES` UTF-8 bytes, cut after the last line break when there is one. */
function boundedPrefix(text: string): { scanned: string; partial: boolean } {
  if (Buffer.byteLength(text, "utf8") <= PRESIDIO_MAX_BYTES) return { scanned: text, partial: false };
  const { read } = new TextEncoder().encodeInto(text, new Uint8Array(PRESIDIO_MAX_BYTES));
  const head = text.slice(0, read);
  const nl = head.lastIndexOf("\n");
  return { scanned: nl > 0 ? head.slice(0, nl + 1) : head, partial: true };
}

/**
 * Presidio (Python) reports offsets in code points; JS strings index UTF-16 units. Returns the UTF-16 offset of every
 * code point boundary, or null when the text has no surrogate (the two scales are then identical).
 */
function utf16Boundaries(text: string): number[] | null {
  if (!/[\uD800-\uDFFF]/.test(text)) return null;
  const out: number[] = [];
  let i = 0;
  for (const ch of text) {
    out.push(i);
    i += ch.length;
  }
  out.push(i);
  return out;
}

/** 1-based line of each offset, by binary search over the line starts. */
function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function toResult(text: string, spans: SensitiveSpan[]): PresidioScanResult {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  const byKind = new Map<SensitiveFindingKind, SensitiveFinding>();
  for (const s of spans) {
    let f = byKind.get(s.kind);
    if (!f) {
      f = { kind: s.kind, severity: "warn", source: "presidio", count: 0, samples: [], lines: [] };
      byKind.set(s.kind, f);
    }
    f.count += 1;
    const sample = maskSample(s.kind, text.slice(s.start, s.end)).slice(0, 80);
    if (f.samples.length < MAX_SAMPLES && !f.samples.includes(sample)) f.samples.push(sample);
    const line = lineOf(starts, s.start);
    if (f.lines.length < MAX_LINES && !f.lines.includes(line)) f.lines.push(line);
  }
  return { findings: [...byKind.values()], spans };
}

export function createPresidioScanner(cfg: PresidioConfig, log: FastifyBaseLogger): PresidioScanner {
  if (!cfg.url) return { enabled: false, scan: async () => EMPTY };
  const { url, headers } = endpoint(cfg.url);

  return {
    enabled: true,
    async scan(text) {
      if (text.trim() === "") return EMPTY;
      const { scanned, partial } = boundedPrefix(text);
      const signal = AbortSignal.timeout(cfg.timeoutMs);
      try {
        const perLanguage = await Promise.all(
          cfg.languages.map(async (language) => {
            const res = await fetch(url, {
              method: "POST",
              headers,
              body: JSON.stringify({
                text: scanned,
                language,
                entities: PRESIDIO_ENTITIES,
                score_threshold: SCORE_THRESHOLD,
              }),
              signal,
            });
            if (!res.ok) {
              await res.body?.cancel();
              throw new PresidioStatusError(res.status);
            }
            return PresidioResult.parse(await res.json());
          }),
        );
        const boundaries = utf16Boundaries(scanned);
        const codePoints = boundaries ? boundaries.length - 1 : scanned.length;
        const seen = new Set<string>();
        const spans: SensitiveSpan[] = [];
        for (const raw of perLanguage.flat()) {
          if (raw.end > codePoints || raw.start >= raw.end) throw new PresidioOffsetError();
          const item = boundaries
            ? { ...raw, start: boundaries[raw.start] ?? 0, end: boundaries[raw.end] ?? 0 }
            : raw;
          // Own keys only: an entity_type such as "constructor" must not reach the prototype.
          if (!Object.hasOwn(ENTITY_KIND, item.entity_type)) continue;
          const kind = ENTITY_KIND[item.entity_type as PresidioEntity];
          const key = `${kind}:${item.start}:${item.end}`;
          if (seen.has(key)) continue;
          seen.add(key);
          spans.push({ kind, start: item.start, end: item.end });
        }
        spans.sort((a, b) => a.start - b.start || a.end - b.end);
        const out = toResult(scanned, spans);
        if (partial) out.findings.push(info("extended_scan_partial"));
        return out;
      } catch (err) {
        // Only the error class or the status: never the text, the body or the URL.
        const status = err instanceof PresidioStatusError ? err.status : undefined;
        const errorClass = err instanceof Error ? err.name : "unknown";
        log.warn({ presidio: { errorClass, status } }, "presidio scan unavailable");
        return { findings: [info("extended_scan_unavailable")], spans: [] };
      }
    },
  };
}
