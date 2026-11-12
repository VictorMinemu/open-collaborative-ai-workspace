"""`ocw-extract --batch` (phase 07.17.1.1.1, D-04, D-11, PD-08, PD-09): a whole folder or archive becomes a `.txt`
mirror tree plus `_index.tsv` under /workspace/extracted/<name>, in chunks that always end before the exec limit.

- The walk is sorted, never follows a symbolic link (a link is a `skipped` row) and skips the output root and the
  scratch folder. Originals are only read: never copied, moved or modified.
- Resume: an entry whose size and mtime_ns match a final row (`done`, `failed`, `unsupported`, `skipped`) keeps its
  exact line and its `.txt`. A PDF resumes per page: its blocks are appended to `<rel>.txt.partial` and `next_page`
  records where to go on; the file becomes `<rel>.txt` when the last page is done.
- Budget rule: before every step (one child process) with nominal timeout T, the remaining budget R is computed;
  R < T writes the index and exits 75 without starting the step, otherwise the step runs with timeout T. A step that
  still times out leaves its entry `partial` (a PDF at that page); the second timeout makes it `failed` with the note
  `timeout`. Exit 75 while work remains, 0 when every entry is final; failures are counted, not exit codes.
- Progress (07.17.1.1.1 review CR-02): the budget is at least the longest step plus 10 s. Office files read through
  a PDF resume per page like PDFs. When nothing moved in a run, the entry that used the whole budget is failed
  (`did not fit in one run`), or its page is written as skipped and the entry goes on, so every run moves the batch
  on. A run that still ends with the index it loaded exits 8 (no progress), never 75.
- One run at a time per output folder (07.17.1.1.1 review WR-07): an exclusive lock on `_index.tsv.lock` for the
  whole run; a second run on the same folder is refused (exit 2) instead of interleaving `.partial` files.
- Archives (PD-09): listed and checked against every cap, extracted into the scratch folder under the size watcher,
  each member mirrored under `<rel>.d/` with a `<rel>!<member>` row; a nested archive is listed, not extracted. A
  top-level archive that breaks a cap exits 6.
"""

import contextlib
import fcntl
import os
import re
import shutil
import sys
import tempfile
import time

from . import archives, bounds, containers, detect, office, pdf, runner

INDEX = "_index.tsv"
LOCK = "_index.tsv.lock"
COLUMNS = ("path", "size", "mtime_ns", "type", "method", "pages", "next_page", "chars", "status", "note")
HEADER = "\t".join(COLUMNS)
FINAL = ("done", "failed", "unsupported", "skipped")
WRITE_EVERY_S = 5.0
# A page or slide block in a `.partial` file: plain, OCR'd, or skipped (did not fit in one run).
PAGE_MARK = re.compile(r"(?m)^--- page (\d+)(?: \((ocr|skipped)\))? ---$")
SLIDE_MARK = re.compile(r"(?m)^### slide (\d+)(?: \((ocr|skipped)\))?$")
_ESC = {"\\": "\\\\", "\t": "\\t", "\n": "\\n", "\r": "\\r"}
_UNESC = {"\\": "\\", "t": "\t", "n": "\n", "r": "\r"}


def esc(value):
    return "".join(_ESC.get(c, c) for c in str(value))


def unesc(value):
    return re.sub(r"\\(.)", lambda m: _UNESC.get(m.group(1), m.group(1)), value)


def page_block(unit, n, text, used_ocr):
    if unit == "slides":
        return f"### slide {n}" + (" (ocr)" if used_ocr else "") + (f"\n{text}" if text.strip() else "")
    return pdf.block(n, text, used_ocr)


def skipped_block(unit, n, name):
    why = f"[not read: it did not fit in one --batch run; read it alone with ocw-extract {name} --pages {n}]"
    if unit == "slides":
        return f"### slide {n} (skipped)\n{why}"
    return f"--- page {n} (skipped) ---\n{why}"


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
        # What this run started from (07.17.1.1.1 review CR-02): `moved` turns true when a row changes or a page is
        # written; a run that ends with the same index it loaded stops with exit 8 instead of 75.
        self.loaded = {}
        self.loaded_lines = []
        self.moved = False

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
                self.loaded[row.f["path"]] = line
                self.loaded_lines.append(line)

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

    def member_mirror(self, arch, member):
        return os.path.normpath(os.path.join(self.out, arch + ".d", member + ".txt"))

    def mirrors_kept(self, rel, row):
        """A final row is trusted only while what it wrote is still there (07.17.1.1.1 review IN-06): a `done` file's
        mirror, or every `done` member's mirror of an archive. A deleted mirror makes the entry run again."""
        if row.status != "done":
            return True
        if row.f["type"] in detect.FAMILIES["archive"] and "!" not in rel:
            prefix = rel + "!"
            return all(
                os.path.isfile(self.member_mirror(rel, key[len(prefix) :]))
                for key, member in self.rows.items()
                if key.startswith(prefix) and member.status == "done"
            )
        if "!" in rel and rel.split("!", 1)[0] in self.rows:
            arch, member = rel.split("!", 1)
            return os.path.isfile(self.member_mirror(arch, member))
        return os.path.isfile(self.mirror_for(rel))

    def inside_out(self, path):
        folder = os.path.realpath(os.path.dirname(path))
        return path.startswith(self.out + "/") and (folder == self.out or folder.startswith(self.out + "/"))

    def forget_gone(self):
        """Remove the rows of sources the walk no longer finds, and what they wrote (07.17.1.1.1 review IN-06): a
        file's `.txt` (and `.partial`), an archive's `<rel>.d/` tree of member mirrors. Only paths under the output
        folder are touched, never through a symbolic link."""
        kept = {row.f["path"] for row in self.ordered()}
        for key in [k for k in self.rows if k not in kept]:
            row = self.rows.pop(key)
            if "!" in key:
                continue  # a member of an archive that is gone: its `.d` tree goes with the archive's row
            target = os.path.normpath(os.path.join(self.out, key + ".txt"))
            if self.inside_out(target):
                self.drop(target)
            if row.f["type"] in detect.FAMILIES["archive"]:
                tree = os.path.normpath(os.path.join(self.out, key + ".d"))
                if self.inside_out(tree) and os.path.isdir(tree) and not os.path.islink(tree):
                    shutil.rmtree(tree, ignore_errors=True)

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
            self.note_moved(rel)
            return
        st = os.lstat(entry.path)
        if entry.kind == "special":
            self.rows[rel] = Row(
                {"path": rel, "size": st.st_size, "mtime_ns": st.st_mtime_ns, "status": "skipped",
                 "note": "not a regular file"}
            )
            self.note_moved(rel)
            return
        prev = self.rows.get(rel)
        if prev is not None and prev.status in FINAL and prev.same_file(st) and self.mirrors_kept(rel, prev):
            return
        self.process_file(rel, entry.path, st, prev, top=entry.top)

    def process_file(self, rel, path, st, prev, top=False, member=False):
        mirror = self.mirror_for(rel)
        resume = prev if prev is not None and prev.status == "partial" and prev.same_file(st) else None
        row = Row({"path": rel, "size": st.st_size, "mtime_ns": st.st_mtime_ns})
        self.rows[rel] = row
        steps_at_start = self.steps.count
        paged = False
        try:
            mime = detect.mime_type(path, self.steps)
            type_name = detect.decide(mime, os.path.basename(path))
            if type_name is None:
                row.update(status="unsupported", note=mime)
                self.drop(mirror)
                self.note_moved(rel)
                return
            row.update(type=type_name)
            family = detect.family(type_name)
            if family == "pdf":
                paged = True
                self.paged_entry(rel, path, mirror, row, resume, type_name, "pages")
            elif self.through_pdf(type_name, family):
                paged = True
                self.paged_entry(rel, path, mirror, row, resume, type_name, "slides" if family == "slides" else "pages")
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
                if not self.moved and self.steps.count > steps_at_start:
                    # Nothing moved in this run and this entry alone used the whole fresh budget: the next run would
                    # start it again and stop at the same point. Fail it, so the batch goes on (07.17.1.1.1 review
                    # CR-02); a paged entry skips the page instead (paged_entry).
                    row.update(
                        status="failed",
                        note=f"did not fit in one run ({int(self.steps.budget)} s budget): read it alone with "
                        "ocw-extract <file> -o FILE",
                        next_page="",
                    )
                    self.drop(mirror)
                    self.moved = True
                elif resume is not None:
                    self.rows[rel] = resume
                else:
                    del self.rows[rel]
            raise
        except bounds.StepTimeout:
            again = resume is not None and resume.f["note"].startswith("timeout")
            if again and (not paged or resume.f["next_page"] == row.f["next_page"]):
                row.update(status="failed", note="timeout", next_page="")
                self.drop(mirror)
            else:
                where = f" at page {row.f['next_page']}" if paged and row.f["next_page"] else ""
                row.update(status="partial", note=f"timeout{where}")
        except bounds.CapsError as exc:
            row.update(status="failed", note=one_line(exc.reason), next_page="")
            self.drop(mirror)
            if top:
                self.note_moved(rel)
                raise TopLevelCaps(exc) from None
        except bounds.ExtractError as exc:
            row.update(status="failed", note=one_line(exc.reason), next_page="")
            self.drop(mirror)
        except Exception as exc:  # noqa: BLE001 - one entry never stops the batch
            row.update(status="failed", note=one_line(f"error: {type(exc).__name__}: {exc}"), next_page="")
            self.drop(mirror)
        self.note_moved(rel)

    def note_moved(self, rel):
        """An entry whose row is not the line this run loaded moved the batch on."""
        row = self.rows.get(rel)
        if row is not None and row.line() != self.loaded.get(rel):
            self.moved = True

    def through_pdf(self, type_name, family):
        """Office files `office.py` reads through a PDF, page by page (07.17.1.1.1 review CR-02): a writer document
        with --ocr always, and every presentation but a pptx outside --ocr always (python-pptx reads that one)."""
        if family == "writer":
            return self.opts.ocr == "always"
        if family == "slides":
            return self.opts.ocr == "always" or type_name != "pptx"
        return False

    def count_ocr(self, n):
        self.ocr_pages += n

    def paged_entry(self, rel, path, mirror, row, resume, type_name, unit):
        """A PDF, or an Office file through its PDF (LibreOffice converts it again on every run): one page at a time
        appended to `<rel>.txt.partial`, `next_page` in the index, so the next run goes on at the next page. A page
        that does not fit even a fresh run (nothing else moved) is written as skipped and the entry goes on."""
        office_file = detect.family(type_name) != "pdf"
        if office_file:
            containers.check(path, type_name, self.steps)
            source = office.convert(path, "pdf", self.steps)
            page_opts = office.Options(self.steps, "always" if self.opts.ocr == "always" else "never", self.opts.lang)
        else:
            source, page_opts = path, self.opts
        total = pdf.info(source, self.steps)
        mark = SLIDE_MARK if unit == "slides" else PAGE_MARK
        partial = mirror + ".partial"
        start = int(resume.f["next_page"]) if resume is not None and resume.f["next_page"].isdigit() else 1
        if start > 1 and (not os.path.isfile(partial) or resume.f["pages"] != str(total)):
            start = 1
        if start == 1:
            self.drop(mirror)
        else:
            self.trim(partial, start, mark)
        os.makedirs(os.path.dirname(partial), exist_ok=True)
        row.update(pages=total, next_page=start, method="soffice+pdftotext" if office_file else "pdftotext")
        name = os.path.basename(rel.split("!")[-1])
        for n in range(start, total + 1):
            row.update(next_page=n)
            try:
                text, used_ocr = pdf.page(source, n, page_opts)
            except bounds.BudgetReached:
                if not self.moved:
                    with open(partial, "a", encoding="utf-8") as f:
                        f.write(skipped_block(unit, n, name) + "\n")
                    self.moved = True
                    if n == total:
                        self.finish_paged(rel, partial, mirror, row, total, type_name, unit)
                        raise
                    row.update(next_page=n + 1, chars=os.path.getsize(partial), status="partial", note="")
                    raise
                row.update(status="partial", note="")
                raise
            with open(partial, "a", encoding="utf-8") as f:
                f.write(page_block(unit, n, text, used_ocr) + "\n")
            if used_ocr:
                self.count_ocr(1)
            self.moved = True
            row.update(next_page=n + 1, chars=os.path.getsize(partial), status="partial", note="")
            self.maybe_write()
        self.finish_paged(rel, partial, mirror, row, total, type_name, unit)

    @staticmethod
    def trim(partial, start, mark=None):
        """Drop any block of page `start` or later (a run killed after writing a page but before the index)."""
        with open(partial, encoding="utf-8") as f:
            text = f.read()
        for m in (mark or PAGE_MARK).finditer(text):
            if int(m.group(1)) >= start:
                with open(partial, "w", encoding="utf-8") as f:
                    f.write(text[: m.start()])
                return

    def finish_paged(self, rel, partial, mirror, row, total, type_name, unit):
        body = ""
        if os.path.isfile(partial):
            with open(partial, encoding="utf-8") as f:
                body = f.read()
        marks = (SLIDE_MARK if unit == "slides" else PAGE_MARK).findall(body)
        skipped = [int(n) for n, flag in marks if flag == "skipped"]
        doc = bounds.Doc(type_name)
        doc.unit = unit
        doc.first, doc.last, doc.total = (1 if total else 0), total, total
        doc.ocr_pages = sum(1 for _, flag in marks if flag == "ocr")
        doc.text_pages = len(marks) - doc.ocr_pages - len(skipped)
        doc.add(body)
        self.write_mirror(mirror, doc.full_text(os.path.basename(rel.split("!")[-1])))
        if os.path.exists(partial):
            os.unlink(partial)
        if detect.family(type_name) != "pdf":
            method = "soffice+ocr" if doc.ocr_pages else "soffice+pdftotext"
        elif doc.ocr_pages:
            method = "ocr" if not doc.text_pages else "pdftotext+ocr"
        else:
            method = "pdftotext"
        word = "page" if unit == "pages" else "slide"
        note = f"skipped {word}{'s' if len(skipped) > 1 else ''} {pdf.ranges(skipped)}: did not fit in one run" if skipped else ""
        row.update(method=method, next_page="", chars=len(doc.body()), status="done", note=note)

    def archive_entry(self, rel, path, type_name, st, row, resume):
        self.archive_rels.add(rel)
        entries = archives.list_archive(path, type_name, self.steps)
        problem = archives.check_caps(
            # The whole archive's size ratio for every type (07.17.1.1.1 review IN-02): many entries under 10 MiB, or a
            # solid 7z with no packed sizes, are checked too.
            entries, runner.room_bytes() - bounds.ARCHIVE_FREE_MARGIN_BYTES, st.st_size
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
                if mprev is not None and mprev.status in FINAL and mprev.same_file(mst) and self.mirrors_kept(key, mprev):
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
        with self.locked():
            self.load()
            return self.run_locked()

    @contextlib.contextmanager
    def locked(self):
        """One batch at a time per output folder (07.17.1.1.1 review WR-07): an exclusive `flock` on
        `_index.tsv.lock`, held for the whole run (the kernel drops it when the process dies, even on SIGKILL). A
        second run is refused at once instead of appending the same pages and overwriting the other's index."""
        fd = os.open(os.path.join(self.out, LOCK), os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise bounds.UsageError(
                    f"another ocw-extract --batch is writing {self.out}: wait for it to end (ocw_sandbox_process), "
                    "then run this again"
                ) from None
            yield
        finally:
            os.close(fd)

    def run_locked(self):
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
                return self.finish(more=True)
            except TopLevelCaps as exc:
                self.write()
                self.summary(more=False)
                raise exc.error from None
        by, _total, pending = self.counts()
        return self.finish(more=pending > 0 or by["partial"] > 0)

    def finish(self, more):
        """Write the index and the summary; 75 while work remains, 0 when done, and exit 8 (StuckError) when work
        remains but this run left the index exactly as it found it: running it again would do the same."""
        self.forget_gone()
        self.write()
        stuck = more and [row.line() for row in self.ordered()] == self.loaded_lines
        self.summary(more=more and not stuck)
        if stuck:
            raise bounds.StuckError(
                f"--batch made no progress in this run ({self.index_path()} is unchanged): stopping instead of running "
                "again; the entries left are not final in the index"
            )
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
