# syntax=docker/dockerfile:1
# OCW stdio MCP sandbox (03.1-14, D-13): vetted, pinned stdio MCP servers baked at build time and exposed to the
# OpenClaw cell over streamable HTTP by bridge.mjs. Nothing third-party ever runs inside the gateway container, and
# nothing is installed at runtime. Build from this directory:
#   docker build -f infra/mcp-sandbox/Dockerfile -t ocw-mcp-sandbox:local infra/mcp-sandbox
# Run it only with the compose hardening (read-only root, cap_drop ALL, no-new-privileges, pids/memory/CPU limits,
# tmpfs /tmp, internal network): see compose.yaml service `mcp-sandbox`.

# Same base as the cell image (node:24.21.0-bookworm-slim), so layers are shared.
FROM node:24.21.0-bookworm-slim
WORKDIR /app
# Exact pins from the committed lockfile (sha512 integrity per tarball), no lifecycle scripts, no dev dependencies.
# Network is used at build time only. Everything under /app stays root-owned and read-only for the `node` user.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && rm -rf node_modules/.package-lock.json /root/.npm
COPY bridge.mjs servers.json ./
# Fail the build if an allowlisted server's entry file is not baked into the image.
RUN node bridge.mjs --check
ENV NODE_ENV=production \
    MCP_SANDBOX_PORT=8080
USER node
# No EXPOSE and no published port: only the cell reaches :8080 over the internal compose network.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "bridge.mjs"]
