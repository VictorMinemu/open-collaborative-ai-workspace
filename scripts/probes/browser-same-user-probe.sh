#!/usr/bin/env bash
# Phase 07.13-04 probe (A-5, research Pitfall 5, D-29): can a process of the SAME OS user reach a Work Zone browser
# child on Linux? Opt-in, needs Docker, never part of `pnpm verify`.
#
#   bash scripts/probes/browser-same-user-probe.sh
#
# In the pinned Node 24 slim image the headless proof uses, as the image's non-root user `node`, with no network:
#   1. a long-lived Node parent spawns a child the way Playwright spawns Chromium for `--remote-debugging-pipe`
#      (Node `spawn` with stdio pipes, fds 3 and 4 as the CDP pipe ends) with a canary in its environment; beside it a
#      `sleep | cat` shell pipeline gives a control process whose stdin is a real pipe(2);
#   2. from a sibling process of the same user (`docker exec`, not a descendant of either), it tries to open
#      `/proc/<child>/fd/{0,3,4}` for writing, read `/proc/<child>/environ`, open `/proc/<child>/mem`, and open the
#      control's `/proc/<cat>/fd/0` for writing;
#   3. it prints one line and exits 0:
#        fd_open=yes|no environ_read=yes|no ptrace_scope=<value|absent> mem_open=yes|no fd_kind=<socket|pipe|…>
#        fd_error=<errno|-> fifo_control_open=yes|no kernel=<uname -r> arch=<uname -m>
# Nothing from the host is mounted; the container is removed on exit, whatever happens. Docker Desktop runs its own
# LinuxKit kernel, so `ptrace_scope` there is that VM's value, not a distribution default: run it on the Linux host
# whose answer you need.
set -euo pipefail

# The same pinned image scripts/headless-server-proof.sh uses (Node 24.22.1, Debian bookworm, user `node` uid 1000).
IMAGE="node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205"
NAME="ocw-browser-same-user-probe-$$"

command -v docker >/dev/null 2>&1 || { echo "browser-same-user-probe: docker is required" >&2; exit 1; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# The target: a Node child holding Node-spawned stdio pipes (fds 0-4), and the real-pipe control (`$!` = cat's pid).
TARGET_JS='
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["-e", "process.stdin.resume(); setInterval(() => {}, 1e6);"], {
  stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  env: { OCW_PROBE_CANARY: "canary-value" },
});
const control = spawn("sh", ["-c", "sleep 100000 | cat > /dev/null & echo $! > /tmp/ocw-probe-fifo.pid; wait"], {
  stdio: "ignore",
});
fs.writeFileSync("/tmp/ocw-probe-target.pid", String(child.pid));
setInterval(() => {}, 1e6);
'

# The sibling: same uid, not a descendant of the target.
PROBE_JS='
const fs = require("node:fs");
const os = require("node:os");
const pid = fs.readFileSync("/tmp/ocw-probe-target.pid", "utf8").trim();
const fifoPid = fs.readFileSync("/tmp/ocw-probe-fifo.pid", "utf8").trim();
const tryOpen = (path, flags) => {
  try {
    fs.closeSync(fs.openSync(path, flags));
    return { ok: true, code: "-" };
  } catch (err) {
    return { ok: false, code: err.code ?? "error" };
  }
};
const kind = (n) => {
  try {
    return fs.readlinkSync(`/proc/${pid}/fd/${n}`).split(":")[0];
  } catch (err) {
    return err.code ?? "error";
  }
};
const fds = [0, 3, 4].map((n) => tryOpen(`/proc/${pid}/fd/${n}`, "w"));
let environ = false;
try {
  environ = fs.readFileSync(`/proc/${pid}/environ`, "utf8").includes("OCW_PROBE_CANARY=canary-value");
} catch {
  environ = false;
}
let scope = "absent";
try {
  scope = fs.readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim();
} catch {
  scope = "absent";
}
const mem = tryOpen(`/proc/${pid}/mem`, "r");
const fifo = tryOpen(`/proc/${fifoPid}/fd/0`, "w");
const yn = (b) => (b ? "yes" : "no");
const failed = fds.find((f) => !f.ok);
console.log(
  [
    `fd_open=${yn(fds.some((f) => f.ok))}`,
    `environ_read=${yn(environ)}`,
    `ptrace_scope=${scope}`,
    `mem_open=${yn(mem.ok)}`,
    `fd_kind=${kind(3)}`,
    `fd_error=${failed ? failed.code : "-"}`,
    `fifo_control_open=${yn(fifo.ok)}`,
    `kernel=${os.release()}`,
    `arch=${os.arch()}`,
  ].join(" "),
);
'

docker run -d --name "$NAME" --network none --user node "$IMAGE" sleep 600 >/dev/null
docker exec -d -u node "$NAME" node -e "$TARGET_JS"
for _ in $(seq 1 50); do
  if docker exec -u node "$NAME" test -s /tmp/ocw-probe-target.pid && docker exec -u node "$NAME" test -s /tmp/ocw-probe-fifo.pid; then
    break
  fi
  sleep 0.2
done
docker exec -u node "$NAME" node -e "$PROBE_JS"
