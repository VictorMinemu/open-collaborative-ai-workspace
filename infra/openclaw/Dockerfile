# syntax=docker/dockerfile:1
# OCW OpenClaw cell: the official OpenClaw 2026.9.7 image + our channel plugin + a locked-down config.
# Build from the repo root:  docker build -f infra/openclaw/Dockerfile -t ocw-openclaw:local .
#
# Pin the image tag AND digest together; bump both deliberately and re-run the contract suite
# (apps/openclaw-channel) + infra/openclaw/test/run-container-smoke.sh.
ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:2026.9.7-slim@sha256:0da12cd49983fcb5e4915fd3135ce7a33d82f93649b1df6964946d2c1d1dbcfc

# Same base as the OpenClaw image (node:24-bookworm-slim), so layers are shared.
FROM node:24.21.0-bookworm-slim AS build
WORKDIR /src
COPY apps/openclaw-channel/package.json ./
# Exact versions in package.json; lifecycle scripts blocked; peers (openclaw) never installed.
RUN npm install --no-package-lock --legacy-peer-deps --ignore-scripts --no-audit --no-fund
COPY apps/openclaw-channel/tsconfig.json apps/openclaw-channel/tsconfig.build.json apps/openclaw-channel/openclaw.plugin.json ./
COPY apps/openclaw-channel/src ./src
RUN npx tsc -p tsconfig.build.json \
 && mkdir -p /out \
 && cp -r dist openclaw.plugin.json package.json /out/ \
 && cd /out \
 && npm install --omit=dev --omit=peer --no-package-lock --legacy-peer-deps --ignore-scripts --no-audit --no-fund \
 && rm -rf /out/node_modules/.package-lock.json

FROM ${OPENCLAW_IMAGE}
# Plugin code is root-owned and read-only for the gateway user (`node`).
COPY --from=build --chown=root:root /out /opt/ocw/openclaw-channel
COPY --chown=root:root infra/openclaw/entrypoint.mjs infra/openclaw/render-config.mjs /opt/ocw/
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
