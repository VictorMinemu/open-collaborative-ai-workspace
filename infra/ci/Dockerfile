# syntax=docker/dockerfile:1
# Step image for the self-hosted Woodpecker CI (.woodpecker/*.yaml). Built inside the CI's dind daemon by
# infra/ci/build-image.sh, which passes the repo's exact pins (.nvmrc, packageManager, @playwright/test).
# Contents: Node + corepack/pnpm, git, curl, the docker CLI with compose/buildx, uv (for `uvx semgrep`) and Playwright's
# Chromium with its system packages. Build context: infra/ci (nothing from the repo is copied in).
ARG NODE_VERSION=24.22.1
FROM docker:29.8.2-cli AS docker-cli
FROM ghcr.io/astral-sh/uv:0.12.23 AS uv

FROM node:${NODE_VERSION}-bookworm
ARG PNPM_VERSION=12.8.1
ARG PLAYWRIGHT_VERSION=1.64.1
LABEL ocw.ci.keep="1"
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    UV_PYTHON_INSTALL_DIR=/opt/uv-python
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/
COPY --from=uv /uv /uvx /usr/local/bin/
RUN apt-get update \
 && apt-get install -y --no-install-recommends rsync jq \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack install -g "pnpm@${PNPM_VERSION}" && pnpm --version
RUN npx --yes "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium \
 && rm -rf /root/.npm /var/lib/apt/lists/*
RUN node --version && docker --version && docker compose version && uv --version
