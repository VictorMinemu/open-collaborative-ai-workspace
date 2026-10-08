# Observability (optional `observability` profile)

Traces, metrics and logs of the API in self-hosted Grafana, Tempo, Prometheus and Loki, behind an OpenTelemetry
Collector. The profile is off by default and can be turned on later for a running install with one command: nothing is
reinstalled or rebuilt, and existing data is not touched (FOUND-05, SELF-01, D-05).

## Enable it

```bash
pnpm ocw enable observability                    # this checkout's .env
pnpm ocw enable observability --env-file /srv/ocw/.env
```

The command:

1. sets `OCW_OTEL_ENDPOINT=http://otel-collector:4318`. Compose passes it to the api as `OTEL_EXPORTER_OTLP_ENDPOINT`;
   without it the API never starts the OpenTelemetry SDK.
2. generates `OCW_GRAFANA_ADMIN_PASSWORD` once. An existing value is never rotated.
3. adds `observability` to `COMPOSE_PROFILES`.
4. runs `docker compose up -d --wait`, which recreates only the api (its endpoint changed) and starts the five profile
   services. PostgreSQL, Redis, Garage, the web app and the OpenClaw cell keep running untouched.

It prints the names of the keys it wrote, never their values. Running it again changes nothing. With `--no-up` it only
writes the env file; start the profile later with `docker compose up -d --wait`.

The same api image runs with or without the profile: it always starts with the telemetry preload
(`node --import tsx --import ./src/telemetry.ts src/main.ts`), which does nothing unless the endpoint is set.

## What runs

| Service | Image (pinned by digest) | Role | Data | Retention |
| --- | --- | --- | --- | --- |
| `otel-collector` | `otel/opentelemetry-collector-contrib:0.161.0` | Receives OTLP from the API, redacts again, fans out | none | — |
| `tempo` | `grafana/tempo:3.1.0` | Traces (monolithic, local storage) | `tempo-data` | 14 days (Tempo default) |
| `prometheus` | `prom/prometheus:v3.13.4` | Metrics (native OTLP receiver) | `prometheus-data` | 15 days |
| `loki` | `grafana/loki:3.7.8` | Logs (native OTLP, single binary) | `loki-data` | 15 days |
| `grafana` | `grafana/grafana:13.2.3` | Dashboards and Explore, datasources provisioned | `grafana-data` | — |

Configuration lives in `infra/observability/`. Only Grafana publishes a port, and only on `127.0.0.1`; every other
service is reachable on the compose network only. Tempo, Loki and Grafana have usage reporting turned off, and Grafana
does not check for updates or install plugins at start.

## Sign in to Grafana

- URL: `http://127.0.0.1:3301` (or `OCW_GRAFANA_PORT`).
- User `admin`; the password is `OCW_GRAFANA_ADMIN_PASSWORD` in the env file:

  ```bash
  grep '^OCW_GRAFANA_ADMIN_PASSWORD=' .env
  ```

- On a remote server, use an SSH tunnel instead of publishing the port:

  ```bash
  ssh -L 3301:127.0.0.1:3301 you@your-server     # then open http://127.0.0.1:3301 locally
  ```

Anonymous access and sign-up are off. Grafana refuses to start when the password is empty or `admin`, with a message
naming `OCW_GRAFANA_ADMIN_PASSWORD`. Grafana applies the password only when it creates its database (first start).
To change it later, run `docker compose exec grafana grafana cli admin reset-admin-password '<new password>'` and
update the env file to match.

In Explore, the three datasources (Prometheus, Loki, Tempo) are linked. A Loki log line opens its trace in Tempo
through its `trace_id`, and a Tempo span opens the logs of the same trace.

What the API sends:

- **Traces:** one per request, with a Fastify request span labelled with the route template (`http.route`), the HTTP
  server span and PostgreSQL query spans. Health checks are not traced.
- **Metrics:** `http_server_request_duration_seconds` (histogram) by `http_route`, method and status.
- **Logs:** the API's own log lines, with the `trace_id` and `span_id` of the request that produced them.

## What is never recorded

The API redacts at the source, and the collector removes the same attributes again (defense in depth, D-18):

- no query strings (`url.query`, `url.full` or a `?…` in a path or log message), since they can carry tokens;
- no credentials: cookies, `Authorization` headers and any attribute whose name looks like a token, secret, password
  or prompt;
- no prompt or message contents, because AI SDK telemetry stays off;
- no absolute host paths: no `process.executable.path`, no `process.command_args`, and paths in stack traces are
  rewritten;
- no Redis payloads (Redis is not instrumented, because chat content travels through it).

The gate step `scripts/gate/observability-smoke.mjs` checks this on a real stack. It sends a request with a
query-string canary and searches Tempo and Loki for the canary, for this checkout's absolute path and for the process
attributes.

## Send telemetry somewhere else instead

You can use an OTLP collector you already run instead of the profile. Leave the profile off and point the API at the
collector in the env file, then recreate the api:

```bash
OCW_OTEL_ENDPOINT=http://collector.internal:4318   # OTLP/HTTP; the API appends /v1/traces, /v1/metrics, /v1/logs
docker compose up -d api
```

Redaction happens inside the API, so it applies to any endpoint. The compose file passes only the endpoint. If your
collector needs an authentication header, run a local collector that adds the header, and point the API at that
collector.

## Resource cost

Memory measured on the gate stack (Docker Desktop, arm64) about two minutes after enabling the profile, across six
runs:

| Service | Memory (RSS) |
| --- | --- |
| `grafana` | 390–580 MiB |
| `otel-collector` | 65–165 MiB (capped at 256 MiB) |
| `loki` | 50–150 MiB |
| `tempo` | 45–95 MiB |
| `prometheus` | 25–50 MiB |
| **Total** | about 0.6–1 GiB |

CPU stays near idle at low traffic. Plan for about 1 GiB of extra RAM.

Disk: the five images are about 3 GB unpacked, of which Grafana is 1.8 GB. The data volumes then grow with traffic,
bounded by the retention above.

Loki protects the disk it shares with the rest of the stack: once the filesystem under `loki-data` is more than 90%
full, it stops accepting logs (its log says `disk usage exceeded threshold, throttling writes`, and pushes fail with
`Ingester is shutting down`). Traces and metrics keep flowing. Free space and Loki resumes on its own.

## Backups

Telemetry is **not** part of `pnpm ocw backup`. The `tempo-data`, `prometheus-data`, `loki-data` and `grafana-data`
volumes are not archived, and a restore starts them empty. Dashboards you build in Grafana are stored in
`grafana-data`; export them as JSON if you want to keep them.

## Turn it off

1. Remove `observability` from `COMPOSE_PROFILES` and clear `OCW_OTEL_ENDPOINT` in the env file.
2. Recreate the api: `docker compose up -d api`.
3. Remove the profile's containers:

   ```bash
   docker compose --profile observability rm -sf otel-collector tempo prometheus loki grafana
   ```

The data volumes stay until you remove them with `docker volume rm`.
