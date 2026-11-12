"""The toolkit's Python environment in `sbx` (phase 07.17.1.1.1, D-01, D-03, PD-05, PD-06, PD-14; ADR-0043).

Runs as 10001 in the hardened, network-less container (`infra/sandbox/test/run-sbx-image-tests.sh`). Prints one line
`installed-versions <JSON>`: the (f) input of `scripts/sandbox-lock-evidence.mjs` at the 07 supply-chain approval.
"""

import json
import os
import re
import stat
import subprocess
import unittest

TOOLS = "/opt/ocw-tools"
VENV_PY = f"{TOOLS}/venv/bin/python3"
SITE = f"{TOOLS}/venv/lib/python3.11/site-packages"
LOCK = f"{TOOLS}/requirements.lock"
LAUNCHER = "/usr/local/bin/ocw-extract"
LIB = f"{TOOLS}/lib/ocw_extract"
TOOLKIT_PYTHONPATH = f"{SITE}:/opt/ocw-packages/python"
SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
# What a bot's own scripts import with the system python3 (D-03). xlrd was dropped (its license): .xls goes through
# LibreOffice inside ocw-extract.
BOT_MODULES = (
    "pandas",
    "openpyxl",
    "docx",
    "pptx",
    "pdfplumber",
    "pypdf",
    "PIL",
    "pytesseract",
    "bs4",
    "lxml",
    "charset_normalizer",
)


def normalize(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def lock_pins():
    pins = {}
    with open(LOCK, encoding="utf-8") as f:
        for line in f:
            m = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s\\;]+)", line)
            if m:
                pins[normalize(m.group(1))] = m.group(2)
    return pins


def run(argv, env=None, timeout=120):
    proc = subprocess.run(
        argv,
        capture_output=True,
        timeout=timeout,
        env=env or {"PATH": SYSTEM_PATH, "LC_ALL": "C.UTF-8", "HOME": "/tmp"},
        check=False,
    )
    return proc.returncode, proc.stdout.decode("utf-8", "replace"), proc.stderr.decode("utf-8", "replace")


class Venv(unittest.TestCase):
    def test_installed_versions_equal_the_lock(self):
        code = (
            "import importlib.metadata as m, json, re;"
            "print(json.dumps({re.sub(r'[-_.]+','-',d.metadata['Name']).lower(): d.version"
            " for d in m.distributions()}, sort_keys=True))"
        )
        rc, out, err = run([VENV_PY, "-I", "-c", code])
        self.assertEqual(rc, 0, err)
        installed = json.loads(out)
        print("installed-versions " + json.dumps(installed, sort_keys=True))
        self.assertEqual(installed, lock_pins())

    def test_the_venv_has_no_pip(self):
        rc, _out, err = run([VENV_PY, "-I", "-c", "import pip"])
        self.assertNotEqual(rc, 0)
        self.assertIn("No module named 'pip'", err)
        self.assertEqual([n for n in os.listdir(f"{TOOLS}/venv/bin") if n.startswith("pip")], [])

    def test_pandas_and_numpy_test_trees_are_pruned(self):
        self.assertFalse(os.path.exists(f"{SITE}/pandas/tests"))
        found = [root for root, dirs, _ in os.walk(f"{SITE}/numpy") for d in dirs if d == "tests"]
        self.assertEqual(found, [])

    def test_nothing_under_the_tools_root_is_writable_by_the_bot(self):
        self.assertEqual(os.getuid(), 10001)
        writable = []
        for path in (TOOLS, LAUNCHER):
            if os.access(path, os.W_OK):
                writable.append(path)
        for root, dirs, files in os.walk(TOOLS):
            for name in dirs + files:
                path = os.path.join(root, name)
                st = os.lstat(path)
                if stat.S_ISLNK(st.st_mode):
                    continue
                if st.st_uid != 0 or st.st_mode & 0o022 or os.access(path, os.W_OK):
                    writable.append(path)
        st = os.stat(LAUNCHER)
        self.assertEqual(st.st_uid, 0)
        self.assertEqual(st.st_mode & 0o022, 0)
        self.assertEqual(writable[:5], [])

    def test_the_launcher_is_isolated_and_the_package_byte_compiled(self):
        with open(LAUNCHER, encoding="utf-8") as f:
            self.assertEqual(f.readline().rstrip("\n"), f"#!{VENV_PY} -I")
        self.assertTrue(os.path.isfile(f"{LIB}/cli.py"))
        compiled = os.listdir(f"{LIB}/__pycache__")
        self.assertTrue(any(n.startswith("cli.cpython-311") for n in compiled), compiled)

    def test_pdfplumber_cli_runs_from_the_curated_bin(self):
        self.assertTrue(os.path.islink(f"{TOOLS}/bin/pdfplumber"))
        self.assertEqual(sorted(os.listdir(f"{TOOLS}/bin")), ["pdfplumber"])
        rc, out, err = run([f"{TOOLS}/bin/pdfplumber", "--help"])
        self.assertEqual(rc, 0, err)
        self.assertIn("usage", out.lower())

    def test_the_bots_system_python_imports_the_toolkit(self):
        env = {"PATH": SYSTEM_PATH, "LC_ALL": "C.UTF-8", "HOME": "/tmp", "PYTHONPATH": TOOLKIT_PYTHONPATH}
        code = (
            "import importlib, json, sys;"
            f"mods = {list(BOT_MODULES)!r};"
            "print(json.dumps({m: importlib.import_module(m).__file__ for m in mods}))"
        )
        rc, out, err = run(["/usr/bin/python3", "-c", code], env=env)
        self.assertEqual(rc, 0, err)
        files = json.loads(out)
        for module in BOT_MODULES:
            self.assertTrue(files[module].startswith(SITE + "/"), (module, files[module]))


if __name__ == "__main__":
    unittest.main()
