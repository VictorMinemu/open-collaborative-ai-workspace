# syntax=docker/dockerfile:1
# Build context: repository root.  docker build -f apps/api/Dockerfile .
FROM node:24.21.0-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

FROM base AS pruner
WORKDIR /repo
COPY . .
RUN npx --yes turbo@2.11.4 prune @ocw/api --docker

FROM base AS installer
WORKDIR /app
COPY --from=pruner /repo/out/json/ .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod
COPY --from=pruner /repo/out/full/ .

FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=installer --chown=node:node /app .
USER node
WORKDIR /app/apps/api
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/main.ts"]
