# ADR-0043: Bots read documents in their sandbox: a toolkit baked into `sbx`

## Status

Status: Accepted. **Date:** 2026-11-12. **Deciders:** Víctor Ruiz (Autofy Labs). Recorded at the phase gate (plan
07.17.1.1.1-07) of phase 07.17.1.1.1, ships in v0.3.2. On ocw.autofy.ing (v0.3.1) the bot "Gertru" was asked to read a
company knowledge pack (3 030 files, 589 of them PDFs and images) and answered: "faltan herramientas para leer PDF e
imágenes; intenté instalarlas y el proxy lo rechazó con 403". The owner, quoted as said:

> "los bots deben poder leer pdfs, imagenes, archivos, etc."
>
> "Tienes que dejar en el sandbox varias herramientas para leer pdf y todo tipo de archivos."

(Bots must be able to read PDFs, images, files and so on; leave several tools in the sandbox to read PDFs and every
kind of file.) The decisions are D-01 … D-12 in
`.planning/phases/07.17.1.1.1-sandbox-document-toolkit-bots-read-pdfs-incl-scanned-ocr-ima/07.17.1.1.1-CONTEXT.md`
(D-08 … D-12 decided after the research under the owner's full-autonomy grant), the planner decisions PD-01 … PD-20 in
`07.17.1.1.1-01-PLAN.md`, and the research in `07.17.1.1.1-RESEARCH.md`.

**Extends, without editing it:** [ADR-0029](0029-bot-sandboxes-plugins-and-live-browser.md). The `sbx` image, its fixed
spec, the egress proxy, the package approval flow and every hardening flag stay exactly as that record says. This
record adds what the image contains, one command, and when an existing sandbox moves to a new image. ADR-0042 is the
long-running bot tasks record (phase 07.17.1.1.2); this phase does not use it.

## Context

- The 403 Gertru hit is correct. ADR-0029 pins every package a bot installs through an admin's approval, and the egress
  proxy refuses an unapproved index. Opening the proxy, or approving a large tree per organization, would trade the
  supply-chain rule for convenience. Every organization needs the same reading tools, so the image should carry them.
- The sandbox is already the place where a hostile file may run: user 10001, read-only root, no capabilities,
  `no-new-privileges`, CPU, memory and pid limits, a 600 s exec limit, gVisor where the host has it. A parser
  exploit inside it gets what the bot already has, and no more.
- sandboxd keeps only the last 16 KiB of a command's output (`SANDBOX_LIMITS.outputTailBytes`). A bot that prints a
  whole PDF would see only its end, so the reading command must bound what it prints.
- Bots on v0.3.1 already have a sandbox container on the old image. sandboxd never re-created a container because the
  image changed, so an upgrade alone would not give them the toolkit.

## Decision

### 1. The Debian set: bookworm `main`, installed at build time (D-01, D-02, D-09, PD-13)

One apt layer in `infra/sandbox/sbx/Dockerfile`, before the setuid strip, from `bookworm`, `bookworm-updates` and
`bookworm-security` with `Components: main` only. The base digest is unchanged. The `dpkg-query -W` dump printed by the
image test (`test_toolkit.py`, plan 01), with LibreOffice 7.4 from bookworm:

```
poppler-utils 22.12.0-2+deb12u3
qpdf 11.3.0-1+deb12u1
tesseract-ocr 5.3.0-2
tesseract-ocr-eng 1:4.1.0-2
tesseract-ocr-spa 1:4.1.0-2
libreoffice-writer-nogui 4:7.4.7-1+deb12u14
libreoffice-calc-nogui 4:7.4.7-1+deb12u14
libreoffice-impress-nogui 4:7.4.7-1+deb12u14
imagemagick 8:6.9.11.60+dfsg-1.6+deb12u15
7zip 22.01+really26.02+dfsg-0+deb12u1
file 1:5.44-3
libimage-exiftool-perl 12.57+dfsg-1
catdoc 1:0.95-6~deb12u1
unrtf 0.21.10-clean-1
libemail-outlook-message-perl 0.921-1
fonts-dejavu-core 2.37-6
fonts-liberation2 2.1.5-1
fonts-crosextra-carlito 20220224-1
fonts-crosextra-caladea 20200211-1
```

The same test asserts `/etc/debian_version` 12.x, `soffice --version` starting `LibreOffice 7.4`, no installed version
containing `bpo`, `deb13` or `~exp`, and no setuid or setgid file. It passed on CI (Woodpecker pipeline 285, step
`sandbox-sbx-tests`).

**Left out, and why:**

- pandoc: about 220 MB on its own. LibreOffice and the Python libraries cover the formats.
- ghostscript: nothing in the set needs it. ImageMagick's PS, EPS and PDF coders are denied anyway.
- unar: `7zz` covers the same archives.
- graphicsmagick: it reads no HEIC.
- extract-msg: GPL, with a GPL/LGPL tree of about eight more pins. Debian's `msgconvert` turns `.msg` into `.eml`,
  which the stdlib `email` parser reads.
- odfpy: published as an sdist only, so `--only-binary :all:` refuses it. LibreOffice reads ODF.

Also absent, and asserted absent: Java, Firebird, hsqldb, the GStreamer backend and `libreoffice-base`. Only the
`-nogui` writer, calc and impress packages are installed.

**Hardening files** (root-owned, COPYed before the setuid strip):

- `/etc/ImageMagick-6/policy.xml`: deny every delegate, filter, `@` path and coder, then allow reading and writing only
  PNG, JPEG, GIF, WEBP, TIFF, BMP, HEIC/HEIF, AVIF, PNM/PBM/PGM/PPM and ICO. Limits: memory 256 MiB, map 512 MiB,
  16 KP per side, 128 MP area, disk 200 MiB, 120 s, 2 threads.
- `/usr/lib/libreoffice/share/registry/ocw.xcd`: five `oor:finalized` keys. `MacroSecurityLevel` is 3 and
  `DisableMacrosExecution` is true. `BlockUntrustedRefererLinks` is true. Writer and Calc link update is "never".

### 2. The Python lock: 26 hash-pinned wheels in a pip-less venv (D-01, D-03, D-09, PD-14, PD-15)

`infra/sandbox/sbx/tools/requirements.in` lists pypdf, pdfplumber, python-docx, openpyxl, python-pptx, pandas, Pillow,
pytesseract, charset-normalizer, beautifulsoup4, lxml and defusedxml. `tools/lock.sh` resolves it inside the image's
pinned base with its own Python 3.11.2 (pip-compile 7.6.2, `--generate-hashes`, wheels only) and never installs
anything while doing it. The result is `requirements.lock`, with **26 pins and 753 sha256 file hashes**, lock sha256
`857f81fd78a1b06d1167999282ee4ed3ad78b486ecb914448b09ea9a78939cdb`.

The image installs it with `--require-hashes --no-deps --only-binary :all:` into `/opt/ocw-tools/venv`, which has no
pip. `ocw_extract` goes to `/opt/ocw-tools/lib`, and `/opt/ocw-tools/bin` holds one curated link (`pdfplumber`). All of
it is root-owned.

- **Held back by the 14-day rule on 2026-11-12:** `pypdf<7.0.0`, `pandas<3.1.1`, `pypdfium2<5.15.0`,
  `python-dateutil<4.0.0` (the last brings `six` 1.17.0). Each line drops once its newer version passes the rule.
- **Dropped:** `xlrd`. Its LICENSE adds a four-clause BSD-style text with an advertising clause, which is outside the
  allow list. Legacy `.xls` files are read through LibreOffice instead.
- **Licenses.** `tools/licenses.json` holds one SPDX record per pin, and `pnpm guard` joins it with the lock. A pin
  without a record, a stale record or a denied license fails the guard. The allow list gains `MIT-CMU` (Pillow) and
  `PSF-2.0` (defusedxml, typing-extensions). `pypdfium2@5.14.0` is a version-pinned exception. It bundles PDFium with
  FTL, Unicode-3.0, IJG, libpng-2.0 and the AGG 2.3 notice. All of these are permissive and none is copyleft, but they
  are outside the allow list. A version bump reopens the review.
- **Pre-install evidence** (plan 02, re-run in 03 after the xlrd drop): `scripts/sandbox-lock-evidence.mjs` returned
  `ok: true` with (a) to (e) true and nothing to hold back.
  - (a) Every hashed file is at least 14 days old. The youngest is xlsxwriter 3.3.1 at 14.87 days.
  - (b) Nothing is yanked.
  - (c) OSV reports no advisory.
  - (d) No verdict is `SLOP`, and every `SUS` matched the project's own repository.
  - (e) The `requirements.in` closure holds.
- **Approval before merge** (07 T3): the merge evidence on the final tree, (a) to (f), plus who approved and when, is
  recorded in `07.17.1.1.1-07-SUMMARY.md`. Check (f) compares the installed versions printed by CI with the lock.

On the bot's shell, `PATH` ends with `…:/sbin:/bin:/opt/ocw-tools/bin:/opt/ocw-packages/bin`, and `PYTHONPATH` is
`/opt/ocw-tools/venv/lib/python3.11/site-packages:/opt/ocw-packages/python`. The toolkit comes after the system paths
and before approved packages. An approved Python package with the same name as a toolkit package is shadowed by the
toolkit's copy. Installer and review runs (`runEnv`) never see the toolkit.

### 3. `ocw-extract`: one bounded command for any supported file (D-04, D-11, PD-06 … PD-09)

`/usr/local/bin/ocw-extract` (`#!/opt/ocw-tools/venv/bin/python3 -I`) prints the UTF-8 text of a file under
`/workspace`. `ocw-extract --types` lists the 36 supported types:

- PDF, with OCR for pages that have no text layer (spa+eng)
- docx/doc/odt/fodt/rtf
- pptx/ppt/odp/fodp
- xlsx/xlsm/xls/ods/fods as `### sheet:` CSV
- csv/tsv/txt/md/json/xml/html
- eml/msg
- zip/7z/tar/tar.gz, listed but not extracted
- png/jpeg/gif/webp/tiff/bmp/avif/heic, as exiftool metadata plus OCR

No image format was dropped: the AVIF (Pillow) and HEIC (ImageMagick) fixtures are generated and OCR'd in the image
test.

- **Contract.**
  - `ocw-extract <file> [--ocr auto|always|never] [--pages A-B] [--max-chars N] [--lang …] [-o FILE]`.
  - Exit codes: 0 ok, 2 usage, 3 unsupported type, 4 path outside `/workspace`, 5 encrypted, 6 a cap was hit,
    7 failed.
- **Bounds.**
  - Stdout is never over 16 384 bytes (12 000 characters by default, 15 000 at most), and the footer says what was
    cut. `-o FILE` writes the whole text, up to 64 MiB.
  - PDFs go one page at a time. OCR rasterizes at 300 dpi scaled to 3 500 px and covers at most 50 pages per call.
  - Archives: 1 GiB in total, 10 000 entries, a size ratio of 100, depth 1, no links, no `..` or absolute paths. A
    size watcher kills an extraction whose real size passes the cap (exit 6).
- **Batch.**
  - `ocw-extract --batch <folder|archive> [--out DIR] [--budget S]` writes a `.txt` mirror tree and `_index.tsv` under
    `/workspace/extracted/<name>`. Originals are never copied, moved or changed.
  - Before every child step, the remaining budget (default 450 s, at most 470) is checked. A step that would not fit is
    never started: the run writes the index and exits **75** ("more to do, run again"). Finished entries are skipped
    on the next run, and PDFs resume page by page.
  - 470 s plus the longest step (120 s) stays under the 600 s exec limit (an import-time assertion), so `ocw-run`
    never kills a batch.
- **Isolation.** `-I` and a fixed `sys.path` mean PYTHONPATH and the current folder never reach the command.
  - Every child is an argv list in its own session, with a step timeout, a process-group kill, `RLIMIT_CPU`,
    `RLIMIT_FSIZE` and `PR_SET_PDEATHSIG`.
  - Children get six environment variables and no proxy variable. LibreOffice and ImageMagick therefore have no network
    path at all when run through `ocw-extract`.
  - Every parser (openpyxl, python-pptx, bs4, lxml, `email`, Pillow, `tarfile`) runs in a child interpreter.
  - An OOXML part that declares a DTD or an entity is refused.
  - LibreOffice gets a throwaway profile under `/tmp`, and scratch space goes to a private 0700 folder under
    `/workspace/.ocw-extract-tmp`. Both are removed after every run.

The bot is told: the `ocw_sandbox_exec` description ends with one paragraph naming the toolkit and `ocw-extract`, and
the attachments how-to says to read an imported file with it (plan 06). The cell image ships that text with v0.3.2.

### 4. Existing sandboxes move to the new image: the drift re-create (D-10, PD-10)

- **`ensure` on a stopped shell.** If the container's image ID differs from the current `sbx` image's ID, or its
  environment lacks a line of the current `SHELL_ENV`, sandboxd removes the container and creates it again. This sits
  next to the existing stale-hosts rule. Only the container goes: the workspace and packages volumes stay. The log line
  carries `recreated: "hosts" | "image" | "env" | null`.
- **`ensure` on a running shell.** It never touches it: the shell is not inspected for drift, stopped or removed.
- **`restart` on a running drifted shell.** It re-creates the shell on the new image. A restart already stops the
  shell's commands, so nothing extra is cut. An up-to-date shell gets the plain restart as before.
- **Unknown image.** When the image cannot be inspected, or the container reports no image, nothing is re-created and
  sandboxd logs one `image_unknown` warning with ids only.
- **The kill switch** is checked again right before removal.

Proven by `image-drift.test.ts` (fake Docker) and by the smoke's `drift` section on real Docker. In that smoke a stopped
shell is re-created after a same-tag rebuild with its file intact, a running shell is untouched until it stops, and
restart moves it.

### 5. Size

The root filesystem (`du -sxm /`) grows from 422 MiB to **1 087 MiB on CI amd64** (pipeline 285) and 1 102 MiB on
local arm64. The gate is 1 300 MiB, enforced by `run-sbx-image-tests.sh`. The compressed size depends on the image
store and is reported, not gated. `docker image inspect` gave 328 MB locally after the Debian layer, before the venv. The
research estimated about 408 MB for the full image, up from about 138 MB. `infra/ci/disk-budget.sh` now budgets about
2.3 GB for the sandbox images.

### 6. gVisor

LibreOffice, tesseract, pdftoppm and ImageMagick under `runsc` are proven only on CI, by the sandbox workflow's
`gvisor-smoke --only core,docs`. That step must print `runtime gvisor` and the docs OCR line. A failure there is fixed,
never skipped (PD-18). At acceptance the gVisor run of the final tree was still in progress on PR #74. Its result is
recorded in `07.17.1.1.1-VALIDATION.md`, and a red run blocks the merge. Docker Desktop has no `runsc`, so it was not
run locally.

## Consequences

- **What people see.** A bot reads PDFs (scans included, in Spanish and English), images, Word, Excel, PowerPoint and
  OpenDocument files, e-mails and archives without installing anything. A large folder is read in background chunks
  (exit 75, then again). Existing bots get the toolkit at their sandbox's next start: after the 15-minute idle stop, or
  at once with Restart, which re-creates a running sandbox on the new image and stops what it was running.
- **Not changed.** The egress proxy, the package approval flow and API-side attachment extraction (ADR-0037).
  `ocw_sandbox_import` still brings a chat attachment into the sandbox.
- **Operators.** `docker image prune` removes the old `sbx` image after the upgrade. The image is about 270 MB larger
  compressed.

### Residual risk: LibreOffice, poppler and ImageMagick on bookworm (D-08)

Read from the Debian security tracker on **2026-11-12**
(`https://security-tracker.debian.org/tracker/source-package/libreoffice`, `…/poppler`, `…/imagemagick`, "Open issues"
with bookworm not fixed):

- **LibreOffice 7.4.7: 14 open, all "vulnerable"** in bookworm. All are fixed in trixie-security, forky and sid.

  | CVE | Class |
  | --- | --- |
  | CVE-2026-63266 | Calc external data link opens an embedded Firebird database that writes a file anywhere |
  | CVE-2026-63267 | Calc external CSV link fetched on load: local file read or request to a chosen host (SSRF) |
  | CVE-2026-63268 | Calc `sql` data link reads local text files on load |
  | CVE-2026-63269 | linked media as an HLS playlist makes GStreamer read local files and remote URLs |
  | CVE-2026-63270 | URLs expanding environment or INI values, exfiltrated on open (XForms, Calc providers) |
  | CVE-2026-63272 | heap buffer overflow in WMF import |
  | CVE-2026-63273 | heap buffer overflow in PDF import (encryption key length) |
  | CVE-2026-63274 | heap buffer overflow in PDF import (stream length) |
  | CVE-2026-63275 | stack buffer overflow reading CFF font hints |
  | CVE-2026-63276 | stack buffer overflow converting CFF to Type 1 during PDF export |
  | CVE-2026-63277 | Calc external data link loads a Java database driver from a remote location (RCE) |
  | CVE-2026-63278 | environment or INI expansion through another name of the package content provider |
  | CVE-2026-63279 | out-of-bounds read in PICT import (palette index) |
  | CVE-2026-76181 | heap overflow and unbounded recursion in the dBASE driver's index pages |

- **poppler 22.12: 10 open.** CVE-2026-107705 is "vulnerable": a stack overflow in `Decrypt::revision6Hash` when the
  caller supplies a password over 127 bytes. Seven are "no DSA, postponed":
  - CVE-2026-102620: integer overflow, `FoFiTrueType::cvtSfnts`
  - CVE-2026-102621: integer overflow, `SplashClip::clipToPath`
  - CVE-2026-93311: integer overflow, `SampledFunction`
  - CVE-2026-93312: null dereference, `JBIG2Stream::rewind`
  - CVE-2026-93313: integer overflow, `JBIG2Stream::readCodeTableSeg`
  - CVE-2026-93314: integer overflow, `FoFiTrueType::mapCodeToGID`
  - CVE-2026-93653: denial of service, a Splash tiling-pattern loop

  Two are "ignored": CVE-2019-9543 and CVE-2019-9545, recursion.
- **ImageMagick 6.9.11: 3 open.**
  - CVE-2026-123273 ("vulnerable"): an infinite loop in the SVG decoder.
  - CVE-2026-109282 ("postponed"): type confusion in the INFO, JSON and YAML encoders.
  - CVE-2026-119123 ("postponed"): a stack overflow in the TIFF decoder.

**Mitigations.**

- **Everything runs in the bot's own sandbox.** That means user 10001, a read-only root, no capabilities and
  `no-new-privileges`. CPU, memory and pid limits apply, and gVisor where the host has it. A memory-corruption exploit
  in any parser reaches only that bot's sandbox files.
- **The backends the load-time CVEs need are not installed.** Java (63277), Firebird (63266), GStreamer (63269), hsqldb
  and `libreoffice-base` are all absent, and their absence is asserted by the image test. A `.dbf` or `.ndx` is not a
  type `ocw-extract` opens (76181).
- **No network path for conversions run by `ocw-extract`.** Their children carry no proxy variable (63267, 63270,
  63278). A bot's own `soffice` call goes through the egress proxy, which by default allows no host.
- **No secret in the shell's environment.** `SHELL_ENV` carries none (spec test), so an environment or INI expansion
  leaks nothing secret.
- **Link updates are finalized to "never"** (63267, 63268), and macros are off.
- **ImageMagick's policy** denies the SVG, INFO, JSON and YAML coders (123273, 109282).
- **Bounded work.** The TIFF crash (119123) and the poppler denial-of-service cases end at the step timeout and
  `RLIMIT_CPU`.
- **Passwords.** `ocw-extract` never passes a password to poppler (107705); an encrypted PDF exits 5.

**Macro proof, as plan 05 recorded it: fired.** The fixture `macro.fodt` has an embedded Basic module bound to its load
event, which writes a marker file.

- In the real image the marker is never written, whether the file goes through `ocw-extract`, through the bot's own
  `soffice --headless --convert-to pdf` with a profile in `/workspace`, or through a headless open after seeding
  `MacroSecurityLevel` 0 in the user profile.
- In a test-only image derived from `sbx` without `ocw.xcd`, the same headless open writes the marker.

So the finalized keys in `share/registry/ocw.xcd` win over a user profile (A-02). This is a behavioural proof, not a
configuration-only one. It ran locally on runc, and the CI `sandbox-smoke` runs it on every PR. Under gVisor the
control is skipped with one line.

**Follow-up: move `sbx` to trixie.** That fixes the 14 LibreOffice CVEs (trixie-security ships 25.2.3) and the newer
poppler and ImageMagick issues. It needs:

- a re-review of every approved Debian package and of every organization's approved PyPI packages against the new
  base;
- the toolkit lock moved from cp311 to cp313 (Python 3.13), as a new lock with new evidence and a new approval;
- a new `dpkg-query` dump and size measurement.

It is a later phase, not this one.

### Flagged assumptions

- **A-01.** The toolkit works under gVisor systrap. Proven only by `gvisor-smoke` on CI (§ 6).
- **A-02.** Proven true: see the macro proof.
- **A-03.** OCR takes 1.5 to 4 s per page on shared amd64. The budget rule and per-page resume make the exact figure
  irrelevant to correctness.
- **A-05.** Proven true: AVIF and HEIC are both read and OCR'd.
- **A-06.** Closed by the scripted evidence (a) to (f) and the approval before merge.

### Out of scope (PD-20)

- audio and video transcription;
- OCR languages beyond Spanish and English;
- pandoc;
- the move to trixie (recorded above as a follow-up);
- changes to the egress proxy or the package approval flow;
- API-side attachment extraction (07.15);
- cross-turn long jobs (phase 07.17.1.1.2 and ADR-0042).

AGENTS.md's "Bot sandboxes and browser" row names the toolkit, `ocw-extract` and the drift re-create, and cites this
record next to ADR-0029.

## Amendment (code review)

**Date:** 2026-11-12. The phase's code review
(`.planning/phases/07.17.1.1.1-sandbox-document-toolkit-bots-read-pdfs-incl-scanned-ocr-ima/07.17.1.1.1-REVIEW.md`,
findings CR-01 to IN-08, fix log at its end) found places where the behaviour fell short of the text above. The
decision stands. The points below change behaviour, and where they name a sentence above, they replace it.

- **Exit codes.** They are now 0, 2 to 7 as before, **8** (a `--batch` run made no progress: do not run it again), and
  75.
- **The batch follows the real exec timeout (CR-01).**
  - `ocw-run` exports `SBX_EXEC_DEADLINE_S`. `--batch` cuts its budget so a chunk ends 130 s (the longest step plus
    10 s) before that deadline.
  - It refuses to start, with exit 2 and a message naming `background true` and `timeoutSeconds 600`, when less than
    130 s would be left. With the API's default 120 s, the bot therefore gets the way out at once instead of a
    SIGKILL mid-chunk.
  - This replaces § 3's "470 s plus the longest step … so `ocw-run` never kills a batch", which held only for a 600 s
    timeout. The exec tool description now says `run it with background true and timeoutSeconds 600`.
- **Every batch run moves on (CR-02).**
  - `--budget` takes 130 to 470 s, so no budget is shorter than the step it waits for.
  - Office files read through a PDF (writer documents with `--ocr always`, presentations other than a pptx) resume
    per page like PDFs.
  - When nothing moved in a run, the entry that used the whole budget is failed (`did not fit in one run`). A page
    that alone does not fit is written as skipped, and its file goes on.
  - A run that ends with the index it loaded exits 8, never 75. Steps run with their nominal timeout; the
    "min(T, R)" of § 3 was never implemented.
- **One batch per output folder (WR-07).** An exclusive lock on `_index.tsv.lock` is held for the whole run. A second
  run on the same folder is refused with exit 2.
- **Single files are time-bounded too (WR-05).**
  - Under `ocw-run`, a single-file read ends 10 s before the deadline. A PDF or a document read through its PDF stops
    at the last page read and says which pages are left. Anything else exits 7, naming a longer `timeoutSeconds`.
  - In stdout mode, the read also stops once the capped output is full.
- **Children and the kill (WR-01, IN-03).** This replaces § 3's "every child is an argv list in its own session, with
  … a process-group kill".
  - Children stay in `ocw-extract`'s process group, which is the group `ocw-run` records and kills. When
    `ocw-extract` is killed, every grandchild dies with it, LibreOffice's `soffice.bin` included.
  - A step timeout kills the child's whole tree, found through `/proc`. `ocw-extract` is a child subreaper, and it
    kills the tree before it reaps the child.
- **Images (WR-02).**
  - The cap is really 128 MP: Pillow's warning band between 1 and 2 times the limit is an error.
  - Every PNG, JPEG, TIFF, WEBP and BMP is probed frame by frame from its headers before tesseract sees it, and a
    multi-page TIFF is OCR'd frame by frame, up to 50 frames.
  - Images are reduced in place, never copied at full size.
- **OOXML and ODF files (WR-03, WR-04).** The sentence "An OOXML part that declares a DTD or an entity is refused" is
  now true for every part, whatever its name, its encoding or its length:
  - lxml reads each part up to its first element, with entities, DTD loading and the network off.
  - A part that starts like XML but cannot be parsed is scanned whole, in UTF-8, UTF-16 and UTF-32.
  - Media and opaque blobs are skipped: printer settings may embed a plist with a doctype.
  - docx is now checked before LibreOffice opens it.
  - Before any parser, an OOXML or ODF zip meets the archive caps (ratio, entry count, links, paths) and a 512 MiB
    uncompressed total (exit 6).
- **Archives (WR-06, IN-02).**
  - sandboxd tells every exec the room left under the bot's soft quota (`SBX_DISK_ROOM_BYTES`). The archive caps and
    the size watcher use the smaller of the free space and that room, minus 64 MiB.
  - The 100:1 ratio applies to the whole archive for every type, not only to tar.
- **Scratch after a kill (WR-06).** This qualifies § 3's "Both are removed after every run".
  - Scratch folders and LibreOffice profiles carry their run's pid and start time, and the next run removes those of
    a run that is gone, at once.
  - Over quota, once the shell has stopped, sandboxd removes `/workspace/.ocw-extract-tmp` through the files helper
    and measures again.
- **PYTHONPATH (WR-08).**
  - § 2's "The toolkit comes after the system paths and before approved packages. An approved Python package with the
    same name as a toolkit package is shadowed by the toolkit's copy" is replaced. The order is now
    `/opt/ocw-packages/python:/opt/ocw-tools/venv/lib/python3.11/site-packages`, so an approved package and the
    versions its approval pinned win.
  - `ocw-extract` runs isolated and is unaffected. `PATH` is unchanged.
  - Existing shells converge through the environment drift re-create of § 4.
- **The kill switch on restart (WR-09).** The restart re-create checks the policy again after the create, and kills a
  shell that started while the organization was killed, as `ensure` does. This adds to § 4's "checked again right
  before removal".
- **The files helper (IN-08).** An idle `files` helper built from an older image is created again before it is reused.
- **Network wording (IN-01).** § 3's "LibreOffice and ImageMagick therefore have no network path at all" overstated
  it, and is replaced:
  - Children get no proxy variable. The only host the shell's network reaches is the egress proxy, by its
    `/etc/hosts` name, and the proxy refuses origin-form requests and allows no host by default.
  - The link and referer settings of `ocw.xcd` stay. `ocw.xcd` now also finalizes Calc's recalculation on load to
    never, for OOXML and ODF, so a WEBSERVICE-style formula never runs.
- **Text (IN-04).** `ocw-extract` also removes C1 controls and the bidi embeddings, overrides and isolates.
- **The pypdfium2 exception (WR-10).** Its status in `scripts/guard/license-policy.json` records the approval of
  2026-11-12 and the lock sha256.
