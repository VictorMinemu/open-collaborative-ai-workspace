# syntax=docker/dockerfile:1
# OCW `sandboxd` (Phase 07.8, D-01, D-11, SBX-01): the sandbox broker, the ONLY component that holds the Docker API.
# It creates each bot's hardened `sbx` / `brw` containers from a fixed spec and acts only on objects carrying its
# labels. Build from the repository root (the root .dockerignore keeps node_modules, .git and .env files out):
#   docker build -f infra/sandbox/sandboxd/Dockerfile -t ocw-sandboxd:local .
# compose.yaml runs it in the `sandbox` profile: the Docker socket mounted, `read_only`, `cap_drop: [ALL]`,
# `no-new-privileges`, `init`, a tmpfs at /tmp, no published port and only the internal `sandbox-control` network,
# which only the API shares.
#
# Image gate (07.8-24 Task 1, approved; C-04, P-15):
#   - the base approved at the 07.8-04 gate (same digest as `sbx` and `sandbox-egress`), nothing added to it;
#   - the build stage installs the workspace's locked packages only (`pnpm install --frozen-lockfile`) and bundles the
#     broker entrypoint (apps/sandboxd/src/main.ts) with esbuild 0.28.2 (already locked) into ONE file, with
#     @ocw/contracts, @ocw/egress-policy and zod inlined; the runtime stage is the base plus that file and the `brw`
#     seccomp profile: no node_modules, no apt or npm package, no setuid or setgid binary.
#   - It runs as root (uid 0) only because the Docker socket is root-owned; every capability is dropped by compose.
#     Host hardening, documented in ADR-0029: rootless Docker (or a Docker authorization plugin) behind the socket.

# The base approved at the 07.8-04 image gate (C-04, P-15).
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo
COPY package.json ./
# pnpm 12 fetches its own binary on first use; the registry sometimes times out on it, so retry before giving up.
RUN for i in 1 2 3 4; do pnpm --version && exit 0; echo "pnpm bootstrap attempt $i failed" >&2; sleep 10; done; exit 1
COPY . .
# Locked versions only; no lifecycle script runs (esbuild's binary comes from its locked platform package).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter "@ocw/sandboxd..." \
 && pnpm --filter @ocw/sandboxd build \
 && node -e 'const s=require("fs").statSync("apps/sandboxd/dist/sandboxd.mjs"); if (!s.size) process.exit(1)'

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
WORKDIR /app
COPY --from=build /repo/apps/sandboxd/dist/sandboxd.mjs /app/sandboxd.mjs
# Docker's default seccomp profile + user-namespace clone/unshare/setns, sent inline for each `brw` (D-14).
COPY infra/sandbox/browser/seccomp.json /app/brw-seccomp.json
RUN chown -R 0:0 /app \
 && chmod 0555 /app \
 && chmod 0444 /app/sandboxd.mjs /app/brw-seccomp.json \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} + \
 && test -z "$(find / -xdev -type f -perm /6000 -print -quit)"

ENV NODE_ENV=production \
    OCW_SANDBOXD_HOST=0.0.0.0 \
    OCW_SANDBOXD_PORT=8090 \
    OCW_SANDBOX_BRW_SECCOMP=/app/brw-seccomp.json \
    DOCKER_SOCKET=/var/run/docker.sock
# Root only for the Docker socket (see the gate notes above); compose drops every capability.
USER 0:0
# /v1/info with the broker's own token from its environment (never in the command line): the daemon answers too.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8090/v1/info',{headers:{authorization:'Bearer '+process.env.OCW_SANDBOX_TOKEN}}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "/app/sandboxd.mjs"]
