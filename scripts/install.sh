#!/usr/bin/env bash
# One-command server install of Open Collaborative AI Workspace (self-hosted, docs/INSTALL.md).
#
#   curl -fsSL https://raw.githubusercontent.com/VictorMinemu/open-collaborative-ai-workspace/main/scripts/install.sh \
#     | sudo bash -s -- --domain ocw.example.com
#   sudo ./scripts/install.sh --domain ocw.example.com      # from a checkout: installs that checkout in place
#
# What it does, in order (re-running it is safe: it never overwrites .env or rotates a secret):
#   1. checks the host (Linux x86_64/arm64, RAM, disk) and installs git, curl and Docker Engine with the Compose
#      plugin from Docker's apt repository when they are missing (Ubuntu and Debian; elsewhere install Docker first);
#   2. clones the repository into --dir (default /opt/ocw), or uses the checkout it runs from;
#   3. runs `ocw setup` (every secret generated on this host, never printed) or `ocw setup --add-missing`;
#   4. puts the instance behind Caddy on one HTTPS origin (`ocw enable proxy`): a DNS name gets a Let's Encrypt
#      certificate, an IPv4 address gets Caddy's internal CA;
#   5. builds and starts the stack (`docker compose up -d --build --wait`) and prints the next steps.
# Node 24 (the `ocw` operator tool: setup, enable, backup, restore) is installed from nodejs.org's pinned release,
# checksum-verified, when the host has no Node 24.
#
# Options:
#   --domain <host>     DNS name (A/AAAA record to this server, ports 80 and 443 open) or IPv4 address. Required,
#                       except with --local.
#   --tls internal      Caddy's own CA even for a DNS name (internal names); clients must trust its root.
#   --local             no proxy: http://localhost:3000 on this machine only (a laptop trial, not for a team).
#   --dir <path>        install directory when cloning (default /opt/ocw).
#   --ref <git ref>     branch or tag to clone (default the newest vX.Y.Z release, else main).
#   --repo <url>        repository to clone (default the upstream GitHub repository).
#   --ports <NN> --project <name> --image-tag <tag>
#                       a second instance on the same host (passed to `ocw setup` on the first run; docs/INSTALL.md).
#   --no-docker-install never install Docker; fail if it is missing.
#   --prepare-only      stop after installing the prerequisites (git, curl, Docker, Node 24); nothing is cloned.
#   --dry-run           print what would run, change nothing.
#   -h, --help          this help.
set -euo pipefail
ORIG_ARGS=("$@")

REPO_URL="https://github.com/VictorMinemu/open-collaborative-ai-workspace.git"
REF=""
DIR="/opt/ocw"
DOMAIN=""
TLS=""
LOCAL=0
INSTALL_DOCKER=1
PREPARE_ONLY=0
DRY_RUN=0
DIR_SET=0
SETUP_ARGS=()
IMAGE_TAG_SET=0

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'EOF'
Usage: install.sh --domain <host> [--tls internal] [--dir /opt/ocw] [--ref main] [--repo <url>]
       install.sh --local | --prepare-only | --dry-run | --help

  --domain <host>     DNS name pointing at this server (Let's Encrypt) or its IPv4 address (Caddy's internal CA)
  --tls internal      Caddy's internal CA even for a DNS name
  --local             no proxy: http://localhost:3000 on this machine only (a trial, not for a team)
  --dir <path>        install directory when cloning (default /opt/ocw)
  --ref <git ref>     branch or tag to clone (default the newest release, else main)
  --repo <url>        repository to clone (default the upstream GitHub repository)
  --ports <NN> --project <name> --image-tag <tag>
                      a second instance on this host (passed to ocw setup on the first run)
  --no-docker-install never install Docker; fail if it is missing
  --prepare-only      only install the prerequisites (git, curl, Docker, Node 24)
  --dry-run           print what would run, change nothing

Re-running is safe: .env is never overwritten and no secret is rotated. Guide: docs/INSTALL.md
EOF
}
run() {
  if [[ $DRY_RUN -eq 1 ]]; then printf '    [dry-run] %s\n' "$*"; else "$@"; fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --domain=*) DOMAIN="${1#*=}"; shift ;;
    --tls) TLS="${2:-}"; shift 2 ;;
    --tls=*) TLS="${1#*=}"; shift ;;
    --local) LOCAL=1; shift ;;
    --dir) DIR="${2:-}"; DIR_SET=1; shift 2 ;;
    --dir=*) DIR="${1#*=}"; DIR_SET=1; shift ;;
    --ref) REF="${2:-}"; shift 2 ;;
    --ref=*) REF="${1#*=}"; shift ;;
    --repo) REPO_URL="${2:-}"; shift 2 ;;
    --repo=*) REPO_URL="${1#*=}"; shift ;;
    --image-tag) IMAGE_TAG_SET=1; SETUP_ARGS+=("$1" "${2:-}"); shift 2 ;;
    --ports | --project) SETUP_ARGS+=("$1" "${2:-}"); shift 2 ;;
    --no-docker-install) INSTALL_DOCKER=0; shift ;;
    --prepare-only) PREPARE_ONLY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

# --- Arguments -------------------------------------------------------------------------------------------------------
LABEL='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
if [[ $PREPARE_ONLY -eq 0 ]]; then
  if [[ $LOCAL -eq 1 && -n "$DOMAIN" ]]; then die "--local and --domain exclude each other"; fi
  if [[ $LOCAL -eq 0 && -z "$DOMAIN" ]]; then
    die "--domain <host> is required (a DNS name pointing at this server, or its IPv4 address); --local for a trial on this machine only"
  fi
  if [[ -n "$DOMAIN" ]]; then
    DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')"
    [[ "$DOMAIN" =~ ^${LABEL}(\.${LABEL})*$ && ${#DOMAIN} -le 253 ]] ||
      die "--domain takes a bare host name or IPv4 address (no scheme, port or path): $DOMAIN"
  fi
  if [[ -n "$TLS" && "$TLS" != "internal" ]]; then die "--tls only takes 'internal'"; fi
  if [[ -n "$TLS" && $LOCAL -eq 1 ]]; then die "--tls needs --domain"; fi
fi
[[ -n "$DIR" && "$DIR" == /* ]] || die "--dir must be an absolute path: $DIR"

# Root on Linux (package installs, Docker, /opt): re-run under sudo when started as a user from a file. A laptop trial
# on macOS (--local) runs as the user, with Docker Desktop and Node already installed.
if [[ $DRY_RUN -eq 0 && $(id -u) -ne 0 && "$(uname -s)" == "Linux" ]]; then
  if [[ -f "${BASH_SOURCE[0]:-}" ]] && command -v sudo >/dev/null 2>&1; then
    say "Re-running with sudo"
    exec sudo -- bash "${BASH_SOURCE[0]}" "${ORIG_ARGS[@]}"
  fi
  die "run as root (pipe into 'sudo bash -s -- …')"
fi

# --- 1. Host checks --------------------------------------------------------------------------------------------------
say "Checking the host"
OS_ID="unknown"
OS_LIKE=""
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-unknown}"
  OS_LIKE="${ID_LIKE:-}"
fi
KERNEL="$(uname -s)"
ARCH="$(uname -m)"
note "system: $KERNEL $ARCH ($OS_ID)"
if [[ "$KERNEL" != "Linux" ]]; then
  warn "this installer targets Linux servers; on $KERNEL install Docker yourself and follow docs/INSTALL.md (or use --local)"
fi
case "$ARCH" in x86_64 | amd64 | aarch64 | arm64) ;; *) warn "untested architecture: $ARCH" ;; esac
if [[ -r /proc/meminfo ]]; then
  MEM_MB=$(($(awk '/^MemTotal:/ {print $2}' /proc/meminfo) / 1024))
  note "memory: ${MEM_MB} MB"
  [[ $MEM_MB -ge 3800 ]] || warn "4 GB RAM is the minimum (8 GB recommended); the first build may fail with less"
fi

APT=0
if command -v apt-get >/dev/null 2>&1 && [[ "$OS_ID" == "ubuntu" || "$OS_ID" == "debian" || "$OS_LIKE" == *debian* ]]; then
  APT=1
fi

LOG="/var/log/ocw-install.log"
# Package output goes to $LOG; its tail is shown when a step fails.
quiet() {
  if [[ $DRY_RUN -eq 1 ]]; then printf '    [dry-run] %s\n' "$*"; return 0; fi
  "$@" >>"$LOG" 2>&1 || { tail -n 25 "$LOG" >&2; die "'$*' failed (full log: $LOG)"; }
}
apt_install() { quiet env DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$@"; }
apt_update() { quiet apt-get update -q; }

# --- 1b. Prerequisites: git, curl, Docker Engine + Compose ----------------------------------------------------------
NEED=()
command -v git >/dev/null 2>&1 || NEED+=(git)
command -v curl >/dev/null 2>&1 || NEED+=(curl)
if [[ ${#NEED[@]} -gt 0 ]]; then
  [[ $APT -eq 1 ]] || die "missing ${NEED[*]}: install them, then re-run"
  say "Installing ${NEED[*]}"
  apt_update
  apt_install ca-certificates "${NEED[@]}"
fi

docker_ok() { command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; }
if ! docker_ok; then
  [[ $INSTALL_DOCKER -eq 1 ]] || die "Docker Engine with the Compose plugin is missing (--no-docker-install was given)"
  [[ $APT -eq 1 ]] || die "Docker is missing: install Docker Engine and the Compose plugin (https://docs.docker.com/engine/install/), then re-run"
  DOCKER_DISTRO="$OS_ID"
  [[ "$DOCKER_DISTRO" == "ubuntu" || "$DOCKER_DISTRO" == "debian" ]] || DOCKER_DISTRO="debian"
  say "Installing Docker Engine and the Compose plugin from Docker's apt repository ($DOCKER_DISTRO)"
  apt_update
  apt_install ca-certificates curl gnupg
  run install -m 0755 -d /etc/apt/keyrings
  run curl -fsSL "https://download.docker.com/linux/${DOCKER_DISTRO}/gpg" -o /etc/apt/keyrings/docker.asc
  run chmod a+r /etc/apt/keyrings/docker.asc
  CODENAME="${VERSION_CODENAME:-}"
  [[ -n "$CODENAME" || $DRY_RUN -eq 1 ]] || die "cannot read VERSION_CODENAME from /etc/os-release"
  LIST="deb [arch=$(dpkg --print-architecture 2>/dev/null || echo amd64) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${DOCKER_DISTRO} ${CODENAME} stable"
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '    [dry-run] write /etc/apt/sources.list.d/docker.list: %s\n' "$LIST"
  else
    printf '%s\n' "$LIST" >/etc/apt/sources.list.d/docker.list
  fi
  apt_update
  apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  if [[ -d /run/systemd/system ]]; then
    quiet systemctl enable --now docker
  elif command -v service >/dev/null 2>&1; then
    run service docker start || warn "could not start the Docker daemon: start it, then re-run"
  fi
  [[ $DRY_RUN -eq 1 ]] || docker_ok || die "Docker was installed but 'docker compose version' still fails"
fi
if [[ $DRY_RUN -eq 0 ]]; then
  note "docker: $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?'), compose: $(docker compose version --short 2>/dev/null || echo '?')"
fi

# Node 24 for the `ocw` operator tool (setup, enable proxy, backup, restore use only Node's built-ins).
NODE_PIN="24.22.1"
node_ok() { command -v node >/dev/null 2>&1 && [[ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 24 ]]; }
if ! node_ok; then
  [[ "$KERNEL" == "Linux" ]] || die "Node 24 is missing: install it (https://nodejs.org), then re-run"
  case "$ARCH" in x86_64 | amd64) NARCH=x64 ;; aarch64 | arm64) NARCH=arm64 ;; *) die "no Node build for $ARCH" ;; esac
  if ! command -v xz >/dev/null 2>&1; then
    [[ $APT -eq 1 ]] || die "xz is missing: install it, then re-run"
    apt_install xz-utils
  fi
  NODE_DIST="node-v${NODE_PIN}-linux-${NARCH}"
  say "Installing Node ${NODE_PIN} from nodejs.org (checksum-verified) into /usr/local/lib/nodejs"
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '    [dry-run] download %s.tar.xz, verify SHASUMS256.txt, link node/npm/npx/corepack into /usr/local/bin\n' "$NODE_DIST"
  else
    TMP="$(mktemp -d)"
    curl -fsSL "https://nodejs.org/dist/v${NODE_PIN}/${NODE_DIST}.tar.xz" -o "$TMP/${NODE_DIST}.tar.xz"
    curl -fsSL "https://nodejs.org/dist/v${NODE_PIN}/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
    (cd "$TMP" && grep " ${NODE_DIST}.tar.xz\$" SHASUMS256.txt | sha256sum -c --status) || die "Node download failed its checksum"
    install -d /usr/local/lib/nodejs
    tar -xJf "$TMP/${NODE_DIST}.tar.xz" -C /usr/local/lib/nodejs
    for b in node npm npx corepack; do ln -sf "/usr/local/lib/nodejs/${NODE_DIST}/bin/$b" "/usr/local/bin/$b"; done
    rm -rf "$TMP"
    hash -r
    node_ok || die "Node was installed but is not usable"
  fi
fi
[[ $DRY_RUN -eq 1 ]] || note "node: $(node --version)"

if [[ $PREPARE_ONLY -eq 1 ]]; then
  say "Prerequisites are ready (--prepare-only): nothing was cloned or started"
  exit 0
fi

# --- 2. The checkout -------------------------------------------------------------------------------------------------
SELF="${BASH_SOURCE[0]:-}"
if [[ $DIR_SET -eq 0 && -n "$SELF" && -f "$SELF" && -f "$(cd "$(dirname "$SELF")/.." && pwd)/compose.yaml" ]]; then
  DIR="$(cd "$(dirname "$SELF")/.." && pwd)"
  say "Using this checkout: $DIR"
elif [[ -f "$DIR/compose.yaml" && -d "$DIR/.git" ]]; then
  say "Using the existing checkout in $DIR (not updated here: upgrade with node scripts/ocw.mjs upgrade)"
else
  [[ ! -e "$DIR" || -z "$(ls -A "$DIR" 2>/dev/null)" ]] || die "$DIR exists and is not an install of this project; choose another --dir"
  if [[ -z "$REF" ]]; then
    # The newest stable release (vX.Y.Z, no pre-release); main until one is published. `ocw upgrade` moves between them.
    REF="$(git ls-remote --tags --refs "$REPO_URL" 'v*' 2>/dev/null | sed 's#.*refs/tags/##' |
      grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1 || true)"
    REF="${REF:-main}"
  fi
  say "Cloning $REPO_URL ($REF) into $DIR"
  # A server needs no planning history (.planning/ is most of the tree): a sparse, blobless clone skips it, and later
  # `git pull` / `git checkout <tag>` upgrades keep the same sparse set.
  run git clone --quiet --depth 1 --branch "$REF" --filter=blob:none --sparse "$REPO_URL" "$DIR"
  run git -C "$DIR" sparse-checkout set --no-cone '/*' '!/.planning/'
fi

if [[ $DRY_RUN -eq 0 ]]; then
  FREE_GB=$(($(df -Pk "$DIR" | awk 'NR==2 {print $4}') / 1024 / 1024))
  note "free disk in $DIR: ${FREE_GB} GB"
  [[ $FREE_GB -ge 15 ]] || warn "20 GB free is recommended for the images, the build cache and the data"
fi

# The ocw operator tool (scripts/ocw.mjs) uses only Node's built-ins: no pnpm install on the server.
ocw() { run node -- "$DIR/scripts/ocw.mjs" "$@"; }

# --- 3. Secrets ------------------------------------------------------------------------------------------------------
if [[ -f "$DIR/.env" ]]; then
  say "Keeping the existing .env (adding only missing keys; nothing is rotated)"
  ocw setup --add-missing
else
  say "Generating .env with fresh secrets (written with mode 0600, never printed)"
  # A release's images are tagged with it, so `ocw upgrade` keeps the previous release's images for a rollback.
  if [[ $IMAGE_TAG_SET -eq 0 && "$REF" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then SETUP_ARGS+=(--image-tag "$REF"); fi
  ocw setup "${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"}"
fi

# --- 4. HTTPS through Caddy ------------------------------------------------------------------------------------------
if [[ $LOCAL -eq 0 ]]; then
  if command -v ss >/dev/null 2>&1 && [[ $DRY_RUN -eq 0 ]]; then
    BUSY="$(ss -Hltn '( sport = :80 or sport = :443 )' 2>/dev/null | grep -v docker-proxy || true)"
    if [[ -n "$BUSY" ]] && ! docker ps --format '{{.Names}}' | grep -q caddy; then
      warn "ports 80/443 are already in use on this host; Caddy needs them (stop the other web server or see docs/self-hosting/reverse-proxy.md)"
    fi
  fi
  say "Serving https://$DOMAIN through Caddy"
  if [[ "$DOMAIN" =~ ^[0-9.]+$ || "$DOMAIN" == localhost || "$TLS" == "internal" ]]; then
    note "certificate: Caddy's internal CA (browsers warn until its root is trusted; see the summary below)"
  else
    note "certificate: Let's Encrypt (the DNS record must point here and ports 80/443 must be reachable)"
  fi
  if [[ -n "$TLS" ]]; then
    ocw enable proxy --site-address "$DOMAIN" --tls "$TLS" --no-up
  else
    ocw enable proxy --site-address "$DOMAIN" --no-up
  fi
fi

# --- 5. Build and start ----------------------------------------------------------------------------------------------
say "Building and starting the stack (first run: 10-20 minutes)"
note "'pull access denied for ocw-…' lines are expected: those images are built here"
if [[ $DRY_RUN -eq 1 ]]; then
  printf '    [dry-run] (cd %s && docker compose up -d --build --wait)\n' "$DIR"
else
  (cd "$DIR" && docker compose up -d --build --wait) ||
    die "docker compose up failed; read 'docker compose logs' in $DIR, fix it and re-run this installer (it resumes)"
fi

# --- Summary ---------------------------------------------------------------------------------------------------------
env_get() { [[ -f "$DIR/.env" ]] && sed -n "s/^$1=//p" "$DIR/.env" | tail -n 1; }
URL="$(env_get OCW_PUBLIC_WEB_URL || true)"
if [[ -z "$URL" ]]; then
  if [[ $LOCAL -eq 1 ]]; then URL="http://localhost:3000"; else URL="https://$DOMAIN"; fi
fi
cat <<EOF

$(printf '\033[1m')Open Collaborative AI Workspace is running.$(printf '\033[0m')

  1. Read the one-time setup token on this server:
       sudo grep '^OCW_SETUP_TOKEN=' "$DIR/.env"
  2. Open $URL/setup, paste the token and create the organization and the first admin.
  3. Settings › Models: add a provider key (OpenAI, Anthropic, OpenRouter or any OpenAI-compatible endpoint).
  4. Settings › Members: create invite links for your team (they are links you send; no email is needed).

  Operate it from "$DIR":  docker compose ps | logs -f api | down
  Back up:               cd "$DIR" && node scripts/ocw.mjs backup   (docs/self-hosting/backup-restore.md)
  Upgrade:               cd "$DIR" && sudo node scripts/ocw.mjs upgrade   (backup, newest release, rebuild)
  Operator tool:         cd "$DIR" && node scripts/ocw.mjs help
  Guide:                 "$DIR/docs/INSTALL.md"
EOF
if [[ $LOCAL -eq 0 && ( "$DOMAIN" =~ ^[0-9.]+$ || "$DOMAIN" == localhost || "$TLS" == "internal" ) ]]; then
  cat <<EOF

  Internal certificate: copy Caddy's root to each client and trust it:
       cd "$DIR" && docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./ocw-root.crt
EOF
fi
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active" && [[ $LOCAL -eq 0 ]]; then
  printf '\n  ufw is active: allow the proxy with  sudo ufw allow 80,443/tcp\n'
fi
