#!/bin/sh
# Removes what infra/openclaw/test/run-container-smoke.sh creates (fixed names, prefix ocw-smoke) when a run was killed
# before its own EXIT trap could. Safe when nothing is left.
docker rm -fv ocw-smoke-openclaw ocw-smoke-api ocw-smoke-model ocw-smoke-mcp-sandbox >/dev/null 2>&1 || true
docker volume rm ocw-smoke-state >/dev/null 2>&1 || true
docker network rm ocw-smoke-net ocw-smoke-sbx-net >/dev/null 2>&1 || true
