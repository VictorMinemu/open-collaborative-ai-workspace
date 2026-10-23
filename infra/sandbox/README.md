# Bot sandboxes and browser: images, smokes and host hardening

The decisions behind this folder are in [ADR-0029](../../docs/adr/0029-bot-sandboxes-plugins-and-live-browser.md).
Operators turn the feature on as described in [docs/self-hosting/sandbox.md](../../docs/self-hosting/sandbox.md).

## Images

| Folder | Image | What it is |
| --- | --- | --- |
| `sandboxd/` | `ocw-sandboxd` | The broker (`apps/sandboxd`, bundled with esbuild into one file, no `node_modules`). The only service that holds the Docker socket. Runs as root only for the socket, with a read-only root, no capabilities and `no-new-privileges` |
| `sbx/` | `ocw-sandbox-sbx` | A bot's shell: Node 24, Python 3, git, curl, jq, unzip, xz; user `ocw` 10001; setuid and setgid bits stripped at build; `ocw-run` (runs one argv as a process group with a timeout) and `ocw-files` (realpath-confined file ops), both root-owned |
| `browser/` | `ocw-sandbox-brw` | A bot's browser: `playwright-core@1.64.1` driving the Chrome for Testing headless shell of Chrome stable **156.0.8078.47**, sha256-pinned per arch, over a pipe (no port). `agent.mjs` is the only page view a caller gets: redacted snapshots, masked screenshots, the site lock |
| `egress/` | `ocw-sandbox-egress` | The `sandbox-egress` proxy (`apps/sandboxd/src/egress`, plain Node, uid 10002): every bot network's only way out, with the API's own 07.4 rules (`@ocw/egress-policy`) |

All four build `FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20`.
Compose builds them under the `sandbox` profile and never starts `sbx`, `brw` or `egress` itself (`scale: 0`): sandboxd
creates those containers from its fixed spec.

**Bumping Chrome.** Every Chrome stable release needs the same change: the CfT headless shell version and its two
sha256 checksums in `browser/Dockerfile` (from Google's `chrome-for-testing-public` bucket), the agent's version check,
and a `playwright-core` whose Chromium is on the same milestone. Re-run the browser, stack and journey smokes. Nothing
watches for releases yet (WINDOWS #300).

## Smokes (real Docker)

Each smoke uses its own namespace (`ocw-smoke-<pid>`), builds `:smoke-<sha>` tags, removes its namespace's objects by
label **before starting and on exit**, and removes its images. None of them prunes or touches another namespace.

```bash
bash infra/sandbox/test/run-sandbox-smoke.sh     # sbx: hardening, isolation, files, quota, idle, events, restart
bash infra/sandbox/test/run-egress-smoke.sh      # the proxy: refusals, the single shared hop, fail closed
bash infra/sandbox/test/run-browser-smoke.sh     # brw on real Chromium: E1 masking, state, downloads, resize, site lock
bash infra/sandbox/test/run-stack-smoke.sh       # sandboxd + proxy + brw: frames, takeover, two bots apart, real egress
bash infra/sandbox/test/run-packages-smoke.sh    # npm, PyPI, ClawHub installs from the recorded tree, republish refused
bash infra/sandbox/test/run-orphans-check.sh     # sandboxd SIGKILL: objects adopted; nothing survives the label cleanup
```

`--only <sections>` runs part of a smoke (e.g. `run-stack-smoke.sh --only coldstart`). The full-stack proof (real
cell, API, sandboxd and browser) is `scripts/sandbox-proof.sh`, run through `scripts/e2e-isolated.sh --sandbox`.

## gVisor on the host

Sandboxes run under gVisor (`runsc`, systrap platform) when the Docker daemon has it, and on hardened runc otherwise.
Under gVisor Chromium keeps its own sandbox (`chromium+gvisor`).

1. Download the GitHub release `google/gvisor` **`release-20261005.0`**, asset `gvisor-x86_64.tar.bz2` (Google's
   release bucket answers 404 for this release). Check it against the release's `SHA512SUMS`:
   `79869ae9a589355a46d46fdac068d9a954e741741ffe77c64e38c56ea955498c1cb04e9bce44e1cce5155333e6b76bee72347c6661bb7c78fd2fe3aad198c8fe`.
2. Install the **whole** tarball: `runsc`, `containerd-shim-runsc-v1` and the `gvisor-bin/` sidecars. `runsc` alone
   refuses to start ("sidecar … not usable").
3. Register it in `/etc/docker/daemon.json` and restart Docker:

   ```json
   { "runtimes": { "runsc": { "path": "/usr/local/bin/runsc", "runtimeArgs": ["--platform=systrap"] } } }
   ```

4. `docker info --format '{{json .Runtimes}}'` lists `runsc`. Settings › Sandbox & Browser then reads
   "Isolated with gVisor".

`OCW_SANDBOX_RUNTIME` chooses:

| Value | Behaviour |
| --- | --- |
| `auto` (default) | `runsc` when the daemon lists it, otherwise hardened runc, reported as such |
| `runsc` | gVisor or nothing: sandboxd refuses to start without it, and never falls back |
| `runc` | Hardened runc even where gVisor exists |

Systrap works inside a VM without nested virtualisation (e.g. Hetzner Cloud). Docker Desktop on macOS has runc only.

**Hardened runc.** Every container runs as 10001 with a read-only root, no capabilities, `no-new-privileges`, PID,
memory and CPU limits, a `noexec` `/tmp`, no host mounts and its own internal network. Chromium keeps its sandbox there
through a seccomp profile (`browser/seccomp.json`: Docker's default plus `clone`, `setns`, `unshare`, `chroot`). On hosts
that restrict unprivileged user namespaces (Ubuntu 23.10 and later, `kernel.apparmor_restrict_unprivileged_userns=1`)
Chromium cannot sandbox itself; the browser then runs with `--no-sandbox` and the container as its only boundary, and
Settings says **container-only**. Allowing user namespaces for the browser with an AppArmor profile restores Chromium's
sandbox; gVisor is the better fix.

## Host hardening

Anyone who controls sandboxd controls the host's Docker. Recommended, in order of effort:

- **Docker Engine 26 or later** (required): older internal networks forwarded DNS (CVE-2024-29018). Keep it current;
  CI runs 29.8.2, and 29.9.2 is the next bump (WINDOWS #299).
- **Rootless Docker or `userns-remap`** for the daemon that runs sandboxes, so root in a container is not root on the
  host.
- **A Docker authorization plugin** (e.g. OPA `opa-docker-authz`) behind the socket, refusing privileged containers,
  host binds and anything sandboxd never asks for. A section-level socket proxy (Tecnativa) cannot inspect
  `HostConfig` and is defence in depth only.
- **Hard disk limits with XFS project quotas.** sandboxd's quota is soft: it measures with `du -sb` before writes and
  every minute, and stops a sandbox that goes over. For a hard limit, put Docker's volume directory on XFS mounted with
  `pquota` (`/etc/fstab`: `… xfs defaults,pquota 0 0`) and give the volumes project quotas (`xfs_quota -x -c 'project
  -s <id>'`, `limit -p bhard=<size> <id>`). The per-bot packages volume has no quota of its own (WINDOWS #261).
- **Kata Containers** later, where the host has KVM (bare metal, not Hetzner Cloud).
