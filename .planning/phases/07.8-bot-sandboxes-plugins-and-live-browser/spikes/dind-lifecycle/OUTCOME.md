# Spike (iii): the sandboxd lifecycle inside the Woodpecker dind

**Question (A3, D-01, D-11, P-14):** can a sandboxd-like process create per-bot internal networks and hardened
containers, exec as uid 10001, attach stdio and clean up by label inside the Woodpecker dind, and are two bots isolated
there (volume, network, no external route, no external DNS)? Is the dind's Docker ≥ 26 (CVE-2024-29018)?

**Result: POSITIVE.** Every check passed on the first real run (2026-10-15). The dind does **not** have `runsc`
(runc only), which spike (i) covers with a nested daemon.

**Chosen path:** `sandboxd` runs in CI against the Woodpecker dind socket exactly as the steps already do
(`/var/run/docker.sock` of the dind, `.woodpecker/cell-smoke.yaml` `&docker_sock`), on the **hardened-runc** profile.
P-14's fallback (a nested `docker:dind` service step) is **not needed for the runc path**. It is needed only for a gVisor
CI job, because the Woodpecker dind must not be reconfigured to register `runsc` (see spike (i)).

## Environment

| Item | Value |
|------|-------|
| Host | Hetzner CI box `hetzner-ci`, Ubuntu 24.04, kernel `6.8.0-106-generic`, x86_64 |
| Daemon | `woodpecker-dind` (`docker:29.8.2-dind`), **ServerVersion 29.8.2**, API 1.56 (min 1.40), Alpine 3.24 (containerized) |
| Runtimes | `io.containerd.runc.v2`, `runc` (default `runc`); no `runsc` |
| Cgroup | v2, `cgroupfs` driver; storage `overlayfs` (containerd snapshotter) |
| Security options | `apparmor` (profile default), `seccomp` (builtin), `cgroupns` |
| Runner | `node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20` with the dind socket mounted, like a CI step |
| Bot image | `ocw-spike-078-bot:spike` = the same node base + `mkdir /workspace && chown 10001:10001` (Pitfall 4) |

Docker 29.8.2 ≥ 26, so internal networks do not forward DNS (CVE-2024-29018 / GHSA-mq39-4gv4-mvpx fixed in 26.0.0).

## Commands

```bash
bash .planning/phases/07.8-bot-sandboxes-plugins-and-live-browser/spikes/dind-lifecycle/run.sh > report.json
```

`run.sh` checks the dind is idle (no pipeline container), builds the bot image with `docker exec woodpecker-dind docker
build -`, then runs `lifecycle.mjs` from a node container with the dind socket mounted (`node --input-type=module -`).
`lifecycle.mjs` uses only `node:http` with `socketPath` (Engine API, no CLI): `GET /version`, `GET /info`,
`POST /networks/create` (`Internal: true`), `POST /volumes/create`, `POST /containers/create` with the research's
hardened spec, `POST /containers/{id}/exec` + hijacked `POST /exec/{id}/start`, hijacked
`POST /containers/{id}/attach`, `POST /containers/{id}/kill`, `DELETE` by label filter. The full report is
[`report.json`](report.json).

## Results

| Check | Evidence (from `report.json`) | Result |
|-------|-------------------------------|--------|
| Docker ≥ 26 | `ServerVersion: 29.8.2` | ✅ |
| Per-bot `internal: true` network, one per bot | `networkInternal: true`; A `172.18.0.2`, B `172.19.0.2` | ✅ |
| Hardened container spec accepted | `ReadonlyRootfs: true`, `CapDrop: [ALL]`, `no-new-privileges:true`, `Init: true`, `PidsLimit: 256`, `Memory: 1 GiB`, `NanoCpus: 1e9`, tmpfs `/tmp` `noexec,nosuid,nodev,size=256m`, `Binds: null`, `User: 10001:10001`, `Runtime: runc` | ✅ |
| Hardening seen from inside | `CapEff 0000000000000000`, `NoNewPrivs 1`, `Seccomp 2`, write to `/etc` → `EROFS`, exec from `/tmp` → `EACCES`, PID 1 `/sbin/docker-init` | ✅ |
| Exec as 10001 | `uid 10001, gid 10001`, exit 0 | ✅ |
| Volume write/read in A (image-owned `/workspace`) | read back `bot-a`, file uid 10001 | ✅ |
| B does not see A's file | `exists: false` | ✅ |
| Control: A reaches its own listener | `aReachesItself ok` | ✅ |
| B cannot reach A | `ENETUNREACH` to `172.18.0.2:8080` | ✅ |
| B has no external route | `ENETUNREACH` to `1.1.1.1:443` | ✅ |
| B has no external DNS | `EAI_AGAIN` for `example.com` | ✅ |
| B cannot resolve A's name | `ENOTFOUND` for `ocw-spike-078-bot-a` (A resolves itself: `172.18.0.2`) | ✅ |
| Stdio attach round-trip on the main process | sent and received `{"id":1,"method":"ping","params":{"from":"sandboxd"}}` | ✅ |
| Kill by label, remove by label | killed A and B; removed 2 containers, 2 networks, 2 volumes; leftovers 0/0/0 | ✅ |

One false start, recorded for 24: the first run killed its own runner (exit 137) because the runner also carried
`ocw.spike=07.8`. A label-scoped kill must never match the process doing the killing; `sandboxd` must not label
itself with `ocw.sandbox=1` (its own container is a compose service, not a sandbox).

## Cleanup

After the run, in the Woodpecker dind: `docker ps -aq --filter label=ocw.spike=07.8` → 0, networks 0, volumes 0, the
image `ocw-spike-078-bot:spike` removed. The node base was already present (same digest) and is kept. The `docker build`
left one 12.39 kB build-cache record (`mkdir -p /workspace && chown …`); it is not removable by name and is left to the
housekeeping workflow (`infra/ci/disk-budget.sh`), per the no-prune rule. Disk: images 11.27 GB + build cache 38.79 GB =
50.1 GB, inside the 60 GB budget; unchanged from before the spike. The dind daemon was never reconfigured or restarted.

## What the dependent plans do

- **04 (sbx image and spec):** keep `/workspace` created and chowned to 10001 in the image (proved here); the spec above
  is accepted verbatim by Engine 29.8.2.
- **13 (sandboxd lifecycle):** exec start and attach must use the hijacked (`Connection: Upgrade`, `Upgrade: tcp`)
  request and demultiplex the 8-byte frame headers (no TTY); the `node:http` approach works with no dependency.
  Name resolution of a peer bot fails (`ENOTFOUND`), so only `sandbox-egress` must be attached to each bot network.
- **24 (CI jobs):** sandbox jobs run in the Woodpecker dind directly on hardened runc (no nested step needed);
  `infra/ci/smoke-reset.sh` and `e2e-reset.sh` remove `label=ocw.sandbox=1` containers, networks and volumes. A gVisor
  job, if wanted, runs in a nested `docker:dind` step as spike (i) did.
