# Backup, restore and upgrade

One command backs up an install and one restores it (SELF-04). Both run from the checkout you installed from, and
both act on the compose project named in your `.env` (`COMPOSE_PROJECT_NAME`, or the directory name by default).

```bash
pnpm ocw backup                        # writes backups/<UTC timestamp>/
pnpm ocw restore backups/20261008T020000Z --yes
```

Both accept `--env-file <file>` (or `--dir <dir>` for `<dir>/.env`) for an install whose `.env` is elsewhere.

## What a backup contains

| File | What | How |
| --- | --- | --- |
| `db.dump` | The whole PostgreSQL database: schemas `app`, `auth` and `drizzle`, the `pg_trgm` and `unaccent` extensions, row-level security policies and grants | `pg_dump -Fc` as `ocw_migrator`, inside the postgres container |
| `objects/` + `objects.json` | Every object in the attachments bucket, with its size, ETag, content type and sha256 | Through the S3 API, inside the api image (works with any S3-compatible store) |
| `openclaw-state.tar` | The OpenClaw cell's state volume: bot sign-ins, installed plugin records and package roots | `tar` of `/home/node/.openclaw`, with `openclaw` stopped for the copy |
| `openbao-data.tar`, `openbao-seal.key`, `openbao-init.json` | Only with the `vault` profile on: OpenBao's data volume (where the API-only secrets now live), the static seal key that decrypts it and the recovery material, from `secrets/` | `tar` of `/openbao/file`, with `openbao` stopped for the copy; the two files copied from `secrets/` |
| `manifest.json` | Format, creation time, API version and commit, compose project, the applied migrations (the schema version) and the sha256 of every file | |

The dump is taken as `ocw_migrator` because it owns every schema and is exempt from row-level security. A dump as
`ocw_app` would contain zero organization rows. The whole database is dumped: a dump limited to some schemas with
`-n` would lose the extensions, and a restore would then fail.

**Not in a backup:**

- **`.env`** (and, without the `vault` profile, `secrets/`). A backup is useless without them. Sealed organization
  secrets need `OCW_ENCRYPTION_KEY`, sessions and JWKS need `BETTER_AUTH_SECRET`, and the database and storage
  passwords live there too. Back them up separately, to a different place, and treat them like the backup itself.
  With the `vault` profile on, those API-only secrets exist only inside OpenBao, so the backup takes OpenBao's data and
  its seal key (above): such a backup plus `.env` is enough to bring the install back, and anyone holding the backup
  can read those secrets. Keep it exactly as private as `.env`.
- **Redis.** It is ephemeral by design (ADR-0003): presence, rate limits and short-lived sign-in flows. Nothing durable
  lives only in Redis.
- **Telemetry** (`observability` profile: Prometheus, Loki, Tempo, Grafana). It is operational data, not instance data.
- **Caddy's data volume** (`proxy` profile). It only holds certificates, which Caddy obtains again on start. Copy the
  volume only if you want to avoid re-issuing them.

**A backup is sensitive.** It contains every message, file and audit event, sealed organization secrets and the cell's
sign-ins. `ocw backup` creates the directory as 0700 with 0600 files. `backups/` is ignored by git and by the Docker
build context. Copy it off the host encrypted (for example `restic`, `borg` or `age`).

## Taking a backup

```bash
pnpm ocw backup [--out DIR] [--consistent]
```

- **Online (the default).** The stack keeps serving users. `pg_dump` reads one consistent snapshot of the database. The
  objects are listed after the dump, so at worst the backup holds a few objects that no row references yet. The
  cell is stopped for the few seconds its state is copied.
- **`--consistent`.** Stops `api`, `web` and `openclaw` for the whole backup and starts them again afterwards, even when
  the backup fails. Use it before an upgrade, or whenever a short outage is acceptable.

The command prints the directory, each file and its size, and the number of migrations and objects. It never prints
a value from `.env`. `--out` must name a directory that does not exist yet or is empty.

**Schedule** it with cron on the Docker host. Keep a few days and copy each backup off the machine:

```cron
# /etc/cron.d/ocw-backup: every night at 02:30, keep 7 days
30 2 * * * ocw cd /srv/ocw && pnpm ocw backup >> /var/log/ocw-backup.log 2>&1 && find /srv/ocw/backups -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} +
```

## Restoring

```bash
pnpm ocw restore DIR --yes
```

A restore is **destructive**. It replaces the database, the objects and the cell state with the backup's. Without
`--yes` it changes nothing.

Before anything changes, the restore checks that:

1. The manifest has a known format and names only known files.
2. Every file matches its sha256, and every object matches its entry in `objects.json`. Otherwise it stops with
   `checksum mismatch: <file>`.
3. Every migration the backup lists exists in this checkout. Otherwise the backup was made by a newer release and is
   refused (`this backup was made by a newer release (unknown migrations: …)`). Restore it with that release or a
   later one.

Then it runs these steps and prints each one:

1. Stop `api`, `web` and `openclaw`, and start `postgres`, `redis` and `garage`. On brand-new volumes these are
   created.
2. Run `docker compose run --rm migrate` to create the database roles with the passwords in your current `.env`.
3. As `ocw_migrator`, `DROP SCHEMA IF EXISTS app, auth, drizzle, pgboss CASCADE`, then
   `pg_restore --exit-on-error --single-transaction`. Dropping first removes tables a newer migration may have added
   since the backup, and the job queue (`pgboss`) the migrate step just installed; the backup's own queue comes back
   with it, and step 4 installs it when the backup predates automations.
4. Run `migrate` again. A backup from an **older release is upgraded** to this one here, and grants and policies are
   re-applied.
5. Import the objects with their stored content types. Objects that the backup does not hold are removed, so the
   bucket matches the database again.
6. Replace the cell's state volume.
7. With the `vault` profile: write the seal key and recovery material back to `secrets/` (the path in
   `OCW_OPENBAO_SEAL_KEY_FILE`), replace OpenBao's data volume and start OpenBao, which unseals itself with that key.
   A vault backup is refused, before anything changes, when the env file does not turn the `vault` profile on.
8. `docker compose up -d --wait`.

The restore uses the keys and passwords in your **current** `.env`, never any from the backup. To restore onto a new
machine, first put the original `.env` (and `secrets/`, if you use `_FILE` secrets; a vault backup brings its own
`secrets/openbao-*` files) in place, then `docker compose up -d --build --wait`, then `pnpm ocw restore DIR --yes`.

The restore in step 3 is one transaction, so a failing `pg_restore` leaves the schemas empty rather than half
restored. Fix the cause (it is printed) and run the same restore again. The API refuses to start on the empty schema
until then.

## Upgrading

Releases are the `vX.Y.Z` tags on GitHub ([releases](https://github.com/VictorMinemu/open-collaborative-ai-workspace/releases)).
`ocw upgrade` moves an install to the newest one (`node scripts/ocw.mjs upgrade` where pnpm is not installed):

```bash
pnpm ocw upgrade --check      # current and newest release; changes nothing
pnpm ocw upgrade              # asks first; --yes in scripts; --to vX.Y.Z for a given release
```

It refuses to start on edited tracked files, on an older release, or on a release made before an install from
`main`. It then runs, in order:

1. `ocw backup --consistent` into `backups/pre-<tag>-<time>/`;
2. `git checkout <tag>`, and `OCW_IMAGE_TAG=<tag>` in `.env`, so the previous release's images stay for a rollback;
3. `ocw setup --add-missing` from the new release (new keys only; never rotates a value);
4. `docker compose up -d --build --wait` (the one-shot migrate service upgrades the schema).

If a step after the backup fails, it prints the commit, image tag and backup to go back to. The same steps by hand:

```bash
pnpm ocw backup --consistent                  # 1. a backup of the current release
git fetch --tags && git checkout v0.2.0      # 2. the new release
pnpm ocw setup --add-missing                  # 3. new keys the release needs; never rotates existing values
docker compose up -d --build --wait           # 4. new images; the one-shot migrate service upgrades the schema
```

`migrate` runs before `api` starts (`service_completed_successfully`), and the API compares the applied migrations
with its own before it listens. If they differ, it exits with one of these messages (`docker compose logs api`):

| Message | Meaning | What to do |
| --- | --- | --- |
| `Database schema is behind this API (N pending, newest X). Run: docker compose run --rm migrate` | migrate did not run or failed | `docker compose run --rm migrate`, read its error, then `docker compose up -d --wait` |
| `Database was migrated by a newer release (unknown: Y). Restore a backup or run the newer image.` | an older image on a newer database (a rollback without a restore) | Run the newer release, or roll back properly (below) |
| `Migration X was modified after it was applied. …` | a migration file was edited after it ran | Check out an unmodified release; never edit an applied migration |
| `Database has never been migrated (or ocw_app cannot read drizzle.__drizzle_migrations). …` | an empty database, or migrate never finished | `docker compose run --rm migrate` |

**Rollback.** Migrations only move forward, so an older release cannot run on a schema a newer release migrated. To
roll back:

```bash
git checkout v0.1.0                            # and OCW_IMAGE_TAG back to the previous tag in .env
docker compose up -d --build --wait            # the API refuses to start: "migrated by a newer release"
pnpm ocw restore backups/<pre-upgrade> --yes   # the backup from step 1; everything after it is lost
```

### Which upgrades are tested (N-1 → N)

Every `pnpm verify` restores the previous release's schema and data and migrates them to the current code. The test
then checks the rows, tenant isolation, forced row-level security, sealed secrets and API boot
(`apps/api/src/upgrade.int.test.ts`). N-1 is still the Phase 5 merge (`3bbcbd9`). It is older than `v0.1.0` (the
Phase 7 tag, which had no published release), so the test covers every migration up to `v0.2.0`, the first public
release. From the next release on, N-1 is the previous release tag. Upgrade one release at a time when you skip
several, and take a backup before each one.

## Object storage keys

Garage creates its access key and the private bucket from `OCW_S3_ACCESS_KEY_ID` and `OCW_S3_SECRET_ACCESS_KEY` the
first time it starts on empty volumes. The keys in `.env` must match the key Garage already has. `pnpm ocw setup
--force` rotates every secret, including these, and the API then loses access to the existing bucket. To rotate the
storage keys on purpose:

```bash
pnpm ocw backup --consistent                   # with the old keys
# set new OCW_S3_ACCESS_KEY_ID / OCW_S3_SECRET_ACCESS_KEY (and GARAGE_RPC_SECRET) in .env
docker compose down
docker volume rm <project>_garage-meta <project>_garage-data
docker compose up -d --wait                    # Garage creates the new key and an empty bucket
pnpm ocw restore backups/<that backup> --yes   # re-imports every object with the current keys
```

## Data across container recreation

All state lives in named volumes: `pgdata`, `garage-meta`, `garage-data` and `openclaw-state`. `docker compose up -d
--force-recreate`, `docker compose down` (without `-v`) and image upgrades keep them. `docker compose down -v` deletes
them: after that, only a restore brings the data back. The gate step `scripts/gate/backup-roundtrip.mjs` checks all
of this on a real stack. It covers backup, change and restore, a restore onto brand-new volumes, and identical row
counts, sign-in and attachment download across `up -d --force-recreate --wait`.
