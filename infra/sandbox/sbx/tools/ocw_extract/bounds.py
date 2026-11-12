"""Constants, errors and output bounds of `ocw-extract` (phase 07.17.1.1.1, D-04, D-11, PD-07, PD-08, PD-09).

Every limit lives here so the hub's numbers (07.17.1.1.1-01 "Cross-plan contracts") are tunable in one file (A-04).
"""

import re
import unicodedata

WORKSPACE = "/workspace"
TOOLS_LIB = "/opt/ocw-tools/lib"

# Output bounds (D-11, PD-07). sandboxd keeps the *tail* of stdout (`SANDBOX_LIMITS.outputTailBytes` = 16 384), so the
# head is capped here and the rest goes to `-o FILE`.
DEFAULT_MAX_CHARS = 12_000
STDOUT_MAX_CHARS = 15_000
STDOUT_MAX_BYTES = 16_384
# Header, footer and notes never take more than this; the body gets the rest of STDOUT_MAX_BYTES.
STDOUT_RESERVED_BYTES = 1_024
OUTPUT_FILE_MAX_BYTES = 64 * 1024 * 1024
# The largest file any child may write (RLIMIT_FSIZE): converted PDFs and PNGs fit, a runaway writer is stopped.
CHILD_MAX_FILE_BYTES = 512 * 1024 * 1024

# OCR and rasterization (PD-07, Pitfall 6).
OCR_MIN_PAGE_CHARS = 25
# In auto mode a non-empty text layer is replaced by OCR only when OCR finds at least this many more characters.
OCR_GAIN_MIN_CHARS = 10
OCR_PAGES_PER_CALL = 50
RASTER_DPI = 300
RASTER_SCALE_TO = 3500
IMAGE_OCR_MIN_SIDE = 200
IMAGE_MAX_PIXELS = 128_000_000
# Frames of one image file (a multi-page TIFF) checked and OCR'd per call, like PDF pages (07.17.1.1.1 review WR-02).
IMAGE_MAX_FRAMES = OCR_PAGES_PER_CALL
OCR_LANGS = ("spa", "eng", "spa+eng", "eng+spa")
DEFAULT_LANG = "spa+eng"

# Archives (PD-09).
ARCHIVE_MAX_TOTAL_BYTES = 1024**3
ARCHIVE_MAX_ENTRIES = 10_000
ARCHIVE_MAX_RATIO = 100
ARCHIVE_RATIO_MIN_ENTRY_BYTES = 10 * 1024 * 1024
ARCHIVE_MAX_DEPTH = 1
# An OOXML/ODF container's total uncompressed size (07.17.1.1.1 review WR-04): python-pptx holds every part in memory.
OFFICE_MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
ARCHIVE_FREE_MARGIN_BYTES = 64 * 1024 * 1024
ARCHIVE_WATCH_INTERVAL_S = 0.25
# The room left under the bot's soft disk quota when the exec started (07.17.1.1.1 review WR-06): sandboxd sets it
# from the organization's quota and its last measurement of the workspace; absent when it knows neither.
DISK_ROOM_ENV = "OCW_DISK_ROOM_BYTES"

# Batch (PD-08).
BATCH_DEFAULT_BUDGET_S = 450
BATCH_MAX_BUDGET_S = 470
EXEC_TIMEOUT_MAX_S = 600  # SANDBOX_LIMITS.execTimeoutMaxSeconds (packages/contracts/src/sandbox.ts)

# Nominal timeout of every child step, in seconds (PD-08). `python` is one parser run in a child interpreter
# (openpyxl, python-pptx, charset-normalizer, bs4, lxml, email, Pillow), so no parser runs unbounded in this process.
STEP_TIMEOUTS = {
    "file": 30,
    "pdfinfo": 60,
    "pdftotext": 60,
    "pdftoppm": 60,
    "tesseract": 120,
    "soffice": 120,
    "exiftool": 30,
    "convert": 60,
    "msgconvert": 60,
    "catdoc": 60,
    "unrtf": 60,
    "python": 120,
    "7zz_list": 60,
    "7zz_extract": 120,
}
STEP_TIMEOUT_MAX_S = max(STEP_TIMEOUTS.values())

# A batch run plus its longest step always ends before `ocw-run` kills it (PD-08).
assert BATCH_MAX_BUDGET_S + STEP_TIMEOUT_MAX_S <= EXEC_TIMEOUT_MAX_S, "batch budget + longest step exceed 600 s"

# The exec timeout this command really got (07.17.1.1.1 review CR-01): `ocw-run` exports it. A batch keeps its longest
# step plus 10 s between the end of its budget and that deadline, and refuses to start when what is left is shorter
# than one longest step plus 10 s (the API's default 120 s is: the bot is told to pass timeoutSeconds 600).
EXEC_DEADLINE_ENV = "OCW_EXEC_DEADLINE_S"
# A single-file run ends this long before that deadline with what it read (07.17.1.1.1 review WR-05); a step is
# cut to the time left, and none starts with less than SINGLE_MIN_STEP_S left.
SINGLE_END_MARGIN_S = 10
SINGLE_MIN_STEP_S = 2
BATCH_END_MARGIN_S = STEP_TIMEOUT_MAX_S + 10
BATCH_MIN_BUDGET_S = STEP_TIMEOUT_MAX_S + 10
assert BATCH_MAX_BUDGET_S + BATCH_END_MARGIN_S <= EXEC_TIMEOUT_MAX_S, "the batch margin does not fit 600 s"

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_UNSUPPORTED = 3
EXIT_PATH = 4
EXIT_ENCRYPTED = 5
EXIT_CAPS = 6
EXIT_FAILED = 7
# A batch run that changed nothing in its index (07.17.1.1.1 review CR-02): stopped instead of "run again" forever.
EXIT_STUCK = 8
EXIT_MORE = 75


class ExtractError(Exception):
    """A failure with its exit code; `reason` is one plain line for stderr."""

    code = EXIT_FAILED

    def __init__(self, reason, code=None):
        super().__init__(reason)
        self.reason = reason
        if code is not None:
            self.code = code


class UsageError(ExtractError):
    code = EXIT_USAGE


class UnsupportedError(ExtractError):
    code = EXIT_UNSUPPORTED


class PathError(ExtractError):
    code = EXIT_PATH


class EncryptedError(ExtractError):
    code = EXIT_ENCRYPTED


class CapsError(ExtractError):
    code = EXIT_CAPS


class ConversionError(ExtractError):
    code = EXIT_FAILED


class StepTimeout(ConversionError):
    """A child ran past its step timeout; its process group was killed."""

    def __init__(self, reason, pgid=None):
        super().__init__(reason)
        self.pgid = pgid


class StuckError(ExtractError):
    """A --batch run made no progress: its index is the same as when it started (exit 8, never 75)."""

    code = EXIT_STUCK


class BudgetReached(Exception):
    """The remaining batch budget is shorter than the next step's timeout: stop before starting it (PD-08)."""


# C0 and C1 controls (CSI U+009B included) but tab and newline, and the bidi embeddings, overrides and isolates
# (07.17.1.1.1 review IN-04): none reaches the model or a person's activity view.
_CONTROL = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]")


def clean_text(text):
    """UTF-8-ready text: NFC, no BOM, `\\n` line ends, no control characters other than tab and newline, no bidi
    embedding, override or isolate."""
    text = text.replace("\ufeff", "").replace("\r\n", "\n").replace("\r", "\n")
    text = _CONTROL.sub("", text)
    return unicodedata.normalize("NFC", text)


def nonspace_chars(text):
    return sum(1 for c in text if not c.isspace())


def parse_pages(spec, total):
    """`A-B` or `N` → (first, last), both within 1 … total; anything else is a usage error."""
    m = re.fullmatch(r"\s*(\d{1,7})\s*(?:-\s*(\d{1,7})\s*)?", spec or "")
    if not m:
        raise UsageError(f"--pages must look like 2-5 or 3 (got {spec!r})")
    first = int(m.group(1))
    last = int(m.group(2)) if m.group(2) else first
    if first < 1 or last < first:
        raise UsageError(f"--pages {spec}: the first page must be at least 1 and not after the last")
    if last > total:
        raise UsageError(f"--pages {spec} is out of range: the document has {total} page{'s' if total != 1 else ''}")
    return first, last


def parse_max_chars(value):
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise UsageError(f"--max-chars must be a whole number (got {value!r})") from None
    if n < 1:
        raise UsageError("--max-chars must be at least 1")
    return min(n, STDOUT_MAX_CHARS)


def parse_budget(value):
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise UsageError(f"--budget must be a whole number of seconds (got {value!r})") from None
    # At least the longest step plus 10 s (07.17.1.1.1 review CR-02): a shorter budget could never start a soffice,
    # tesseract, parser or extraction step, so its batch would exit 75 forever without progress.
    if n < BATCH_MIN_BUDGET_S or n > BATCH_MAX_BUDGET_S:
        raise UsageError(f"--budget must be between {BATCH_MIN_BUDGET_S} and {BATCH_MAX_BUDGET_S} seconds (got {n})")
    return n


def exec_deadline(environ):
    """The exec timeout `ocw-run` exported (whole seconds), or None outside it (a hand run, the image tests)."""
    value = str(environ.get(EXEC_DEADLINE_ENV, "") or "")
    if not value.isdigit() or int(value) < 1:
        return None
    return int(value)


def workspace_room(environ):
    """The bytes left under the workspace's soft quota that sandboxd exported, or None (unknown, or a hand run)."""
    value = str(environ.get(DISK_ROOM_ENV, "") or "")
    return int(value) if value.isdigit() else None


def batch_budget(requested, deadline):
    """The budget of one batch chunk: the one asked for, cut so that the chunk ends BATCH_END_MARGIN_S before the exec
    deadline; a deadline that leaves less than BATCH_MIN_BUDGET_S is a usage error naming the way out."""
    if deadline is None:
        return requested
    budget = min(requested, deadline - BATCH_END_MARGIN_S)
    if budget < BATCH_MIN_BUDGET_S:
        raise UsageError(
            f"--batch needs a longer command timeout than this one ({deadline} s): run it with background true and "
            f"timeoutSeconds 600, and run it again while it exits {EXIT_MORE}"
        )
    return budget


def head(body, max_chars, max_bytes):
    """The longest prefix of `body` within `max_chars` characters and `max_bytes` UTF-8 bytes, and what is left."""
    cut = body[:max_chars]
    if len(cut.encode("utf-8")) > max_bytes:
        lo, hi = 0, len(cut)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if len(cut[:mid].encode("utf-8")) <= max_bytes:
                lo = mid
            else:
                hi = mid - 1
        cut = cut[:lo]
    return cut, len(body) - len(cut)


class Doc:
    """What one extraction produced: blocks of text, counts for the header, notes for the end."""

    def __init__(self, type_name, method=""):
        self.type = type_name
        self.method = method
        self.blocks = []
        self.notes = []
        self.unit = None  # "pages" (PDF counts) or "slides"
        self.first = 0
        self.last = 0
        self.total = 0
        self.text_pages = 0
        self.ocr_pages = 0
        self.extra = None

    def add(self, block):
        if block is not None:
            self.blocks.append(block.rstrip("\n"))

    def body(self):
        return clean_text("\n".join(self.blocks)).strip("\n")

    def span(self):
        if self.unit == "pages":
            return f"pages {self.first}-{self.last} of {self.total}"
        if self.unit == "slides":
            return f"slides {self.first}-{self.last} of {self.total}"
        return None

    def header(self, name):
        parts = [name, self.type]
        if self.unit:
            parts.append(self.span())
        if self.unit == "pages":
            parts += [f"text {self.text_pages}", f"ocr {self.ocr_pages}"]
        if self.extra:
            parts.append(self.extra)
        return "=== " + " · ".join(parts) + " ==="

    def summary(self, chars):
        parts = [f"{chars} characters"]
        if self.unit:
            parts.append(self.span())
        if self.unit == "pages":
            parts.append(f"ocr {self.ocr_pages}")
        return " · ".join(parts)

    def full_text(self, name):
        parts = [self.header(name)]
        body = self.body()
        if body:
            parts.append(body)
        parts.extend(n for n in self.notes if n)
        return "\n".join(parts) + "\n"


def stopped_note(n, last, deadline, unit="page"):
    """The note of a single-file run that ran out of time before `unit` n (07.17.1.1.1 review WR-05)."""
    where = f"at {unit} {n - 1} of {last}" if n > 1 else f"before {unit} {n} of {last}"
    return (
        f"[stopped {where}: this command's {deadline} s ran out; use --pages {n}-{last}, a longer timeoutSeconds with "
        "-o FILE, or --batch]"
    )


def capped_note(n, last, unit="page"):
    """The note of a stdout run that stopped reading once its capped output was full (07.17.1.1.1 review WR-05)."""
    return f"[stopped after {unit} {n} of {last}: the output is capped; use --pages {n + 1}-{last} or -o FILE]"


def footer(more):
    return f"[truncated: {more} more characters; use -o FILE or --pages]"


def bounded_stdout(header, body, notes, max_chars):
    """Header, the head of the body, the truncation footer and the notes; never over STDOUT_MAX_BYTES."""
    notes = [n for n in notes if n]
    budget = STDOUT_MAX_BYTES - STDOUT_RESERVED_BYTES
    text, more = head(body, min(max_chars, STDOUT_MAX_CHARS), budget)
    parts = [header, text.rstrip("\n")] if text.strip() else [header]
    if more:
        parts.append(footer(more))
    parts.extend(notes)
    out = "\n".join(parts) + "\n"
    data = out.encode("utf-8")
    if len(data) > STDOUT_MAX_BYTES:  # only when a header or a note is absurdly long
        data = data[: STDOUT_MAX_BYTES - 1].decode("utf-8", "ignore").encode("utf-8") + b"\n"
    return data
