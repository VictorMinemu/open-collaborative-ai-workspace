"""Children of `ocw-extract` (phase 07.17.1.1.1, PD-06): argv lists only, each with a step timeout, a fresh minimal
environment without any proxy variable, and a private scratch directory removed afterwards.

Children stay in ocw-extract's own process group, which is the one `ocw-run` records (07.17.1.1.1 review WR-01): when
`ocw-run --kill` or the exec timeout SIGKILLs that group, every child and grandchild (LibreOffice's soffice.bin
included) dies with ocw-extract. A step timeout kills the child's whole process tree, found through /proc, and
ocw-extract is a child subreaper, so a grandchild orphaned during a step is reparented here and killed with it. The
tree is killed before the child is reaped, so its pid cannot have been reused (review IN-03).

Nothing here ever hands a string to a shell. Output is written to unnamed files in the scratch directory and read
back with a cap, so a hostile input cannot fill this process's memory through a pipe.
"""

import contextlib
import os
import resource
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time

from . import bounds

try:  # death with the parent (PR_SET_PDEATHSIG), loaded before any fork; absent outside Linux
    import ctypes

    _LIBC = ctypes.CDLL(None)
except Exception:  # noqa: BLE001
    _LIBC = None

SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
SCRATCH_ROOT = os.path.join(bounds.WORKSPACE, ".ocw-extract-tmp")
SCRATCH_STALE_S = 3600
LO_PROFILE_PREFIX = "ocw-lo-"
# The `ocw_extract` package's parent folder: children re-import it from here (never from PYTHONPATH or the cwd).
LIB_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STDERR_TAIL_BYTES = 4096

# One parser run in a child interpreter: `python3 -I -c WORKER <lib> <module> <function> args…`.
WORKER = (
    "import sys;sys.path.insert(0,sys.argv[1]);import importlib;"
    "m=importlib.import_module(sys.argv[2]);sys.exit(getattr(m,sys.argv[3])(sys.argv[4:]) or 0)"
)

_scratch = None
_live = {}  # pid of a running child → this process's children before it started (kill_tree's orphans)
_SUBREAPER = [False]


class Result:
    def __init__(self, returncode, stdout, stderr):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr

    def err_line(self):
        """The last non-empty stderr line, for a one-line reason."""
        lines = [line.strip() for line in self.stderr.decode("utf-8", "replace").splitlines() if line.strip()]
        return lines[-1] if lines else ""


def current_scratch():
    return _scratch


def child_env(scratch=None):
    """Exactly the six variables every child gets: no proxy, no PYTHONPATH, nothing inherited (PD-06)."""
    home = scratch or _scratch or tempfile.gettempdir()
    return {
        "PATH": SYSTEM_PATH,
        "LC_ALL": "C.UTF-8",
        "HOME": home,
        "TMPDIR": home,
        "OMP_THREAD_LIMIT": "1",
        "OPENBLAS_NUM_THREADS": "1",
    }


def _limits(timeout, fsize):
    """Runs in the child before exec: CPU-time backstop, per-file size cap, and death with its parent (Linux). The
    child keeps ocw-extract's process group (never a new session), so ocw-run's group kill reaches it."""

    def apply():
        cpu = int(timeout) + 5
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 5))
        resource.setrlimit(resource.RLIMIT_FSIZE, (fsize, fsize))
        if _LIBC is not None:
            with contextlib.suppress(Exception):
                _LIBC.prctl(1, signal.SIGKILL)  # PR_SET_PDEATHSIG

    return apply


def _subreaper():
    """Become a child subreaper (PR_SET_CHILD_SUBREAPER, Linux): a grandchild whose parent exits during a step is
    reparented to this process, where `kill_tree` finds it, instead of to the container's init."""
    if not _SUBREAPER[0] and _LIBC is not None:
        with contextlib.suppress(Exception):
            _LIBC.prctl(36, 1)  # PR_SET_CHILD_SUBREAPER
        _SUBREAPER[0] = True


def _processes():
    """{pid: (ppid, state)} of every process /proc shows (this container's pid namespace), or None without /proc."""
    try:
        names = os.listdir("/proc")
    except OSError:
        return None
    table = {}
    for name in names:
        if not name.isdigit():
            continue
        try:
            with open(f"/proc/{name}/stat", "rb") as f:
                data = f.read()
        except OSError:
            continue
        rest = data[data.rfind(b")") + 2 :].split()  # the command name may hold spaces and parentheses
        if len(rest) >= 2:
            table[int(name)] = (int(rest[1]), rest[0])
    return table


def _descendants(table, roots):
    found, todo = set(), list(roots)
    while todo:
        parent = todo.pop()
        for pid, (ppid, _state) in table.items():
            if ppid == parent and pid not in found:
                found.add(pid)
                todo.append(pid)
    return found


def kill_tree(pid, orphans_since=None):
    """SIGKILL `pid` and every live descendant of it, plus any process reparented to this one (a subreaper) that is
    not in `orphans_since` and its descendants; repeated until none is left, so a fork during the kill is caught
    too. Zombies left as this process's children are reaped, never the child `pid` itself (its Popen does that)."""
    me = os.getpid()
    for _ in range(20):
        table = _processes()
        if table is None:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.kill(pid, signal.SIGKILL)
            return
        roots = {pid}
        if orphans_since is not None:
            roots |= {p for p, (pp, _s) in table.items() if pp == me and p != pid and p not in orphans_since}
        targets = {p for p in roots | _descendants(table, roots) if p in table and table[p][1] != b"Z" and p != me}
        for p in targets:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.kill(p, signal.SIGKILL)
        for p, (pp, state) in table.items():
            if pp == me and p != pid and state == b"Z" and p not in _live and (orphans_since is None or p not in orphans_since):
                with contextlib.suppress(ChildProcessError, OSError):
                    os.waitpid(p, os.WNOHANG)
        if not targets:
            return
        time.sleep(0.01)


def own_children():
    table = _processes() or {}
    me = os.getpid()
    return {p for p, (pp, _s) in table.items() if pp == me}


def wait_exited(proc, timeout):
    """Wait up to `timeout` s for the child to exit without reaping it (waitid WNOWAIT), so its tree can be killed
    while its pid is still reserved. True when it exited."""
    deadline = time.monotonic() + timeout
    delay = 0.002
    while True:
        try:
            info = os.waitid(os.P_PID, proc.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        except ChildProcessError:
            return True
        if info is not None and info.si_pid == proc.pid:
            return True
        left = deadline - time.monotonic()
        if left <= 0:
            return False
        time.sleep(min(delay, left))
        delay = min(delay * 2, 0.05)


def spawn(argv, timeout, *, cwd=None, stdout=None, stderr=None, fsize=None, env=None):
    """Start one argv with the limits, in this process group; the caller waits. Never a shell."""
    if not isinstance(argv, (list, tuple)) or not argv:
        raise TypeError("argv must be a non-empty list")
    _subreaper()
    before = own_children()
    proc = subprocess.Popen(
        [str(a) for a in argv],
        stdin=subprocess.DEVNULL,
        stdout=stdout if stdout is not None else subprocess.DEVNULL,
        stderr=stderr if stderr is not None else subprocess.DEVNULL,
        cwd=cwd or _scratch or tempfile.gettempdir(),
        env=env or child_env(),
        close_fds=True,
        preexec_fn=_limits(timeout, fsize or bounds.CHILD_MAX_FILE_BYTES),
    )
    proc.ocw_before = before
    _live[proc.pid] = before
    return proc


def reap(proc):
    """Kill whatever is left of the child's process tree (itself included while it runs), then reap it."""
    kill_tree(proc.pid, getattr(proc, "ocw_before", None))
    with contextlib.suppress(Exception):
        proc.wait(timeout=5)
    _live.pop(proc.pid, None)


def run(argv, timeout, *, cwd=None, max_output=bounds.OUTPUT_FILE_MAX_BYTES, fsize=None):
    """Run one argv with a timeout; returns a Result with at most `max_output` bytes of stdout.

    On expiry the whole process group is killed and StepTimeout raised (exit 7 at the CLI)."""
    where = _scratch or tempfile.gettempdir()
    with tempfile.TemporaryFile(dir=where) as out, tempfile.TemporaryFile(dir=where) as err:
        proc = spawn(argv, timeout, cwd=cwd, stdout=out, stderr=err, fsize=fsize)
        try:
            if not wait_exited(proc, timeout):
                reap(proc)
                raise bounds.StepTimeout(
                    f"{os.path.basename(str(argv[0]))} did not finish within {int(timeout)} s", pgid=proc.pid
                )
        finally:
            reap(proc)
        out.seek(0)
        data = out.read(max_output + 1)
        err.seek(0, os.SEEK_END)
        size = err.tell()
        err.seek(max(0, size - STDERR_TAIL_BYTES))
        tail = err.read()
    if len(data) > max_output:
        raise bounds.CapsError(f"{os.path.basename(str(argv[0]))} produced more than {max_output} bytes")
    return Result(proc.returncode, data, tail)


def python_argv(module, function, *args):
    """The argv of one parser run in a child interpreter of this venv, isolated (-I) like the launcher."""
    return [sys.executable, "-I", "-c", WORKER, LIB_DIR, module, function, *[str(a) for a in args]]


def _remove_stale(root):
    now = time.time()
    with contextlib.suppress(FileNotFoundError):
        for name in os.listdir(root):
            path = os.path.join(root, name)
            with contextlib.suppress(OSError):
                st = os.lstat(path)
                if now - st.st_mtime > SCRATCH_STALE_S:
                    if os.path.isdir(path) and not os.path.islink(path):
                        shutil.rmtree(path, ignore_errors=True)
                    else:
                        os.unlink(path)


@contextlib.contextmanager
def scratch(root=None):
    """A private 0700 scratch directory for one run under /workspace/.ocw-extract-tmp (disk, not the memory-backed
    /tmp), removed in a `finally`; leftovers older than one hour (a killed run) are removed first."""
    global _scratch
    root = root or SCRATCH_ROOT
    os.makedirs(root, mode=0o700, exist_ok=True)
    with contextlib.suppress(OSError):
        os.chmod(root, 0o700)
    _remove_stale(root)
    path = tempfile.mkdtemp(prefix="run-", dir=root)
    previous = _scratch
    _scratch = path
    try:
        yield path
    finally:
        _scratch = previous
        shutil.rmtree(path, ignore_errors=True)
        with contextlib.suppress(OSError):
            os.rmdir(root)  # only when empty: another run may be using it


@contextlib.contextmanager
def lo_profile():
    """A throwaway LibreOffice profile under /tmp (PD-06), removed afterwards; yields its file:// URL."""
    path = tempfile.mkdtemp(prefix=LO_PROFILE_PREFIX + secrets.token_hex(4) + "-", dir="/tmp")
    try:
        yield "file://" + path
    finally:
        shutil.rmtree(path, ignore_errors=True)


def install_signal_handlers():
    """SIGTERM, SIGHUP and SIGINT kill the live children's trees, then unwind (finally blocks remove the scratch)."""

    def handler(signum, _frame):
        for pid, before in list(_live.items()):
            kill_tree(pid, before)
        raise SystemExit(128 + signum)

    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, handler)


def confine(path, *, for_output=False, want_dir=False, allow_dir=False):
    """Resolve `path` with realpath and refuse anything outside /workspace (exit 4).

    Inputs must exist (a regular file, or a folder when `allow_dir`/`want_dir`); an output's folder must exist."""
    if not path:
        raise bounds.PathError("no path given")
    real = os.path.realpath(path)
    root = bounds.WORKSPACE
    if real != root and not real.startswith(root + "/"):
        raise bounds.PathError(f"{path} is outside /workspace: only files in your workspace can be read or written")
    if real.startswith(SCRATCH_ROOT + "/") or real == SCRATCH_ROOT:
        raise bounds.PathError(f"{path} is ocw-extract's own scratch folder")
    if for_output:
        if want_dir:
            if os.path.exists(real) and not os.path.isdir(real):
                raise bounds.PathError(f"{path} exists and is not a folder")
            return real
        if os.path.isdir(real):
            raise bounds.PathError(f"{path} is a folder: give a file name for -o")
        if not os.path.isdir(os.path.dirname(real)):
            raise bounds.PathError(f"the folder of {path} does not exist: create it first")
        return real
    if not os.path.exists(real):
        raise bounds.PathError(f"{path} not found")
    if os.path.isdir(real):
        if want_dir or allow_dir:
            return real
        raise bounds.UsageError(f"{path} is a folder: use --batch {path}")
    if want_dir:
        raise bounds.PathError(f"{path} is not a folder")
    if not os.path.isfile(real):
        raise bounds.PathError(f"{path} is not a regular file")
    return real


def free_bytes(path=bounds.WORKSPACE):
    st = os.statvfs(path)
    return st.f_bavail * st.f_frsize


class Steps:
    """How every extractor runs a child: the nominal timeout of its kind (`bounds.STEP_TIMEOUTS`), an optional batch
    budget (PD-08) and a replaceable runner (the batch tests pass a fake).

    With a budget, before every step the remaining time R is computed; R < T raises BudgetReached without starting
    the step, otherwise the step runs with its nominal timeout T (it always ends within the budget). `count` is the
    number of steps started, so a batch can tell whether an entry ran anything (07.17.1.1.1 review CR-02)."""

    def __init__(self, runner=None, timeouts=None, budget=None, clock=time.monotonic):
        self._runner = runner or run
        self.timeouts = timeouts or bounds.STEP_TIMEOUTS
        self.budget = budget
        self.clock = clock
        self.start = clock()
        self.count = 0

    def remaining(self):
        if self.budget is None:
            return None
        return self.budget - (self.clock() - self.start)

    def timeout_for(self, kind):
        nominal = self.timeouts[kind]
        left = self.remaining()
        if left is None:
            return nominal
        if left < nominal:
            raise bounds.BudgetReached(kind)
        return nominal

    def __call__(self, kind, argv, **kwargs):
        timeout = self.timeout_for(kind)
        self.count += 1
        return self._runner(argv, timeout, **kwargs)

    def python(self, module, function, *args, **kwargs):
        """One parser run in a child interpreter (kind `python`)."""
        return self("python", python_argv(module, function, *args), **kwargs)
