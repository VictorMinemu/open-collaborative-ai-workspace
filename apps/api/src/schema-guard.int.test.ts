import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSchema } from "@ocw/db";
import { startTestDatabase, type TestDatabase } from "@ocw/db/testing";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * SELF-03 / D-06 / D-18 (plan 07-02): the API refuses to start when the database's applied migrations differ from
 * the ones it ships. The real `src/main.ts` is spawned as a child process against a testcontainers database; the
 * migrations table is mutated only as the test container's superuser, and restored after each case.
 */

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXIT_TIMEOUT_MS = 30_000;

let tdb: TestDatabase;
let redis: StartedRedisContainer;
let su: pg.Client;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The URL from Fastify's "Server listening at …" line, when the API got that far. */
  listeningAt: string | null;
}

/** A free loopback port (the API's env schema requires PORT > 0). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Spawn `node --import tsx src/main.ts`; resolve when it exits, or (once listening) after `onListening` ran. */
async function runApi(onListening?: (url: string) => Promise<void>): Promise<Run> {
  const port = await freePort();
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    NODE_ENV: "test",
    LOG_LEVEL: "info",
    HOST: "127.0.0.1",
    PORT: String(port),
    DATABASE_URL: tdb.appUrl,
    AUTH_DATABASE_URL: tdb.authUrl,
    REDIS_URL: redis.getConnectionUrl(),
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    OCW_SETUP_TOKEN: "test-setup-token-0123456789",
    OCW_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    OCW_PUBLIC_WEB_URL: "http://localhost:3999",
    OCW_PUBLIC_API_URL: "http://localhost:4999",
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: API_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const run: Run = { code: null, stdout: "", stderr: "", listeningAt: null };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`API did not exit within ${EXIT_TIMEOUT_MS} ms\n${run.stdout}\n${run.stderr}`));
    }, EXIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      run.stdout += chunk.toString();
      const match = /Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(run.stdout);
      if (match?.[1] && !run.listeningAt) {
        run.listeningAt = match[1];
        const url = match[1];
        void (onListening ? onListening(url) : Promise.resolve())
          .catch((err: unknown) => {
            run.stderr += `\n[test] onListening failed: ${String(err)}`;
          })
          .finally(() => child.kill("SIGTERM"));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      run.stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      run.code = code;
      resolve(run);
    });
  });
}

async function newestMigration(): Promise<{ id: number; hash: string; created_at: string; name: string }> {
  const { rows } = await su.query(
    "select id, hash, created_at, name from drizzle.__drizzle_migrations order by id desc limit 1",
  );
  return rows[0];
}

beforeAll(async () => {
  [tdb, redis] = await Promise.all([startTestDatabase(), new RedisContainer("redis:8").start()]);
  su = new pg.Client({ connectionString: tdb.superuserUrl });
  await su.connect();
});

afterAll(async () => {
  await su?.end();
  await Promise.allSettled([tdb?.stop(), redis?.stop()]);
});

describe("API boot schema guard", () => {
  it("starts and answers /health 200 against a fully migrated database", async () => {
    let health = 0;
    const run = await runApi(async (url) => {
      health = (await fetch(`${url}/health`)).status;
    });
    expect(run.listeningAt, run.stderr).not.toBeNull();
    expect(health).toBe(200);
    expect(run.stderr).not.toMatch(/Database schema|never been migrated/);
  });

  it("refuses to start, exit 1, when the database is behind (the newest migration was not applied)", async () => {
    const newest = await newestMigration();
    await su.query("delete from drizzle.__drizzle_migrations where id = $1", [newest.id]);
    try {
      const run = await runApi();
      expect(run.code).toBe(1);
      expect(run.listeningAt).toBeNull();
      expect(run.stdout).not.toMatch(/listening/i);
      expect(run.stderr).toContain(`Database schema is behind this API (1 pending, newest ${newest.name})`);
      expect(run.stderr).toContain("docker compose run --rm migrate");
    } finally {
      await su.query(
        "insert into drizzle.__drizzle_migrations (id, hash, created_at, name) values ($1, $2, $3, $4)",
        [newest.id, newest.hash, newest.created_at, newest.name],
      );
    }
  });

  it("refuses to start, exit 1, when a newer release migrated the database", async () => {
    await su.query(
      "insert into drizzle.__drizzle_migrations (hash, created_at, name) values ('f00d', 0, '29991231235959_from_the_future')",
    );
    try {
      const run = await runApi();
      expect(run.code).toBe(1);
      expect(run.listeningAt).toBeNull();
      expect(run.stderr).toContain(
        "Database was migrated by a newer release (unknown: 29991231235959_from_the_future)",
      );
    } finally {
      await su.query(
        "delete from drizzle.__drizzle_migrations where name = '29991231235959_from_the_future'",
      );
    }
  });

  it("refuses to start, exit 1, when an applied migration was modified afterwards", async () => {
    const newest = await newestMigration();
    await su.query("update drizzle.__drizzle_migrations set hash = 'edited' where id = $1", [newest.id]);
    try {
      const run = await runApi();
      expect(run.code).toBe(1);
      expect(run.listeningAt).toBeNull();
      expect(run.stderr).toContain(`Migration ${newest.name} was modified after it was applied.`);
    } finally {
      await su.query("update drizzle.__drizzle_migrations set hash = $1 where id = $2", [
        newest.hash,
        newest.id,
      ]);
    }
  });

  it("is back to ok after every mutation was restored", async () => {
    expect((await checkSchema(tdb.appUrl)).status).toBe("ok");
  });
});

describe("ocw_app access to drizzle.__drizzle_migrations", () => {
  it("can read the table but never write it", async () => {
    const app = new pg.Client({ connectionString: tdb.appUrl });
    await app.connect();
    try {
      const { rows } = await app.query("select count(*)::int as n from drizzle.__drizzle_migrations");
      expect(rows[0].n).toBeGreaterThan(0);
      await expect(
        app.query("insert into drizzle.__drizzle_migrations (hash, created_at, name) values ('x', 0, 'x')"),
      ).rejects.toThrow(/permission denied/);
      await expect(app.query("update drizzle.__drizzle_migrations set hash = 'x'")).rejects.toThrow(
        /permission denied/,
      );
      await expect(app.query("delete from drizzle.__drizzle_migrations")).rejects.toThrow(
        /permission denied/,
      );
      await expect(app.query("truncate drizzle.__drizzle_migrations")).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
  });

  it("reports missing (never migrated / unreadable) when ocw_app cannot read the table", async () => {
    await su.query("revoke select on drizzle.__drizzle_migrations from ocw_app");
    try {
      const res = await checkSchema(tdb.appUrl);
      expect(res.status).toBe("missing");
    } finally {
      await su.query("grant select on drizzle.__drizzle_migrations to ocw_app");
    }
  });
});
