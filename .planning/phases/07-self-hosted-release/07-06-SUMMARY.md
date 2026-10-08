---
phase: 07-self-hosted-release
plan: 06
subsystem: secrets
status: complete
tags: [secrets, openbao, self-hosting, compose, cli, gate]
requires:
  - "07-02: checkSchema guard in main.ts (order kept: config → schema → buildApp)"
  - "07-03: api pass-throughs OCW_OPENBAO_*, include of infra/openbao/compose.yaml"
  - "07-04: scripts/ocw/env-file.mjs (setKeys, addProfile, composeArgs, reportWritten, writePrivate)"
  - "07-01/03: scripts/gate/lib.mjs (withGateStack, ensureAdmin, demoSnapshot)"
provides:
  - "SecretReference `openbao` variant, parseSecretUri, formatSecretUri, createChainedSecretStore, UnsupportedReferenceError (apps/api/src/lib/secret-store.ts)"
  - "createOpenBaoSecretStore(cfg, refs): fetch-only AppRole/token login, one KV v2 read per path, fields in memory, token revoked (apps/api/src/lib/openbao.ts)"
  - "loadConfig(source, deps) + OPENBAO_ALLOWED (apps/api/src/config/env.ts); main.ts awaits it"
  - "vault profile: infra/openbao/{compose.yaml,openbao.hcl}"
  - "pnpm ocw enable vault (scripts/ocw/enable-vault.mjs)"
  - "gate step scripts/gate/vault-check.mjs (--up | --attach | --down)"
  - "docs/self-hosting/secrets.md"
affects: [07-09, 07-10, 07-11]
tech-stack:
  added: ["openbao/openbao:2.7.1@sha256:6d2b93856e3fcf7b18ad855a0b51eaba474dc8b79cf554379ea32034797d2acf (vault profile only, MPL-2.0)"]
  patterns:
    - "Secret references in env values: `NAME=openbao://<mount>/<path>#<field>`, resolved once at boot by loadConfig before Zod; compose `:?` guards still see a non-empty value"
    - "Secrets to `bao` inside a container go over stdin (first line = token, rest = payload), never argv"
    - "Root-only wrapper entrypoint to hand a 0600 host file to a non-root container user via tmpfs"
key-files:
  created:
    - apps/api/src/lib/openbao.ts
    - apps/api/src/lib/openbao.int.test.ts
    - apps/api/src/lib/secret-store.test.ts
    - infra/openbao/openbao.hcl
    - infra/openbao/compose-vault.test.mjs
    - scripts/ocw/enable-vault.mjs
    - scripts/ocw/enable-vault.test.mjs
    - scripts/gate/vault-check.mjs
    - docs/self-hosting/secrets.md
  modified:
    - apps/api/src/lib/secret-store.ts
    - apps/api/src/config/env.ts
    - apps/api/src/config/env.test.ts
    - apps/api/src/main.ts
    - infra/openbao/compose.yaml
decisions:
  - "OpenBao 2.7.1 has no `file` storage backend (`unknown storage type file`): the profile uses integrated storage (raft, single node) on the openbao-data volume, mounted at /openbao/file"
  - "Static seal key = 32 raw random bytes in secrets/openbao-seal.key (0600, 0700 dir); the container starts as root with only CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID to copy it into a tmpfs owned by openbao, then the image entrypoint drops to openbao"
  - "Healthcheck is strict (/v1/sys/health 200 = initialised, unsealed, active); enable-vault therefore polls `bao status` (exit 0 or 2) before init and only then uses `up --wait openbao`"
  - "The API's AppRole: policy ocw-api read-only on secret/data/ocw/*, token_ttl 5m, token_max_ttl 15m, secret id without expiry or use limit; the API revokes its token right after the boot read"
  - "After revoking the root token, enable-vault rewrites secrets/openbao-init.json without root_token (root_token_revoked: true); a new root token needs the recovery key (documented)"
  - "loadConfig refuses an openbao:// value in any variable the API reads other than the four (D-16), checked against EnvSchema's keys + SECRET_VARS + OCW_S3_SECRET_ACCESS_KEY, after NAME_FILE resolution"
  - "enable-vault is resumable: it keeps an existing seal key and reuses the saved root token when OpenBao is already initialised; KV write and the .env rewrite happen together after the configuration"
metrics:
  duration: "~2 h 40 min (two full verify runs of ~14 min, four gate attempts)"
  completed: 2026-10-08
actuals:
  tokens: 26200
  tasks: 2
  commits: 5
---

# Phase 7 Plan 06: OpenBao behind `SecretStore`, `vault` profile, `ocw enable vault` Summary

The API's four API-only secrets (`BETTER_AUTH_SECRET`, `OCW_ENCRYPTION_KEY`, `OCW_SETUP_TOKEN`, `OCW_SMTP_URL`) can now
live in OpenBao as `openbao://secret/ocw/api#FIELD` references, resolved once at boot through the same `SecretStore`
interface as env/file (one contract suite, real OpenBao 2.7.1). `pnpm ocw enable vault` moves an existing install
onto the optional `vault` profile (server mode, static auto-unseal, no port) in one command, without reinstalling.

## Commits

| Task | Type | Commit | Message |
|------|------|--------|---------|
| 1 | feat | 8f69f38 | feat(api): resolve API-only secrets from OpenBao through the SecretStore at boot |
| 2 | feat | 8590d32 | feat(infra): vault profile with OpenBao in server mode and static auto-unseal |
| 2 | feat | 1896f81 | feat(scripts): pnpm ocw enable vault moves the API-only secrets into OpenBao |
| 2 | feat | 9a5ccc6 | feat(scripts): vault gate step and self-hosting secrets guide |

## Results

- Unit: `vitest --project unit secret-store.test.ts env.test.ts`: **36 passed** (10 new in secret-store.test.ts,
  10 new `loadConfig` cases in env.test.ts, 16 existing).
- Integration, one file at a time: `openbao.int.test.ts` **16 passed** (contract × 3 stores = 6, client 7, boot of the
  real `src/main.ts` 3); `schema-guard.int.test.ts` **7 passed**.
- Node: `enable-vault.test.mjs` **12 passed**, `compose-vault.test.mjs` **6 passed**;
  `node --test 'scripts/**/*.test.mjs' infra/compose.test.mjs infra/openbao/compose-vault.test.mjs`: **102 passed,
  0 failed, 0 skipped**.
- `pnpm typecheck --force`: exit 0.
- `pnpm verify` before the Task 1 commit and again on the final tree before the Task 2 commits: exit 0 both times,
  lint clean (the 4 warnings are pre-existing in apps/local-runtime), guard semgrep/licenses/fields/codeowners ok,
  typecheck ok, **201 files, 2809 tests passed** (wave-1 baseline 2773 + 36 new).
- Mutation check: disabling the AppRole token revoke makes "AppRole login … revokes its token" fail.

### Gate: `node scripts/gate/vault-check.mjs --up` (run muywm9ju0246, exit 0, `ok: true`, 285 s total)

| Step | ms | Details |
|------|----|---------|
| ports-free / disk-free | 2 / 270 | 7.1 GB free |
| build | 60 413 | api 213 MB, web 95 MB, openclaw 1203 MB, fake-model 77 MB (cached layers) |
| up | 28 467 | minimal stack, no vault profile |
| admin-before | 123 | first-run setup created the admin |
| enable-vault | 23 912 | exit 0, 0 values in its output |
| env-references-only | 0 | all four are `openbao://`, `COMPOSE_PROFILES=vault` |
| api-healthy-on-references | 2 074 | api healthy, `/health` 200 |
| admin-signs-in | 98 | pre-enable session still 200 (same BETTER_AUTH_SECRET), fresh sign-in 200 |
| openbao-unpublished | 109 | 0 publishers, `compose port` host port 0 |
| restart-auto-unseal | 23 503 | `restart openbao` → healthy (unsealed, no human), `restart api` → healthy, session 200 |
| secrets-files-private | 1 | secrets/ 700, seal key 600, init 600, .env 600 |
| logs-clean | 81 | 5 values (4 secrets + AppRole secret id) absent from 22 KB of api + openbao logs |
| teardown / build-cache | 31 393 / 24 574 | 4 images removed, 55 cache records pruned |
| demo-untouched | | 3 `:local` images, 5 demo containers unchanged |

After every run, `docker ps -a`, `docker volume ls` and `docker images` show nothing carrying any of this plan's run ids.

### Final static-seal HCL (`infra/openbao/openbao.hcl`)

```hcl
storage "raft" { path = "/openbao/file"  node_id = "ocw-openbao" }
listener "tcp" { address = "0.0.0.0:8200"  tls_disable = true }
seal "static" { current_key_id = "ocw-1"  current_key = "file:///run/openbao/seal.key" }
api_addr = "http://openbao:8200"  cluster_addr = "http://openbao:8201"  disable_mlock = true  ui = false
```

The key is 32 raw bytes. `/run/openbao` is a tmpfs, and the root wrapper fills it from the read-only bind of
`OCW_OPENBAO_SEAL_KEY_FILE` on every start. It was smoke-tested by hand and in the gate: init, then restart, then
unsealed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `storage "file"` does not exist in OpenBao 2.7.1 (assumption A2)**
- **Found during:** Task 2 smoke test before writing the profile.
- **Fix:** integrated storage (`raft`, single node) on the named volume; the rest of A2 (static seal with
  `current_key_id`/`current_key = "file://…"`) held. Never dev mode, no manual unseal.
- **Files:** infra/openbao/openbao.hcl

**2. [Rule 1 - Bug] OpenBao could not read the seal key in the hardened container (gate attempt 2)**
- **Issue:** the 0600 host file is unreadable by the image's `openbao` user. The first wrapper lacked FOWNER
  (busybox `install` chowns and then chmods) and left the tmpfs owned by root. OpenBao kept restarting, so
  `ocw enable vault` stopped at "waiting for OpenBao" before changing any secret, and `.env` kept its plain values.
- **Fix:** `chown openbao:openbao /run/openbao` and `cap_add` CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID (all other
  capabilities dropped, `no-new-privileges`). The config test pins the capability set. `enable-vault` now appends the
  last 5 lines of the openbao log when OpenBao never answers (new test).
- **Files:** infra/openbao/compose.yaml, infra/openbao/compose-vault.test.mjs, scripts/ocw/enable-vault.{mjs,test.mjs}

**3. [Rule 1 - Bug] `docker compose port` prints `<ip>:0` with exit 0 for an unpublished port (gate attempt 3)**
- **Fix:** the gate check parses the host port and fails only on a non-zero one; it also checks the container's
  Publishers.
- **Files:** scripts/gate/vault-check.mjs

**4. [Rule 2 - Missing critical] Interrupted runs and root-token material**
- `ocw enable vault` is resumable (keeps the seal key, reuses the saved root token, refuses an initialised OpenBao
  whose init file is missing). After revoking, it drops `root_token` from `openbao-init.json`.

### Other deviations

- **Gate attempt 1** failed at `ports-free`: another agent's stack still held 3400–3404 when the lock was handed
  over. A retry passed this step. Nothing changed.
- **TDD order:** the unit tests (secret-store, loadConfig) and enable-vault.test.mjs were RED before their
  implementation. `openbao.int.test.ts` and `compose-vault.test.mjs` were written right after the implementation and
  pass against it. The revoke assertion was mutation-checked.
- **Plan's "vault profile healthcheck + `up -d --wait openbao` before init"**: a strict healthcheck cannot be healthy
  before init, so enable-vault polls `bao status` first and runs `up --wait openbao` after init.
- **The boot path is proven with the real `src/main.ts`** in `openbao.int.test.ts` (references only → `/health` 200;
  OpenBao unreachable → exit 1 before the schema check; DATABASE_URL reference → exit 1). This goes beyond the plan.
- **vault-check `--up` sets an `OCW_SMTP_URL`** (dummy SMTP with a credential, never contacted) on its own stack, so
  all four secrets move. With `--attach`, it leaves the stack's SMTP setting alone.
- **Branch:** commits are on `wt/07-06` as instructed, not on a GSD `agent-*` branch.

## Known Stubs

None.

## Broken windows (for WINDOWS.md; not written there per instructions)

- **kind deviation, phase 7, `apps/api` / compose:** the api has no `depends_on: openbao` (compose.yaml was out of
  scope). On a cold `docker compose up` of a vault install, the api may exit once with "OpenBao is unreachable" and
  be restarted by `restart: unless-stopped` until OpenBao answers. This is documented in secrets.md. A
  `depends_on: openbao (required: false)` in compose.yaml would remove it.

## Open items

- **Backups (07-09):** with the vault on, the four values exist only in the `openbao-data` volume. The 07-09 plan
  backs up the DB, the bucket and the cell state, and excludes `.env` and `secrets/`. A vault install also needs
  `openbao-data` in the backup (with the seal key from `secrets/`), or a restored install cannot boot.
- **Tools that read `OCW_SETUP_TOKEN` from `.env`** (`ensureAdmin` in scripts/gate/lib.mjs, `scripts/demo-seed.mjs`)
  get a reference once the vault is enabled. `ensureAdmin` needs the token only before first-run setup, so it is
  unaffected in practice. Any 07-10/07-11 flow that enables the vault before setup would need the plain token.
- **Moving a secret set after enabling** (for example, adding SMTP later) is manual: write the KV field, then the
  reference. It is documented. A second `ocw enable vault` stops because the root token is gone.
- **Linux host check:** capabilities and ownership were verified on Docker Desktop (macOS). The owner's clean-machine
  run (D-10) should include `ocw enable vault` on Linux.
- `.env.example` does not list `OCW_OPENBAO_SEAL_KEY_FILE`; the command appends it.
- CI wiring (D-12): `node --test infra/openbao/compose-vault.test.mjs scripts/ocw/enable-vault.test.mjs` (already
  covered by the `'scripts/**/*.test.mjs'` glob except the infra file) and `node scripts/gate/vault-check.mjs --up`.

## Threat Flags

None. The new surface (OpenBao on the compose network, AppRole credentials in `.env`, `secrets/`) is in the plan's
threat model. T-07-06-01..06 are mitigated and tested: errors carry no values (canary tests); there is no published
port (config test + gate); the root token is revoked; the seal key is 0600; auto-unseal survives a restart (gate);
the policy is read-only on `secret/data/ocw/*` and a 403 is tested; other variables refuse references (unit + boot
test).

## Verification

| Command | Result |
|---------|--------|
| `pnpm exec vitest run --project unit apps/api/src/lib/secret-store.test.ts apps/api/src/config/env.test.ts` | 36 passed |
| `pnpm exec vitest run --project integration apps/api/src/lib/openbao.int.test.ts` | 16 passed, 0 skipped |
| `pnpm exec vitest run --project integration apps/api/src/schema-guard.int.test.ts` | 7 passed |
| `pnpm typecheck --force` | exit 0 |
| `node --test infra/openbao/compose-vault.test.mjs scripts/ocw/enable-vault.test.mjs` | 18 passed |
| `node --test 'scripts/**/*.test.mjs' infra/compose.test.mjs infra/openbao/compose-vault.test.mjs` | 102 passed |
| `node scripts/gate/vault-check.mjs --up` | exit 0, every check ok (run muywm9ju0246) |
| `pnpm verify` (final tree) | exit 0, 2809 passed |
| `grep -n "await loadConfig" apps/api/src/main.ts` / `checkSchema` after it | line 9 / line 19 |
| `grep -n 'provider: "openbao"' apps/api/src/lib/secret-store.ts` | present |
| `grep -n "ports:" infra/openbao/compose.yaml` | nothing |
| digest grep in infra/openbao/compose.yaml | present |
| `docker ps -aq --filter name=ocw-gate-` after the gate | empty (0) |

## Self-Check: PASSED

Files exist: apps/api/src/lib/openbao.ts, openbao.int.test.ts, secret-store.test.ts, infra/openbao/openbao.hcl,
compose-vault.test.mjs, scripts/ocw/enable-vault.mjs, enable-vault.test.mjs, scripts/gate/vault-check.mjs,
docs/self-hosting/secrets.md. Commits exist on wt/07-06: 8f69f38, 8590d32, 1896f81, 9a5ccc6.
