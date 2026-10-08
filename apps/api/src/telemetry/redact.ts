import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Attributes, AttributeValue } from "@opentelemetry/api";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan, SpanExporter, TimedEvent } from "@opentelemetry/sdk-trace-base";

/**
 * Redaction at the source (D-05, D-18, T-07-05-01/02): whatever OTLP endpoint an operator configures, spans and log
 * records leave the API without query strings, credentials, prompts or absolute host paths. The collector in the
 * `observability` profile repeats the URL rules as defense in depth; this layer must hold on its own.
 */

type LogAttributes = ReadableLogRecord["attributes"];
type AnyValue = LogAttributes[string];

/** Longest exported exception / status message. */
export const MAX_MESSAGE_LENGTH = 512;

/** Any key that looks like it carries a credential or user content. */
const SENSITIVE_KEY = /token|secret|password|authorization|cookie|prompt/i;
/** URL attributes that carry the raw path with its query string (instrumentation-http, old and stable semconv). */
const DROPPED_KEYS = new Set(["url.query", "url.full", "http.target", "http.url"]);
/** Free-text attributes that may quote paths or user input. */
const MESSAGE_KEYS = new Set(["exception.message"]);
const PATH_KEYS = new Set(["exception.stacktrace"]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A root only matches as a whole path prefix: `/app` must not eat `/approvals`. */
const rootPattern = (root: string, label: string) =>
  [new RegExp(`${escapeRe(root)}(?=[/\\\\:'")\\s]|$)`, "g"), label] as const;

/** The repository root (apps/api/src/telemetry → ../../../..) and the home directory, longest first. */
const HOST_ROOTS = (() => {
  const repo = fileURLToPath(new URL("../../../..", import.meta.url)).replace(/[/\\]$/, "");
  const home = homedir().replace(/[/\\]$/, "");
  const roots: Array<readonly [RegExp, string]> = [];
  if (repo.length > 1) roots.push(rootPattern(repo, "<app>"));
  if (home.length > 1) roots.push(rootPattern(home, "~"));
  return roots;
})();

/** `/path?query` → `/path` (the query of a request path never leaves the process). */
const QUERY_AFTER_PATH = /(\/[^\s?#"'<>]*)\?[^\s"'<>]*/g;

/** `GET:/x?token=…` → `GET:/x`: drops the query string after any path in free text. */
export function stripQueryStrings(value: string): string {
  return value.replace(QUERY_AFTER_PATH, "$1");
}

/** Strip absolute host paths and query strings from free text (messages, stack traces, log bodies). */
export function scrubString(value: string): string {
  let out = value;
  for (const [re, label] of HOST_ROOTS) out = out.replace(re, label);
  return stripQueryStrings(out);
}

const cap = (s: string) => (s.length > MAX_MESSAGE_LENGTH ? `${s.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : s);

/**
 * Span attribute rules: `url.path` becomes the route template (or is dropped), query-bearing URL attributes and
 * sensitive-looking keys are dropped, exception messages are scrubbed and capped, stack traces lose host paths.
 */
export function redactAttributes(attrs: Attributes): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (DROPPED_KEYS.has(key) || SENSITIVE_KEY.test(key)) continue;
    if (key === "url.path") {
      const route = attrs["http.route"];
      if (typeof route === "string" && route) out[key] = route;
      continue;
    }
    if (typeof value === "string" && MESSAGE_KEYS.has(key)) out[key] = cap(scrubString(value));
    else if (typeof value === "string" && PATH_KEYS.has(key)) out[key] = scrubString(value);
    else out[key] = value as AttributeValue;
  }
  return out;
}

function redactEvent(event: TimedEvent): TimedEvent {
  return event.attributes ? { ...event, attributes: redactAttributes(event.attributes) } : event;
}

function redactSpan(span: ReadableSpan): ReadableSpan {
  const { status } = span;
  // An explicit copy: ReadableSpan implementations keep spanContext() on the prototype.
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => span.spanContext(),
    ...(span.parentSpanContext ? { parentSpanContext: span.parentSpanContext } : {}),
    startTime: span.startTime,
    endTime: span.endTime,
    status: status.message === undefined ? status : { ...status, message: cap(scrubString(status.message)) },
    attributes: redactAttributes(span.attributes),
    links: span.links,
    events: span.events.map(redactEvent),
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

/** Wraps the OTLP span exporter so every exported span went through `redactAttributes`. */
export class RedactingSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter["export"]>[1]): void {
    this.inner.export(spans.map(redactSpan), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  async forceFlush(): Promise<void> {
    await this.inner.forceFlush?.();
  }
}

/** Log values: sensitive keys dropped at any depth, strings scrubbed, exception messages capped. */
function redactLogValue(value: AnyValue, key?: string): AnyValue {
  if (typeof value === "string") {
    const scrubbed = scrubString(value);
    return key !== undefined && MESSAGE_KEYS.has(key) ? cap(scrubbed) : scrubbed;
  }
  if (Array.isArray(value)) return value.map((v) => redactLogValue(v));
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    const out: Record<string, AnyValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, AnyValue>)) {
      if (SENSITIVE_KEY.test(k) || DROPPED_KEYS.has(k)) continue;
      out[k] = redactLogValue(v, k);
    }
    return out;
  }
  return value;
}

function redactLogRecord(record: ReadableLogRecord): ReadableLogRecord {
  return {
    hrTime: record.hrTime,
    hrTimeObserved: record.hrTimeObserved,
    ...(record.spanContext ? { spanContext: record.spanContext } : {}),
    ...(record.severityText !== undefined ? { severityText: record.severityText } : {}),
    ...(record.severityNumber !== undefined ? { severityNumber: record.severityNumber } : {}),
    ...(record.body !== undefined ? { body: redactLogValue(record.body) } : {}),
    ...(record.eventName !== undefined ? { eventName: record.eventName } : {}),
    resource: record.resource,
    instrumentationScope: record.instrumentationScope,
    attributes: redactLogValue(record.attributes) as LogAttributes,
    droppedAttributesCount: record.droppedAttributesCount,
  };
}

/**
 * Wraps the OTLP log exporter. Pino lines are already query-free (the request serializer in app.ts) and pass the
 * logger's `redact` list; this catches what free text can still carry (route-not-found messages, error stacks).
 */
export class RedactingLogRecordExporter implements LogRecordExporter {
  constructor(private readonly inner: LogRecordExporter) {}

  export(logs: ReadableLogRecord[], resultCallback: Parameters<LogRecordExporter["export"]>[1]): void {
    this.inner.export(logs.map(redactLogRecord), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }
}
