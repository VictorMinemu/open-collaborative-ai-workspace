# syntax=docker/dockerfile:1
# OCW OpenClaw cell: the official OpenClaw 2026.9.7 image + our channel plugin + the pinned official
# keyless search plugins (DuckDuckGo, SearXNG) + a locked-down config + the marketplace install gate.
# Build from the repo root:  docker build -f infra/openclaw/Dockerfile -t ocw-openclaw:local .
#
# Pin the image tag AND digest together; bump both deliberately and re-run the contract suite
# (apps/openclaw-channel) + infra/openclaw/test/run-container-smoke.sh.
ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:2026.9.7-slim@sha256:0da12cd49983fcb5e4915fd3135ce7a33d82f93649b1df6964946d2c1d1dbcfc

# Same base as the OpenClaw image (node:24-bookworm-slim), so layers are shared.
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
WORKDIR /src
COPY apps/openclaw-channel/package.json ./
# Exact versions in package.json; lifecycle scripts blocked; peers (openclaw) never installed.
RUN npm install --no-package-lock --legacy-peer-deps --ignore-scripts --no-audit --no-fund
COPY apps/openclaw-channel/tsconfig.json apps/openclaw-channel/tsconfig.build.json apps/openclaw-channel/openclaw.plugin.json ./
COPY apps/openclaw-channel/src ./src
# Runtime dependencies come from a committed lockfile (infra/openclaw/plugin-runtime: exact top-level pins, every
# transitive version pinned to what pnpm-lock.yaml resolved, sha512 integrity per tarball, no lifecycle scripts).
COPY infra/openclaw/plugin-runtime/package.json infra/openclaw/plugin-runtime/package-lock.json /deps/
RUN npx tsc -p tsconfig.build.json \
 && mkdir -p /out \
 && cp -r dist openclaw.plugin.json package.json /out/ \
 && cd /deps \
 && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && cp -R /deps/node_modules /out/node_modules \
 && rm -rf /out/node_modules/.package-lock.json

# Official search plugins, exact versions + sha512 integrity from bundled-plugins.json, no lifecycle
# scripts (T-03.1-SC). Network is used at build time only; the cell never installs at runtime.
COPY infra/openclaw/bundled-plugins.json infra/openclaw/install-bundled-plugins.sh /src/bundled/
RUN bash /src/bundled/install-bundled-plugins.sh /out-plugins /src/bundled/bundled-plugins.json

FROM ${OPENCLAW_IMAGE}
# Plugin code is root-owned and read-only for the gateway user (`node`).
COPY --from=build --chown=root:root /out /opt/ocw/openclaw-channel
# render-config.mjs loads /opt/ocw/plugins/<id>; a missing directory is skipped at boot, never fatal.
COPY --from=build --chown=root:root /out-plugins /opt/ocw/plugins
# install-policy.mjs is OpenClaw's `security.installPolicy` exec (D-14): OpenClaw refuses a policy script that is
# not root- or gateway-owned, is group/world-writable or sits outside trustedDirs, so it must stay root:root 0644.
COPY --chown=root:root --chmod=0644 infra/openclaw/entrypoint.mjs infra/openclaw/render-config.mjs infra/openclaw/install-policy.mjs /opt/ocw/
ENV OPENCLAW_STATE_DIR=/home/node/.openclaw \
    OPENCLAW_NO_AUTO_UPDATE=1 \
    OPENCLAW_DISABLE_BONJOUR=1 \
    OCW_PLUGIN_DIR=/opt/ocw/openclaw-channel
# State (sessions, cursor, rendered config) lives in a named volume; never a host bind mount
# (SQLite locking).
VOLUME ["/home/node/.openclaw"]
# No EXPOSE: the gateway binds loopback inside the container; nothing is published.
ENTRYPOINT ["tini", "-s", "--", "node", "/opt/ocw/entrypoint.mjs"]
CMD ["node", "openclaw.mjs", "gateway"]
