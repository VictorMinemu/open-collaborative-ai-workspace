# syntax=docker/dockerfile:1
# OCW bot sandbox `sbx` (Phase 07.8, D-01, D-02, D-11): one container per bot, created only by `sandboxd` from its
# fixed spec (user 10001, read-only root, cap-drop ALL, no-new-privileges, init, pids/memory/CPU limits, tmpfs /tmp
# noexec, the bot's named volume at /workspace, the bot's own internal network). Build from this directory:
#   docker build -f infra/sandbox/sbx/Dockerfile -t ocw-sandbox-sbx:local infra/sandbox/sbx
# Never run it by hand with extra privileges: sandboxd is the only creator (apps/sandboxd/src/spec.ts).
#
# Phase 07.17.1.1.1 (D-01, D-02, D-09; ADR-0043) adds the document toolkit: a bot reads PDFs (text and scanned, OCR in
# Spanish and English), images, Office and OpenDocument files, mail and archives without installing anything. The
# Debian set is approved before merge (07.17.1.1.1-07, PD-13) on the evidence `infra/sandbox/test/run-sbx-image-tests.sh`
# prints (the `dpkg-query -W` dump, bookworm `main` only); the root filesystem stays at most 1300 MiB (PD-16).

# Base and packages approved at the 07.8-04 image gate (C-04, P-15): the digest-pinned Docker Official Image, the
# same base as the cell and the spikes, and Debian bookworm / bookworm-security packages only (DFSG-free).
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq python3 python3-pip python3-venv unzip xz-utils \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb

# The document toolkit (07.17.1.1.1, D-02, PD-13), bookworm / bookworm-security `main` only, no recommends, in a layer
# before the setuid strip below so the strip and its assert cover it. In: poppler (pdftotext, pdftoppm, pdfinfo,
# pdfimages), qpdf, tesseract with eng + spa, LibreOffice Writer/Calc/Impress without a GUI, ImageMagick 6, 7-Zip,
# file, exiftool, catdoc, unrtf, msgconvert (.msg -> .eml) and metric-compatible fonts. Never: ghostscript, pandoc,
# Java, the Firebird or hsqldb connectors, a GStreamer backend (D-05, D-09; asserted by the image tests).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      poppler-utils qpdf tesseract-ocr tesseract-ocr-eng tesseract-ocr-spa \
      libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
      imagemagick 7zip file libimage-exiftool-perl catdoc unrtf libemail-outlook-message-perl \
      fonts-dejavu-core fonts-liberation2 fonts-crosextra-carlito fonts-crosextra-caladea \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb

# Hardening of the toolkit (D-05, D-08, PD-11, PD-12), root-owned and read-only for the bot: ImageMagick reads and
# writes raster images only (deny-all coders, no delegate, no `@file`), and LibreOffice's finalized defaults (macros
# never run, links never update) win over any user profile, including the one a bot's own `soffice` call creates.
COPY policy.xml /etc/ImageMagick-6/policy.xml
COPY ocw.xcd /usr/lib/libreoffice/share/registry/ocw.xcd

# The bot's user. /workspace exists and belongs to 10001 in the image, so a fresh named volume mounted there inherits
# that owner (Pitfall 4). /opt/ocw-packages is the bot's packages volume (read-only in `sbx`, written only by an
# installer run, 07.8-17, P-12); /staging is the scratch volume of a package review or installer run. Both belong to
# 10001 for the same reason. No setuid or setgid binary is left (no-new-privileges already neutralises them; this is
# defence in depth).
RUN groupadd --gid 10001 ocw \
 && useradd --uid 10001 --gid 10001 --home-dir /workspace --no-create-home --shell /bin/sh ocw \
 && mkdir -p /workspace /opt/ocw-packages /staging \
 && chown 10001:10001 /workspace /opt/ocw-packages /staging \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} + \
 && test -z "$(find / -xdev -type f -perm /6000 -print -quit)"

# Root-owned and read-only for the bot: the only way sandboxd runs an argv (process group record + timeout), and the
# only way it touches workspace files (realpath-confined to /workspace, run as 10001; never the archive API).
COPY --chmod=0755 ocw-run /usr/local/bin/ocw-run
COPY --chmod=0755 ocw-files /usr/local/bin/ocw-files

# sandboxd sets the whole environment of every container it creates (spec.ts SHELL_ENV); this default only keeps a
# hand-run container in the same order: the document toolkit (07.17.1.1.1, D-03) and then approved package bins after
# the system paths, never before them; Python finds the toolkit's venv before approved packages.
ENV HOME=/workspace \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/ocw-tools/bin:/opt/ocw-packages/bin \
    NODE_PATH=/opt/ocw-packages/node_modules \
    PYTHONPATH=/opt/ocw-tools/venv/lib/python3.11/site-packages:/opt/ocw-packages/python
WORKDIR /workspace
USER 10001:10001
# sandboxd always sets Cmd and Init (docker-init as PID 1); this default only keeps the container idle.
CMD ["sleep", "infinity"]
