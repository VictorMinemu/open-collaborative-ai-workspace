# Bot sandboxes and the live browser

Each bot can get its own sandbox, where it writes files, runs commands and uses approved packages, and its own
browser, which people watch live in a small window and take over to sign in. The API decides, limits, audits and can
stop every call. The decisions behind this page are in
[ADR-0029](../adr/0029-bot-sandboxes-plugins-and-live-browser.md); images, smokes and host hardening are in
[infra/sandbox/README.md](../../infra/sandbox/README.md).

**Isolation, in one sentence.** Each bot runs in its own containers on its own private networks, under gVisor where
your Docker has it (Settings says "Isolated with gVisor") and otherwise in hardened containers that share the host's
kernel, a weaker boundary that Settings states ("Hardened container · weaker isolation").

## Turn it on

Three switches, all off by default. Nothing runs until all three are on.

1. **The compose profile** (the server). Add to `.env` (append `sandbox` if `COMPOSE_PROFILES` already exists), then
   `docker compose up -d --build --wait`:

   ```dotenv
   COMPOSE_PROFILES=sandbox
   OCW_SANDBOX_URL=http://sandboxd:8090
   ```

   `OCW_SANDBOX_TOKEN` is written by `pnpm ocw setup` (`pnpm ocw setup --add-missing` adds it to an older install).
   Docker Engine 26 or later is required. See [INSTALL.md](../INSTALL.md#bot-sandboxes-and-browser-optional-sandbox-profile).
2. **The organization switch** (an admin). Settings › **Sandbox & Browser** › *Sandbox & Browser for the
   organization*. Turning it on shows the isolation your server gives before you confirm.
3. **The bot's switches** (whoever configures the bot). Bots › the bot › **Capabilities** › Sandbox and Browser.

Admins and leads can keep a team out with Settings › **Modules** (Sandbox, Browser), per organization, unit or person.
A module that is off wins over every switch.

## Settings › Sandbox & Browser

| Section | What it controls | Default |
| --- | --- | --- |
| **Isolation** | Read only: gVisor, hardened containers, *service not reachable*, or *Docker too old*; for the browser, *container-only* when Chromium cannot use its own sandbox on this host | — |
| **Limits** | Sandboxes running at once (0–100), browsers at once (0–50), CPU minutes per day (1–100,000), disk per bot (1–100 GB), disk in total (1–1,024 GB), how long a sign-in lasts (1–90 days) | 10, 3, 600, 2 GB, 50 GB, 30 days |
| **Network** | The browser's and the shell's internet access: **Off**, **Allowlist** (only the hosts you list, up to 64) or **Public** (any public host). Private hosts come from Settings › MCP servers › *Private network hosts* | Browser Public, Shell Allowlist |
| **Sandbox packages** | Approved npm, PyPI, Debian and ClawHub packages for every bot's sandbox (below) | none |
| **Stop everything** | The kill switch: stops every sandbox and browser at once, including anyone signing in. Files are kept. Resume turns it back on | — |

Each container also has fixed limits: a shell 1 CPU, 1 GB of memory and 256 processes, stopped after 15 idle minutes; a
browser 1 CPU, 2 GB and 512 processes, closed 5 minutes after its last use (15 while a sign-in or an approval waits).
Settings are versioned: if another admin saved first, the page shows the current values and asks you to save again.

## The network

- Every sandbox reaches the outside only through the `sandbox-egress` proxy, which applies the same rules as the API's
  own outbound guard: public addresses only, ports 80 and 443, your private hosts by exact `host:port`, and never a
  platform service (the API, the database, the cell, sandboxd, the proxy itself), cloud metadata or another bot.
- A bot can never reach another bot's shell, browser or files, even if you list them as private hosts.
- The proxy never intercepts TLS and logs the host only, never a path or a query. Each new host a bot reaches (or is
  refused) is audited once an hour as `sandbox.egress`.

## Sandbox packages

Bots can install their own dependencies with commands, under the network rules. For something every bot should have,
an admin approves a **sandbox package**:

1. **Add package**: source (npm, PyPI, Debian, ClawHub skill), the exact name and one exact version.
2. The review runs in a throwaway container and shows the digest, license, publisher, size, whether it runs an install
   script, **how many dependencies it pulls, each pinned by hash**, and the risk with its reasons. High risk needs you
   to type `install anyway`; refused packages cannot be approved.
3. **Approve**: it installs in each bot's sandbox when that sandbox next starts, from exactly the recorded tree (`npm
   ci` from the stored lockfile, `pip --no-deps --require-hashes`, a sha256 per Debian or ClawHub file). Personal bots
   get it only with *Personal bots* on.

If the package or any of its dependencies changed upstream since the review, approval is refused and the review is
refreshed; after approval, the install is refused, nothing is written, and the row reads **Changed upstream** until you
review and approve it again. Native OpenClaw plugins with shell, file or browser tools stay refused in the Marketplace:
they would run inside the bot runtime, not a sandbox.

## Documents in the sandbox

Every bot's shell already has the tools to read documents, so a bot never needs to install anything for it
([ADR-0043](../adr/0043-sandbox-document-toolkit.md)):

- **What is installed.**
  - From Debian bookworm `main`:
    - poppler (`pdftotext`, `pdftoppm`, `pdfinfo`, `pdfimages`) and `qpdf`;
    - tesseract OCR with English and Spanish;
    - LibreOffice 7.4 without a GUI (Writer, Calc, Impress);
    - ImageMagick, limited to raster image formats;
    - 7-Zip, `file`, exiftool, catdoc, unrtf and `msgconvert` (Outlook `.msg`).
  - A hash-locked Python environment in `/opt/ocw-tools`: pypdf, pdfplumber, python-docx, openpyxl, python-pptx,
    pandas, Pillow, pytesseract, charset-normalizer, beautifulsoup4, lxml and defusedxml. The bot's `python3` imports
    them directly.
- **`ocw-extract`.** This one command turns a file into bounded UTF-8 text. It reads:
  - PDFs, scanned PDFs included;
  - images (PNG, JPEG, GIF, WEBP, TIFF, BMP, AVIF, HEIC), with OCR;
  - Word, Excel, PowerPoint and OpenDocument files;
  - CSV, JSON, XML and HTML;
  - `.eml` and `.msg` e-mails;
  - zip, 7z and tar archives.

  The bot runs, for example:

  ```bash
  ocw-extract informe.pdf                          # the text, at most 16 KiB on screen
  ocw-extract escaneo.pdf --pages 1-5 -o escaneo.txt   # OCR of five pages into a file
  ocw-extract --batch paquete/                     # a whole folder into /workspace/extracted/paquete/
  ```

  `ocw-extract --types` lists every supported type, and `--help` lists the exit codes.
- **Batch and exit 75.** `--batch` writes one `.txt` per file, plus an `_index.tsv`, under `/workspace/extracted/`. It
  never copies or changes the originals. The bot runs it as a background command with a 600 s timeout
  (`timeoutSeconds 600`); each run sizes its chunk from that timeout and stops before it, and a shorter timeout (the
  default is 120 s) is refused at once with a message saying so. While files remain, it exits **75**: the bot runs it
  again until it exits 0. Finished files are skipped and long PDFs and Office files go on at the next page, so a pack
  of thousands of files is read in chunks. A file that cannot be read within one run is marked failed (or its page
  skipped) and the batch goes on; a run that made no progress at all exits **8** instead of looping. Only one batch
  writes an output folder at a time.
- **Long single files.** Reading one file stops 10 s before the command's timeout and prints what it read, with a
  note naming the next pages (`--pages`), so a long scan never ends with nothing on screen.
- **Size.** The shell image is about 1.1 GB on disk, up from about 0.4 GB (CI measured 1 087 MiB), and about 270 MB
  larger to download.
- **Nothing is installed at runtime.** If a bot still tries `pip install` or `apt-get`, the proxy answers **403**,
  which is expected: packages for every bot go through *Sandbox packages* above. An approved Python package, and the
  versions its approval pinned (for example `numpy<2`), wins over the toolkit's copy of the same package: approved
  packages come first on the shell's `PYTHONPATH`. `ocw-extract` itself always uses the toolkit's own versions.
- **Disk quota.** An archive is extracted only within the room left under the bot's disk quota. If a killed run
  leaves its scratch folder behind and the workspace goes over quota, sandboxd removes that folder once the sandbox
  has stopped and measures again.
- **Residual risk.** LibreOffice 7.4, poppler and ImageMagick on bookworm have open CVEs. The macro, link and network
  mitigations, the CVE list and the plan to move the image to Debian trixie are in
  [ADR-0043](../adr/0043-sandbox-document-toolkit.md). A hostile document stays inside that bot's own sandbox.

## Signing in for a bot

When a page needs an account, the bot posts a **Sign in needed** card. Only the person who asked sees **Open and sign
in**: they take control of the page in the live view, sign in themselves and **Hand back**.

- While they are in control, and whenever their sign-in is loaded in the page, nobody else receives a frame (others see
  *Private sign-in in progress* or *Private browsing for {person}*).
- The bot, the model, logs and the audit never see what they type; password fields are masked in everything the bot
  reads.
- The sign-in is sealed for that person, that site and that bot only, and reused only in that person's private chats
  with that bot. It lasts until the site's cookies expire or the organization's maximum, and the person revokes it in
  Settings › **Keychain** › *Browser sessions*. Admins never see it.
- Once a sign-in was used in a conversation, the bot asks that person before opening another site, clicking a link
  that leaves the site, or running a command with internet access, and team bots stop writing to their shared
  workspace in that conversation.

## Limits to know

- **Disk** is a soft quota: sandboxd measures before writes and every minute and stops a sandbox that goes over. For a
  hard limit, use XFS project quotas (infra/sandbox/README.md). The packages volume has no quota of its own.
- **Proxy restarts:** a running sandbox keeps the proxy's old address until its next start or restart, and has no
  internet until then (it fails closed).
- **Upgrading the sandbox image:** existing sandboxes get the new image, and with it the document toolkit, at their
  next start. A sandbox left alone picks it up after its 15-minute idle stop. **Restart** on the bot's **Sandbox** tab re-creates a
  running sandbox on the new image at once, and so stops what it was running. A bot's files and packages are kept.
  Afterwards, `docker image prune` removes the old image.
- **Removing it:** `docker compose down` does not remove bot containers, because sandboxd created them. They go when a
  bot is deleted; to remove them all, filter by `label=ocw.namespace=<project>` (INSTALL.md).
- Not available: CAPTCHA solving, sharing a sign-in between people, recording sessions, desktop computer use.
