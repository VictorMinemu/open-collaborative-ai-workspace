# Deterministic fake LLM for e2e/CI. No dependencies. Never part of the default profile.
# Build from the repo root: docker build -f infra/fake-model/Dockerfile -t ocw-fake-model:local .
FROM node:24.21.0-bookworm-slim
WORKDIR /app
COPY --chown=root:root infra/fake-model/server.mjs ./server.mjs
COPY --chown=root:root infra/fake-model/fake-mcp.mjs ./fake-mcp.mjs
COPY --chown=root:root infra/fake-model/fake-clawhub.mjs ./fake-clawhub.mjs
COPY --chown=root:root infra/fake-model/fake-responses.mjs ./fake-responses.mjs
COPY --chown=root:root infra/fake-model/fake-siwc.mjs ./fake-siwc.mjs
COPY --chown=root:root infra/fake-model/fixtures/clawhub ./fixtures/clawhub
USER node
ENV PORT=18999
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||18999)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.mjs"]
