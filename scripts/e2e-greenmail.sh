#!/usr/bin/env bash
# Opt-in GreenMail for the isolated e2e stack (07.6-04, P-17 / P-20). scripts/e2e-isolated.sh runs it only when
# OCW_E2E_MAIL=1; it can also run alone to check the container:
#   bash scripts/e2e-greenmail.sh start   # container ocw-e2e-greenmail: IMAP 127.0.0.1:${OCW_E2E_IMAP_PORT:-4294},
#                                         # SMTP 127.0.0.1:${OCW_E2E_SMTP_PORT:-4295}; returns once IMAP greets
#   bash scripts/e2e-greenmail.sh stop    # removes that container (and nothing else)
# Same pinned image as apps/api/src/testing-mail.ts. Authentication is off, so every spec signs in as its own address
# (any password) and specs sharing one run never read each other's mail. Ports are published on loopback only, never
# 4293 (07.8's real sandboxd under --sandbox).
set -euo pipefail

IMAGE="greenmail/standalone:2.1.14@sha256:1ef95a966418cd09b7ea91d504d8c0826bbe7a2f6e679a75c601a831587c1626"
NAME=ocw-e2e-greenmail   # the ONLY container this script removes
IMAP_PORT="${OCW_E2E_IMAP_PORT:-4294}"
SMTP_PORT="${OCW_E2E_SMTP_PORT:-4295}"

# True once the IMAP port answers with its `* OK` greeting (GreenMail publishes ports before it serves them).
imap_greets() {
  (
    exec 3<>"/dev/tcp/127.0.0.1/$IMAP_PORT"
    IFS= read -r -t 2 line <&3
    [[ "$line" == "* OK"* ]]
  ) 2>/dev/null
}

case "${1:-}" in
  start)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" --label ocw.e2e=greenmail \
      -p "127.0.0.1:$IMAP_PORT:3143" -p "127.0.0.1:$SMTP_PORT:3025" \
      -e GREENMAIL_OPTS="-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled" \
      "$IMAGE" >/dev/null
    for _ in $(seq 1 60); do
      if imap_greets; then
        echo "e2e-greenmail: IMAP 127.0.0.1:$IMAP_PORT, SMTP 127.0.0.1:$SMTP_PORT"
        exit 0
      fi
      sleep 1
    done
    echo "e2e-greenmail: no IMAP greeting on 127.0.0.1:$IMAP_PORT"
    docker logs --tail 20 "$NAME" 2>&1 || true
    exit 1
    ;;
  stop)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    ;;
  *)
    echo "usage: bash scripts/e2e-greenmail.sh start|stop" >&2
    exit 2
    ;;
esac
