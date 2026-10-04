import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { EnvError, loadEnv } from "../config/env";
import { clearMemoryOutbox, createMailer, memoryOutbox } from "./mailer";

const BASE = {
  DATABASE_URL: "postgres://app@localhost:5432/ocw",
  AUTH_DATABASE_URL: "postgres://auth@localhost:5432/ocw",
  REDIS_URL: "redis://localhost:6379",
  BETTER_AUTH_SECRET: "x".repeat(32),
  OCW_SETUP_TOKEN: "setup-token-0123456789",
  OCW_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};

const env = (extra: Record<string, string>) => loadEnv({ ...BASE, NODE_ENV: "test", ...extra });

beforeEach(() => clearMemoryOutbox());

describe("mailer (AUTH-04)", () => {
  it("is absent without OCW_SMTP_URL", () => {
    const e = env({});
    expect(e.OCW_SMTP_URL).toBeUndefined();
    expect(e.OCW_MAIL_FROM).toBe("Open Collaborative AI Workspace <no-reply@localhost>");
    expect(createMailer(e)).toBeNull();
    // compose passes unset variables as empty strings
    expect(env({ OCW_SMTP_URL: "", OCW_MAIL_FROM: "" }).OCW_MAIL_FROM).toBe(e.OCW_MAIL_FROM);
    expect(createMailer(env({ OCW_SMTP_URL: "" }))).toBeNull();
  });

  it("memory: records every message in the test outbox", async () => {
    const mailer = createMailer(env({ OCW_SMTP_URL: "memory:" }));
    expect(mailer?.kind).toBe("memory");
    await mailer?.send({ to: "a@example.test", subject: "Hello", text: "plain", html: "<p>html</p>" });
    expect(memoryOutbox()).toEqual([
      { to: "a@example.test", subject: "Hello", text: "plain", html: "<p>html</p>" },
    ]);
    clearMemoryOutbox();
    expect(memoryOutbox()).toEqual([]);
  });

  it("rejects memory: outside tests and unknown schemes", () => {
    expect(() => loadEnv({ ...BASE, NODE_ENV: "production", OCW_SMTP_URL: "memory:" })).toThrow(EnvError);
    expect(() => loadEnv({ ...BASE, NODE_ENV: "development", OCW_SMTP_URL: "memory:" })).toThrow(
      /OCW_SMTP_URL: memory: is only allowed when NODE_ENV is test/,
    );
    expect(() => env({ OCW_SMTP_URL: "http://mail.example.test" })).toThrow(/OCW_SMTP_URL/);
  });

  it("an smtp:// or smtps:// URL builds a nodemailer transport without sending", () => {
    const smtp = createMailer(
      loadEnv({ ...BASE, NODE_ENV: "production", OCW_SMTP_URL: "smtp://user:pass@mail.example.test:587" }),
    );
    expect(smtp?.kind).toBe("smtp");
    const smtps = createMailer(
      env({ OCW_SMTP_URL: "smtps://mail.example.test", OCW_MAIL_FROM: "Ops <ops@x.test>" }),
    );
    expect(smtps?.kind).toBe("smtp");
    expect(memoryOutbox()).toEqual([]);
  });

  it("OCW_SMTP_URL accepts the _FILE form like every other secret", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "ocw-smtp-"));
    const file = join(dir, "smtp");
    writeFileSync(file, "smtp://mail.example.test:25\n");
    expect(env({ OCW_SMTP_URL_FILE: file }).OCW_SMTP_URL).toBe("smtp://mail.example.test:25");
  });
});
