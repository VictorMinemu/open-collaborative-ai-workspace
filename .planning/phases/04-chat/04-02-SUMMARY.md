---
phase: 04-chat
plan: 02
subsystem: ui
tags: [markdown, streamdown, shiki, xss, vitest, playwright]

requires:
  - phase: 03.2
    provides: Work Zone event stream (assistant items with `streaming`), fake local-runtime device
provides:
  - "components/markdown/markdown.tsx: Markdown({text, variant chat|document, streaming}), MentionContext, MentionContextValue, MentionTarget"
  - "components/markdown/rehype-mentions.ts: rehypeMentions"
  - "components/markdown/safe-url.ts: safeUrl (URL allowlist judged on the browser-normalised URL)"
  - "vitest project `web` (apps/web/**/*.test.{ts,tsx}, node env, oxc automatic JSX, @ alias)"
  - "e2e/tests/renderer.spec.ts and before/after renderer-* screenshots"
  - "fake runtime OCW_RUNTIME_FAKE_ECHO=1 (answer repeats the prompt) for renderer e2e"
affects: [04-05 emoji picker (frimousse approved), 05 AI chats (same component), any plan rendering message bodies]

actuals:
  tokens: 16066
  tasks: 3
  commits: 4

tech-stack:
  added: ["streamdown@2.6.0", "@streamdown/code@1.1.1 (shiki)"]
  removed: ["react-markdown@10.1.0", "remark-gfm@4.0.1", "rehype-highlight@7.0.2"]
  patterns:
    - "One renderer, two variants: chat (compact, headings as bold paragraphs) and document (Work Zone)"
    - "Explicit rehype list [imagesAsLinks, streamdown's harden with our policy, rehypeMentions]; never rehype-raw"
    - "urlTransform = safeUrl(defaultUrlTransform(...)) as the final authority"
    - "Unlayered CSS on [data-streamdown=...] restyles streamdown's code block to the app's compact panel"

key-files:
  created:
    - apps/web/components/markdown/markdown.tsx
    - apps/web/components/markdown/rehype-mentions.ts
    - apps/web/components/markdown/safe-url.ts
    - apps/web/components/markdown/markdown.test.tsx
    - apps/web/components/markdown/safe-url.test.ts
    - e2e/tests/renderer.spec.ts
  modified:
    - apps/web/components/chat/markdown.tsx
    - apps/web/components/work-zone/markdown.tsx
    - apps/web/components/work-zone/event-stream.tsx
    - apps/web/app/globals.css
    - apps/web/app/(app)/chat/chat.css
    - apps/web/package.json
    - pnpm-lock.yaml
    - vitest.config.ts
    - apps/local-runtime/src/fake/fake-runtime.ts

key-decisions:
  - "Shipped pair: streamdown@2.6.0 + @streamdown/code@1.1.1 (compatible; the 2.7.0/2.0.0 fallback was not needed)"
  - "Images become links in a rehype step before hardening, so harden's link rules decide their URL and allowedImagePrefixes stays []"
  - "harden uses allowedLinkPrefixes ['*'] (prefixes like 'https://' never parse in rehype-harden 1.1.8 and would block every link); safeUrl narrows to http/https/mailto/same-origin"
  - "Code blocks keep streamdown's header (language + copy), no line numbers, no downloads, no table/image/mermaid controls"
  - "Code blocks above 20,000 characters are not highlighted (T-04-02-04)"

requirements-completed: [CHAT-05]

coverage:
  - id: D1
    description: "Channel messages, thread replies, bot DM answers and the Work Zone stream render through one Markdown component with GFM tables, lists, quotes, links, shiki-highlighted code and mention chips (chips where a mention directory exists)"
    requirement: CHAT-05
    verification:
      - kind: e2e
        ref: "e2e/tests/renderer.spec.ts (desktop + mobile, 6 tests)"
        status: pass
      - kind: unit
        ref: "apps/web/components/markdown/markdown.test.tsx"
        status: pass
    human_judgment: false
  - id: D2
    description: "No raw HTML, no unsafe URLs, no image pixels (script, on*, javascript:/data:/vbscript:, iframe, style, svg, control-character and entity-encoded schemes, protocol-relative, backslashes)"
    requirement: CHAT-05
    verification:
      - kind: unit
        ref: "apps/web/components/markdown/{markdown,safe-url}.test.ts(x) (98 tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "A streaming Work Zone answer with an unterminated fence renders as an incomplete code block, never literal backticks"
    requirement: CHAT-05
    verification:
      - kind: e2e
        ref: "playwright:renderer-workzone-streaming-1440.png / -390.png"
        status: pass
      - kind: unit
        ref: "markdown.test.tsx#Markdown: streaming (D-05)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Before/after visual parity of chat, thread, DM and Work Zone at 1440/390, light and dark (only change: code is highlighted and gains a language + copy header row)"
    verification:
      - kind: automated_ui
        ref: ".planning/phases/04-chat/screenshots/{before/,}renderer-*.png"
        status: pass
    human_judgment: true
    rationale: "Owner review of the new code-block header is a visual taste call (D-08)"

duration: 30min
completed: 2026-10-05
status: complete
---

# Phase 4 Plan 02: Shared Markdown Renderer Summary

**One streamdown-based `<Markdown>` (shiki highlighting, streaming-safe parsing, no raw HTML, browser-normalised URL allowlist) now renders chat, threads, bot DMs and the Work Zone, with the chat pixel-identical except highlighted code.**

## Performance

- **Duration:** ~30 min of execution (plus e2e/verify runs)
- **Started:** 2026-10-05T23:08Z
- **Completed:** 2026-10-05T23:40Z
- **Tasks:** 3 (Task 2 was the package checkpoint, approved by the orchestrator)
- **Files modified:** 15 source files + 34 screenshots

## Accomplishments

- `components/markdown/markdown.tsx` is the only renderer; `chat/markdown.tsx` and `work-zone/markdown.tsx` are thin adapters (unchanged import paths for message-list, channel-view, approval-banner, event-stream).
- New `web` vitest project runs inside `pnpm verify`: 98 tests (XSS fixtures, URL bypasses, mentions, tables, variants, streaming, 10,000-line block in ~200 ms).
- streamdown 2.6.0 + @streamdown/code 1.1.1 replace react-markdown/remark-gfm/rehype-highlight; highlight.js CSS deleted.
- Work Zone passes `streaming`; an open fence renders as a code block while the answer streams (screenshot `renderer-workzone-streaming-*`).

## Task Commits

1. **Task 1 baseline (RED for e2e):** `c822061` test(04-02): renderer e2e spec and baseline screenshots of the current renderers
2. **Task 1:** `30e99a9` feat(04-02): one shared Markdown renderer for chat, threads, DMs, bot output and the Work Zone
3. **Security fix (coordinator-flagged):** `5ae4413` fix(web): renderer URL allowlist judges the URL the browser parses, not the raw string
4. **Task 2:** checkpoint, no commit (approval recorded below)
5. **Task 3:** `d4fb8ae` feat(04-02): shared Markdown renderer runs on streamdown with shiki highlighting and streaming-safe parsing

## Package approval (Task 2, blocking-human gate)

Approved by the orchestrator under the owner's delegated decisions, with evidence gathered via `npm view` on 2026-10-05:

| Package | Pin | Published | Licence / repo | Install scripts |
|---|---|---|---|---|
| streamdown | 2.6.0 | 2026-08-24 | Apache-2.0, github.com/vercel/streamdown (maintainers incl. vercel-release-bot) | none |
| @streamdown/code | 1.1.1 | 2026-03-17 | same repo | none |
| frimousse | 0.4.0 | 2026-09-21 | MIT, github.com/liveblocks/frimousse | none (not installed here; Plan 05) |

All pins are older than 7 days; `pnpm install` passed the `minimumReleaseAge` supply-chain check and `pnpm install --frozen-lockfile` passes. **Shipped pair: streamdown@2.6.0 + @streamdown/code@1.1.1** (the 2.7.0 + 2.0.0 fallback was not needed).

## Screenshot review

Reviewed with the Read tool against `before/`: chat, thread, DM (light/dark, 1440/390) are pixel-identical in the message region on the current pipeline (Task 1; only timestamps/channel names differ). After streamdown (Task 3): spacing, mention chips, tables, lists, quotes and links unchanged; code is shiki-highlighted (github-light / github-dark), dark theme readable, wide lines scroll inside the block at 390 (as before); the only layout change is the slim header row (language label + copy button) on each code block. Work Zone gained highlighting; streaming capture shows an open fence as a code block with no backticks.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fake runtime cannot answer with a fenced block**
- **Found during:** Task 1 (renderer.spec Work Zone surface)
- **Issue:** the fake device's answer only quotes the prompt's first line; no way to stream a code block through the real Work Zone pipeline.
- **Fix:** `OCW_RUNTIME_FAKE_ECHO=1` makes the fake repeat the whole prompt in its answer (off by default; unit test added).
- **Files modified:** apps/local-runtime/src/fake/fake-runtime.ts (+ test)
- **Committed in:** c822061

**2. [Rule 3 - Blocking] Bot DM via test routes impossible in the isolated harness**
- **Found during:** Task 1 baseline run
- **Issue:** the isolated API does not run with NODE_ENV=test, so `/api/v1/test/chat/agent-reply` is 404.
- **Fix:** the DM test creates a mock-model team bot and answers through `FakeCellPlugin` (`replyText`), the same path as team-bot-dm.spec (real Agent Channel API output).
- **Committed in:** c822061

**3. [Rule 2 - Security, coordinator-flagged] safeUrl bypass with control characters**
- **Found during:** automated security review of 30e99a9
- **Issue:** `\u0001javascript:` / `java\tscript:` passed the scheme regex as "relative" and browsers strip those characters, running javascript:.
- **Fix:** `safe-url.ts`: strip C0 controls + DEL, trim, refuse protocol-relative in any slash/backslash spelling, parse with `new URL()` and keep only http/https/mailto or same-origin references; composed after the engine's `defaultUrlTransform`; applied to the streamdown pipeline too. 52 new fixtures (tab, LF, CR, NUL, DEL, leading/trailing controls, mixed case, data:, vbscript:, file:, blob:, //evil, backslashes, decimal/hex/named entities).
- **Committed in:** 5ae4413

**4. [Rule 2 - DoS] Highlighting a 10,000-line block took ~990 ms**
- **Found during:** Task 1 (flaky 1 s fixture)
- **Fix:** blocks over 20,000 characters are not highlighted (kept on streamdown by dropping their language); fixture now ~200 ms.
- **Committed in:** 30e99a9, d4fb8ae

**5. [Rule 1 - Spec mismatch] Plan's harden config would block all http(s) links**
- **Issue:** rehype-harden 1.1.8 cannot parse prefixes like `"https://"`, so the research config blocks every link; `allowedImagePrefixes: []` would also turn images into "[Image blocked]" text instead of links.
- **Fix:** images are turned into links before harden; harden uses `["*"]` (http(s) + root-relative only, mailto as safe protocol, blocked links as text) and `safeUrl` narrows the rest. Absolute URLs come back normalised (`http://example.com` → `http://example.com/`).
- **Committed in:** d4fb8ae

**6. [Scope] Acceptance grep for chat/markdown.tsx** - the adapter imports and re-exports from the shared module in one import statement so the criterion prints exactly two lines.

---

**Total deviations:** 6 (2 blocking test-support, 2 security, 1 spec mismatch, 1 cosmetic). **Impact:** all necessary for correctness/security; no scope creep.

## Issues Encountered

- streamdown wraps output in `space-y-4`; overridden with `className="space-y-0"` so spacing stays per element (chat parity).
- The test-agent route is unavailable in the isolated harness (see deviation 2).

## Known limitations / open issues

- **Mention chips in DMs and the Work Zone:** the component supports chips everywhere, but `dm-view.tsx` and the Work Zone provide no `MentionContext`, so `@handle` stays plain text there (as before). dm-view.tsx belongs to Plan 01 in this wave; a later DM plan should wrap it in `MentionContext.Provider` (one line using `useOrgDirectory`).
- Bare relative links without a leading slash (`[x](docs/readme)`) are now shown as text (harden refuses them); root-relative permalinks (`/chat/...`) work.
- SUMMARY records 34 screenshots: `before/renderer-*` (16) and `renderer-*` (18 incl. 2 streaming).

## Verification

- `pnpm exec vitest run --project web` → 2 files, 98 tests passed
- `pnpm verify` (after Task 3) → lint clean (4 pre-existing warnings in apps/local-runtime), typecheck 8/8, 113 files / 1557 tests passed
- `pnpm install --frozen-lockfile` → passes
- `bash scripts/e2e-isolated.sh --rebuild-web renderer chat.spec work-zone.spec` → 11 passed (desktop + mobile), none skipped or flaky
- Acceptance greps: streamdown imported only in components/markdown/markdown.tsx; no react-markdown imports; `hljs` count 0 in chat.css; `@source` names streamdown; package.json check exits 0

## Self-Check: PASSED

- FOUND: all created files listed in key-files
- FOUND: commits c822061, 30e99a9, 5ae4413, d4fb8ae
