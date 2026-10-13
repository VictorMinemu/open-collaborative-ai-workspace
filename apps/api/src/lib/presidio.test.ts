import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPresidioScanner, PRESIDIO_ENTITIES } from "./presidio";

/** A local stand-in for the Presidio analyzer: records every request and answers with `reply`. */
interface Recorded {
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}
type Reply = (req: Recorded, res: ServerResponse) => void;

let server: Server;
let base: string;
let requests: Recorded[];
let reply: Reply;

beforeEach(async () => {
  requests = [];
  reply = (_req, res) => json(res, 200, []);
  server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      const rec = { path: req.url ?? "", headers: req.headers, body };
      requests.push(rec);
      reply(rec, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function spyLogger() {
  const calls: unknown[][] = [];
  const record =
    (level: string) =>
    (...args: unknown[]) => {
      calls.push([level, ...args]);
    };
  const log = {
    level: "info",
    fatal: vi.fn(record("fatal")),
    error: vi.fn(record("error")),
    warn: vi.fn(record("warn")),
    info: vi.fn(record("info")),
    debug: vi.fn(record("debug")),
    trace: vi.fn(record("trace")),
    silent: vi.fn(),
    child: vi.fn(),
  };
  log.child.mockReturnValue(log);
  return { log: log as unknown as FastifyBaseLogger, calls, warn: log.warn };
}

const UNAVAILABLE = {
  kind: "extended_scan_unavailable",
  severity: "info",
  source: "presidio",
  count: 0,
  samples: [],
  lines: [],
};

const TEXT = "Notas de la reunión\nDNI 12345678Z del cliente\ncorreo ana@acme.com\n";
const span = (value: string) => {
  const start = TEXT.indexOf(value);
  return { start, end: start + value.length };
};

const cfg = (over: Partial<Parameters<typeof createPresidioScanner>[0]> = {}) => ({
  url: base,
  languages: ["es", "en"] as const,
  timeoutMs: 2000,
  ...over,
});

describe("createPresidioScanner: success", () => {
  it("returns masked warn findings with 1-based lines, one request per language, unknown entities ignored", async () => {
    reply = (req, res) => {
      const { language } = JSON.parse(req.body) as { language: string };
      const email = { entity_type: "EMAIL_ADDRESS", ...span("ana@acme.com"), score: 1 };
      if (language === "es") {
        json(res, 200, [
          { entity_type: "ES_NIF", ...span("12345678Z"), score: 0.5, analysis_explanation: null },
          email,
          { entity_type: "NRP", ...span("cliente"), score: 0.9 },
          { entity_type: "constructor", ...span("Notas"), score: 0.9 },
        ]);
      } else {
        json(res, 200, [email]);
      }
    };
    const { log, calls } = spyLogger();
    const out = await createPresidioScanner(cfg(), log).scan(TEXT);

    expect(requests).toHaveLength(2);
    const bodies = requests.map((r) => JSON.parse(r.body));
    expect(bodies.map((b) => b.language).sort()).toEqual(["en", "es"]);
    for (const b of bodies) {
      expect(b.text).toBe(TEXT);
      expect(b.entities).toEqual([...PRESIDIO_ENTITIES]);
      expect(b.score_threshold).toBe(0.5);
    }
    expect(requests.every((r) => r.path === "/analyze")).toBe(true);

    expect(out.findings).toEqual([
      { kind: "es_nif", severity: "warn", source: "presidio", count: 1, samples: ["•••••678Z"], lines: [2] },
      {
        kind: "email",
        severity: "warn",
        source: "presidio",
        count: 1,
        samples: ["a•••@acme.com"],
        lines: [3],
      },
    ]);
    expect(out.spans).toEqual([
      { kind: "es_nif", ...span("12345678Z") },
      { kind: "email", ...span("ana@acme.com") },
    ]);
    expect(JSON.stringify(calls)).not.toContain("12345678Z");
  });

  it("converts Presidio's code point offsets (Python) to UTF-16 offsets past astral characters", async () => {
    const text = "🎉 Fiesta 🎉\nDNI 12345678Z";
    const cps = [...text];
    const cpStart = cps.indexOf("1");
    reply = (_req, res) =>
      json(res, 200, [{ entity_type: "ES_NIF", start: cpStart, end: cpStart + 9, score: 1 }]);
    const { log } = spyLogger();
    const out = await createPresidioScanner(cfg({ languages: ["es"] }), log).scan(text);
    const start = text.indexOf("12345678Z");
    expect(out.spans).toEqual([{ kind: "es_nif", start, end: start + 9 }]);
    expect(out.findings[0]).toMatchObject({ kind: "es_nif", samples: ["•••••678Z"], lines: [2] });
  });

  it("an end within the UTF-16 length but past the code point length is refused (marker)", async () => {
    const text = "🎉🎉🎉 Ana";
    reply = (_req, res) => json(res, 200, [{ entity_type: "PERSON", start: 4, end: text.length, score: 1 }]);
    const { log } = spyLogger();
    const out = await createPresidioScanner(cfg({ languages: ["es"] }), log).scan(text);
    expect(out.findings.map((f) => f.kind)).toEqual(["extended_scan_unavailable"]);
  });

  it("maps every requested entity type to its finding kind", async () => {
    const text =
      "Ana Pérez vive en Madrid, X1234567L, ES9121000418450200051332, 4111 1111 1111 1111, a@b.co, +34 612 345 678, 10.1.2.3";
    const parts = text.split(", ");
    const types = [
      "PERSON",
      "ES_NIE",
      "IBAN_CODE",
      "CREDIT_CARD",
      "EMAIL_ADDRESS",
      "PHONE_NUMBER",
      "IP_ADDRESS",
    ];
    reply = (_req, res) =>
      json(
        res,
        200,
        parts.map((p, i) => ({
          entity_type: types[i],
          start: text.indexOf(p),
          end: text.indexOf(p) + p.length,
          score: 0.9,
        })),
      );
    const { log } = spyLogger();
    const out = await createPresidioScanner(cfg({ languages: ["en"] }), log).scan(text);
    expect(out.findings.map((f) => f.kind)).toEqual([
      "person",
      "es_nie",
      "iban",
      "payment_card",
      "email",
      "phone",
      "ip_address",
    ]);
    expect(PRESIDIO_ENTITIES).toContain("LOCATION");
  });

  it("keeps a path in the base URL and sends URL credentials as a Basic header, never in the log", async () => {
    const u = new URL(base);
    u.username = "ocw";
    u.password = "s3cr3t-pass";
    u.pathname = "/analyzer/";
    const { log, calls } = spyLogger();
    reply = (_req, res) => json(res, 500, { error: "boom" });
    await createPresidioScanner(cfg({ url: u.toString(), languages: ["es"] }), log).scan(TEXT);
    expect(requests[0]?.path).toBe("/analyzer/analyze");
    expect(requests[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from("ocw:s3cr3t-pass").toString("base64")}`,
    );
    expect(JSON.stringify(calls)).not.toContain("s3cr3t-pass");
  });
});

describe("createPresidioScanner: fail-open with a visible marker", () => {
  const cases: [string, Reply][] = [
    ["status 500", (_req, res) => json(res, 500, { error: "detail TEXT-ECHO" })],
    [
      "invalid JSON",
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{not json TEXT-ECHO");
      },
    ],
    [
      "a body failing the schema",
      (_req, res) => json(res, 200, [{ entity_type: "PERSON", start: "TEXT-ECHO" }]),
    ],
    [
      "offsets outside the text",
      (_req, res) => json(res, 200, [{ entity_type: "PERSON", start: 0, end: 10_000, score: 1 }]),
    ],
  ];

  for (const [name, r] of cases) {
    it(`${name} → exactly the extended_scan_unavailable info finding, logged without content`, async () => {
      reply = r;
      const { log, calls, warn } = spyLogger();
      const out = await createPresidioScanner(cfg(), log).scan(TEXT);
      expect(out).toEqual({ findings: [UNAVAILABLE], spans: [] });
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(calls);
      expect(logged).not.toContain("TEXT-ECHO");
      expect(logged).not.toContain("12345678Z");
      expect(logged).not.toContain("reunión");
    });
  }

  it("connection refused → the marker", async () => {
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    const { log, calls } = spyLogger();
    const out = await createPresidioScanner(cfg({ url: `http://127.0.0.1:${port}` }), log).scan(TEXT);
    expect(out).toEqual({ findings: [UNAVAILABLE], spans: [] });
    expect(JSON.stringify(calls)).not.toContain("12345678Z");
  });

  it("a reply delayed past the deadline → the marker within 400 ms", async () => {
    reply = (_req, res) => {
      setTimeout(() => {
        if (!res.destroyed) json(res, 200, []);
      }, 1500);
    };
    const { log } = spyLogger();
    const started = performance.now();
    const out = await createPresidioScanner(cfg({ timeoutMs: 200 }), log).scan(TEXT);
    expect(performance.now() - started).toBeLessThan(400);
    expect(out).toEqual({ findings: [UNAVAILABLE], spans: [] });
  });
});

describe("createPresidioScanner: off and limits", () => {
  it("without a URL it is disabled, finds nothing and sends nothing", async () => {
    for (const url of [undefined, null, ""]) {
      const { log, calls } = spyLogger();
      const scanner = createPresidioScanner(cfg({ url }), log);
      expect(scanner.enabled).toBe(false);
      expect(await scanner.scan(TEXT)).toEqual({ findings: [], spans: [] });
      expect(calls).toEqual([]);
    }
    expect(requests).toHaveLength(0);
  });

  it("150 KiB of text: at most 100 KiB is sent, cut at a line break, plus an extended_scan_partial finding", async () => {
    const line = `${"x".repeat(99)}\n`;
    const text = line.repeat(Math.ceil((150 * 1024) / line.length));
    const { log } = spyLogger();
    const out = await createPresidioScanner(cfg(), log).scan(text);
    expect(requests).toHaveLength(2);
    for (const r of requests) {
      const sent = (JSON.parse(r.body) as { text: string }).text;
      expect(Buffer.byteLength(sent, "utf8")).toBeLessThanOrEqual(100 * 1024);
      expect(sent.endsWith("\n")).toBe(true);
      expect(text.startsWith(sent)).toBe(true);
    }
    expect(out.findings).toEqual([
      {
        kind: "extended_scan_partial",
        severity: "info",
        source: "presidio",
        count: 0,
        samples: [],
        lines: [],
      },
    ]);
  });

  it("a multibyte text over the limit is never cut inside a character", async () => {
    const text = "ñ".repeat(60 * 1024); // 120 KiB, no line break
    const { log } = spyLogger();
    await createPresidioScanner(cfg({ languages: ["es"] }), log).scan(text);
    const sent = (JSON.parse(requests[0]?.body ?? "{}") as { text: string }).text;
    expect(Buffer.byteLength(sent, "utf8")).toBeLessThanOrEqual(100 * 1024);
    expect(sent).toBe("ñ".repeat(sent.length));
    expect(sent.length).toBe(50 * 1024);
  });

  it("blank text sends nothing", async () => {
    const { log } = spyLogger();
    expect(await createPresidioScanner(cfg(), log).scan("  \n")).toEqual({ findings: [], spans: [] });
    expect(requests).toHaveLength(0);
  });
});
