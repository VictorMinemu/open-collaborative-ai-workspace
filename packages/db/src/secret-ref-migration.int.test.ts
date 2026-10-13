import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "./migrate";
import { startTestDatabase, type TestDatabase } from "./testing";

/**
 * D-07 / AICHAT-01 / T-05-01-03: the provider-key backfill sets `secret_ref = {provider: "db", secretId,
 * organizationId}` on every model_providers row with a key, touches nothing else, is idempotent, never moves or
 * rewrites a sealed secret, and its documented rollback restores the pre-migration state. Runs the exact SQL of
 * the migration folder against legacy rows seeded on a fresh ephemeral PostgreSQL (with every migration applied).
 */

let tdb: TestDatabase;
let su: pg.Client;

function migrationDir(suffix: string): string {
  const dirs = readdirSync(MIGRATIONS_DIR).filter((d) => d.endsWith(suffix));
  expect(dirs, `exactly one *${suffix} migration`).toHaveLength(1);
  return dirs[0] as string;
}

function migrationSql(suffix: string): string {
  return readFileSync(join(MIGRATIONS_DIR, migrationDir(suffix), "migration.sql"), "utf8");
}

/** The rollback statement exactly as the migration header documents it. */
function rollbackSql(sql: string): string {
  const m = /^-- Rollback: `([^`]+)`/m.exec(sql);
  expect(m, "the migration header documents its rollback").not.toBeNull();
  return (m as RegExpExecArray)[1] as string;
}

const sealed = () => ({
  ciphertext: randomBytes(48).toString("base64"),
  iv: randomBytes(12).toString("base64"),
  tag: randomBytes(16).toString("base64"),
});

beforeAll(async () => {
  tdb = await startTestDatabase();
  su = new pg.Client({ connectionString: tdb.superuserUrl });
  await su.connect();
});

afterAll(async () => {
  await su?.end();
  await tdb?.stop();
});

async function seedOrg(name: string): Promise<string> {
  const org = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, $2, $3)", [
    org,
    name,
    `${name.toLowerCase()}-${org}`,
  ]);
  return org;
}

async function seedSecret(org: string, provider: string): Promise<string> {
  const id = randomUUID();
  const s = sealed();
  await su.query(
    "insert into app.secrets (id, organization_id, name, kind, provider, ciphertext, iv, tag) values ($1, $2, $3, 'provider_api_key', $3, $4, $5, $6)",
    [id, org, provider, s.ciphertext, s.iv, s.tag],
  );
  return id;
}

async function seedProvider(
  org: string,
  provider: string,
  opts: { secretId?: string; baseUrl?: string; account?: unknown; secretRef?: unknown } = {},
): Promise<string> {
  const r = await su.query(
    "insert into app.model_providers (organization_id, provider, secret_id, key_hint, base_url, allowed_models, account, secret_ref) values ($1, $2, $3, $4, $5, '{m-1}', $6, $7) returning id",
    [
      org,
      provider,
      opts.secretId ?? null,
      opts.secretId ? "x9Qa" : null,
      opts.baseUrl ?? null,
      opts.account === undefined ? null : JSON.stringify(opts.account),
      opts.secretRef === undefined ? null : JSON.stringify(opts.secretRef),
    ],
  );
  return r.rows[0].id;
}

async function providers(orgs: string[]) {
  const r = await su.query(
    "select id, organization_id, provider, secret_id, key_hint, base_url, allowed_models, enabled, account, secret_ref, updated_at from app.model_providers where organization_id = any($1) order by id",
    [orgs],
  );
  return r.rows;
}

async function secrets(orgs: string[]) {
  const r = await su.query(
    "select id, organization_id, name, kind, provider, ciphertext, iv, tag, created_at from app.secrets where organization_id = any($1) order by id",
    [orgs],
  );
  return r.rows;
}

describe("provider_secret_refs data migration", () => {
  it("sorts after the ai_chat schema migration that adds secret_ref", () => {
    const dirs = readdirSync(MIGRATIONS_DIR).sort();
    const schema = dirs.indexOf(migrationDir("_ai_chat"));
    const backfill = dirs.indexOf(migrationDir("_provider_secret_refs"));
    expect(schema).toBeGreaterThanOrEqual(0);
    expect(backfill).toBeGreaterThan(schema);
    // The data migration runs right after the schema migration that adds the column (was "is the newest
    // migration", true only until Phase 6 added 20261007073058_multiplayer_ai, which never touches model_providers).
    expect(backfill).toBe(schema + 1);
    // No later migration touches model_providers (any change to its secret_ref names the table). Other tables may
    // have their own `secret_ref` SecretReference column (Phase 07.4: vault_items), which this backfill never reads.
    for (const later of dirs.slice(backfill + 1)) {
      const laterSql = readFileSync(join(MIGRATIONS_DIR, later, "migration.sql"), "utf8");
      expect(laterSql, later).not.toMatch(/model_providers/);
    }
    const sql = migrationSql("_provider_secret_refs");
    expect(sql).toContain("secret_id is not null");
    expect(sql).toContain("secret_ref is null");
    // Ids only: the data migration never reads, writes or deletes app.secrets.
    expect(sql.replace(/^--.*$/gm, "")).not.toMatch(/app\.secrets|ciphertext|delete|drop/i);
  });

  it("backfills keyed legacy rows only, is idempotent, leaves ciphertext alone and rolls back", async () => {
    const backfill = migrationSql("_provider_secret_refs");
    const rollback = rollbackSql(backfill);
    expect(rollback).toBe("UPDATE app.model_providers SET secret_ref = NULL;");

    await su.query("begin");
    try {
      const acme = await seedOrg("Acme");
      const globex = await seedOrg("Globex");
      const anthropicKey = await seedSecret(acme, "anthropic");
      const openaiKey = await seedSecret(acme, "openai");
      const globexKey = await seedSecret(globex, "anthropic");
      const anthropic = await seedProvider(acme, "anthropic", { secretId: anthropicKey });
      const openai = await seedProvider(acme, "openai", { secretId: openaiKey });
      const compat = await seedProvider(acme, "openai-compatible", {
        baseUrl: "http://llm.internal:8000/v1",
      });
      const codex = await seedProvider(acme, "openai-codex", {
        account: {
          email: "ops@acme.test",
          planType: "plus",
          connectedAt: "2026-10-01T10:00:00.000Z",
          needsReconnect: false,
        },
      });
      const globexAnthropic = await seedProvider(globex, "anthropic", { secretId: globexKey });
      const orgs = [acme, globex];

      // Legacy state: the column exists (schema migration) but nothing references a secret through it yet.
      const legacyProviders = await providers(orgs);
      const legacySecrets = await secrets(orgs);
      expect(legacyProviders).toHaveLength(5);
      expect(legacyProviders.every((p) => p.secret_ref === null)).toBe(true);
      expect(legacySecrets).toHaveLength(3);

      await su.query(backfill);
      const refOf = async () => Object.fromEntries((await providers(orgs)).map((p) => [p.id, p.secret_ref]));
      const first = await refOf();
      expect(first).toEqual({
        [anthropic]: { provider: "db", secretId: anthropicKey, organizationId: acme },
        [openai]: { provider: "db", secretId: openaiKey, organizationId: acme },
        [compat]: null,
        [codex]: null,
        [globexAnthropic]: { provider: "db", secretId: globexKey, organizationId: globex },
      });
      // Nothing but secret_ref changed on any provider row.
      const after = await providers(orgs);
      expect(after.map(({ secret_ref: _r, ...rest }) => rest)).toEqual(
        legacyProviders.map(({ secret_ref: _r, ...rest }) => rest),
      );
      // The sealed secrets are byte-identical (never moved, decrypted, re-encrypted or deleted).
      expect(await secrets(orgs)).toEqual(legacySecrets);

      // Idempotent: a second run changes nothing.
      const second = await su.query(backfill);
      expect(second.rowCount).toBe(0);
      expect(await providers(orgs)).toEqual(after);
      expect(await secrets(orgs)).toEqual(legacySecrets);

      // The documented rollback restores the pre-migration state exactly.
      await su.query(rollback);
      expect(await providers(orgs)).toEqual(legacyProviders);
      expect(await secrets(orgs)).toEqual(legacySecrets);
      // Pre-Phase-5 code resolves keys through secret_id: every keyed row still reaches its sealed secret.
      const viaSecretId = await su.query(
        "select p.id, s.ciphertext from app.model_providers p join app.secrets s on s.id = p.secret_id and s.organization_id = p.organization_id where p.organization_id = any($1) order by p.id",
        [orgs],
      );
      expect(viaSecretId.rows.map((r) => r.id).sort()).toEqual([anthropic, openai, globexAnthropic].sort());
      for (const r of viaSecretId.rows) {
        expect(legacySecrets.map((s) => s.ciphertext)).toContain(r.ciphertext);
      }

      // And the backfill can be re-applied after a rollback with the same result.
      await su.query(backfill);
      expect(await refOf()).toEqual(first);
    } finally {
      await su.query("rollback");
    }
  });

  it("never overwrites a reference that is already set (operator env/file refs)", async () => {
    const backfill = migrationSql("_provider_secret_refs");
    await su.query("begin");
    try {
      const org = await seedOrg("Initech");
      const key = await seedSecret(org, "openrouter");
      const envRef = { provider: "env", key: "OCW_OPENROUTER_API_KEY" };
      const row = await seedProvider(org, "openrouter", { secretId: key, secretRef: envRef });
      const r = await su.query(backfill);
      expect(r.rowCount).toBe(0);
      const after = await su.query("select secret_ref, secret_id from app.model_providers where id = $1", [
        row,
      ]);
      expect(after.rows[0]).toEqual({ secret_ref: envRef, secret_id: key });
    } finally {
      await su.query("rollback");
    }
  });
});
