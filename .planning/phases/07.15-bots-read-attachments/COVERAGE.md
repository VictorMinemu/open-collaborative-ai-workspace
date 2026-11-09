# API Coverage — unpdf (PDF.js, server-side PDF text)

> Full coverage by default. Opt-outs are explicit, reasoned decisions.
>
> The detector fired on the phrase "Agent Channel API", which is this repository's own internal API (no external
> service is integrated in Phase 07.15). The only third-party surface the phase adopts is the `unpdf@1.9.1` library
> (D-05, D-12), so its capability surface is decided here. Plans: 07.15-05 (worker, caps), 07.15-11 (ADR-0037).

| capability | decision | reason |
|---|---|---|
| getDocumentProxy | INTEGRATE | |
| getPage / getTextContent (per-page text) | INTEGRATE | |
| getResolvedPDFJS (bundled PDF.js version check) | INTEGRATE | |
| extractText (whole-document helper) | OPT-OUT | the per-page loop is used instead so the page cap and the character cap stop parsing early |
| getMeta (document metadata) | OPT-OUT | not needed: the bot reads text only; metadata can carry author names and paths that add nothing |
| extractLinks | OPT-OUT | not needed: links are part of the extracted text when present; no separate link list in this phase |
| extractImages | OPT-OUT | explicitly out of scope: OCR and images inside PDFs are deferred (CONTEXT Deferred) |
| renderPageAsImage | OPT-OUT | explicitly out of scope: needs a canvas backend (native binaries) and serves OCR, which is deferred |
| definePDFJSModule (custom PDF.js build) | OPT-OUT | not needed yet: only if unpdf lags a PDF.js security fix (RESEARCH alternatives); ADR-0037 records it |
