#!/bin/sh
# Regenerates the sbx document toolkit's Python lock (07.17.1.1.1 D-03, D-09; PD-14; ADR-0043) and prints the license
# fields of every pinned wheel, for a person to review `licenses.json` against.
#
#   sh infra/sandbox/sbx/tools/lock.sh [--show name[,name...]]     # from the repository root, by a person
#
# - Resolves `requirements.in` into `requirements.lock` (pip-compile 7.6.2, sha256 hashes of every wheel of each pinned
#   version, wheels only) inside the image's own pinned base, so the pins fit its Python 3.11.2 (RESEARCH Pitfall 5:
#   a newer host interpreter pins numpy 2.5 and soupsieve 3+, which fail on 3.11.2). An existing lock keeps its pins
#   unless `requirements.in` forces a change (a new name or a `name<version` hold-back).
# - Never installs a locked package, so no package code runs: the pinned wheels are downloaded with
#   `--require-hashes --only-binary :all: --no-deps` and each wheel's `*.dist-info/METADATA` is read as a zip member.
#   pip-tools lives only in a scratch venv of this throwaway container (dev-time, never in the image).
# - Prints one JSON line per pin: name, version, License-Expression, the first line of License, the `License ::`
#   classifiers, Home-page, every Project-URL and the license files the wheel ships. `--show` also prints the text of
#   those license files for the named wheels (for example xlrd's LICENSE or pypdfium2's BUILD_LICENSES/).
# - Needs the network: deb.debian.org (python3, pip, venv) and pypi.org / files.pythonhosted.org. Nothing secret is
#   mounted; only this folder, at /work.
# - Never runs on CI. Re-run it when `requirements.in` changes and at the 07.17.1.1.1 gate, then review
#   `licenses.json` against its output, re-run `node scripts/sandbox-lock-evidence.mjs` and `pnpm guard --only licenses`.
set -eu

BASE="node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205"
TOOLS_DIR="infra/sandbox/sbx/tools"

SHOW=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --show)
      SHOW="${2:?--show needs a comma-separated list of names}"
      shift 2
      ;;
    *)
      echo "usage: sh $TOOLS_DIR/lock.sh [--show name[,name...]]" >&2
      exit 2
      ;;
  esac
done

if [ ! -f "$TOOLS_DIR/requirements.in" ]; then
  echo "run from the repository root ($TOOLS_DIR/requirements.in not found)" >&2
  exit 2
fi

INNER=$(cat <<'EOF'
set -eu
export DEBIAN_FRONTEND=noninteractive PIP_DISABLE_PIP_VERSION_CHECK=1
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends python3 python3-venv python3-pip ca-certificates >/dev/null
python3 -m venv /tmp/pt
/tmp/pt/bin/pip install -q pip-tools==7.6.2
cd /work
/tmp/pt/bin/pip-compile -q --generate-hashes --allow-unsafe --strip-extras --no-emit-index-url \
  --pip-args "--only-binary :all:" --output-file requirements.lock requirements.in
chown "$HOST_UID:$HOST_GID" requirements.lock
/tmp/pt/bin/pip download -q --no-deps --only-binary :all: --require-hashes -r requirements.lock -d /tmp/wheels
python3 -I - /tmp/wheels <<"PY"
import email.parser, json, os, re, sys, zipfile

norm = lambda n: re.sub(r"[-_.]+", "-", n).lower()

wheels = sys.argv[1]
show = {norm(n.strip()) for n in os.environ.get("SHOW", "").split(",") if n.strip()}
for wheel in sorted(os.listdir(wheels)):
    if not wheel.endswith(".whl"):
        continue
    with zipfile.ZipFile(os.path.join(wheels, wheel)) as z:
        names = z.namelist()
        meta_name = next(n for n in names if n.count("/") == 1 and n.endswith(".dist-info/METADATA"))
        meta = email.parser.Parser().parsestr(z.read(meta_name).decode("utf-8"), headersonly=True)
        dist_info = meta_name.split("/")[0] + "/"
        license_files = sorted(
            n for n in names
            if n.startswith(dist_info) and not n.endswith("/")
            and ("LICEN" in n.upper() or "COPYING" in n.upper() or "NOTICE" in n.upper())
        )
        name = meta.get("Name", "")
        print(json.dumps({
            "name": name,
            "version": meta.get("Version", ""),
            "license_expression": meta.get("License-Expression"),
            "license": (meta.get("License") or "").strip().splitlines()[0] if meta.get("License") else None,
            "classifiers": [c for c in meta.get_all("Classifier", []) if c.startswith("License ::")],
            "home_page": meta.get("Home-page"),
            "project_urls": meta.get_all("Project-URL", []),
            "license_files": license_files,
            "wheel": wheel,
        }, sort_keys=True))
        if norm(name) in show:
            for n in license_files:
                print("----- " + wheel + " " + n)
                print(z.read(n).decode("utf-8", "replace"))
PY
EOF
)

exec docker run --rm \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" -e SHOW="$SHOW" \
  -v "$PWD/$TOOLS_DIR:/work" \
  "$BASE" sh -c "$INNER"
