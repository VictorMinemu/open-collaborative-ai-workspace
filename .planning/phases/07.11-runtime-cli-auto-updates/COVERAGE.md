# API Coverage — npm registry (public read API)

> Full coverage by default. Opt-outs are explicit, reasoned decisions.

The only external API this phase integrates is the public npm registry, read by the Local Runtime to learn the latest
version of `@anthropic-ai/claude-code` and `@openai/codex` on the channel the install follows (D-04, D-07, PD-10). The
Claude Agent SDK and `codex app-server` are existing integrations; this phase only adds an environment variable and a
config override to the processes the daemon launches (D-12, PD-14). The CLIs' own installers (`claude update`, `codex
update`, npm, Homebrew) are run as commands from a fixed on-device table, not called as an API (D-05, PD-09).

| capability | decision | reason |
|---|---|---|
| dist-tag version (`GET /<pkg>/<tag>`) | INTEGRATE | |
| full packument (`GET /<pkg>`) | OPT-OUT | not needed: one dist-tag answers the question, and the packument is large (body capped at 64 KB) |
| all dist-tags (`GET /-/package/<pkg>/dist-tags`) | OPT-OUT | not needed: the device reads only the tag that matches its install's channel (PD-10) |
| one version's manifest (`GET /<pkg>/<version>`) | OPT-OUT | not needed: the installer resolves and verifies the version it installs |
| tarball download | OPT-OUT | explicitly out of scope: the vendor's installer downloads and verifies (RESEARCH, Don't Hand-Roll) |
| package search (`GET /-/v1/search`) | OPT-OUT | not needed: the two package names are constants on the device |
| security advisories (`POST /-/npm/v1/security/advisories/bulk`) | OPT-OUT | not needed yet: compatibility comes from our own manifest served by the Control Plane (D-04) |
| publish, dist-tag writes, login and tokens | OPT-OUT | explicitly out of scope: read-only, no credentials ever sent |
