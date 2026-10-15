# syntax=docker/dockerfile:1
# OCW bot sandbox `sbx` (Phase 07.8, D-01, D-02, D-11): one container per bot, created only by `sandboxd` from its
# fixed spec (user 10001, read-only root, cap-drop ALL, no-new-privileges, init, pids/memory/CPU limits, tmpfs /tmp
# noexec, the bot's named volume at /workspace, the bot's own internal network). Build from this directory:
#   docker build -f infra/sandbox/sbx/Dockerfile -t ocw-sandbox-sbx:local infra/sandbox/sbx
# Never run it by hand with extra privileges: sandboxd is the only creator (apps/sandboxd/src/spec.ts).

# Base and packages approved at the 07.8-04 image gate (C-04, P-15): the digest-pinned Docker Official Image, the
# same base as the cell and the spikes, and Debian bookworm / bookworm-security packages only (DFSG-free).
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq python3 python3-pip python3-venv unzip xz-utils \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb

# The bot's user. /workspace exists and belongs to 10001 in the image, so a fresh named volume mounted there inherits
# that owner (Pitfall 4). /opt/ocw-packages is where approved sandbox packages are mounted read-only later (P-12).
# No setuid or setgid binary is left (no-new-privileges already neutralises them; this is defence in depth).
RUN groupadd --gid 10001 ocw \
 && useradd --uid 10001 --gid 10001 --home-dir /workspace --no-create-home --shell /bin/sh ocw \
 && mkdir -p /workspace /opt/ocw-packages \
 && chown 10001:10001 /workspace /opt/ocw-packages \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} + \
 && test -z "$(find / -xdev -type f -perm /6000 -print -quit)"

# Root-owned and read-only for the bot: the only way sandboxd runs an argv (process group record + timeout).
COPY --chmod=0755 ocw-run /usr/local/bin/ocw-run

ENV HOME=/workspace
WORKDIR /workspace
USER 10001:10001
# sandboxd always sets Cmd and Init (docker-init as PID 1); this default only keeps the container idle.
CMD ["sleep", "infinity"]
