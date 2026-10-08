---
phase: 07-self-hosted-release
plan: 07
subsystem: observability
status: complete
tags: [opentelemetry, observability, grafana, tempo, prometheus, loki, compose, gate, cli]
requires:
  - phase: 07-03
    provides: "compose include of infra/observability/compose.yaml, api OTEL pass-through, gate harness (withGateStack, 34xx, lock)"
  - phase: 07-04
    provides: "scripts/ocw/env-file.mjs helpers and the ocw dispatcher"
  - phase: 07-05
    provides: "apps/api/src/telemetry.ts preload and redaction"
provides:
  - "infra/observability/: profile `observability` (otel-collector, tempo, prometheus, loki, grafana) + configs + contract test"
  - "pnpm ocw enable observability [--env-file F | --dir D] [--no-up]"
  - "api image CMD with the telemetry preload"
  - "scripts/gate/observability-smoke.mjs: gate step (--up | --attach <envFile>), exports run(ctx), inNetworkGet, leaks, flattenSpans, pipelineErrors"
  - "docs/self-hosting/observability.md"
affects: [07-10 (full gate runs this step), 07-11 (install guide links the doc)]
tech-stack:
  added:
    - "otel/opentelemetry-collector-contrib 0.161.0, grafana/tempo 3.1.0, prom/prometheus v3.13.4, grafana/loki 3.7.8, grafana/grafana 13.2.3 (images, pinned by digest; no npm dependency)"
  patterns:
    - "Backends queried from inside the compose network with node in the api container; only Grafana is published, on loopback"
    - "Gate-only compose override file in the stack's temp dir, appended to COMPOSE_FILE, removed with the stack"
key-files:
  created:
    - infra/observability/otel-collector.yaml
    - infra/observability/tempo.yaml
    - infra/observability/prometheus.yml
    - infra/observability/loki.yaml
    - infra/observability/grafana/datasources.yaml
    - infra/observability/compose-observability.test.mjs
    - scripts/ocw/enable-observability.mjs
    - scripts/ocw/enable-observability.test.mjs
    - scripts/gate/observability-smoke.mjs
    - docs/self-hosting/observability.md
  modified:
    - infra/observability/compose.yaml
    - apps/api/Dockerfile
key-decisions:
  - "Tempo 3.1.0 kept (assumption A1 held: the 2.x-shaped minimal monolithic config starts and serves traces); no fallback to 3.0.3"
  - "ocw enable observability never rotates an existing Grafana password (Grafana applies it only when it creates its DB) and replaces a foreign OCW_OTEL_ENDPOINT without printing it"
  - "Grafana's entrypoint refuses an empty or `admin` password naming OCW_GRAFANA_ADMIN_PASSWORD (a `:?` guard would break compose config for installs without the profile)"
  - "Product keeps Loki's 90% WAL disk guard; gate stacks raise it to 99% through a temp-dir override (the dev Docker disk sits at 90-93%)"
  - "Usage reporting off in Tempo, Loki and Grafana; Grafana update checks, news and plugin preinstall off"
metrics:
  duration: "~95 min wall clock (2 full pnpm verify runs of ~14 min, 7 gate runs of ~3.5-6 min)"
  completed: 2026-10-08
actuals:
  tokens: 16250
  tasks: 2
  commits: 9
---

# Phase 7 Plan 07: Observability profile and `ocw enable observability` Summary

One command (`pnpm ocw enable observability`) now turns on a self-hosted OpenTelemetry Collector + Tempo + Prometheus +
Loki + Grafana profile for a running install. It recreates only the api. On a real gate stack, one API request shows
up as a trace in Tempo, as a route-labelled metric in Prometheus and as log lines with the same trace id in Loki. No
canary, host path or process attribute is stored. The only exposed surface is Grafana, on loopback, behind a
generated password.

## Results (exact)

- **Node tests (plan verify):** `node --test scripts/ocw/enable-observability.test.mjs infra/observability/compose-observability.test.mjs infra/compose.test.mjs` gives **39 tests, 39 pass, 0 fail, 0 skipped**: 8 for enable, 16 for the profile contract and 15 for the compose contract, run against real Compose.
- **All script/infra node tests:** `node --test 'scripts/**/*.test.mjs' 'infra/**/*.test.mjs'` gives **239 pass, 0 fail, 0 skipped**.
- **`pnpm verify`** ran twice, on the Task 1 tree and on the final tree. Both exited 0:
  - lint: 971 files, with the 4 warnings that were already there in `apps/local-runtime`;
  - guard: semgrep, licenses, fields and codeowners all ok;
  - typecheck: 8/8;
  - vitest: **199 files, 2773 tests passed**.
- **Gate `node scripts/gate/observability-smoke.mjs --up`:** final two consecutive runs exit 0, all steps ok, in 207.6 s and 204.7 s. The last run:
  - `obs-enable`: exit 0, password not printed.
  - `obs-only-api-recreated`: recreated `["api"]` only, every profile service running, messages 1 → 1.
  - `obs-trace-in-tempo`: 35 spans, including `request` (`http.route=/api/v1/me`), `GET /api/v1/me` (http SERVER) and `pg.query:SELECT ocw`. Leaks: none.
  - `obs-metric-in-prometheus`: `http_server_request_duration_seconds_count{http_route="/api/v1/me", job="ocw-api"}` is present. Labels include `service_name` and `service_version`.
  - `obs-logs-in-loki`: 2 lines with the request's `trace_id`. 22 api lines were searched, with no leaks.
  - `obs-grafana`: Loki, Prometheus and Tempo are listed, and each datasource's health is `OK`. `admin:admin` gets 401 and anonymous gets 401.
  - `obs-grafana-refuses-empty-password`: empty → exit 1, `admin` → exit 1. Both messages name `OCW_GRAFANA_ADMIN_PASSWORD`.
  - The demo is untouched, teardown removed 4 images, and the build-cache prune removed 55 records.
- **Acceptance greps:**
  - `grep -n telemetry.ts apps/api/Dockerfile` prints the CMD line (28).
  - `grep -c @sha256: infra/observability/compose.yaml` prints **5**.
  - `grep -n 127.0.0.1 …` shows the Grafana port line (89).
  - The doc exists.
  - `test -z "$(docker ps -aq --filter name=ocw-gate-)"` exits 0.
- **Final Tempo version:** 3.1.0. The 2.x-shaped minimal monolithic config (`distributor.receivers.otlp`, `storage.trace.local`/`wal`) starts and serves traces within about 1 s.
- **Profile memory**, about 2 min after enabling, across 6 gate runs:

| Service | Memory |
| --- | --- |
| grafana | 391-580 MiB |
| otel-collector | 64-162 MiB (capped at 256 MiB) |
| loki | 50-150 MiB |
| tempo | 43-93 MiB |
| prometheus | 27-48 MiB |
| **Total** | about 0.6-1 GiB |

- **Images:** about 3 GB unpacked; Grafana alone is 1.81 GB. All five digests verified on pull.

## Commits

| Task | Commit | Message |
| --- | --- | --- |
| 1 RED | 5286f10 | test(07-07): failing tests for ocw enable observability |
| 1 | c1f79cf | feat(07-07): ocw enable observability turns the profile on for a running install |
| 1 | 6e1a786 | feat(07-07): api image starts with the telemetry preload |
| 1 | a645b3c | feat(07-07): observability profile tracer: collector and Tempo, trace proven after enabling |
| 2 RED | 5270ca1 | test(07-07): failing compose contract for the full observability profile |
| 2 | e71e84d | fix(07-07): scope two profile contract assertions to what they mean |
| 2 | 0d0997c | feat(07-07): Prometheus, Loki and Grafana complete the observability profile |
| 2 | a4ffbec | feat(07-07): observability smoke checks metrics, logs, Grafana and leaks end to end |
| 2 | 30046dc | docs(07-07): self-hosting guide for the observability profile |

## TDD Gate Compliance

- **Task 1:** RED was 8 of 8 failing ("Unknown command"), committed in 5286f10. It went GREEN with 8 of 8 in c1f79cf.
- **Tracer:** `observability-smoke.mjs --up` passed on the first run (213 s) before a645b3c.
- **Task 2:** RED was 12 of 16 failing, committed in 5270ca1. It went GREEN with 16 of 16 after 0d0997c.

## Deviations from Plan

**1. [Rule 1 - Bug] Two assertions in my own RED contract test were over-broad (e71e84d)**
- The service-block split also matched the top-level `volumes:` keys, giving 9 blocks for 5 services.
- The no-`:?`-guard regex matched the phrase in a comment.
- Both are now scoped: blocks inside `services:` only, and `${VAR:?` interpolation only.
- A mutation check shows both still fail on a real defect: a service without `profiles` (2 failures) and a real `:?` guard (3 failures).

**2. [Rule 1 - Bug, environment] Loki's WAL disk guard silently dropped logs on this machine; gate-only threshold 0.99**
- **Symptom:** gate runs 2 and 3 failed `obs-logs-in-loki`. Loki held 6 lines while the api had logged 21 request lines, 2 of them with the trace id.
- **What it was not:** an isolated repro showed Loki stores pushes from 0.6 s after start, and named-volume ownership is correct.
- **Root cause:** a diagnostic run inside the gate lock showed `wal.go: disk usage exceeded threshold, throttling writes usage_percent=91.06% threshold_percent=90.00%`. After that, every push failed with `Ingester is shutting down`. The Mac's Docker disk is 93% used (`df`), which is environmental.
- **Fix:**
  - The product keeps Loki's default 90% guard. It protects the disk shared with PostgreSQL, and the doc tells operators what it looks like.
  - The smoke writes a gate-only compose override in the stack's temp dir, `loki: command: [... -ingester.wal-disk-full-threshold=0.99]`. A truly full disk still throttles.
  - A failed log check now attaches the collector, Loki, Tempo and Prometheus warn/error tails, plus api stdout counts, so a recurrence explains itself.
- **Verified:** two consecutive green runs after the fix.

**3. [Rule 3 - Blocking] `compose.e2e.yaml` forces api `LOG_LEVEL: warn`**
- At warn the api emits no request logs, so Loki can never see the traced request on the gate's default stack.
- No request path logs at warn. `lib.mjs` (07-03) cannot pass extra env, and `compose.yaml`/`compose.e2e.yaml` are not this plan's files.
- The same temp-dir override sets the api's `LOG_LEVEL: info` only when the running level is quieter than info. Product installs default to info and are unaffected.

**4. [Rule 2] Extra hardening beyond the plan**
- Grafana's guard also refuses the literal `admin`.
- Usage reporting is off in Tempo, Loki and Grafana. Grafana update checks, news feed and plugin preinstall are off, so there are no outbound calls at start.
- The collector also redacts in the logs and metrics pipelines (process attributes) and strips `?…` from `url.path`/span names.
- The deprecated `otlp`/`otlphttp` exporter aliases were renamed to `otlp_grpc`/`otlp_http`. 0.161 warned that they are deprecated.

**5. [Process] Per-commit verification**
- A full `pnpm verify` (about 14 min) ran on the Task 1 tree and on the final tree, both green.
- Intermediate commits are subsets of those trees and touch only `.mjs`/YAML/Dockerfile/Markdown. No vitest or typecheck input changed: vitest covers `apps/*/src` and `packages/*/src`, and no test there references these paths (checked).
- Lint and guard ran on the full superset each time.

**6. [Process] Gate lock contention**
- I waited about 15 min for 07-06's `vault-check.mjs` (two runs) to release the lock and for disk to recover. Their stack was never touched.

## Open Items

- **For 07-10 (full gate):** run this step after the compose gate, with `--attach <envFile>` or as a step in `compose-gate`. It applies its own gate overrides, api LOG_LEVEL=info and Loki 0.99, which recreate api (and loki when the profile is already on); `obs-only-api-recreated` allows exactly that.
- **Not verified on a stack:** the doc's "Turn it off" commands (`docker compose --profile observability rm -sf …`) and the Grafana password-reset command are standard Compose/Grafana CLI, but no gate exercised them.
- **Metric latency:** the API exports metrics every 60 s by default, so `obs-metric-in-prometheus` takes about 46 s. `OTEL_METRIC_EXPORT_INTERVAL` is not passed by `compose.yaml`, which this plan does not own.
- **Auth headers for an external OTLP endpoint:** `compose.yaml` passes only the endpoint. The doc says to front such a collector with a local one.
- **Docker disk:** with the five observability images present, this Mac is at about 91-93% Docker disk usage during gate runs. All my images are removed; 14.2 GB were free at the end.

## Known Stubs

None. 07-03's `infra/observability/compose.yaml` `services: {}` stub is resolved.

## Broken-windows entries (for the orchestrator to record in WINDOWS.md)

- `deviation` | `scripts/gate/observability-smoke.mjs` | gate stacks run Loki with `-ingester.wal-disk-full-threshold=0.99` (the product keeps 0.9) because the dev Docker disk sits at 90-93%.
- `deviation` | `scripts/gate/observability-smoke.mjs` | the smoke lowers the api to `LOG_LEVEL=info` on stacks that use `compose.e2e.yaml` (warn), via a temp-dir compose override.
- `unrun-verify` | `docs/self-hosting/observability.md` | the "Turn it off" and Grafana password-reset commands were not exercised on a stack.

## Threat Flags

None beyond the plan's register. T-07-07-01..03 and 05 are mitigated and checked by the smoke; T-07-07-04 is accepted, with the collector `mem_limit` and memory_limiter and the cost documented. The single new surface, Grafana on 127.0.0.1, is in the register (T-07-07-02/03).

## Cleanup

- Removed the five observability images and `curlimages/curl:8.11.1`, which I pulled for a probe.
- No `ocw-gate-*` container, volume, network or temp dir is left.
- Probe containers, volumes and networks (`ocw-gate-0707-*`, project `ocw-gate-0707obs`) are removed, and so is `/tmp/ocw-0707-probe`.
- Gate build cache was pruned per run by the harness. No global prune was run.
- The demo was untouched in all 7 gate runs (`demo-untouched` ok).

## Self-Check: PASSED

- FOUND: every created and modified file listed in key-files is present on `wt/07-07`.
- FOUND commits: 5286f10, c1f79cf, 6e1a786, a645b3c, 5270ca1, e71e84d, 0d0997c, a4ffbec, 30046dc.
