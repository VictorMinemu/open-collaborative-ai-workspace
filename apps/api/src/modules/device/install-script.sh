#!/bin/sh
# Open Collaborative AI Workspace: the Local Runtime installer (ocw-runtime), served by your workspace.
#
# It installs ocw-runtime for the current user only:
#   - downloads the runtime bundle from your workspace and verifies its SHA-256 with node before using it;
#   - installs the Claude Agent SDK, its peers and their whole dependency tree beside it from your npm registry with
#     `npm ci`, from the lockfile below (exact versions, each tarball checked against its integrity), without
#     running any package install script;
#   - writes only under $OCW_HOME (default ~/.ocw) and the launcher ~/.local/bin/ocw-runtime.
# It never asks for elevated rights, never changes system files and runs nothing it downloads except the verified
# bundle. The whole body runs from main(), called on the last line, so a truncated download does nothing.
#
# Environment: OCW_SERVER_URL (download from another origin, e.g. inside a container), OCW_HOME (default ~/.ocw),
# OCW_INSTALL_ALLOW_HTTP=1 (allow plain http to a host other than this machine, on a network you trust).
set -eu
umask 077

OCW_EMBEDDED_SERVER=@SERVER_URL@
OCW_VERSION=@VERSION@
OCW_SHA256=@SHA256@
OCW_SHA12=@SHA12@
OCW_MIN_NODE=@MIN_NODE@
OCW_BUNDLE_ROUTE=@BUNDLE_ROUTE@
OCW_BUNDLE_FILE=@BUNDLE_FILE@
OCW_SDK_PACKAGE=@SDK_PACKAGE@
OCW_LOCK_FILE=@LOCK_FILE@

say() { printf '%s\n' "$*"; }
warn() { printf 'ocw-runtime install: warning: %s\n' "$*" >&2; }
die() {
  printf 'ocw-runtime install: %s\n' "$*" >&2
  exit 1
}

# Prints its argument single-quoted for sh (each ' inside becomes '\'').
shq() {
  _rest=$1
  _out=
  while :; do
    case $_rest in
      *"'"*)
        _out="$_out${_rest%%"'"*}'\\''"
        _rest=${_rest#*"'"}
        ;;
      *) break ;;
    esac
  done
  printf "'%s%s'" "$_out" "$_rest"
}

# The host of an http(s) URL (no port, no path).
host_of() {
  _h=${1#*://}
  _h=${_h%%/*}
  printf '%s' "${_h%%:*}"
}

is_loopback() {
  case $1 in
    localhost | 127.*) return 0 ;;
  esac
  return 1
}

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --proto '=https,http' -o "$2" "$1"
  else
    wget -q -O "$2" "$1"
  fi
}

sha256_of() {
  "$node_bin" -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "$1"
}

# Writes the package.json and the lockfile `npm ci` installs from into $1 (quoted heredocs: nothing is expanded).
write_npm_files() {
  cat >"$1/package.json" <<'OCW_PACKAGE_JSON'
@PACKAGE_JSON@
OCW_PACKAGE_JSON
  cat >"$1/$OCW_LOCK_FILE" <<'OCW_EXTERNAL_LOCK'
@EXTERNAL_LOCK@
OCW_EXTERNAL_LOCK
}

cleanup() {
  if [ -n "${building:-}" ]; then rm -rf "$building"; fi
  if [ -n "${tmp:-}" ]; then rm -rf "$tmp"; fi
}

main() {
  tmp=
  building=

  # 1. Where to download from: the workspace this script came from, or OCW_SERVER_URL.
  server=${OCW_SERVER_URL:-$OCW_EMBEDDED_SERVER}
  server=${server%/}
  case $server in
    *[!A-Za-z0-9.:/_-]*) die "the server URL may contain only letters, digits and . : / _ -" ;;
  esac
  host=$(host_of "$server")
  [ -n "$host" ] || die "the server URL has no host"
  case $server in
    https://*) ;;
    http://*)
      if ! is_loopback "$host" && [ "${OCW_INSTALL_ALLOW_HTTP:-}" != 1 ]; then
        die "refusing plain http to a non-loopback host ($host): anyone on the network could change what is installed. Use https, or set OCW_INSTALL_ALLOW_HTTP=1 on a network you trust."
      fi
      ;;
    *) die "the server URL must start with https:// or http://" ;;
  esac

  # 2. This machine: system, account, node, npm and a downloader. Nothing is written before these pass.
  os=$(uname -s)
  case $os in
    Linux | Darwin) ;;
    *) die "unsupported system $os: the Local Runtime runs on Linux and macOS" ;;
  esac
  if [ "$(id -u)" = 0 ]; then
    warn "running as root installs the runtime for root only. Run this script as the account that will run the runtime."
  fi
  command -v node >/dev/null 2>&1 ||
    die "Node $OCW_MIN_NODE or later is required and node was not found. Install it from https://nodejs.org or your package manager, then re-run."
  node_bin=$(command -v node)
  case $node_bin in
    /*) ;;
    *) node_bin=$(node -p 'process.execPath') ;;
  esac
  node_version=$("$node_bin" -p 'process.versions.node' 2>/dev/null) || node_version=unknown
  node_major=${node_version%%.*}
  case $node_major in
    '' | *[!0-9]*) node_major=0 ;;
  esac
  if [ "$node_major" -lt "$OCW_MIN_NODE" ]; then
    die "Node $OCW_MIN_NODE or later is required (found $node_version). Install it from https://nodejs.org or your package manager, then re-run."
  fi
  command -v npm >/dev/null 2>&1 ||
    die "npm is required to install the Claude Agent SDK beside the runtime, and it was not found. Install Node $OCW_MIN_NODE with npm (https://nodejs.org), then re-run."
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    die "curl or wget is required to download the runtime"
  fi

  ocw_home=${OCW_HOME:-$HOME/.ocw}
  case $ocw_home in
    /*) ;;
    *) die "OCW_HOME must be an absolute path" ;;
  esac
  runtime_dir=$ocw_home/runtime
  version_dir=$runtime_dir/versions/$OCW_SHA12
  bin_dir=$HOME/.local/bin
  shim=$bin_dir/ocw-runtime

  # 3. Download and verify, in a temporary directory removed on exit.
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP
  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t ocw-runtime)
  say "Downloading ocw-runtime $OCW_VERSION from $server"
  fetch "$server$OCW_BUNDLE_ROUTE" "$tmp/$OCW_BUNDLE_FILE" ||
    die "could not download the runtime from $server$OCW_BUNDLE_ROUTE"
  actual=$(sha256_of "$tmp/$OCW_BUNDLE_FILE") || die "could not compute the checksum of the download"
  if [ "$actual" != "$OCW_SHA256" ]; then
    die "checksum mismatch: expected $OCW_SHA256, got $actual. Nothing was installed; download the script again from your workspace."
  fi

  # 4. Install into versions/<sha12> with the SDK beside the bundle (reused when that version is already complete).
  had_install=false
  if [ -f "$runtime_dir/install.json" ]; then had_install=true; fi
  previous=
  if [ -L "$runtime_dir/current" ]; then
    previous=$(readlink "$runtime_dir/current" || true)
    previous=${previous##*/}
  fi
  mkdir -p "$runtime_dir/versions"
  if [ -f "$version_dir/$OCW_BUNDLE_FILE" ] &&
    [ -f "$version_dir/node_modules/$OCW_SDK_PACKAGE/package.json" ] &&
    [ -f "$version_dir/$OCW_LOCK_FILE" ] &&
    [ "$(sha256_of "$version_dir/$OCW_BUNDLE_FILE")" = "$OCW_SHA256" ]; then
    say "ocw-runtime $OCW_VERSION is already installed; reusing it"
  else
    rm -rf "$version_dir"
    building=$version_dir
    mkdir "$version_dir"
    mv "$tmp/$OCW_BUNDLE_FILE" "$version_dir/$OCW_BUNDLE_FILE"
    write_npm_files "$version_dir"
    say "Installing $OCW_SDK_PACKAGE and its dependencies with npm ci (exact versions from the lockfile)"
    if ! npm ci --prefix "$version_dir" --no-audit --no-fund --omit=optional --ignore-scripts >"$tmp/npm.log" 2>&1; then
      cat "$tmp/npm.log" >&2
      die "npm could not install $OCW_SDK_PACKAGE beside the runtime (output above)"
    fi
  fi
  got=$("$node_bin" "$version_dir/$OCW_BUNDLE_FILE" version 2>"$tmp/version.log") || {
    cat "$tmp/version.log" >&2
    die "the installed runtime does not start (output above)"
  }
  [ "$got" = "$OCW_VERSION" ] || die "the installed runtime reports version $got, expected $OCW_VERSION"
  building=

  # 5. Switch current, record the install, write the launcher, keep this version and the previous one.
  ln -sfn "versions/$OCW_SHA12" "$runtime_dir/current"
  # shellcheck disable=SC2016 # JavaScript template literals, not shell expansions; the values come in as arguments.
  "$node_bin" -e '
const fs = require("node:fs");
const [file, serverUrl, version, sha256, nodePath] = process.argv.slice(1);
const record = { serverUrl, version, sha256, installedAt: new Date().toISOString(), nodePath };
fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(`${file}.tmp`, file);
' "$runtime_dir/install.json" "$server" "$OCW_VERSION" "$OCW_SHA256" "$node_bin"
  mkdir -p "$bin_dir"
  {
    printf '#!/bin/sh\n'
    printf '# ocw-runtime: written by the OCW install script. Runs the installed runtime with the node it was installed with.\n'
    # A non-default OCW_HOME stays the default of every later command (an exported OCW_HOME still wins).
    if [ "$ocw_home" != "$HOME/.ocw" ]; then
      # shellcheck disable=SC2016 # written into the launcher, expanded when it runs.
      printf 'OCW_HOME=${OCW_HOME:-%s}\nexport OCW_HOME\n' "$(shq "$ocw_home")"
    fi
    printf 'exec %s %s "$@"\n' "$(shq "$node_bin")" "$(shq "$runtime_dir/current/$OCW_BUNDLE_FILE")"
  } >"$shim.tmp.$$"
  chmod 755 "$shim.tmp.$$"
  mv -f "$shim.tmp.$$" "$shim"
  if [ "$previous" != "$OCW_SHA12" ]; then
    for dir in "$runtime_dir"/versions/*; do
      [ -d "$dir" ] || continue
      name=${dir##*/}
      case $name in
        "$OCW_SHA12" | "$previous") continue ;;
        *[!0-9a-f]*) continue ;;
      esac
      [ ${#name} -eq 12 ] || continue
      rm -rf "$dir"
    done
  fi

  say "Installed ocw-runtime $OCW_VERSION ($OCW_SHA12)."
  case ":${PATH:-}:" in
    *":$bin_dir:"*) ;;
    *) say "$bin_dir is not on your PATH. Add it (for example in ~/.profile): export PATH=\"$bin_dir:\$PATH\"" ;;
  esac
  say "Next: ocw-runtime setup"
  if [ "$had_install" = true ]; then
    say "If the service runs, restart it when no session runs: ocw-runtime service restart"
  fi
}

main "$@"
