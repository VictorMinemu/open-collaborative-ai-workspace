/**
 * OpenTelemetry preload (FOUND-05, D-05): `node --import tsx --import ./src/telemetry.ts src/main.ts`.
 *
 * Off by default: unless OTEL_EXPORTER_OTLP_ENDPOINT is non-empty this module returns before importing any SDK
 * package, so boot is unchanged. When on, the API exports traces (`@fastify/otel` request spans with `http.route`,
 * http server spans, pg spans), the `http.server.request.duration` metric and pino logs carrying `trace_id`, all
 * over OTLP/HTTP (JSON). Nothing here may take the API down: any setup error is one warning and the API runs on.
 *
 * Never exported: query strings, credentials, prompts, absolute host paths (telemetry/redact.ts), the process
 * executable path and argv (no resource detectors). AI SDK telemetry stays off (Semgrep rule in 07-01); Redis and
 * undici are not instrumented (Redis payloads carry chat content).
 */
import { API_VERSION } from "./version";

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();

/** A positive integer from the environment, or the fallback. */
const envMs = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

async function startTelemetry(): Promise<void> {
  const [
    { NodeSDK },
    { resourceFromAttributes },
    { BatchSpanProcessor },
    { PeriodicExportingMetricReader },
    { BatchLogRecordProcessor },
    { OTLPTraceExporter },
    { OTLPMetricExporter },
    { OTLPLogExporter },
    { HttpInstrumentation },
    { PgInstrumentation },
    { PinoInstrumentation },
    { FastifyOtelInstrumentation },
    { RedactingLogRecordExporter, RedactingSpanExporter },
  ] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/sdk-trace-base"),
    import("@opentelemetry/sdk-metrics"),
    import("@opentelemetry/sdk-logs"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/exporter-metrics-otlp-http"),
    import("@opentelemetry/exporter-logs-otlp-http"),
    import("@opentelemetry/instrumentation-http"),
    import("@opentelemetry/instrumentation-pg"),
    import("@opentelemetry/instrumentation-pino"),
    import("@fastify/otel"),
    import("./telemetry/redact"),
  ]);

  const isHealth = (url: string | undefined) => url === "/health" || (url ?? "").startsWith("/health?");
  const metricInterval = envMs("OTEL_METRIC_EXPORT_INTERVAL", 60_000);

  const sdk = new NodeSDK({
    // The default detectors export process.executable.path (an absolute host path) and process.command_args.
    resourceDetectors: [],
    resource: resourceFromAttributes({
      "service.name": process.env.OTEL_SERVICE_NAME?.trim() || "ocw-api",
      "service.version": API_VERSION,
      "deployment.environment.name": process.env.NODE_ENV || "development",
    }),
    spanProcessors: [new BatchSpanProcessor(new RedactingSpanExporter(new OTLPTraceExporter()))],
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: metricInterval,
        exportTimeoutMillis: Math.min(envMs("OTEL_METRIC_EXPORT_TIMEOUT", 30_000), metricInterval),
      }),
    ],
    // sdk-logs 0.222 processors take an options object (07-RESEARCH Pitfall 5).
    logRecordProcessors: [
      new BatchLogRecordProcessor({
        exporter: new RedactingLogRecordExporter(new OTLPLogExporter()),
        scheduledDelayMillis: envMs("OTEL_BLRP_SCHEDULE_DELAY", 1_000),
      }),
    ],
    instrumentations: [
      new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => isHealth(req.url) }),
      new PgInstrumentation(),
      new PinoInstrumentation(),
      new FastifyOtelInstrumentation({
        registerOnInitialization: true,
        ignorePaths: (route) => route.url === "/health",
      }),
    ],
  });
  sdk.start();

  // Flush what is buffered when the process is asked to stop (main.ts's close-with-grace then exits).
  const flush = () => {
    sdk.shutdown().catch(() => {});
  };
  process.once("SIGTERM", flush);
  process.once("SIGINT", flush);
}

if (endpoint) {
  try {
    await startTelemetry();
  } catch (err) {
    // One line, never the endpoint itself (it may carry credentials), and the API keeps booting.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`telemetry disabled: ${message.split(endpoint).join("<endpoint>")}`);
  }
}
