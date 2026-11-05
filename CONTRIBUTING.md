# Contributing

Thanks for helping. This guide covers the development setup, the checks a change must pass and the conventions the
codebase follows. The architectural rules every change must respect are in [`AGENTS.md`](AGENTS.md); they apply to
people as much as to AI coding agents.

## Before you start

- **Bugs and small fixes:** open a pull request directly, or an issue first if you are unsure.
- **Features or anything architectural** (a new module, a dependency, a change to permissions, policies, audit or
  tenant isolation): open an issue to discuss it first. Stack and architecture decisions are recorded as ADRs in
  [`docs/adr/`](docs/adr/), and [`docs/prd/PRD.md`](docs/prd/PRD.md) is the authoritative spec. If your change and
  the PRD disagree, the PR changes the PRD explicitly.
- **Security issues:** never in a public issue. See [`SECURITY.md`](SECURITY.md).

## Development setup

You need:

- Node 24 (`.nvmrc` pins the exact version);
- corepack, for pnpm 12;
- Docker, because the integration tests start real PostgreSQL and Redis containers;
- git.

```bash
git clone https://github.com/VictorMinemu/open-collaborative-ai-workspace.git && cd open-collaborative-ai-workspace
corepack enable
pnpm install
pnpm verify          # lint + guard + typecheck + every test; must pass before a commit
```

To run the whole product locally, follow [Try it on your laptop](README.md#try-it-on-your-laptop) (`pnpm ocw setup`,
then `docker compose up -d --build --wait`). The layout of the monorepo is in [`AGENTS.md`](AGENTS.md#monorepo-layout).

Useful commands:

| Command | What it does |
| --- | --- |
| `pnpm lint` | Biome (format and lint) |
| `pnpm typecheck` | `tsc --noEmit` across the workspace |
| `pnpm test` | Vitest: unit, integration (real PostgreSQL via testcontainers) and web |
| `npx vitest run --project integration <file>` | One integration file, run from the repository root |
| `node --test 'scripts/**/*.test.mjs'` | The operator-script tests (CI runs them separately) |
| `pnpm gate:compose` | The release gate on real images (isolated project, ports 34xx) |

## What a pull request needs

- **A failing test first.** Every fix and feature comes with the test that proves it. Integration tests hit a real,
  ephemeral PostgreSQL, never a database mock.
- **Tenant isolation is a test target.** Every query path on organization-scoped data has a test proving another
  organization cannot reach it.
- **Never weaken a permission check, an RLS policy or an approval gate** to make a test pass.
- **Contracts first.** Shared types and event schemas are Zod schemas in `packages/contracts`; apps derive their
  types from them.
- **No secrets.** Never commit `.env` files, tokens or real credentials. `.env.example` holds placeholders only.
- **`pnpm verify` passes.** For UI changes, attach screenshots at desktop and mobile widths, in light and dark.

## Conventions

- **English** for code, comments, docs, commits and PRs.
- **Conventional Commits** with the app or package as scope: `feat(api): …`, `fix(web): …`, `docs: …`. Keep commits
  small and atomic.
- **Modules, not microservices.** In `apps/api`, each service is a folder with a public `index.ts`, and modules import
  each other only through it.
- **No `any` and no `@ts-ignore`** without a comment that explains why.
- **ADRs** (`docs/adr/NNNN-kebab-title.md`) for every architectural or stack decision. An accepted ADR is never
  edited; a new ADR supersedes it.

## License of contributions

By contributing you agree that your contribution is licensed under the license of the part of the repository it
touches:

- AGPL-3.0 for the server, the control plane and the apps (see [`LICENSE`](LICENSE));
- Apache-2.0 for the protocol, SDKs and plugins once they are published as their own packages.

Everyone who takes part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
