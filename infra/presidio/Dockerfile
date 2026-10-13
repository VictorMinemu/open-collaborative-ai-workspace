# syntax=docker/dockerfile:1
# OCW Presidio analyzer for the optional `pii` profile (MEM-05, D-06, D-08, C-04): Microsoft's presidio-analyzer image
# pinned by index digest, plus the Spanish spaCy model next to the image's English one. Build from this directory:
#   docker build -t ocw-presidio:<tag> infra/presidio
# Run it only with the compose hardening (no published port, read-only root, cap_drop ALL, no-new-privileges,
# internal network shared with the api): see infra/presidio/compose.yaml. Network is used at build time only.
FROM mcr.microsoft.com/presidio-analyzer:2.2.362@sha256:286e3fa7f3a7426e775e8564fe1870f1ba8f999d3ab8bbb8cc46a44355d9d6e9

# The base runs as `presidio` (1001); installing into the system site-packages needs root for this one layer.
USER root
COPY requirements.txt /tmp/ocw-presidio-requirements.txt
# Hash-pinned wheel, no dependency resolution (spaCy 3.8 is already in the image), no cache.
RUN pip install --no-cache-dir --no-deps --require-hashes -r /tmp/ocw-presidio-requirements.txt \
 && rm /tmp/ocw-presidio-requirements.txt \
 && python -c "import spacy; spacy.load('es_core_news_md'); spacy.load('en_core_web_lg')"

COPY analyzer-config.yaml nlp-config.yaml recognizers.yaml /app/ocw-conf/
# gunicorn 25 opens a control socket in the working directory, which the read-only root refuses: not needed here.
ENV ANALYZER_CONF_FILE=/app/ocw-conf/analyzer-config.yaml \
    NLP_CONF_FILE=/app/ocw-conf/nlp-config.yaml \
    RECOGNIZER_REGISTRY_CONF_FILE=/app/ocw-conf/recognizers.yaml \
    GUNICORN_CMD_ARGS=--no-control-socket

# Back to the image's non-root user; the files above stay root-owned and read-only for it.
USER 1001
