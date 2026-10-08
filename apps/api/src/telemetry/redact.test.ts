import { homedir } from "node:os";
import type { Attributes, SpanContext } from "@opentelemetry/api";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGE_LENGTH,
  RedactingLogRecordExporter,
  RedactingSpanExporter,
  redactAttributes,
  scrubString,
} from "./redact";

type ExportResult = Parameters<Parameters<SpanExporter["export"]>[1]>[0];

const CANARY = "QUERY-CANARY";
/** vitest runs from the repository root, the same root the exporter scrubs. */
const REPO = process.cwd();
const HOME = homedir();

const ctx: SpanContext = { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 };

function span(attributes: Attributes, extra: Partial<ReadableSpan> = {}): ReadableSpan {
  return {
    name: "request",
    kind: 1,
    spanContext: () => ctx,
    startTime: [1, 0],
    endTime: [2, 0],
    status: { code: 0 },
    attributes,
    links: [],
    events: [],
    duration: [1, 0],
    ended: true,
    resource: { attributes: {} } as ReadableSpan["resource"],
    instrumentationScope: { name: "@fastify/otel" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    ...extra,
  };
}

class Capture implements SpanExporter {
  spans: ReadableSpan[] = [];
  flushed = 0;
  shut = 0;
  export(spans: ReadableSpan[], done: (r: ExportResult) => void) {
    this.spans.push(...spans);
    done({ code: 0 });
  }
  async shutdown() {
    this.shut++;
  }
  async forceFlush() {
    this.flushed++;
  }
}

describe("redactAttributes", () => {
  it("replaces url.path (with its query string) by the route template", () => {
    const out = redactAttributes({ "url.path": `/items/42?token=${CANARY}`, "http.route": "/items/:id" });
    expect(out["url.path"]).toBe("/items/:id");
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });

  it("drops url.path when there is no route template", () => {
    const out = redactAttributes({ "url.path": `/nope?token=${CANARY}` });
    expect(out).not.toHaveProperty("url.path");
  });

  it("drops query-bearing URL attributes", () => {
    const out = redactAttributes({
      "url.query": `token=${CANARY}`,
      "url.full": `http://x/items/42?token=${CANARY}`,
      "http.target": `/items/42?token=${CANARY}`,
      "http.url": `http://x/items/42?token=${CANARY}`,
      "http.route": "/items/:id",
    });
    expect(Object.keys(out)).toEqual(["http.route"]);
  });

  it("drops sensitive-looking keys", () => {
    const out = redactAttributes({
      "ocw.prompt": "tell me the secret",
      "auth.token": CANARY,
      "db.password": CANARY,
      "http.request.header.cookie": CANARY,
      "http.request.header.authorization": `Bearer ${CANARY}`,
      "ocw.client_secret": CANARY,
      "http.request.method": "GET",
    });
    expect(out).toEqual({ "http.request.method": "GET" });
  });

  it("caps exception.message and strips host paths from messages and stack traces", () => {
    const out = redactAttributes({
      "exception.message": `ENOENT ${REPO}/apps/api/src/x.ts ${"y".repeat(5000)}`,
      "exception.stacktrace": `Error: boom\n    at f (${REPO}/apps/api/src/app.ts:1:2)\n    at g (${HOME}/lib.js:3:4)`,
      "exception.type": "Error",
    });
    const message = out["exception.message"] as string;
    expect(message.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(message).not.toContain(REPO);
    expect(out["exception.stacktrace"]).not.toContain(REPO);
    expect(out["exception.stacktrace"]).not.toContain(HOME);
    expect(out["exception.stacktrace"]).toContain("app.ts:1:2");
    expect(out["exception.type"]).toBe("Error");
  });

  it("leaves other attributes untouched", () => {
    const attrs = {
      "http.route": "/api/v1/me",
      "http.request.method": "GET",
      "http.response.status_code": 200,
      "db.query.text": "select $1",
      "db.system.name": "postgresql",
    };
    expect(redactAttributes(attrs)).toEqual(attrs);
  });
});

describe("scrubString", () => {
  it("replaces the repository root and the home directory but not look-alike URL paths", () => {
    expect(scrubString(`at ${REPO}/apps/api/src/app.ts:1`)).not.toContain(REPO);
    expect(scrubString(`${HOME}/x`)).not.toContain(HOME);
    expect(scrubString("GET /api/v1/approvals")).toBe("GET /api/v1/approvals");
  });

  it("strips the query string after a path", () => {
    expect(scrubString(`Route GET:/nope?token=${CANARY} not found`)).toBe("Route GET:/nope not found");
  });
});

describe("RedactingSpanExporter", () => {
  it("hands redacted copies to the inner exporter and keeps the span identity", async () => {
    const inner = new Capture();
    const exporter = new RedactingSpanExporter(inner);
    const result = await new Promise<ExportResult>((resolve) =>
      exporter.export(
        [
          span(
            {
              "url.path": `/items/42?token=${CANARY}`,
              "http.route": "/items/:id",
              "url.query": `token=${CANARY}`,
              "ocw.prompt": "hello",
            },
            {
              status: { code: 2, message: `failed at ${REPO}/x.ts ${"z".repeat(5000)}` },
              events: [
                {
                  name: "exception",
                  time: [1, 5],
                  attributes: { "exception.message": "boom", "exception.stacktrace": `${REPO}/a.ts:1` },
                },
              ],
            },
          ),
        ],
        resolve,
      ),
    );
    expect(result.code).toBe(0);
    expect(inner.spans).toHaveLength(1);
    const out = inner.spans[0]!;
    expect(out.spanContext()).toEqual(ctx);
    expect(out.name).toBe("request");
    expect(out.attributes).toEqual({ "url.path": "/items/:id", "http.route": "/items/:id" });
    expect(out.status.code).toBe(2);
    expect(out.status.message?.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(out.events[0]?.attributes?.["exception.message"]).toBe("boom");
    const serialized = JSON.stringify({ ...out, ctx: out.spanContext() });
    expect(serialized).not.toContain(CANARY);
    expect(serialized).not.toContain(REPO);
    expect(serialized).not.toContain("hello");
  });

  it("delegates flush and shutdown", async () => {
    const inner = new Capture();
    const exporter = new RedactingSpanExporter(inner);
    await exporter.forceFlush();
    await exporter.shutdown();
    expect([inner.flushed, inner.shut]).toEqual([1, 1]);
  });
});

describe("RedactingLogRecordExporter", () => {
  it("scrubs bodies and drops sensitive keys at any depth", async () => {
    const got: ReadableLogRecord[] = [];
    const exporter = new RedactingLogRecordExporter({
      export: (logs, done) => {
        got.push(...logs);
        done({ code: 0 });
      },
      shutdown: async () => {},
      forceFlush: async () => {},
    });
    const record: ReadableLogRecord = {
      hrTime: [1, 0],
      hrTimeObserved: [1, 0],
      spanContext: ctx,
      severityText: "info",
      severityNumber: 9,
      body: `Route GET:/nope?token=${CANARY} not found`,
      resource: { attributes: {} } as ReadableLogRecord["resource"],
      instrumentationScope: { name: "@opentelemetry/instrumentation-pino" },
      attributes: {
        req: { method: "GET", url: `/x?token=${CANARY}`, headers: { cookie: CANARY, authorization: CANARY } },
        "exception.stacktrace": `at f (${REPO}/apps/api/src/app.ts:1:2)`,
        reqId: "req-1",
      },
      droppedAttributesCount: 0,
    };
    await new Promise((resolve) => exporter.export([record], resolve));
    expect(got).toHaveLength(1);
    const out = got[0]!;
    expect(out.body).toBe("Route GET:/nope not found");
    expect(out.spanContext).toEqual(ctx);
    expect(out.attributes.reqId).toBe("req-1");
    expect(out.attributes.req).toEqual({ method: "GET", url: "/x", headers: {} });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(CANARY);
    expect(serialized).not.toContain(REPO);
  });
});
