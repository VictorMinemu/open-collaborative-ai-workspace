# Spike (i), 07.8-03: throwaway browser image for the runsc / hardened-runc probe. Built only inside the nested spike
# daemon (run.sh), tagged ocw-spike-078-brw:spike, removed with that daemon. Not a product image.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production
WORKDIR /opt/probe

# playwright-core@1.63.0 (Apache-2.0, no install scripts); the build fails unless npm resolved the integrity approved at
# the 07.8-03 gate (the same one pnpm-lock.yaml carries). Then the Chromium headless shell it pins (r1243,
# 153.0.8010.12) and its Debian system dependencies.
RUN npm init -y >/dev/null \
 && npm install --ignore-scripts --no-audit --no-fund --save-exact playwright-core@1.63.0 \
 && grep -q '"integrity": "sha512-rYCsBF/M5HjUch52bbtVONEFjv6Xu8sm8h72dNlR5bzIE1fvC/bxgspzkjSfU+MweEMmPM8KJebG6nnyxo5mCg=="' package-lock.json \
 && node node_modules/playwright-core/cli.js install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm \
 && mkdir -p /workspace && chown 10001:10001 /workspace

COPY probe.mjs /opt/probe/probe.mjs
LABEL ocw.spike=07.8
USER 10001:10001
WORKDIR /workspace
ENV HOME=/workspace
CMD ["node", "/opt/probe/probe.mjs"]
