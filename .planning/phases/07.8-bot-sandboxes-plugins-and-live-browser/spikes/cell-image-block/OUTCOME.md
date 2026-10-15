# Spike (ii): does a plugin tool's image block reach the model in a real OpenClaw 2026.9.7 cell?

**Question (A2, D-05, D-11, P-14):** can a plugin tool return an image that reaches the model in a real 2026.9.7 cell,
and in what request shape?

**Result: POSITIVE, with one condition.** The image reaches the model **only when the provider model is declared
`input: ["text", "image"]`** in OpenClaw's config. Our cell does not declare it today: the reconciler renders
`{ id, name }` only. As rendered today, OpenClaw drops the image and the model reads
`(tool image omitted: model does not support images)`.

**Chosen path:** offer `ocw_browser_screenshot` with an image result, **only to bots whose model accepts images**. The
cell renders `input: ["text", "image"]` for those models, from a capability the API puts in the cell snapshot. For any
other model, P-14's fallback applies **per bot**: `ocw_browser_screenshot` is not offered, and the redacted snapshot is
the model's only view. ADR-0029 records both.

## Environment

| Item | Value |
|------|-------|
| Cell | `ocw-openclaw:spike-078`, built from a scratch copy of `infra/openclaw/Dockerfile` (base `ghcr.io/openclaw/openclaw:2026.9.7-slim@sha256:0da12cd4…dbcfc`, no new image), with this tree's plugin + `spike-tool.ts` |
| Fake model | `ocw-fake-model:spike-078` (scratch copy of `infra/fake-model`), `FAKE_MODEL_CAPTURE_DIR` on, OpenAI Chat Completions (`api: "openai-completions"`, the fake provider `fake/mock-1`) |
| Fake API | `apps/openclaw-channel/src/testing/run-fake-api.ts` (scratch copy), bot `archie` with `capabilities.tools = ["ocw_spike_image"]` |
| Network | `ocw-spike-078-net`, `--internal`, 10.231.81.0/24 (the demo's `ocw-demo-net` 10.231.78.0/24 left alone) |
| Host | local Docker Desktop (arm64), 2026-10-15 |

## What the scratch copy changes (never the repository's files)

`run.sh` copies `apps/openclaw-channel`, `infra/openclaw` and `infra/fake-model` into a `mktemp -d` directory and patches
three things there:

1. `src/spike-tool.ts` is added and registered from `register-full.ts`. It returns
   `content: [{ type: "text", text: "spike-078 caption: screenshot attached" }, { type: "image", data: <1×1 PNG base64>, mimeType: "image/png" }]`.
2. `openclaw.plugin.json` `contracts.tools` gains `ocw_spike_image`. Without it the turn fails with
   `No callable tools remain after resolving explicit tool allowlist … no registered tools matched` (first run). A
   plugin tool must be declared in the manifest to be resolvable at all.
3. `reconciler.ts` `desiredProviderEntry` adds `input: OCW_SPIKE_MODEL_INPUT.split(",")` to each model when that env var
   is set, for variant 2.

## Commands

```bash
bash .planning/phases/07.8-bot-sandboxes-plugins-and-live-browser/spikes/cell-image-block/run.sh > report.jsonl
```

One DM mention `show me the page [[call ocw_spike_image {}]]`, turn tools `["ocw_spike_image"]`
(`untrustedOutput: true`, `sideEffecting: false`). For each variant the cell gets a fresh state volume. The full
output is [`report.jsonl`](report.jsonl).

## Results

| Variant | Rendered provider model | Gate | Request after the tool result | Image reached the model |
|---------|-------------------------|------|-------------------------------|-------------------------|
| as-rendered (today) | `{"id":"mock-1","name":"mock-1"}` | `/tool-calls` allowed | `tool` message (string): `spike-078 caption: screenshot attached\n(tool image omitted: model does not support images)`; no image part anywhere | ❌ dropped by OpenClaw |
| input-image | `{"id":"mock-1","name":"mock-1","input":["text","image"]}` | `/tool-calls` allowed | `tool` message (string): `spike-078 caption: screenshot attached`, then a **`user` message** `[{type: "text", text: "Image(s) from tool result #1 (ocw_spike_image):"}, {type: "image_url", image_url: {url: "data:image/png;base64,iVBORw0KGgo…"}}]` (the full PNG, 118-char data URL) | ✅ |

Exact message order of the second request in variant input-image: `system`, `user` (the turn), `assistant`
(`tool_calls: [ocw_spike_image]`), `tool` (text only), `user` (the image block above), `user` (OpenClaw's internal
context block).

**Documented behaviour** (pinned image, `/app/docs`):
- `concepts/models.md`: a model's capabilities come from its `input` row; "When the source row omits `input`, plugin
  discovery can fill that capability metadata". Our custom provider has no discovery, so it stays text-only. Provider
  examples declare `input: ["text", "image"]` for vision models (`providers/litellm.md`, `bedrock.md`, …).
- `releases/2026.9.3.md`: "keep images with the tool results they came from"; "Preserve image ownership across parallel
  tool results in Chat Completions". Chat Completions cannot carry an image inside a `tool` message, so OpenClaw
  follows it with a labelled `user` image message, as captured. Anthropic Messages keeps the image inside the
  `tool_result` block (#140409); not exercised here, because the fake provider speaks Chat Completions.
- `reference/transcript-hygiene.md`: every image is sanitized, downscaled and recompressed to
  `agents.defaults.imageMaxDimensionPx`. `concepts/session-pruning.md`: older image blocks in `toolResult` history are
  replaced with `[image data removed - already processed by model]` after 3 turns.

## Cleanup

The EXIT trap removed the containers `ocw-spike-078-{model,api,openclaw}`, the network, both state volumes, the images
`ocw-openclaw:spike-078` and `ocw-fake-model:spike-078`, and the scratch directory. Afterwards
`docker ps -aq --filter label=ocw.spike=07.8` → 0 and `docker images -q --filter reference='*:spike-078'` → 0. No demo
object was used (the demo containers kept running).

## What the dependent plans do

- **06 (screenshot tool):** `ocw_browser_screenshot` returns `content: [{type: "text", text: <caption>}, {type:
  "image", data: <masked JPEG/PNG base64>, mimeType}]`. Extend `openclaw-sdk.d.ts` so `execute` may return
  `ImageContent` (`{ type: "image"; data: string; mimeType: string }`) instead of casting, and add the tool to
  `openclaw.plugin.json` `contracts.tools`, as every `ocw_*` tool needs. The image is untrusted page content and reaches
  Chat Completions models as a **`user`-role** message labelled `Image(s) from tool result #1 (<tool>)`. The tool's
  `untrustedOutput: true` flag (taint) is therefore what protects later side-effecting calls. The mask (D-07) must be
  burned into the pixels before the tool returns: OpenClaw only downsizes.
- **14 (offering):** offer `ocw_browser_screenshot` only when the bot's model accepts images. The cell snapshot needs a
  per-model image capability (provider models today are plain ids). The reconciler then renders `input: ["text",
  "image"]` for those models and `["text"]` (or nothing) for the rest. Never offer the tool to a text-only model: it
  would only ever read `(tool image omitted …)`. Subscription models (`openai-codex/*`) get `input` from OpenClaw's own
  discovery. Confirm this in 14's real-cell smoke.
- **29 (ADR-0029):** record A2 as positive with the `input` condition, the user-role image placement on Chat
  Completions, and the per-bot fallback.
