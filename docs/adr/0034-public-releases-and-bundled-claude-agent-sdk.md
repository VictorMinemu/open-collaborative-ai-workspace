# ADR-0034: Public releases, `ocw upgrade`, and the Claude Agent SDK in the desktop app

## Status

Status: Accepted. **Date:** 2026-11-05. **Deciders:** Víctor Ruiz (Autofy Labs).

**Builds on, without editing it:** [ADR-0021](0021-self-hosted-release.md). This ADR settles ADR-0021's first pending
license point (decision 11, the `@anthropic-ai/claude-agent-sdk` exception) for the desktop app. The second point,
the `@modelcontextprotocol/server-everything` clarification, stays pending. That package ships in no release file: it
is installed only when an operator builds the `mcp-sandbox` image.

## Context

On 2026-11-05 the repository became public. The owner asked for the apps to be compiled and published in a release.

The desktop app bundles the Local Runtime, and with it `@anthropic-ai/claude-agent-sdk` and its platform package.
These are under Anthropic's commercial terms, not an open-source license. ADR-0021 held back any public distribution
of the desktop app or the Local Runtime until the owner confirmed that exception. It named a fallback: ship the
Claude Code adapter as a separate download.

The headless runtime is not affected. Its installer (`/api/v1/runtime/install.sh`) installs the SDK from npm on the
user's machine, so we never redistribute it.

## Decision

1. **Releases are `vX.Y.Z` tags.** A tag runs `.github/workflows/release.yml`, which builds the macOS app on a GitHub
   runner and publishes a GitHub release with three files:
   - `OCW-<tag>-macos-arm64.dmg`;
   - `install.sh`;
   - `SHA256SUMS`.

   The notes come from `docs/releases/<tag>.md`. A tag with a suffix (`-rc.1`) is a pre-release.
2. **The desktop app ships with the Claude Agent SDK bundled.** The owner confirmed the exception for this
   distribution on 2026-11-05. He chose it over releasing without the app, and over the ADR-0021 fallback (the SDK
   fetched from npm on first launch). The license guard still prints the exception on every run.
3. **The app is ad-hoc signed and not notarized until Phase 9.** The release notes explain how to open it.
4. **Upgrades go through `ocw upgrade`.** The command:
   - picks the newest stable tag;
   - refuses to move backwards;
   - backs up first;
   - tags the images with the release, so a rollback keeps the previous images.

   The server installer installs the newest stable release by default.

## Consequences

- Each release redistributes Anthropic's SDK inside the DMG. If Anthropic's terms change, or the owner withdraws this
  confirmation, apply ADR-0021's fallback. That means fetching the SDK on first launch, as the headless installer
  already does, and stopping releases of the bundled app.
- PR runs of the release workflow only build the app. They upload nothing, so the release is the only download
  channel.
