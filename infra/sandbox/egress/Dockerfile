# syntax=docker/dockerfile:1
# OCW `sandbox-egress` (Phase 07.8, D-01, D-11, SBX-03): the forward proxy that is every bot sandbox's only way out.
# It runs the second entrypoint of @ocw/sandboxd (apps/sandboxd/src/egress/main.ts) on plain Node with native type
# stripping, next to the shared @ocw/egress-policy: no npm package, no apt package, no build step. Build from the
# repository root (the root .dockerignore keeps node_modules, .git and .env files out of the context):
#   docker build -f infra/sandbox/egress/Dockerfile -t ocw-sandbox-egress:local .
# Run it only as sandboxd does (07.8-13): attached to per-bot internal networks and an egress network, never to the
# control network; `--read-only --cap-drop ALL --security-opt no-new-privileges:true --init` and a tmpfs at
# /run/ocw-egress, where the broker writes policy.json as root (`docker exec`) and then sends SIGHUP.

# The base approved at the 07.8-04 image gate and re-approved for this image at the 07.8-12 gate (C-04, P-15): the
# same digest-pinned Docker Official Image as `sbx`, with nothing added.
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

WORKDIR /app
# The workspace layout, so `@ocw/egress-policy` resolves through apps/sandboxd/node_modules to a real path outside
# node_modules (Node strips types only there). Files are root-owned and read-only for the proxy's user.
COPY packages/egress-policy/package.json packages/egress-policy/package.json
COPY packages/egress-policy/src/index.ts packages/egress-policy/src/index.ts
COPY apps/sandboxd/package.json apps/sandboxd/package.json
COPY apps/sandboxd/src/egress/main.ts apps/sandboxd/src/egress/proxy.ts apps/sandboxd/src/egress/

# The proxy's own user (not the bot's 10001). /run/ocw-egress exists for the tmpfs mount point; the tmpfs is
# root-owned 0755, so the proxy reads its policy and can never rewrite it. No setuid or setgid binary is left.
RUN mkdir -p apps/sandboxd/node_modules/@ocw /run/ocw-egress \
 && ln -s ../../../../packages/egress-policy apps/sandboxd/node_modules/@ocw/egress-policy \
 && chown -R 0:0 /app \
 && chmod -R u=rwX,go=rX /app \
 && groupadd --gid 10002 ocw-egress \
 && useradd --uid 10002 --gid 10002 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin ocw-egress \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} + \
 && test -z "$(find / -xdev -type f -perm /6000 -print -quit)"

ENV NODE_ENV=production \
    OCW_EGRESS_POLICY=/run/ocw-egress/policy.json \
    OCW_EGRESS_HOST=0.0.0.0 \
    OCW_EGRESS_PORT=3128
USER 10002:10002
EXPOSE 3128
ENTRYPOINT ["node", "/app/apps/sandboxd/src/egress/main.ts"]
