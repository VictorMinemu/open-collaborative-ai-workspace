"""`ocw-extract --batch` (phase 07.17.1.1.1, D-04, D-11, PD-08, PD-09): a whole folder or archive becomes a `.txt`
mirror tree plus `_index.tsv` under /workspace/extracted/<name>, in chunks that always end before the exec limit.

- The walk is sorted, never follows a symbolic link (a link is a `skipped` row) and skips the output root and the
  scratch folder. Originals are only read: never copied, moved or modified.
- Resume: an entry whose size and mtime_ns match a final row (`done`, `failed`, `unsupported`, `skipped`) keeps its
  exact line and its `.txt`. A PDF resumes per page: its blocks are appended to `<rel>.txt.partial` and `next_page`
  records where to go on; the file becomes `<rel>.txt` when the last page is done.
- Budget rule: before every step (one child process) with nominal timeout T, the remaining budget R is computed;
  R < T writes the index and exits 75 without starting the step, otherwise the step runs with timeout min(T, R). A
  step that still times out leaves its entry `partial` (a PDF at that page); the second timeout makes it `failed`
  with the note `timeout`. Exit 75 while work remains, 0 when every entry is final; failures are counted, not exit codes.
- Archives (PD-09): listed and checked against every cap, extracted into the scratch folder under the size watcher,
  each member mirrored under `<rel>.d/` with a `<rel>!<member>` row; a nested archive is listed, not extracted. A
  top-level archive that breaks a cap exits 6.
"""

import os
import re
import shutil
import sys
import tempfile
import time

from . import archives, bounds, detect, pdf, runner

INDEX = "_index.tsv"
COLUMNS = ("path", "size", "mtime_ns", "type", "method", "pages", "next_page", "chars", "status", "note")
HEADER = "\t".join(COLUMNS)
FINAL = ("done", "failed", "unsupported", "skipped")
WRITE_EVERY_S = 5.0
PAGE_MARK = re.compile(r"(?m)^--- page (\d+)( \(ocr\))? ---$")
_ESC = {"\\": "\\\\", "\t": "\\t", "\n": "\\n", "\r": "\\r"}
_UNESC = {"\\": "\\", "t": "\t", "n": "\n", "r": "\r"}


def esc(value):
    return "".join(_ESC.get(c, c) for c in str(value))


def unesc(value):
    return re.sub(r"\\(.)", lambda m: _UNESC.get(m.group(1), m.group(1)), value)


def one_line(reason, limit=300):
    return " ".join(str(reason).split())[:limit]


class Row:
    def __init__(self, fields, raw=None):
        self.f = {c: "" for c in COLUMNS}
        self.f.update({k: "" if v is None else str(v) for k, v in fields.items()})
        self.raw = raw

    @classmethod
    def parse(cls, line):
        values = line.split("\t")
        if len(values) != len(COLUMNS):
            return None
        return cls(dict(zip(COLUMNS, (unesc(v) for v in values))), raw=line)

    def line(self):
        return self.raw if self.raw is not None else "\t".join(esc(self.f[c]) for c in COLUMNS)

    def update(self, **fields):
        self.f.update({k: "" if v is None else str(v) for k, v in fields.items()})
        self.raw = None
        return self

    @property
    def status(self):
        return self.f["status"]

    def same_file(self, st):
        return self.f["size"] == str(st.st_size) and self.f["mtime_ns"] == str(st.st_mtime_ns)


class Entry:
    def __init__(self, rel, path, kind="file", top=False):
        self.rel = rel
        self.path = path
        self.kind = kind  # file, symlink, special
        self.top = top


class TopLevelCaps(Exception):
    def __init__(self, error):
        super().__init__(error.reason)
        self.error = error


class Batch:
    def __init__(self, src, out, budget, ocr_mode, lang, steps, timeouts, clock, stdout):
        from . import cli  # cli imports this module

        self.cli = cli
        self.src = src
        self.out = out
        self.clock = clock or time.monotonic
        self.steps = runner.Steps(runner=steps, timeouts=timeouts, budget=budget, clock=self.clock)
        self.opts = cli.Options(self.steps, ocr=ocr_mode, lang=lang, batch=True)
        self.stdout = stdout or sys.stdout
        self.rows = {}
        self.order = []
        self.archive_rels = set()
        self.ocr_pages = 0
        self.last_write = self.clock()
        self.load()

    # --- index -------------------------------------------------------------------------------------------------

    def index_path(self):
        return os.path.join(self.out, INDEX)

    def load(self):
        try:
            with open(self.index_path(), encoding="utf-8") as f:
                lines = f.read().splitlines()
        except FileNotFoundError:
            return
        if not lines or lines[0] != HEADER:
            return
        for line in lines[1:]:
            row = Row.parse(line)
            if row is not None:
                self.rows[row.f["path"]] = row

    def member_of(self, key, walk):
        """The archive a `<rel>!<member>` key belongs to, or None (a plain name may contain `!` too)."""
        for i, c in enumerate(key):
            if c == "!" and key[:i] in walk:
                return key[:i]
        return None

    def ordered(self):
        walk = set(self.order)
        members = {}
        for key in self.rows:
            if key in walk:
                continue
            arch = self.member_of(key, walk)
            if arch is not None:
                members.setdefault(arch, []).append(key)
        out = []
        for rel in self.order:
            if rel in self.rows:
                out.append(self.rows[rel])
            out.extend(self.rows[k] for k in members.get(rel, ()))
        return out

    def write(self):
        lines = [HEADER] + [row.line() for row in self.ordered()]
        fd, tmp = tempfile.mkstemp(prefix=".index-", dir=self.out)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write("\n".join(lines) + "\n")
            os.replace(tmp, self.index_path())
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
        self.last_write = self.clock()

    def maybe_write(self):
        if self.clock() - self.last_write >= WRITE_EVERY_S:
            self.write()

    # --- walk --------------------------------------------------------------------------------------------------

    def skip_dir(self, path):
        return path == self.out or path.startswith(self.out + "/") or path == runner.SCRATCH_ROOT

    def walk(self):
        if os.path.isfile(self.src):
            yield Entry(os.path.basename(self.src), self.src, top=True)
            return
        for base, dirs, files in os.walk(self.src):
            dirs.sort()
            kept = []
            for d in dirs:
                path = os.path.join(base, d)
                if self.skip_dir(path):
                    continue
                if os.path.islink(path):
                    yield Entry(os.path.relpath(path, self.src), path, kind="symlink")
                    continue
                kept.append(d)
            dirs[:] = kept
            for name in sorted(files):
                path = os.path.join(base, name)
                if os.path.islink(path):
                    kind = "symlink"
                elif not os.path.isfile(path):
                    kind = "special"
                else:
                    kind = "file"
                yield Entry(os.path.relpath(path, self.src), path, kind=kind)

    # --- mirror files ------------------------------------------------------------------------------------------

    def mirror_for(self, rel):
        if "!" in rel and rel.split("!", 1)[0] in self.archive_rels:
            arch, member = rel.split("!", 1)
            target = os.path.join(self.out, arch + ".d", member + ".txt")
        else:
            target = os.path.join(self.out, rel + ".txt")
        target = os.path.normpath(target)
        if not target.startswith(self.out + "/"):
            raise bounds.PathError(f"{rel} would be mirrored outside the output folder")
        return target

    def write_mirror(self, target, text):
        folder = os.path.dirname(target)
        os.makedirs(folder, exist_ok=True)
        real = os.path.realpath(folder)
        if real != self.out and not real.startswith(self.out + "/"):
            raise bounds.PathError(f"{folder} leaves the output folder")
        data = text.encode("utf-8")
        if len(data) > bounds.OUTPUT_FILE_MAX_BYTES:
            raise bounds.CapsError("the text is larger than 64 MiB")
        fd, tmp = tempfile.mkstemp(prefix=".mirror-", dir=folder)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            os.replace(tmp, target)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    @staticmethod
    def drop(path):
        for p in (path, path + ".partial"):
            if os.path.lexists(p) and not os.path.isdir(p):
                os.unlink(p)

    # --- entries -----------------------------------------------------------------------------------------------

    def process(self, entry):
        rel = entry.rel
        if entry.kind == "symlink":
            self.rows[rel] = Row({"path": rel, "status": "skipped", "note": "symlink (links are never followed)"})
            return
        st = os.lstat(entry.path)
        if entry.kind == "special":
            self.rows[rel] = Row(
                {"path": rel, "size": st.st_size, "mtime_ns": st.st_mtime_ns, "status": "skipped",
                 "note": "not a regular file"}
            )
            return
        prev = self.rows.get(rel)
        if prev is not None and prev.status in FINAL and prev.same_file(st):
            return
        self.process_file(rel, entry.path, st, prev, top=entry.top)

    def process_file(self, rel, path, st, prev, top=False, member=False):
        mirror = self.mirror_for(rel)
        resume = prev if prev is not None and prev.status == "partial" and prev.same_file(st) else None
        row = Row({"path": rel, "size": st.st_size, "mtime_ns": st.st_mtime_ns})
        self.rows[rel] = row
        try:
            mime = detect.mime_type(path, self.steps)
            type_name = detect.decide(mime, os.path.basename(path))
            if type_name is None:
                row.update(status="unsupported", note=mime)
                self.drop(mirror)
                return
            row.update(type=type_name)
            family = detect.family(type_name)
            if family == "pdf":
                self.pdf_entry(rel, path, mirror, row, resume)
            elif family == "archive" and not member:
                self.archive_entry(rel, path, type_name, st, row, resume)
            else:
                if family == "archive":
                    doc = archives.listing_doc(path, type_name, self.opts)
                else:
                    doc = self.cli.handlers()[family](path, type_name, self.opts)
                self.count_ocr(doc.ocr_pages)
                self.write_mirror(mirror, doc.full_text(os.path.basename(rel.split("!")[-1])))
                row.update(
                    method=doc.method,
                    pages=doc.total if doc.unit else "",
                    chars=len(doc.body()),
                    status="done",
                )
        except bounds.BudgetReached:
            if not row.status:
                if resume is not None:
                    self.rows[rel] = resume
                else:
                    del self.rows[rel]
            raise
        except bounds.StepTimeout:
            again = resume is not None and resume.f["note"].startswith("timeout")
            if again and (row.f["type"] != "pdf" or resume.f["next_page"] == row.f["next_page"]):
                row.update(status="failed", note="timeout", next_page="")
                self.drop(mirror)
            else:
                where = f" at page {row.f['next_page']}" if row.f["type"] == "pdf" and row.f["next_page"] else ""
                row.update(status="partial", note=f"timeout{where}")
        except bounds.CapsError as exc:
            row.update(status="failed", note=one_line(exc.reason), next_page="")
            self.drop(mirror)
            if top:
                raise TopLevelCaps(exc) from None
        except bounds.ExtractError as exc:
            row.update(status="failed", note=one_line(exc.reason), next_page="")
            self.drop(mirror)
        except Exception as exc:  # noqa: BLE001 - one entry never stops the batch
            row.update(status="failed", note=one_line(f"error: {type(exc).__name__}: {exc}"), next_page="")
            self.drop(mirror)

    def count_ocr(self, n):
        self.ocr_pages += n

    def pdf_entry(self, rel, path, mirror, row, resume):
        total = pdf.info(path, self.steps)
        partial = mirror + ".partial"
        start = int(resume.f["next_page"]) if resume is not None and resume.f["next_page"].isdigit() else 1
        if start > 1 and not os.path.isfile(partial):
            start = 1
        if start == 1:
            self.drop(mirror)
        else:
            self.trim(partial, start)
        os.makedirs(os.path.dirname(partial), exist_ok=True)
        row.update(pages=total, next_page=start, method="pdftotext")
        for n in range(start, total + 1):
            row.update(next_page=n)
            try:
                text, used_ocr = pdf.page(path, n, self.opts)
            except bounds.BudgetReached:
                row.update(status="partial", note="")
                raise
            with open(partial, "a", encoding="utf-8") as f:
                f.write(pdf.block(n, text, used_ocr) + "\n")
            if used_ocr:
                self.count_ocr(1)
            row.update(next_page=n + 1, chars=os.path.getsize(partial), status="partial", note="")
            self.maybe_write()
        self.finish_pdf(rel, partial, mirror, row, total)

    @staticmethod
    def trim(partial, start):
        """Drop any block of page `start` or later (a run killed after writing a page but before the index)."""
        with open(partial, encoding="utf-8") as f:
            text = f.read()
        for m in PAGE_MARK.finditer(text):
            if int(m.group(1)) >= start:
                with open(partial, "w", encoding="utf-8") as f:
                    f.write(text[: m.start()])
                return

    def finish_pdf(self, rel, partial, mirror, row, total):
        body = ""
        if os.path.isfile(partial):
            with open(partial, encoding="utf-8") as f:
                body = f.read()
        marks = PAGE_MARK.findall(body)
        doc = bounds.Doc("pdf")
        doc.unit = "pages"
        doc.first, doc.last, doc.total = (1 if total else 0), total, total
        doc.ocr_pages = sum(1 for _, o in marks if o)
        doc.text_pages = len(marks) - doc.ocr_pages
        doc.add(body)
        self.write_mirror(mirror, doc.full_text(os.path.basename(rel.split("!")[-1])))
        if os.path.exists(partial):
            os.unlink(partial)
        method = "ocr" if doc.ocr_pages and not doc.text_pages else "pdftotext+ocr" if doc.ocr_pages else "pdftotext"
        row.update(method=method, next_page="", chars=len(doc.body()), status="done", note="")

    def archive_entry(self, rel, path, type_name, st, row, resume):
        self.archive_rels.add(rel)
        entries = archives.list_archive(path, type_name, self.steps)
        problem = archives.check_caps(
            entries, runner.free_bytes(), st.st_size if type_name in archives.TAR else None
        )
        if problem:
            raise bounds.CapsError(problem)
        timeout = self.steps.timeout_for("7zz_extract")
        dest = os.path.join(runner.current_scratch(), f"archive-{len(self.archive_rels)}")
        shutil.rmtree(dest, ignore_errors=True)
        archives.extract(path, dest, timeout=timeout, type_name=type_name)
        try:
            members = []
            for base, dirs, files in os.walk(dest):
                dirs.sort()
                members.extend(os.path.join(base, n) for n in sorted(files))
            row.update(method="extract", note=f"{len(members)} members", status="partial")
            for mpath in members:
                key = f"{rel}!{os.path.relpath(mpath, dest)}"
                mst = os.lstat(mpath)
                mprev = self.rows.get(key)
                if mprev is not None and mprev.status in FINAL and mprev.same_file(mst):
                    continue
                self.process_file(key, mpath, mst, mprev, member=True)
                self.maybe_write()
            keys = [f"{rel}!{os.path.relpath(m, dest)}" for m in members]
            done = all(self.rows.get(k) is not None and self.rows[k].status in FINAL for k in keys)
            row.update(status="done" if done else "partial")
        finally:
            shutil.rmtree(dest, ignore_errors=True)

    # --- run ---------------------------------------------------------------------------------------------------

    def counts(self):
        rows = self.ordered()
        pending = sum(1 for rel in self.order if rel not in self.rows)
        by = {s: sum(1 for r in rows if r.status == s) for s in ("done", "partial", "failed")}
        return by, len(rows) + pending, pending

    def summary(self, more):
        by, total, _pending = self.counts()
        line = (
            f"batch: {by['done']}/{total} done · {by['partial']} partial · {by['failed']} failed · "
            f"ocr pages {self.ocr_pages} · {self.index_path()}"
        )
        self.stdout.write(line + "\n")
        if more:
            self.stdout.write("more to do: run the same command again\n")
        self.stdout.flush()

    def run(self):
        os.makedirs(self.out, exist_ok=True)
        with runner.scratch():
            entries = list(self.walk())
            self.order = [e.rel for e in entries]
            for e in entries:
                if e.top:
                    self.archive_rels.add(e.rel)
            try:
                for e in entries:
                    self.process(e)
                    self.maybe_write()
            except bounds.BudgetReached:
                self.write()
                self.summary(more=True)
                return bounds.EXIT_MORE
            except TopLevelCaps as exc:
                self.write()
                self.summary(more=False)
                raise exc.error from None
        self.write()
        by, _total, pending = self.counts()
        more = pending > 0 or by["partial"] > 0
        self.summary(more=more)
        return bounds.EXIT_MORE if more else bounds.EXIT_OK


def resolve(src, out):
    """Confine the input and the output root to /workspace; refuse an output that is or contains the input."""
    real_src = runner.confine(src, allow_dir=True)
    if os.path.isfile(real_src) and detect.family(detect.by_extension(real_src) or "txt") != "archive":
        raise bounds.UsageError("--batch takes a folder or an archive (.zip, .7z, .tar, .tar.gz); read one file without it")
    out = out or os.path.join(bounds.WORKSPACE, "extracted", os.path.basename(real_src.rstrip("/")) or "workspace")
    real_out = runner.confine(out, for_output=True, want_dir=True)
    if os.path.isdir(real_src) and (real_out == real_src or real_src.startswith(real_out + "/")):
        raise bounds.UsageError("--out must not be the input folder or contain it")
    return real_src, real_out


def run_batch(src, out=None, budget=bounds.BATCH_DEFAULT_BUDGET_S, ocr="auto", lang=bounds.DEFAULT_LANG,
              steps=None, timeouts=None, clock=None, stdout=None):
    """Run one batch chunk; returns the exit code (0 done, 75 more to do). `steps` replaces `runner.run` (tests)."""
    real_src, real_out = resolve(src, out)
    return Batch(real_src, real_out, budget, ocr, lang, steps, timeouts, clock, stdout).run()
