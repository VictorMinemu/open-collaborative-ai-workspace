# Woodpecker CI on one dind daemon

Every workflow in `.woodpecker/` runs on the agent `hetzner-ci` against one nested Docker daemon (`woodpecker-dind`),
with the scratch dir `/home/ocw-ci` shared by all of them. The agent runs up to `WOODPECKER_MAX_WORKFLOWS` workflows at
once, so each heavy workflow (and each e2e viewport) owns a **slot**: everything it creates on the daemon or in the
scratch dir belongs to the slot, and its reset and cleanup touch nothing else.

| Workflow | Slot (`OCW_CI_SLOT`) | Compose projects | Ports (dind network) | Label namespaces and names | Dirs under `/home/ocw-ci` |
| --- | --- | --- | --- | --- | --- |
| verify | `verify` | none | none fixed (testcontainers publish random ports, 32768+) | none (testcontainers) | `ws/verify` |
| e2e (desktop) | `e2e-desktop` | `ocw-ci-e2e-desktop` | block 21: web 2100, API 2101, postgres 2102, redis 2103, Garage 2104, fake 2191 | none | `ws/e2e-desktop` |
| e2e (mobile) | `e2e-mobile` | `ocw-ci-e2e-mobile` | block 22: 2200-2204, fake 2291 | none | `ws/e2e-mobile` |
| cell-smoke | `cell-smoke` | none | none (internal networks 10.231.76/77.0/24) | names `ocw-ci-cell-smoke-*` | `ws/cell-smoke`, `tmp/cell-smoke` |
| sandbox | `sandbox` | `ocw-ci-sandbox` (proof postgres/redis), `ocw-ci-sandbox-storage` (runner Garage) | block 24: postgres 2402, redis 2403, runner web 2400, API 2401, fake 2491, Garage 2492, sandboxd 2493 (proof network 10.231.80.0/24) | `ocw-ci-sandbox-smoke-*`, `ocw-ci-sandbox-e2e`, `ocw-ci-sandbox-proof`, `ocw-ci-sandbox-gvisor` | `ws/sandbox`, `tmp/sandbox`, `run/ocw-ci-sandbox-gvisor` |
| images | none | none | none | none (`ocw-*:ci` tags only) | none |
| housekeeping | none | none | none | none | none |

Rules (checked by `infra/ci/slots.test.mjs`):

- Every name of a slot is `ocw-ci-<slot>` or starts with `ocw-ci-<slot>-`, and no slot name is another slot's name
  followed by a dash, so `infra/ci/slot-reset.sh` (by compose project, `ocw.namespace` label or name) never matches
  another slot's objects. It never prunes.
- Each slot that publishes ports owns one block NN00-NN99 (`pnpm setup:env --ports NN`), below Docker's ephemeral range
  (32768+, where testcontainers and every `listen(0)` land), clear of the daemon's own 2375 and of the ports browsers
  and Node `fetch` refuse.
- Two pipelines (two open pull requests) never run the same slot at once: `infra/ci/slot-lease.sh acquire` (first
  command of each install step) waits while a live run of another pipeline holds it, and takes over at once from a
  cancelled or killed run (its Woodpecker workflow volume is gone). A new push to the same pull request cancels the
  older pipeline (repo setting `cancel_previous_pipeline_events`), so the usual wait is zero.
- A cancelled run's leftovers are removed by the next run of the same slot (`slot-reset.sh` at the start of its first
  step that uses the daemon) and its cleanup step.

Shared resources:

- **Step image.** Each pipeline builds and runs `ocw-ci:<commit sha>` (`infra/ci/build-image.sh`), so a pull request
  that changes the pins never swaps the image under another pipeline's next step. Workflows of one pipeline build the
  same content (same image id; re-tagging is atomic and changes nothing).
- **pnpm store** (`cache/pnpm-store`). pnpm writes the content-addressable store with atomic renames and is built for
  concurrent installs sharing one store; the global virtual store is off (each workspace links its own
  `node_modules/.pnpm`). The uv cache (`cache/uv`, verify only) locks its own entries.
- **Disk budget** (`infra/ci/disk-budget.sh`, housekeeping). It only removes what no running workflow can use:
  dangling images, and stopped containers, unused networks and unused volumes older than 3 hours. Tag clean-ups, the
  over-budget image prune and dropping the caches wait until no other workflow is running.

Agent: `WOODPECKER_MAX_WORKFLOWS` sets how many workflows run at once (the host is shared with production; 3 is the
intended value).
