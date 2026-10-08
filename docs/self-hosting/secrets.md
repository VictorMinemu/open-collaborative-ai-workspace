# Secrets

Every secret an install needs is generated once by `pnpm ocw setup` and written to `.env` (mode 0600). Nothing is
generated at boot: a missing secret stops the API with a message naming it (`set NAME or NAME_FILE`). Commands
report which keys they wrote and where, never the values.

The API reads its own secrets through one `SecretStore` interface, backed by environment variables and files by
default, and optionally by [OpenBao](https://openbao.org) (the `vault` profile).

## Where each secret lives

| Secret | Used by | env/file | OpenBao (`vault` profile) |
| --- | --- | --- | --- |
| `POSTGRES_PASSWORD`, `OCW_DB_MIGRATOR_PASSWORD`, `OCW_DB_APP_PASSWORD`, `OCW_DB_AUTH_PASSWORD` | postgres, migrate, api | yes | no |
| `OCW_CELL_TOKEN` | api, openclaw cell | yes | no |
| `GARAGE_RPC_SECRET`, `OCW_S3_ACCESS_KEY_ID`, `OCW_S3_SECRET_ACCESS_KEY` | garage, api | yes | no |
| `BETTER_AUTH_SECRET` | api | yes | yes |
| `OCW_ENCRYPTION_KEY` | api | yes | yes |
| `OCW_SETUP_TOKEN` | api | yes | yes |
| `OCW_SMTP_URL` (optional) | api | yes | yes |
| `OCW_OPENBAO_SECRET_ID` or `OCW_OPENBAO_TOKEN` | api | yes | (the credential to reach OpenBao) |

Only the four secrets that the API alone reads can move to OpenBao. The others are shared with containers that know
nothing about OpenBao (postgres, the migrate job, Garage, the OpenClaw cell), so they stay env/file. If you give any
other variable an `openbao://` reference, the API refuses to start and names the variable.

## `NAME` or `NAME_FILE`

Each API secret can be set directly (`OCW_ENCRYPTION_KEY=…`) or as a path to a file that holds it
(`OCW_ENCRYPTION_KEY_FILE=/run/secrets/ocw_encryption_key`), for Docker or Kubernetes secrets and other deployments
that do not use this repository's compose file. The direct variable wins when both are set. Trailing newlines in the
file are ignored. `OCW_OPENBAO_SECRET_ID_FILE` and `OCW_OPENBAO_TOKEN_FILE` work the same way.

## Moving the API secrets into OpenBao: `pnpm ocw enable vault`

You can run this on an existing install at any time. There is no reinstall, and existing data and sessions keep
working because the values do not change; only where they are stored changes.

```bash
pnpm ocw enable vault                  # the repository's .env
pnpm ocw enable vault --env-file <f>   # another install (its secrets/ directory sits next to the env file)
pnpm ocw enable vault --no-up          # prepare everything, restart the stack later yourself
```

What it does, in order:

1. Generates a 32-byte static seal key in `secrets/openbao-seal.key`, mode 0600 in a 0700 directory, and writes
   `OCW_OPENBAO_ADDR=http://openbao:8200` and `OCW_OPENBAO_SEAL_KEY_FILE` to `.env`. It also adds `vault` to
   `COMPOSE_PROFILES`.
2. Starts `openbao` in server mode. It uses integrated storage on the `openbao-data` volume, auto-unseals with the
   static key, publishes no port and is reachable only on the compose network.
3. Runs `bao operator init` once with one recovery share. The output goes straight to `secrets/openbao-init.json`
   (mode 0600).
4. Using the root token, which goes over stdin and never on a command line:
   - enables KV v2 at `secret/` and the AppRole auth method;
   - writes the policy `ocw-api` (read-only on `secret/data/ocw/*`) and the role `ocw-api`.
5. Writes the AppRole role id and a secret id to `.env` as `OCW_OPENBAO_ROLE_ID` and `OCW_OPENBAO_SECRET_ID`.
6. Copies the values of `BETTER_AUTH_SECRET`, `OCW_ENCRYPTION_KEY`, `OCW_SETUP_TOKEN` and `OCW_SMTP_URL` (only
   those that are set) into `secret/ocw/api`. It then replaces those lines in `.env` with references such as
   `OCW_ENCRYPTION_KEY=openbao://secret/ocw/api#OCW_ENCRYPTION_KEY`. Every other line of `.env` stays as it was.
7. Revokes the root token and removes it from `secrets/openbao-init.json`, which keeps only the recovery key.
8. Runs `docker compose up -d --wait`, which recreates the api so it reads its secrets from OpenBao.

Running it again prints `already enabled` and changes nothing. If a run is interrupted, running it again picks up
where it stopped, using the saved init material.

At boot the API logs in with AppRole and reads `secret/ocw/api` once. It keeps the values in memory and revokes its
own token. If OpenBao is unreachable, refuses the read or lacks a field, the API exits with a message naming the
address or the `openbao://…#FIELD` reference, never a value. Docker's restart policy retries the API until OpenBao
is up. After a host reboot this normally takes one or two seconds.

### Back up `secrets/` together with `.env`

`secrets/openbao-seal.key` decrypts OpenBao's storage. **If you lose it, you lose the data in OpenBao**: the recovery
key cannot unseal a static-seal OpenBao. Back up `secrets/` and `.env` together, keep them private (both are
git-ignored and excluded from Docker build contexts), and never paste them anywhere.

## Rotating a value stored in OpenBao

The API's AppRole can only read. To write, you need a token with write access. The root token was revoked, so you
generate a new one with the recovery key, use it, and revoke it again:

```bash
docker compose exec openbao bao operator generate-root -init                  # prints a nonce and an OTP
docker compose exec -it openbao bao operator generate-root -nonce=<nonce>     # paste the recovery key from secrets/openbao-init.json
docker compose exec openbao bao operator generate-root -decode=<encoded> -otp=<otp>
docker compose exec -it openbao sh                                           # then, inside the container:
  export BAO_TOKEN=<new root token>     # typed, not passed on the docker command line
  bao kv patch -mount=secret ocw/api OCW_SMTP_URL=-   # reads the new value from stdin; end with Ctrl-D
  bao token revoke -self
docker compose up -d --force-recreate api
```

`kv patch` changes one field and keeps the others. The API reads the values only at boot, which is why the api is
recreated. Rotating `BETTER_AUTH_SECRET` signs everyone out and invalidates stored JWT signing keys; delete the
`auth.jwks` rows first (see ADR-0008). Never rotate `OCW_ENCRYPTION_KEY` this way: organization secrets stored
encrypted with the old key would become unreadable.

To move a secret that was empty when you enabled the vault (for example, adding SMTP later), set the field the same
way, then put the reference `OCW_SMTP_URL=openbao://secret/ocw/api#OCW_SMTP_URL` in `.env` yourself.

## Recovery

- **OpenBao will not start: `OCW_OPENBAO_SEAL_KEY_FILE is not set or empty`.** Restore `secrets/` from the same
  backup as `.env`.
- **`ocw enable vault` says OpenBao is initialised but `secrets/openbao-init.json` is missing.** The volume holds an
  OpenBao whose init material was lost. If you never finished enabling it, no secret depends on it yet. In that case
  remove the volume (`docker compose rm -sf openbao && docker volume rm <project>_openbao-data`) and run the command
  again.
- **Going back to env/file.** Read each value from OpenBao with a token, as in the rotation steps (`bao kv get
  -mount=secret ocw/api`), put the plain values back in `.env`, remove `vault` from `COMPOSE_PROFILES`, and run
  `docker compose up -d`.

## Development and tests

Integration tests run OpenBao 2.7.1 in dev mode through testcontainers (`apps/api/src/lib/openbao.int.test.ts`).
Dev mode keeps everything in memory and is never used by the compose profile. The gate step
`node scripts/gate/vault-check.mjs --up` checks the whole flow on an isolated stack: enable, health, sign-in, no
published port, an auto-unsealing restart, and no values in the logs.
