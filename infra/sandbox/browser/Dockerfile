# OCW bot browser (`brw`, 07.8-07, D-05, D-11, D-14): one Chromium per bot, driven by agent.mjs over a pipe (no
# debugging port) and spoken to only by sandboxd over the container's stdio. Build from this directory:
#   docker build -t ocw-sandbox-brw:local infra/sandbox/browser
# Run it only with sandboxd's spec (or run-browser-smoke.sh): user 10001, read-only root, CapDrop ALL,
# no-new-privileges, Docker init, pids/memory/CPU limits, tmpfs /tmp, ShmSize 512 MiB, a per-bot internal network, no
# published port, no host IPC. Under runsc, Chromium keeps its own sandbox; on hardened runc, seccomp.json (Docker's
# default + user-namespace clone) lets it start, and a host that restricts unprivileged user namespaces gets the
# reported `container-only` fallback (spike i, ADR-0029).
#
# Every input is pinned and checked at build time (07.8-07 package gate):
#   - base image by digest;
#   - playwright-core@1.64.1 from the committed lockfile, its npm sha512 integrity asserted;
#   - the Chrome for Testing headless shell of the current Chrome stable, 156.0.8078.47 (Google's official bucket,
#     verified by sha256). playwright-core 1.64.1 is built against Chromium 156.0.8078.4 (revision 1248), a 156 beta;
#     the stable build of the same milestone and branch carries the security fixes the beta lacks (07.8 hardening).
#     The build asserts that the agent's playwright-core targets this milestone and branch (156.0.8078.x).
#   - Debian packages: playwright-core's `install-deps chromium` list without `xvfb` (headless shell needs no X server),
#     refused unless apt resolves every package from Debian 12 (bookworm / bookworm-security).
ARG BASE=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ARG TARGETARCH

FROM ${BASE} AS base

FROM base AS chromium-amd64
ADD --checksum=sha256:0d5acc62c3e213f8c87d3c298d66ffcf9a236d12ea4b9f85318bf85dbc279daa \
    https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.47/linux64/chrome-headless-shell-linux64.zip /chromium.zip

FROM base AS chromium-arm64
ADD --checksum=sha256:955059fa7020d7be85eb503e21339fd4d718f51f5996d3b60633fbf908bda132 \
    https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.47/linux-arm64/chrome-headless-shell-linux-arm64.zip /chromium.zip

FROM chromium-${TARGETARCH} AS chromium-zip

FROM base AS agent
WORKDIR /app
COPY package.json package-lock.json ./
# Exact pin, sha512 integrity per tarball, no lifecycle scripts, no dev dependencies; network at build time only.
RUN grep -q '"integrity": "sha512-BC4s8y6SEVA6Q1rSxZTto8hI1KUI3xXlHGZgvGqP4IqPdI/a6FX9H29IDNz7vKo9l21b6LfYosScPL6M3xxyDQ=="' package-lock.json \
 && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && rm -rf node_modules/.package-lock.json /root/.npm
COPY unzip.mjs ./
RUN --mount=type=bind,from=chromium-zip,source=/chromium.zip,target=/tmp/chromium.zip \
    node unzip.mjs /tmp/chromium.zip /opt/chromium \
 && test "$(node -p 'JSON.parse(require("fs").readFileSync("node_modules/playwright-core/browsers.json", "utf8")).browsers.find((b) => b.name === "chromium-headless-shell").browserVersion.split(".").slice(0, 3).join(".")')" = 156.0.8078

FROM base
# Only Debian 12 sources, then only Debian 12 origins for every package apt would install (the gate's condition).
RUN set -eu \
 && test ! -s /etc/apt/sources.list \
 && test "$(ls /etc/apt/sources.list.d)" = debian.sources \
 && test "$(grep -hE '^(URIs|Suites):' /etc/apt/sources.list.d/debian.sources | tr -s ' ' | tr '\n' '|')" = \
      "URIs: http://deb.debian.org/debian|Suites: bookworm bookworm-updates|URIs: http://deb.debian.org/debian-security|Suites: bookworm-security|" \
 && PKGS="libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 \
      libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
      libxkbcommon0 libxrandr2 fonts-noto-color-emoji fonts-unifont libfontconfig1 libfreetype6 xfonts-scalable \
      fonts-liberation fonts-ipafont-gothic fonts-wqy-zenhei fonts-tlwg-loma-otf fonts-freefont-ttf" \
 && apt-get update \
 && apt-get install -s --no-install-recommends $PKGS > /tmp/apt-plan.txt \
 && node -e ' \
      const lines = require("fs").readFileSync("/tmp/apt-plan.txt", "utf8").split("\n").filter((l) => l.startsWith("Inst ")); \
      const bad = lines.filter((l) => { \
        const m = /^Inst (\S+) (?:\[[^\]]*\] )?\((\S+) ([^\[]+)\[/.exec(l); \
        return !m || !m[3].trim().split(", ").every((o) => /^(Debian|Debian-Security):12(\.\d+)?\//.test(o)); \
      }); \
      if (lines.length === 0 || bad.length > 0) { console.error("not from bookworm:\n" + bad.join("\n")); process.exit(1); } \
      console.log(`${lines.length} packages, all from Debian 12`);' \
 && apt-get install -y --no-install-recommends $PKGS \
 && rm -rf /var/lib/apt/lists/* /tmp/apt-plan.txt \
 && groupadd -g 10001 ocw && useradd -u 10001 -g 10001 -M -d /tmp -s /usr/sbin/nologin ocw

COPY --from=agent /opt/chromium /opt/chromium
COPY --from=agent /app/node_modules /app/node_modules
COPY package.json agent.mjs redact.mjs capture.mjs /app/
ENV NODE_ENV=production \
    HOME=/tmp \
    OCW_BROWSER_EXECUTABLE=/opt/chromium/chrome-headless-shell \
    OCW_BROWSER_PROXY= \
    OCW_BROWSER_CHROMIUM_SANDBOX=on
# Fail the build if the agent cannot load or Chromium is missing.
RUN node /app/agent.mjs --check
LABEL org.opencontainers.image.title="ocw-sandbox-brw" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
USER 10001:10001
WORKDIR /tmp
# No EXPOSE: the agent speaks only over stdio; Chromium is driven over a pipe.
ENTRYPOINT ["node", "/app/agent.mjs"]
